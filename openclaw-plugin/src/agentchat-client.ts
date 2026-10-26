import WebSocket from "ws";
import type { ChatMessage, ClientOptions, MessageHandler } from "./agentchat-protocol";

/**
 * WebSocket client for AgentChat with built-in auto-reconnect.
 *
 * Why the plugin owns reconnect (not the OpenClaw host):
 *
 * OpenClaw's host health-monitor detects a "stale-socket" when no real
 * inbound message arrives within `staleEventThresholdMs` (default 30 min).
 * When that fires, the host calls `stopAccount` + closes the WS, BUT the
 * host's `resolveChannelRestartReason` path for `reason: "stale-socket"`
 * is specifically treated as `shouldIgnoreReadinessFailure === true` in
 * server.impl — meaning it does NOT trigger the normal auto-restart
 * counter that a "stopped" reason would. Net effect: a low-traffic
 * channel (e.g. #welcome with no recent chatter) gets the bot flagged
 * stale every ~30 minutes and the bot silently dies until someone
 * manually `launchctl kickstart`s the gateway.
 *
 * This client sidesteps the host by keeping its own session alive across
 * transient socket closes. The caller's `connect()` promise still settles
 * normally on the first handshake; after that, if the socket drops and
 * the caller hasn't called `disconnect()`, we reconnect with exponential
 * backoff (1s → 2s → 4s → … capped at `maxReconnectDelayMs`) forever. On
 * each successful re-auth, `onReconnect` fires so the caller can re-join
 * channels that the host only joined once at startup.
 *
 * `waitUntilClosed()` semantics: now resolves only when the caller
 * explicitly calls `disconnect()`, not on transient network drops. This
 * keeps the host-level gateway lifecycle running through network blips,
 * which is exactly what we want for a long-lived chat bot.
 */
export class AgentChatClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageHandlers: MessageHandler[] = [];
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private lifecyclePromise: Promise<void> | null = null;
  private lifecycleResolve: (() => void) | null = null;
  private lifecycleReject: ((err: Error) => void) | null = null;
  private transportError: Error | null = null;
  private connectSettled = false;
  private lifecycleSettled = false;
  /** Cumulative count of reconnect attempts since the last successful
   *  auth_ok. Reset to 0 on each successful handshake. Drives the
   *  exponential-backoff delay. */
  private reconnectAttempt = 0;
  /** True once the caller has invoked `disconnect()`. Suppresses any
   *  further reconnect attempts and signals the lifecycle promise to
   *  resolve on the next close. */
  private explicitlyDisconnected = false;
  /** True during a handshake that follows a prior auth_ok (i.e. a
   *  reconnect). Auth_ok handling uses this to fire `onReconnect` so
   *  the caller can re-subscribe to channels. */
  private isReconnecting = false;

  readonly url: string;
  readonly agentId: string;
  readonly token: string;
  readonly capabilities: string[];
  readonly heartbeatInterval: number;
  readonly reconnectEnabled: boolean;
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly onDebug?: (event: string, meta?: Record<string, unknown>) => void;
  readonly onReconnect?: () => void;

  constructor(options: ClientOptions) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.token = options.token ?? "dev-token";
    this.capabilities = options.capabilities ?? [];
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.reconnectEnabled = options.reconnect ?? true;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.onDebug = options.onDebug;
    this.onReconnect = options.onReconnect;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectSettled = false;
      this.lifecycleSettled = false;
      this.transportError = null;
      this.explicitlyDisconnected = false;
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.lifecyclePromise = new Promise((lifecycleResolve, lifecycleReject) => {
        this.lifecycleResolve = lifecycleResolve;
        this.lifecycleReject = lifecycleReject;
      });

      this.debug("connect:start", { url: this.url, agentId: this.agentId });
      this.openSocket();
    });
  }

  disconnect() {
    this.debug("disconnect", { hadSession: Boolean(this.sessionId) });
    this.explicitlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.sessionId = null;
    // Resolve lifecycle immediately — caller asked to stop; don't make
    // them wait for the socket's close event (which may never fire if
    // the remote side was already gone).
    this.resolveLifecycle();
  }

  waitUntilClosed(): Promise<void> {
    return this.lifecyclePromise ?? Promise.resolve();
  }

  sendMessage(channelId: string, content: string) {
    this.debug("send:message", { channelId, length: content.length });
    this.send({
      type: "message",
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: this.agentId,
      sender_type: "agent",
      content,
      content_type: "text",
      timestamp: new Date().toISOString(),
    });
  }

  joinChannel(channelId: string) {
    this.debug("send:join_channel", { channelId });
    this.send({ type: "join_channel", channel_id: channelId, agent_id: this.agentId });
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return this;
  }

  private openSocket() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (event) => this.handleMessage(String(event.data));
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => this.handleError(new Error("WebSocket error"));
  }

  private handleOpen() {
    this.debug("socket:open");
    this.send({
      type: "auth",
      agent_id: this.agentId,
      token: this.token,
      capabilities: this.capabilities,
    });
  }

  private handleError(error: Error) {
    this.debug("socket:error", { error: error.message });
    this.transportError = error;
    // During a reconnect the initial-connect promise is already settled;
    // we don't want to reject it again. The close handler will schedule
    // the next backoff attempt.
    if (this.isReconnecting) return;
    if (!this.sessionId) {
      this.rejectConnect(error);
      return;
    }
    this.rejectLifecycle(error);
  }

  private handleMessage(raw: string) {
    const data = JSON.parse(raw) as Record<string, unknown>;
    this.debug("recv", { type: String(data.type ?? "unknown") });

    switch (data.type) {
      case "auth_ok":
        this.sessionId = String(data.session_id ?? "");
        this.debug("auth:ok", { sessionId: this.sessionId, wasReconnect: this.isReconnecting });
        this.startHeartbeat();
        if (this.isReconnecting) {
          // Reconnect handshake completed. Reset the backoff counter
          // (so the NEXT drop starts from 1s again, not wherever we
          // gave up) and let the caller re-subscribe to channels — the
          // host-level `startAccount` only joined `defaultChannelId`
          // once at startup, so without this the bot would be auth'd
          // but silent.
          this.reconnectAttempt = 0;
          this.isReconnecting = false;
          try { this.onReconnect?.(); }
          catch (e) { this.debug("onReconnect:threw", { error: e instanceof Error ? e.message : String(e) }); }
        } else {
          this.resolveConnect();
        }
        break;
      case "message":
        for (const handler of this.messageHandlers) {
          handler({
            type: "message",
            id: String(data.id ?? ""),
            channel_id: String(data.channel_id ?? ""),
            sender_id: String(data.sender_id ?? ""),
            sender_type: data.sender_type === "human" ? "human" : "agent",
            content: String(data.content ?? ""),
            content_type: data.content_type === "code" || data.content_type === "proposal" ? data.content_type : "text",
            timestamp: String(data.timestamp ?? new Date().toISOString()),
          });
        }
        break;
      case "error":
        this.debug("server:error", { message: String(data.message ?? "unknown error") });
        if (this.connectReject && !this.sessionId) {
          this.rejectConnect(new Error(`Auth failed: ${String(data.message ?? "unknown error")}`));
        }
        break;
      case "pong":
      default:
        break;
    }
  }

  private handleClose() {
    const hadSession = Boolean(this.sessionId);
    this.debug("socket:close", {
      hadSession,
      transportError: this.transportError?.message ?? null,
      explicitlyDisconnected: this.explicitlyDisconnected,
    });
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const closeError = this.transportError ?? new Error("WebSocket closed");
    // If the initial handshake hasn't settled yet, the caller's
    // `connect()` promise still needs an answer. This path only fires
    // during the very first connect — subsequent reconnect attempts
    // run with `isReconnecting = true` and the connect promise long
    // settled.
    if (!hadSession && !this.isReconnecting) {
      this.rejectConnect(closeError);
    }
    this.ws = null;
    this.sessionId = null;
    this.transportError = null;

    // Decide whether to reconnect. Four cases:
    //   1. Caller asked to stop — honor it, resolve lifecycle.
    //   2. Reconnect disabled — preserve the old v0.2.3 behavior.
    //   3. Initial connect failed (never got a session) — don't retry;
    //      auth problems and bad URLs are the common case here and
    //      retrying would mask them.
    //   4. Transient close after a live session — schedule reconnect.
    if (this.explicitlyDisconnected) {
      this.resolveLifecycle();
      return;
    }
    if (!this.reconnectEnabled) {
      this.resolveLifecycle();
      return;
    }
    if (!hadSession && !this.isReconnecting) {
      // Initial connect failed; already rejected above. Don't retry.
      this.resolveLifecycle();
      return;
    }
    // We either had a session (transient drop) or we're already in a
    // reconnect cycle and a retry just failed. Either way, back off.
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt += 1;
    // Exponential backoff: initial × 2^(attempt-1), capped at max.
    // 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, …
    const raw = this.initialReconnectDelayMs * Math.pow(2, this.reconnectAttempt - 1);
    const delay = Math.min(raw, this.maxReconnectDelayMs);
    this.debug("reconnect:scheduled", { attempt: this.reconnectAttempt, delayMs: delay });
    this.isReconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyDisconnected) return;
      this.debug("reconnect:start", { attempt: this.reconnectAttempt });
      this.openSocket();
    }, delay);
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping", timestamp: new Date().toISOString() });
    }, this.heartbeatInterval);
  }

  private send(data: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private debug(event: string, meta?: Record<string, unknown>) {
    this.onDebug?.(event, meta);
  }

  private resolveConnect() {
    if (this.connectSettled) return;
    this.connectSettled = true;
    this.connectResolve?.();
  }

  private rejectConnect(error: Error) {
    if (this.connectSettled) return;
    this.connectSettled = true;
    this.connectReject?.(error);
  }

  private resolveLifecycle() {
    if (this.lifecycleSettled) return;
    this.lifecycleSettled = true;
    this.lifecycleResolve?.();
  }

  private rejectLifecycle(error: Error) {
    if (this.lifecycleSettled) return;
    this.lifecycleSettled = true;
    this.lifecycleReject?.(error);
  }
}

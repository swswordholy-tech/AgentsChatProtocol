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
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_OUTBOUND = 64;
const DRAIN_MIN_DELAY_MS = 200;
const DRAIN_JITTER_MS = 2_000;

export class AgentChatClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly joinedChannels = new Set<string>();
  private readonly pendingOutbound: Record<string, unknown>[] = [];
  private lastInboundAt = 0;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private lifecyclePromise: Promise<void> | null = null;
  private lifecycleResolve: (() => void) | null = null;
  private lifecycleReject: ((err: Error) => void) | null = null;
  private transportError: Error | null = null;
  private connectSettled = false;
  private lifecycleSettled = false;
  private fastReconnectPending = false;
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
  readonly connectTimeoutMs: number;
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
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.reconnectEnabled = options.reconnect ?? true;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.onDebug = options.onDebug;
    this.onReconnect = options.onReconnect;
  }

  connect(): Promise<void> {
    this.clearConnectTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close();
      } catch {}
    }
    this.sessionId = null;

    return new Promise((resolve, reject) => {
      this.connectSettled = false;
      this.lifecycleSettled = false;
      this.transportError = null;
      this.explicitlyDisconnected = false;
      this.fastReconnectPending = false;
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.pendingOutbound.length = 0;
      this.lastInboundAt = 0;
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
    this.fastReconnectPending = false;
    this.clearConnectTimer();
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
    this.pendingOutbound.length = 0;
    this.lastInboundAt = 0;
    // Resolve lifecycle immediately — caller asked to stop; don't make
    // them wait for the socket's close event (which may never fire if
    // the remote side was already gone).
    this.resolveLifecycle();
  }

  waitUntilClosed(): Promise<void> {
    return this.lifecyclePromise ?? Promise.resolve();
  }

  sendMessage(channelId: string, content: string, threadId?: string | number) {
    const normalizedThread =
      threadId !== undefined && threadId !== null && String(threadId).trim().length > 0
        ? String(threadId).trim()
        : undefined;
    this.debug("send:message", { channelId, length: content.length, ...(normalizedThread ? { threadId: normalizedThread } : {}) });
    const frame: Record<string, unknown> = normalizedThread
      ? {
          type: "thread_reply",
          id: crypto.randomUUID(),
          channel_id: channelId,
          parent_id: normalizedThread,
          sender_id: this.agentId,
          sender_type: "agent",
          content,
          content_type: "text",
          timestamp: new Date().toISOString(),
        }
      : {
          type: "message",
          id: crypto.randomUUID(),
          channel_id: channelId,
          sender_id: this.agentId,
          sender_type: "agent",
          content,
          content_type: "text",
          timestamp: new Date().toISOString(),
        };

    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    if (!this.explicitlyDisconnected && (this.isReconnecting || (this.ws !== null && !this.connectSettled))) {
      if (this.pendingOutbound.length >= MAX_PENDING_OUTBOUND) {
        this.pendingOutbound.shift();
      }
      this.pendingOutbound.push(frame);
      this.debug("send:queued_for_reconnect", { channelId, queued: this.pendingOutbound.length });
      return;
    }
    throw new Error("AgentChat WebSocket is not connected");
  }

  joinChannel(channelId: string) {
    if (!channelId) return;
    this.joinedChannels.add(channelId);
    this.debug("send:join_channel", { channelId });
    this.send({ type: "join_channel", channel_id: channelId, agent_id: this.agentId });
  }

  leaveChannel(channelId: string) {
    if (!channelId) return;
    this.joinedChannels.delete(channelId);
    this.debug("send:leave_channel", { channelId });
    this.send({ type: "leave_channel", channel_id: channelId, agent_id: this.agentId });
  }

  getJoinedChannels(): string[] {
    return Array.from(this.joinedChannels);
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return this;
  }

  private openSocket() {
    this.clearConnectTimer();
    const socket = new WebSocket(this.url, { maxPayload: MAX_WS_PAYLOAD_BYTES });
    this.ws = socket;
    if (this.connectTimeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.ws !== socket || this.sessionId) return;
        const timeoutErr = new Error(`WebSocket connect timed out after ${this.connectTimeoutMs}ms`);
        this.transportError = timeoutErr;
        this.debug("connect:timeout", { timeoutMs: this.connectTimeoutMs, isReconnecting: this.isReconnecting });
        if (!this.isReconnecting) {
          this.rejectConnect(timeoutErr);
        }
        try {
          socket.terminate();
        } catch {
          socket.close();
        }
      }, this.connectTimeoutMs);
      this.connectTimer.unref?.();
    }
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.handleOpen();
    };
    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      this.handleMessage(String(event.data));
    };
    socket.onclose = () => {
      if (this.ws !== socket && this.ws !== null) return;
      this.handleClose();
    };
    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.handleError(new Error("WebSocket error"));
    };
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
    // During a reconnect (or after an authenticated session is established while
    // auto-reconnect is enabled), `waitUntilClosed()` must stay pending across
    // transient socket errors (`onerror` fires before `onclose` sets `isReconnecting`)
    // so `handleClose()` can schedule the next backoff reconnect without tearing
    // down the host gateway or spawning an orphaned reconnect loop.
    if (this.isReconnecting) return;
    if (!this.sessionId) {
      this.rejectConnect(error);
      return;
    }
    if (!this.reconnectEnabled && !this.explicitlyDisconnected) {
      this.rejectLifecycle(error);
    }
  }

  private handleMessage(raw: string) {
    this.lastInboundAt = Date.now();
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        this.debug("recv:invalid_json");
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      this.debug("recv:invalid_json");
      return;
    }
    this.debug("recv", { type: String(data.type ?? "unknown") });

    switch (data.type) {
      case "auth_ok":
        this.clearConnectTimer();
        this.sessionId = String(data.session_id ?? "");
        this.lastInboundAt = Date.now();
        this.debug("auth:ok", { sessionId: this.sessionId, wasReconnect: this.isReconnecting });
        this.startHeartbeat();
        if (this.isReconnecting) {
          this.reconnectAttempt = 0;
          this.isReconnecting = false;
          try { this.onReconnect?.(); }
          catch (e) { this.debug("onReconnect:threw", { error: e instanceof Error ? e.message : String(e) }); }
        } else {
          this.resolveConnect();
        }
        this.flushPendingOutbound();
        break;
      case "auth_error": {
        this.clearConnectTimer();
        const reason = String(data.message ?? data.error ?? "authentication rejected");
        const authErr = new Error(`Auth failed: ${reason}`);
        this.debug("auth:error", { message: reason });
        // Terminal credential rejection — stop reconnect loops immediately.
        this.explicitlyDisconnected = true;
        this.fastReconnectPending = false;
        this.pendingOutbound.length = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!this.connectSettled) {
          this.rejectConnect(authErr);
        }
        this.ws?.close();
        this.ws = null;
        this.sessionId = null;
        this.resolveLifecycle();
        break;
      }
      case "channel_created":
        if (typeof data.channel_id === "string" && data.channel_id.length > 0) {
          this.joinChannel(data.channel_id);
        }
        break;
      case "please_reconnect":
      case "shard_moved":
        this.debug("server:drain", { type: String(data.type) });
        if (!this.explicitlyDisconnected && this.reconnectEnabled) {
          this.fastReconnectPending = true;
          this.ws?.close();
        }
        break;
      case "message":
      case "thread_reply": {
        if (data.content === "__typing__") break;
        const rawThreadId = data.thread_id ?? data.parent_id ?? data.reply_to ?? data.in_reply_to;
        const threadId =
          (typeof rawThreadId === "string" && rawThreadId.length > 0) || typeof rawThreadId === "number"
            ? rawThreadId
            : undefined;
        const normalized: ChatMessage = {
          type: "message",
          id: String(data.id ?? ""),
          channel_id: String(data.channel_id ?? ""),
          sender_id: String(data.sender_id ?? ""),
          sender_type: data.sender_type === "human" ? "human" : "agent",
          content: String(data.content ?? ""),
          content_type: data.content_type === "code" || data.content_type === "proposal" ? data.content_type : "text",
          timestamp: String(data.timestamp ?? new Date().toISOString()),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
        };
        for (const handler of this.messageHandlers) {
          try {
            Promise.resolve(handler(normalized)).catch((err) => {
              this.debug("messageHandler:rejected", { error: err instanceof Error ? err.message : String(err) });
            });
          } catch (err) {
            this.debug("messageHandler:threw", { error: err instanceof Error ? err.message : String(err) });
          }
        }
        break;
      }
      case "error":
        this.debug("server:error", { message: String(data.message ?? "unknown error") });
        if (this.connectReject && !this.sessionId) {
          this.clearConnectTimer();
          this.rejectConnect(new Error(`Auth failed: ${String(data.message ?? "unknown error")}`));
        }
        break;
      case "pong":
      default:
        break;
    }
  }

  private handleClose() {
    this.clearConnectTimer();
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
    let delay: number;
    if (this.fastReconnectPending) {
      this.fastReconnectPending = false;
      this.reconnectAttempt = 0;
      delay = Math.min(
        DRAIN_MIN_DELAY_MS + Math.floor(Math.random() * DRAIN_JITTER_MS),
        this.maxReconnectDelayMs,
      );
    } else {
      this.reconnectAttempt += 1;
      // Exponential backoff: initial × 2^(attempt-1), capped at max.
      // 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, …
      const raw = this.initialReconnectDelayMs * Math.pow(2, this.reconnectAttempt - 1);
      delay = Math.min(raw, this.maxReconnectDelayMs);
    }
    this.debug("reconnect:scheduled", { attempt: this.reconnectAttempt, delayMs: delay });
    this.isReconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyDisconnected) return;
      this.debug("reconnect:start", { attempt: this.reconnectAttempt });
      this.openSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private flushPendingOutbound() {
    if (!this.sessionId || this.ws?.readyState !== WebSocket.OPEN || this.pendingOutbound.length === 0) return;
    const batch = this.pendingOutbound.splice(0);
    for (const frame of batch) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!Number.isFinite(this.heartbeatInterval) || this.heartbeatInterval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (
        this.lastInboundAt > 0 &&
        Date.now() - this.lastInboundAt > this.heartbeatInterval * 3
      ) {
        this.debug("heartbeat:stale_timeout", { idleMs: Date.now() - this.lastInboundAt });
        try {
          this.ws?.terminate();
        } catch {
          this.ws?.close();
        }
        return;
      }
      this.send({ type: "ping", timestamp: new Date().toISOString() });
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
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

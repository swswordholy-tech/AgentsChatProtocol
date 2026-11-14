import { computePleaseReconnectDelay } from "../../src/reconnect.ts";
import type { ChatMessage, MessageHandler, MuseAgentChatOptions, WireMessage } from "./types.ts";

/**
 * WebSocket client for AgentsChat, owned by the Muse bridge.
 *
 * The client owns reconnect (the host does not): after the first successful
 * handshake, a transient socket close triggers exponential backoff
 * (initial -> max, see options) and re-auth on reconnect. `waitUntilClosed()`
 * resolves only on an explicit disconnect(), not on transient drops, so a
 * long-lived Muse bot survives network blips without manual restarts.
 */
export class MuseAgentChatClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReconnectDelayOverrideMs: number | null = null;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private lifecycleResolve: (() => void) | null = null;
  private explicitlyDisconnected = false;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  private connectSettled = false;

  readonly url: string;
  readonly agentId: string;
  readonly token: string;
  readonly capabilities: string[];
  readonly heartbeatIntervalMs: number;
  readonly connectTimeoutMs: number;
  readonly reconnect: boolean;
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly onDebug?: MuseAgentChatOptions["onDebug"];
  onReconnect?: MuseAgentChatOptions["onReconnect"];

  constructor(options: MuseAgentChatOptions) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.token = options.token;
    this.capabilities = options.capabilities ?? ["chat"];
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.reconnect = options.reconnect ?? true;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.onDebug = options.onDebug;
    this.onReconnect = options.onReconnect;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      try {
        h(err);
      } catch {
        /* isolate error listener faults */
      }
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.clearConnectTimer();
      this.connectSettled = false;
      this.explicitlyDisconnected = false;
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.connectResolve = resolve;
      this.connectReject = reject;
      if (this.connectTimeoutMs > 0) {
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (!this.connectSettled) {
            const err = new Error(`AgentsChat connect timed out after ${this.connectTimeoutMs}ms`);
            this.connectSettled = true;
            this.explicitlyDisconnected = true;
            try { this.ws?.close(); } catch {}
            this.connectReject?.(err);
            this.emitError(err);
          }
        }, this.connectTimeoutMs);
        this.connectTimer.unref?.();
      }
      this.openSocket();
    });
  }

  waitUntilClosed(): Promise<void> {
    if (!this.lifecycleResolve) {
      return new Promise((resolve) => {
        this.lifecycleResolve = resolve;
      });
    }
    return new Promise((resolve) => {
      const prev = this.lifecycleResolve;
      this.lifecycleResolve = () => {
        prev?.();
        resolve();
      };
    });
  }

  disconnect(): void {
    this.explicitlyDisconnected = true;
    this.clearConnectTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.connectReject?.(new Error("Disconnected before authentication completed"));
    }
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.sessionId = null;
    this.lifecycleResolve?.();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  get session(): string | null {
    return this.sessionId;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  joinChannel(channelId: string): void {
    this.send({ type: "join_channel", channel_id: channelId, agent_id: this.agentId });
  }

  leaveChannel(channelId: string): void {
    this.send({ type: "leave_channel", channel_id: channelId, agent_id: this.agentId });
  }

  sendMessage(channelId: string, content: string, contentType: ChatMessage["content_type"] = "text"): void {
    this.send({
      type: "message",
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: this.agentId,
      sender_type: "agent",
      content,
      content_type: contentType,
      timestamp: new Date().toISOString(),
    });
  }

  sendTyping(channelId: string): void {
    // cross_pod:true → the hub fans the frame out to humans on other pods;
    // typing frames are ephemeral and never persisted.
    this.send({ type: "typing", channel_id: channelId, sender_id: this.agentId, cross_pod: true });
  }

  private debug(event: string, meta?: Record<string, unknown>): void {
    this.onDebug?.(event, meta);
  }

  private openSocket(): void {
    this.debug("connect:start", { url: this.url, agentId: this.agentId });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        type: "auth",
        agent_id: this.agentId,
        token: this.token,
        capabilities: this.capabilities,
      });
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: "ping", timestamp: new Date().toISOString() });
        }
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    };
    ws.onmessage = (event) => this.handleMessage(String(event.data));
    ws.onerror = () => {
      const err = new Error("WebSocket error");
      if (!this.connectSettled) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.emitError(err);
    };
    ws.onclose = () => {
      if (this.ws && this.ws !== ws) return;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.sessionId = null;
      if (!this.connectSettled && !this.reconnect) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(new Error("WebSocket closed before authentication"));
      }
      if (this.explicitlyDisconnected) {
        this.lifecycleResolve?.();
        return;
      }
      if (!this.reconnect) {
        this.lifecycleResolve?.();
        return;
      }
      let delay: number;
      if (this.nextReconnectDelayOverrideMs !== null) {
        delay = this.nextReconnectDelayOverrideMs;
        this.nextReconnectDelayOverrideMs = null;
      } else {
        delay = Math.min(
          this.initialReconnectDelayMs * 2 ** this.reconnectAttempt,
          this.maxReconnectDelayMs,
        );
        this.reconnectAttempt += 1;
      }
      this.isReconnecting = true;
      this.debug("reconnect:scheduled", { delayMs: delay, attempt: this.reconnectAttempt });
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
      this.reconnectTimer.unref?.();
    };
  }

  private send(payload: WireMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("AgentsChat socket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (msg.type === "auth_ok") {
      this.clearConnectTimer();
      this.sessionId = typeof msg.session_id === "string" ? msg.session_id : null;
      this.reconnectAttempt = 0;
      const wasReconnect = this.isReconnecting;
      this.isReconnecting = false;
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectResolve?.();
      } else if (wasReconnect) {
        this.onReconnect?.();
      }
      return;
    }
    if (msg.type === "auth_error" || msg.type === "error") {
      const text =
        typeof msg.error === "string"
          ? msg.error
          : typeof msg.message === "string"
            ? msg.message
            : msg.type === "auth_error"
              ? "AgentsChat authentication error"
              : "AgentsChat error";
      const err = new Error(text);
      if (msg.type === "auth_error") {
        this.explicitlyDisconnected = true;
        try {
          this.ws?.close();
        } catch {}
      }
      if (!this.connectSettled) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.emitError(err);
      return;
    }
    if (msg.type === "please_reconnect" || msg.type === "shard_moved") {
      const withinMs = typeof msg.within_ms === "number" ? msg.within_ms : undefined;
      this.nextReconnectDelayOverrideMs = computePleaseReconnectDelay(withinMs);
      this.reconnectAttempt = 0;
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "channel_created" && typeof msg.channel_id === "string" && msg.channel_id) {
      if (this.ws?.readyState === WebSocket.OPEN) this.joinChannel(msg.channel_id);
      return;
    }
    if (msg.type === "message" || msg.type === "thread_reply") {
      const chat: ChatMessage = {
        id: String(msg.id ?? ""),
        channel_id: String(msg.channel_id ?? ""),
        sender_id: String(msg.sender_id ?? ""),
        sender_type: (msg.sender_type as ChatMessage["sender_type"]) ?? "agent",
        content: String(msg.content ?? ""),
        content_type: (msg.content_type as ChatMessage["content_type"]) ?? "text",
        timestamp: String(msg.timestamp ?? new Date().toISOString()),
        channel_type: msg.channel_type as ChatMessage["channel_type"],
        thread_id:
          typeof msg.thread_id === "string"
            ? msg.thread_id
            : typeof msg.parent_id === "string"
              ? msg.parent_id
              : undefined,
      };
      for (const h of this.messageHandlers) {
        try {
          Promise.resolve(h(chat)).catch((err) => {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
          });
        } catch (err) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
}

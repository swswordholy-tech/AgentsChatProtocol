export type SenderType = "agent" | "human";
export type ContentType = "text" | "code" | "proposal";

export interface ChatMessage {
  type: "message";
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  content_type: ContentType;
  timestamp: string;
}

export interface ClientOptions {
  url: string;
  agentId: string;
  token?: string;
  capabilities?: string[];
  heartbeatInterval?: number;
  /** Auto-reconnect after an unexpected WS close once the initial
   *  handshake has succeeded. Default: true. Does NOT retry when the
   *  very first connect fails — those errors surface via `connect()`. */
  reconnect?: boolean;
  /** Base delay for the first reconnect attempt, in ms. Default 1000. */
  initialReconnectDelayMs?: number;
  /** Upper bound for exponential backoff between reconnects, in ms. Default 60000. */
  maxReconnectDelayMs?: number;
  onDebug?: (event: string, meta?: Record<string, unknown>) => void;
  /** Invoked after a successful RECONNECT's auth_ok (not the initial
   *  connect). Use this to re-join channels the bot was subscribed to. */
  onReconnect?: () => void;
}

export type MessageHandler = (message: ChatMessage) => void;

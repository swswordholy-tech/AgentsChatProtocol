/** Shared wire types for the AgentsChat protocol (see docs/protocol.md). */

export type SenderType = "agent" | "human";
export type ContentType = "text" | "code" | "proposal";
export type ChannelKind = "direct" | "group" | "project";

export interface ChatMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: SenderType;
  content: string;
  content_type: ContentType;
  timestamp: string;
  /** Present on inbound group messages the server tags as a DM/thread. */
  channel_type?: ChannelKind;
  thread_id?: string;
}

export interface MuseAgentChatOptions {
  url: string;
  agentId: string;
  token: string;
  capabilities?: string[];
  heartbeatIntervalMs?: number;
  reconnect?: boolean;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onDebug?: (event: string, meta?: Record<string, unknown>) => void;
  onReconnect?: () => void;
}

export type MessageHandler = (message: ChatMessage) => void | Promise<void>;

export interface WireMessage {
  type: string;
  [key: string]: unknown;
}

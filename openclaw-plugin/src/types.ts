import type { AgentChatClient } from "./agentchat-client";

export const CHANNEL_ID = "agentchat" as const;
export const DEFAULT_WS_URL =
  "wss://agents-chat.com/ws";

export interface AgentChatAccountConfig {
  name?: string;
  agentId?: string;
  token?: string;
  wsUrl?: string;
  defaultChannelId?: string;
  enabled?: boolean;
}

export interface AgentChatChannelConfig {
  defaultAccountId?: string;
  accounts?: Record<string, AgentChatAccountConfig>;
}

export interface AgentChatPluginConfigRoot {
  channels?: {
    agentchat?: AgentChatChannelConfig;
  };
}

export interface AgentChatResolvedAccount {
  accountId: string;
  name?: string;
  agentId?: string;
  token?: string;
  wsUrl: string;
  defaultChannelId?: string;
  enabled: boolean;
}

export interface AgentChatGatewayState {
  client: AgentChatClient;
  abortHandler: () => void;
}

export interface AgentChatInboundPolicyResult {
  shouldDispatch: boolean;
  bodyForAgent: string;
  rawBody: string;
  commandBody: string;
}

import { AgentChatClient } from "./agentchat-client";

import type { AgentChatGatewayState, AgentChatResolvedAccount } from "./types";

const MAX_MENTION_CURSORS = 2_000;
const gatewayStates = new Map<string, AgentChatGatewayState>();
const mentionCursors = new Map<string, string>();

function mentionCursorKey(accountId: string, conversationId: string) {
  return `${accountId}:${conversationId}`;
}

export function getGatewayState(accountId: string) {
  return gatewayStates.get(accountId);
}

export function setGatewayState(accountId: string, state: AgentChatGatewayState) {
  gatewayStates.set(accountId, state);
}

export function deleteGatewayState(accountId: string) {
  gatewayStates.delete(accountId);
}

export function getMentionCursor(accountId: string, conversationId: string) {
  return mentionCursors.get(mentionCursorKey(accountId, conversationId));
}

export function setMentionCursor(accountId: string, conversationId: string, timestamp: string) {
  const key = mentionCursorKey(accountId, conversationId);
  if (mentionCursors.has(key)) {
    mentionCursors.delete(key);
  } else if (mentionCursors.size >= MAX_MENTION_CURSORS) {
    const oldest = mentionCursors.keys().next().value;
    if (oldest !== undefined) mentionCursors.delete(oldest);
  }
  mentionCursors.set(key, timestamp);
}

export function createGatewayClient(
  account: AgentChatResolvedAccount,
  onDebug?: (event: string, meta?: Record<string, unknown>) => void,
  onReconnect?: () => void,
) {
  return new AgentChatClient({
    url: account.wsUrl,
    agentId: account.agentId ?? account.accountId,
    token: account.token,
    capabilities: ["chat"],
    onDebug,
    onReconnect,
  });
}

import type { ChatMessage } from "./agentchat-protocol";

import { buildConversationId } from "./conversation";
import { getMentionCursor, setMentionCursor } from "./state";
import type { AgentChatInboundPolicyResult, AgentChatResolvedAccount } from "./types";

const HISTORY_LIMIT = 50;
const MAX_CONTEXT_BYTES = 15_000;
const MAX_PER_MESSAGE_CHARS = 2_000;
const TRUNCATED_SUFFIX = " …[truncated]";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDirectChannel(channelId: string) {
  return channelId.startsWith("dm-");
}

function getThreadId(message: ChatMessage): string | number | undefined {
  const value = (message as ChatMessage & { thread_id?: string | number | null }).thread_id;
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function deriveRestBaseUrl(wsUrl: string) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.endsWith("/ws")
    ? url.pathname.slice(0, -3) || "/"
    : url.pathname || "/";
  return url.toString().replace(/\/$/, "");
}

function extractMentionAliases(account: AgentChatResolvedAccount) {
  return Array.from(
    new Set(
      [account.agentId, account.accountId, account.name]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function isMentioned(content: string, account: AgentChatResolvedAccount) {
  const aliases = extractMentionAliases(account);
  if (aliases.some((alias) => content.includes(`@${alias}`))) return true;

  const idCandidates = [account.agentId, account.accountId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return idCandidates.some((id) => {
    const idEsc = escapeRegExp(id);
    const displayMentionRe = new RegExp(`@[^(\n]+\\(${idEsc}\\)`);
    return displayMentionRe.test(content);
  });
}

async function fetchChannelHistory(params: {
  wsUrl: string;
  token?: string;
  channelId: string;
  after?: string;
}) {
  const baseUrl = deriveRestBaseUrl(params.wsUrl);
  const search = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (params.after) search.set("after", params.after);
  const response = await fetch(
    `${baseUrl}/api/channels/${encodeURIComponent(params.channelId)}/messages?${search.toString()}`,
    {
      headers: params.token ? { Authorization: `Bearer ${params.token}` } : {},
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: failed to fetch AgentChat history`);
  }
  const payload = (await response.json()) as { messages?: ChatMessage[] };
  return payload.messages ?? [];
}

function clipMessageContent(content: string) {
  return content.length > MAX_PER_MESSAGE_CHARS
    ? `${content.slice(0, MAX_PER_MESSAGE_CHARS)}${TRUNCATED_SUFFIX}`
    : content;
}

function buildContextPrefix(messages: ChatMessage[]) {
  let totalBytes = 0;
  const trimmed: Array<ChatMessage & { content: string }> = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const clipped = clipMessageContent(message.content ?? "");
    const size = Buffer.byteLength(clipped, "utf8");
    if (totalBytes + size > MAX_CONTEXT_BYTES) break;
    totalBytes += size;
    trimmed.unshift({ ...message, content: clipped });
  }

  if (trimmed.length === 0) return "";

  const truncated = trimmed.length < messages.length;
  const note = truncated
    ? `[频道上下文 - 最近 ${trimmed.length} 条消息（更早的已截断保护上下文窗口）]`
    : `[频道上下文 - 自上次 @mention 以来 ${trimmed.length} 条消息]`;
  const context = trimmed.map((message) => `${message.sender_id}: ${message.content}`).join("\n");
  return `${note}\n${context}\n\n[你被 @mention 了，请回复]\n`;
}

function filterHistory(params: {
  messages: ChatMessage[];
  currentMessage: ChatMessage;
  threadId?: string | number;
}) {
  return params.messages.filter((message) => {
    if (message.id === params.currentMessage.id) return false;
    if (message.content === "__typing__") return false;

    if (params.threadId !== undefined) {
      const threadId = getThreadId(message);
      if (threadId !== undefined && String(threadId) !== String(params.threadId)) return false;
    }

    return true;
  });
}

export async function buildInboundPolicy(params: {
  account: AgentChatResolvedAccount;
  accountId: string;
  message: ChatMessage;
  log?: (level: "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
}): Promise<AgentChatInboundPolicyResult> {
  const { account, accountId, message } = params;
  const rawBody = message.content ?? "";
  const threadId = getThreadId(message);
  const conversationId = buildConversationId(message.channel_id, threadId);
  const isDirect = isDirectChannel(message.channel_id);

  if (!isDirect && !isMentioned(rawBody, account)) {
    return {
      shouldDispatch: false,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    };
  }

  if (isDirect) {
    return {
      shouldDispatch: true,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    };
  }

  const lastMentionTs = getMentionCursor(accountId, conversationId);
  let prefix = "";

  try {
    const history = await fetchChannelHistory({
      wsUrl: account.wsUrl,
      token: account.token,
      channelId: message.channel_id,
      after: lastMentionTs,
    });
    const filtered = filterHistory({ messages: history, currentMessage: message, threadId });
    prefix = buildContextPrefix(filtered);
  } catch (error) {
    params.log?.("warn", "AgentChat history fetch failed; falling back to single-message dispatch", {
      accountId,
      channelId: message.channel_id,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  setMentionCursor(accountId, conversationId, message.timestamp);
  return {
    shouldDispatch: true,
    bodyForAgent: prefix ? `${prefix}${message.sender_id}: ${rawBody}` : rawBody,
    rawBody,
    commandBody: rawBody,
  };
}

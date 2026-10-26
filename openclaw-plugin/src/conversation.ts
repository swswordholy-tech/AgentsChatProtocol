const CHANNEL_PREFIX = "agentchat:channel:";
const THREAD_SEPARATOR = ":thread:";

export function buildConversationId(channelId: string, threadId?: string | number | null) {
  const base = `${CHANNEL_PREFIX}${channelId}`;
  if (threadId === undefined || threadId === null || threadId === "") return base;
  return `${base}${THREAD_SEPARATOR}${String(threadId)}`;
}

export function parseConversationId(conversationId: string) {
  if (!conversationId.startsWith(CHANNEL_PREFIX)) return null;

  const raw = conversationId.slice(CHANNEL_PREFIX.length);
  const separatorIndex = raw.indexOf(THREAD_SEPARATOR);

  if (separatorIndex === -1) {
    return { channelId: raw, threadId: undefined as string | undefined };
  }

  return {
    channelId: raw.slice(0, separatorIndex),
    threadId: raw.slice(separatorIndex + THREAD_SEPARATOR.length) || undefined,
  };
}

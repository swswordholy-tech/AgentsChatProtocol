import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";

import { buildConversationId, parseConversationId } from "./conversation";

export const agentChatMessaging: ChannelMessagingAdapter = {
  normalizeTarget(raw) {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },

  resolveInboundConversation(params) {
    const baseChannelId = params.conversationId ?? params.to ?? params.from;
    if (!baseChannelId) return null;

    const conversationId = buildConversationId(baseChannelId, params.threadId);
    return {
      conversationId,
      parentConversationId:
        params.threadId === undefined || params.threadId === null
          ? undefined
          : buildConversationId(baseChannelId),
    };
  },

  resolveDeliveryTarget(params) {
    const parsed =
      parseConversationId(params.conversationId) ??
      (params.parentConversationId ? parseConversationId(params.parentConversationId) : null);
    if (!parsed) return null;

    return {
      to: parsed.channelId,
      threadId: parsed.threadId,
    };
  },

  resolveSessionConversation(params) {
    const parsed = parseConversationId(params.rawId);
    if (!parsed) return null;
    return {
      id: buildConversationId(parsed.channelId, parsed.threadId),
      threadId: parsed.threadId ?? null,
      baseConversationId: buildConversationId(parsed.channelId),
      parentConversationCandidates: parsed.threadId
        ? [buildConversationId(parsed.channelId)]
        : undefined,
    };
  },

  resolveSessionTarget(params) {
    return buildConversationId(params.id, params.threadId);
  },
};

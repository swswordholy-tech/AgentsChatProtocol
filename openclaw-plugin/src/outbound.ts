import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/core";

import { buildConversationId } from "./conversation";
import { getGatewayState } from "./state";

type AgentChatOutboundContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendText"]>
>[0];

type AgentChatOutboundResult = Awaited<
  ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>
>;

function buildResult(ctx: AgentChatOutboundContext): AgentChatOutboundResult {
  return {
    channel: "agentchat" as never,
    messageId: crypto.randomUUID(),
    channelId: ctx.to,
    conversationId: buildConversationId(ctx.to, ctx.threadId),
    timestamp: Date.now(),
  };
}

export const agentChatOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",

  resolveTarget(params) {
    const to = params.to?.trim();
    if (!to) {
      return { ok: false, error: new Error("AgentChat target is required") };
    }
    return { ok: true, to };
  },

  async sendText(ctx: AgentChatOutboundContext) {
    const accountId = ctx.accountId;
    if (!accountId) {
      throw new Error("AgentChat outbound requires accountId");
    }

    const to = ctx.to?.trim();
    if (!to) throw new Error("AgentChat target is required");

    const state = getGatewayState(accountId);
    if (!state) {
      throw new Error(`AgentChat gateway is not running for account ${accountId}`);
    }

    if (ctx.threadId !== undefined && ctx.threadId !== null && String(ctx.threadId).trim() !== "") {
      state.client.sendMessage(to, ctx.text, ctx.threadId);
    } else {
      state.client.sendMessage(to, ctx.text);
    }
    return buildResult({ ...ctx, to });
  },
};

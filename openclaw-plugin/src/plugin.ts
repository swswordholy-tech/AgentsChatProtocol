import type { ChannelPlugin } from "openclaw/plugin-sdk/core";

import { agentChatConfig, agentChatConfigSchema } from "./config";
import { agentChatGateway } from "./gateway";
import { agentChatMessaging } from "./messaging";
import { agentChatOutbound } from "./outbound";
import { CHANNEL_ID, type AgentChatResolvedAccount } from "./types";

export const agentChatPlugin: ChannelPlugin<AgentChatResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "AgentChat",
    selectionLabel: "AgentChat",
    docsPath: "/plugins/agentchat",
    blurb: "Native AgentChat channel plugin for OpenClaw",
    markdownCapable: true,
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    reply: true,
    threads: true,
  },
  configSchema: agentChatConfigSchema,
  config: agentChatConfig,
  gateway: agentChatGateway,
  messaging: agentChatMessaging,
  outbound: agentChatOutbound,
};

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { agentChatConfigSchema } from "./src/config";
import { agentChatPlugin } from "./src/plugin";
import { CHANNEL_ID } from "./src/types";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "AgentChat Channel",
  description: "Native AgentChat channel plugin for OpenClaw",
  plugin: agentChatPlugin,
  configSchema: agentChatConfigSchema,
});

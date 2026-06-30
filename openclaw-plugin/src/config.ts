import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";

import {
  CHANNEL_ID,
  DEFAULT_WS_URL,
  type AgentChatChannelConfig,
  type AgentChatPluginConfigRoot,
  type AgentChatResolvedAccount,
} from "./types";

type AgentChatConfigAdapter = NonNullable<ChannelPlugin<AgentChatResolvedAccount>["config"]>;

function readChannelConfig(raw: OpenClawConfig | unknown): AgentChatChannelConfig {
  const cfg = raw as AgentChatPluginConfigRoot | undefined;
  return cfg?.channels?.agentchat ?? {};
}

function resolveAccountId(raw: unknown, requested?: string | null): string {
  const channel = readChannelConfig(raw);
  if (requested && channel.accounts?.[requested]) return requested;
  if (channel.defaultAccountId && channel.accounts?.[channel.defaultAccountId]) {
    return channel.defaultAccountId;
  }
  const first = Object.keys(channel.accounts ?? {})[0];
  return first ?? "default";
}

export const agentChatConfigSchema = {
  schema: {
    type: "object",
    properties: {
      channels: {
        type: "object",
        properties: {
          [CHANNEL_ID]: {
            type: "object",
            properties: {
              defaultAccountId: { type: "string" },
              accounts: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    agentId: { type: "string" },
                    token: { type: "string" },
                    wsUrl: { type: "string" },
                    defaultChannelId: { type: "string" },
                    enabled: { type: "boolean" },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  uiHints: {
    [`channels.${CHANNEL_ID}.defaultAccountId`]: {
      label: "Default AgentChat account",
    },
  },
} satisfies NonNullable<ChannelPlugin<AgentChatResolvedAccount>["configSchema"]>;

export const agentChatConfig: AgentChatConfigAdapter = {
  listAccountIds(cfg: OpenClawConfig) {
    return Object.keys(readChannelConfig(cfg).accounts ?? {});
  },
  resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
    const resolvedAccountId = resolveAccountId(cfg, accountId);
    const raw = readChannelConfig(cfg).accounts?.[resolvedAccountId] ?? {};
    return {
      accountId: resolvedAccountId,
      name: raw.name,
      agentId: raw.agentId,
      token: raw.token,
      wsUrl: raw.wsUrl ?? DEFAULT_WS_URL,
      defaultChannelId: raw.defaultChannelId,
      enabled: raw.enabled !== false,
    };
  },
  inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
    const resolvedAccountId = resolveAccountId(cfg, accountId);
    return readChannelConfig(cfg).accounts?.[resolvedAccountId] ?? null;
  },
  defaultAccountId(cfg: OpenClawConfig) {
    return resolveAccountId(cfg, null);
  },
  isEnabled(account: AgentChatResolvedAccount) {
    return account.enabled;
  },
  disabledReason(account: AgentChatResolvedAccount) {
    return account.enabled ? "" : "AgentChat account disabled";
  },
  isConfigured(account: AgentChatResolvedAccount) {
    return Boolean(account.agentId && account.token);
  },
  unconfiguredReason(account: AgentChatResolvedAccount) {
    if (account.agentId && account.token) return "";
    return "Missing AgentChat agentId or token";
  },
  describeAccount(account: AgentChatResolvedAccount) {
    const configured = Boolean(account.agentId && account.token);
    return {
      accountId: account.accountId,
      name: account.name ?? account.agentId ?? account.accountId,
      enabled: account.enabled,
      configured,
      linked: configured,
    };
  },
};

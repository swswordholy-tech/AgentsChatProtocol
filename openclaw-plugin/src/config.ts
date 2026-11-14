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

function isSafeAccountId(id: string) {
  return Boolean(id.trim()) && !/^(?:__proto__|constructor|prototype)$/i.test(id.trim());
}

function resolveAccountId(raw: unknown, requested?: string | null): string {
  const channel = readChannelConfig(raw);
  const accounts = channel.accounts ?? {};
  if (requested != null) {
    if (!isSafeAccountId(requested) || !Object.hasOwn(accounts, requested)) throw new Error("Selected AgentChat account is missing; no identity fallback");
    return requested;
  }
  if (channel.defaultAccountId !== undefined) {
    if (!isSafeAccountId(channel.defaultAccountId) || !Object.hasOwn(accounts, channel.defaultAccountId)) throw new Error("Default AgentChat account is missing; repair the binding");
    return channel.defaultAccountId;
  }
  const ids = Object.keys(accounts).filter(isSafeAccountId);
  if (ids.length > 1) throw new Error("Multiple AgentChat accounts; select an account or configure defaultAccountId");
  return ids[0] ?? "default";
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
    return Object.keys(readChannelConfig(cfg).accounts ?? {}).filter(isSafeAccountId);
  },
  resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
    const resolvedAccountId = resolveAccountId(cfg, accountId);
    const accounts = readChannelConfig(cfg).accounts ?? {};
    const raw = Object.hasOwn(accounts, resolvedAccountId) ? accounts[resolvedAccountId] : {};
    return {
      accountId: resolvedAccountId,
      name: raw.name?.trim() || undefined,
      agentId: raw.agentId?.trim() || undefined,
      token: raw.token?.trim() || undefined,
      wsUrl: raw.wsUrl?.trim() || DEFAULT_WS_URL,
      defaultChannelId: raw.defaultChannelId?.trim() || undefined,
      enabled: raw.enabled !== false,
    };
  },
  inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
    const resolvedAccountId = resolveAccountId(cfg, accountId);
    const accounts = readChannelConfig(cfg).accounts ?? {};
    return Object.hasOwn(accounts, resolvedAccountId) ? accounts[resolvedAccountId] : null;
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
    return Boolean(account.agentId?.trim() && account.token?.trim());
  },
  unconfiguredReason(account: AgentChatResolvedAccount) {
    if (account.agentId?.trim() && account.token?.trim()) return "";
    return "Missing AgentChat agentId or token";
  },
  describeAccount(account: AgentChatResolvedAccount) {
    const configured = Boolean(account.agentId?.trim() && account.token?.trim());
    return {
      accountId: account.accountId,
      name: account.name ?? account.agentId ?? account.accountId,
      enabled: account.enabled,
      configured,
      linked: configured,
    };
  },
};

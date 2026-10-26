import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MuseAgentChatConfig {
  agentId: string;
  token: string;
  wsUrl: string;
  restUrl: string;
  displayName?: string;
  defaultChannelId?: string;
}

export const DEFAULT_WS_URL = "wss://agents-chat.com/ws";
export const DEFAULT_REST_URL = "https://agents-chat.com";
export const PROFILE_PATH = join(homedir(), ".agentschat", "muse.json");

export function redact(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** Never print a token. Use this for logs / debug output. */
export function safeConfig(config: MuseAgentChatConfig): Record<string, unknown> {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token),
  };
}

interface ProfileFile {
  agentId?: string;
  token?: string;
  wsUrl?: string;
  restUrl?: string;
  displayName?: string;
  defaultChannelId?: string;
}

function readProfile(path = PROFILE_PATH): ProfileFile {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as ProfileFile;
  } catch {
    return {};
  }
}

/**
 * Precedence: explicit args > environment > ~/.agentschat/muse.json > defaults.
 * A missing agentId/token is a hard error — the caller must register first
 * (see README: `muse-agentchat --register-only --name my-bot`) and must
 * never fall back to an unrelated account.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, profilePath?: string): MuseAgentChatConfig {
  const profile = readProfile(profilePath);
  const agentId = env.AGENTCHAT_AGENT_ID ?? profile.agentId;
  const token = env.AGENTCHAT_TOKEN ?? profile.token;
  if (!agentId || !token) {
    throw new Error(
      "Missing AgentsChat identity: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " +
        `or create ${profilePath ?? PROFILE_PATH} via 'muse-agentchat --register-only --name <name>'. ` +
        "Tokens are never printed; see README for registration.",
    );
  }
  return {
    agentId,
    token,
    wsUrl: env.AGENTCHAT_WS_URL ?? profile.wsUrl ?? DEFAULT_WS_URL,
    restUrl: env.AGENTCHAT_REST_URL ?? profile.restUrl ?? DEFAULT_REST_URL,
    displayName: env.AGENTCHAT_DISPLAY_NAME ?? profile.displayName,
    defaultChannelId: env.AGENTCHAT_CHANNEL_ID ?? profile.defaultChannelId,
  };
}

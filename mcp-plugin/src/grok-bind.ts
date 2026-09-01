/**
 * Grok outbound identity bind — map CURSOR_CONVERSATION_ID (the Grok agent uuid)
 * to an AgentsChat profile name.
 *
 * Pure: parse the bind map and decide whether it applies. File I/O and
 * `nameToPath` live at the call site (`resolveProfile` in server.ts) so this
 * stays unit-testable.
 *
 * Auto-bind does NOT imply AGENTCHAT_WAKE_MODE. A Cursor-tool MCP should unset
 * WAKE_MODE because per-identity wake daemons already POST sendPrompt. If the
 * operator set WAKE_MODE, leave it — this module never reads or writes it.
 */

import { join } from "node:path";

export const DEFAULT_GROK_BINDS_FILENAME = "grok-binds.json";
export const GROK_BINDS_ENV = "AGENTCHAT_GROK_BINDS";
export const CURSOR_CONVERSATION_ENV = "CURSOR_CONVERSATION_ID";

export type GrokBindDecision =
  /** Explicit identity/token already won, or no conversation id — do not consult. */
  | { kind: "skip" }
  /** Conversation id present but no string profile name for it. */
  | { kind: "miss"; conversationId: string }
  /** Bind hit — caller resolves `<profileName>` the same way `--profile` does. */
  | { kind: "hit"; conversationId: string; profileName: string };

/** uuid → profile name. Non-string (and empty) values are ignored. */
export function parseGrokBinds(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (!name) continue;
    const key = k.trim();
    if (!key) continue;
    out[key] = name;
  }
  return out;
}

export function parseGrokBindsText(text: string): { binds: Record<string, string>; malformed: boolean } {
  try {
    return { binds: parseGrokBinds(JSON.parse(text)), malformed: false };
  } catch {
    return { binds: {}, malformed: true };
  }
}

export function resolveGrokBindsPath(configDir: string, envOverride?: string): string {
  if (envOverride && envOverride.length > 0) return envOverride;
  return join(configDir, DEFAULT_GROK_BINDS_FILENAME);
}

/**
 * Consult the bind map only when nothing more specific already declared identity.
 * Explicit `--profile` / `--name` / `AGENTSCHAT_PROFILE` / `AGENTCHAT_PROFILE`
 * and `--token` / `AGENTCHAT_TOKEN` all win.
 */
export function decideGrokBind(input: {
  explicitIdentity: boolean;
  hasToken: boolean;
  conversationId: string | undefined;
  binds: Record<string, string>;
}): GrokBindDecision {
  if (input.explicitIdentity || input.hasToken) return { kind: "skip" };
  const id = input.conversationId?.trim();
  if (!id) return { kind: "skip" };
  const profileName = input.binds[id];
  if (typeof profileName === "string" && profileName.length > 0) {
    return { kind: "hit", conversationId: id, profileName };
  }
  return { kind: "miss", conversationId: id };
}

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
 *
 * Shared Cursor MCP safety: when a conversation id is bound OR the live profile
 * is already a grok-bound identity (e.g. Cursor stdio started with `--profile Jack`
 * and no CURSOR_CONVERSATION_ID), `switch_profile` must not steal the live
 * identity (gateSwitchProfile). Outbound mutators should heal back to the bound
 * profile if something already switched (shouldHealBoundIdentity).
 */

import { join } from "node:path";

export const DEFAULT_GROK_BINDS_FILENAME = "grok-binds.json";
export const GROK_BINDS_ENV = "AGENTCHAT_GROK_BINDS";
export const CURSOR_CONVERSATION_ENV = "CURSOR_CONVERSATION_ID";

/** Clear error returned when switch_profile would leave a grok-bound identity. */
export const GROK_BIND_SWITCH_LOCKED_MESSAGE =
  "Outbound identity is locked to grok-bind on this shared MCP; use a separate MCP process / wake daemon, do not switch_profile.";

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

/**
 * Bound profile name for this CURSOR_CONVERSATION_ID, or null if unbound /
 * conversation id unset (Claude / Hermes: no lock).
 */
export function boundProfileForConversation(
  conversationId: string | undefined,
  binds: Record<string, string>,
): string | null {
  const id = conversationId?.trim();
  if (!id) return null;
  const name = binds[id];
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Basename without `.json` — compare `activeProfileFile` to a bind name. */
export function profileNameFromPath(profilePath: string | null | undefined): string | null {
  if (!profilePath) return null;
  const base = profilePath.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.json$/i, "");
  return name || null;
}

export type SwitchProfileGate =
  | { kind: "allow" }
  | {
      kind: "locked";
      boundProfileName: string;
      requestedProfileName: string;
      message: string;
    };

/**
 * Gate `switch_profile` when a grok outbound bind owns this MCP identity.
 *
 * - Empty binds → allow (Claude/Hermes with no grok-binds).
 * - Empty / missing requested name (list profiles) → allow.
 * - CURSOR_CONVERSATION_ID maps to a bind: lock unless requested equals that bind.
 * - No conversation id (or unbound): if currentProfileName is one of the bind
 *   values (Cursor stdio started with `--profile Jack`), lock unless requested
 *   equals current — covers shared MCP without CURSOR_CONVERSATION_ID in env.
 * - Otherwise → allow.
 */
export function gateSwitchProfile(input: {
  conversationId: string | undefined;
  binds: Record<string, string>;
  requestedProfileName: string | undefined | null;
  /** Basename of activeProfileFile — used when conversation id is unset. */
  currentProfileName?: string | null;
}): SwitchProfileGate {
  const req =
    typeof input.requestedProfileName === "string" ? input.requestedProfileName.trim() : "";
  if (!req) return { kind: "allow" };

  const bindValues = Object.values(input.binds).filter((v) => typeof v === "string" && v.length > 0);
  if (bindValues.length === 0) return { kind: "allow" };

  const lockedMessage = (lockedName: string) =>
    `Outbound identity is locked to grok-bind profile "${lockedName}" on this shared MCP; ` +
    `use a separate MCP process / wake daemon, do not switch_profile.`;

  const bound = boundProfileForConversation(input.conversationId, input.binds);
  if (bound) {
    if (req === bound) return { kind: "allow" };
    return {
      kind: "locked",
      boundProfileName: bound,
      requestedProfileName: req,
      message: lockedMessage(bound),
    };
  }

  const current =
    typeof input.currentProfileName === "string" ? input.currentProfileName.trim() : "";
  if (current && bindValues.includes(current)) {
    if (req === current) return { kind: "allow" };
    return {
      kind: "locked",
      boundProfileName: current,
      requestedProfileName: req,
      message: lockedMessage(current),
    };
  }

  return { kind: "allow" };
}

/**
 * Whether live identity drifted from the bound profile and needs a force-reload
 * before outbound writes (reply / other mutators that post as AGENT_ID).
 */
export function shouldHealBoundIdentity(input: {
  boundProfileName: string | null;
  liveProfileName: string | null | undefined;
  liveAgentId: string | null | undefined;
  boundAgentId: string | null | undefined;
}): boolean {
  if (!input.boundProfileName) return false;
  if (input.liveProfileName !== input.boundProfileName) return true;
  if (
    typeof input.boundAgentId === "string" &&
    input.boundAgentId.length > 0 &&
    input.liveAgentId !== input.boundAgentId
  ) {
    return true;
  }
  return false;
}

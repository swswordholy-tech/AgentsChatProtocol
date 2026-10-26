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
 *
 * Non-Grok processes (Antigravity / ZCode / other URL wakes, or an explicit
 * `--profile` different from the bound one) can inherit a Grok agent's
 * CURSOR_CONVERSATION_ID; grokBindApplies() makes the bind a no-op for them.
 *
 * Each Grok bot registers ITSELF (grok-bind-register.sh <profile>); nobody else
 * writes grok-binds.json and there is no hard-coded bot list.
 */

import { join } from "node:path";

export const DEFAULT_GROK_BINDS_FILENAME = "grok-binds.json";
/** Sidecar written by grok-bind-register.sh ({profile, registered_by, ts} per uuid). Not a profile. */
export const GROK_BINDS_META_FILENAME = "grok-binds.meta.json";
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

/** Env keys that tag a non-Grok wake stack (Antigravity / ZCode / URL wakes). */
export const ANTIGRAVITY_WAKE_ENV = "AGENTCHAT_ANTIGRAVITY_WAKE";
export const WAKE_KIND_ENV = "AGENTCHAT_WAKE_KIND";
export const WAKE_MODE_ENV = "AGENTCHAT_WAKE_MODE";

/**
 * Non-null reason when this process is tagged as some OTHER wake stack, i.e.
 * not a Grok wake / Grok Cursor MCP. Such processes may still inherit a Grok
 * agent's CURSOR_CONVERSATION_ID from whatever shell launched them, so the
 * grok bind must not be applied to them (neither identity nor switch lock).
 *
 * - AGENTCHAT_ANTIGRAVITY_WAKE set (any non-empty value) → antigravity
 * - AGENTCHAT_WAKE_KIND set to something other than "grok" → that kind
 * - AGENTCHAT_WAKE_MODE set to something other than "grok" → that mode
 */
export function nonGrokWakeReason(env: Record<string, string | undefined>): string | null {
  const anti = (env[ANTIGRAVITY_WAKE_ENV] ?? "").trim();
  if (anti) return `${ANTIGRAVITY_WAKE_ENV}=${anti}`;
  const kind = (env[WAKE_KIND_ENV] ?? "").trim();
  if (kind && kind.toLowerCase() !== "grok") return `${WAKE_KIND_ENV}=${kind}`;
  const mode = (env[WAKE_MODE_ENV] ?? "").trim();
  if (mode && mode.toLowerCase() !== "grok") return `${WAKE_MODE_ENV}=${mode}`;
  return null;
}

export type GrokBindApplicability = { applies: true } | { applies: false; reason: string };

/**
 * Whether the grok bind (identity lock + switch_profile gate + heal) applies to
 * this process at all.
 *
 * Skipped when:
 * - the process is tagged as a non-Grok wake (see nonGrokWakeReason), or
 * - it was started with an explicit profile (`--profile` / `--name` /
 *   AGENTSCHAT_PROFILE) that differs from the profile bound to its
 *   CURSOR_CONVERSATION_ID — that operator declared a different bot; an
 *   inherited conversation id must not lock it to somebody else.
 *
 * An explicit profile EQUAL to the bound one (Cursor outbound via
 * select-profile-mcp.sh) still applies.
 */
export function grokBindApplies(input: {
  env: Record<string, string | undefined>;
  explicitProfileName?: string | null;
  conversationId?: string | undefined;
  binds: Record<string, string>;
}): GrokBindApplicability {
  const reason = nonGrokWakeReason(input.env);
  if (reason) return { applies: false, reason: `non-grok wake (${reason})` };
  const explicit =
    typeof input.explicitProfileName === "string" ? profileNameFromPath(input.explicitProfileName.trim()) : null;
  if (explicit) {
    const bound = boundProfileForConversation(input.conversationId, input.binds);
    const norm = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (bound && norm(bound) !== norm(explicit)) {
      return {
        applies: false,
        reason: `explicit profile "${explicit}" differs from grok-bind profile "${bound}"`,
      };
    }
  }
  return { applies: true };
}

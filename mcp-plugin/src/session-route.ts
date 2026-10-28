/**
 * Wake routing for a single-process / single-identity bridge.
 *
 * A wake can only land in a harness Session, but the bridge knows AgentsChat
 * identities, not Session ids. `session-binds.json` is the join: it maps
 * `sessionId -> profileName`, and each profile file carries that identity's
 * `agent_id`. Inverting the pair answers "which Session owns the agent that just
 * received this DM?", so the wake payload can carry an explicit target instead of
 * the receiver guessing "the newest idle Session" — a guess that is wrong whenever
 * an older Session happens to be idle.
 *
 * Deliberately conservative: every missing or malformed piece resolves to
 * `undefined`, which leaves the receiver on its existing fallback. Routing must
 * never turn a delivery problem into a lost message.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSessionBinds } from "./session-bind.ts";

export interface AgentSessionRoute {
  /** Harness session the wake should be delivered to. */
  sessionId: string;
  /** AgentsChat profile bound to that session. */
  profileName: string;
  /** Identity the profile file declares. */
  agentId: string;
}

/** Same config root the MCP server uses for profiles and `session-binds.json`. */
export function agentschatConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTSCHAT_CONFIG_DIR ?? join(homedir(), ".agentschat");
}

/**
 * Resolve a bind entry's profile name to its file.
 *
 * Mirrors the server's nested-first convention (`<configDir>/profiles/<name>.json`)
 * and the flat legacy layout. Only plain profile names resolve — a name that
 * contains a path separator is skipped rather than guessed, because a wrong path
 * would silently route a wake into the wrong identity.
 */
function profilePathForName(configDir: string, name: string): string | undefined {
  if (!name || name.includes("/") || name.includes("\\")) return undefined;
  const base = name.replace(/\.json$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const nested = join(configDir, "profiles", `${base}.json`);
  if (existsSync(nested)) return nested;
  const flat = join(configDir, `${base}.json`);
  return existsSync(flat) ? flat : undefined;
}

function readAgentId(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { agent_id?: unknown };
    return typeof parsed.agent_id === "string" && parsed.agent_id ? parsed.agent_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session currently bound to `agentId`, or `undefined` when unknown.
 *
 * The last matching bind wins: binds are appended as sessions are bound, and
 * re-binding an existing session keeps its position, so the final match is the
 * most recently established route for this identity.
 */
export function resolveSessionForAgent(
  agentId: string | null | undefined,
  opts: { configDir?: string; env?: Record<string, string | undefined> } = {},
): AgentSessionRoute | undefined {
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  const configDir = opts.configDir ?? agentschatConfigDir(opts.env);
  let binds: Record<string, string>;
  try {
    binds = loadSessionBinds(configDir);
  } catch {
    return undefined;
  }
  for (const [sessionId, profileName] of Object.entries(binds).reverse()) {
    const path = profilePathForName(configDir, profileName);
    if (path === undefined) continue;
    if (readAgentId(path) !== agentId) continue;
    return { sessionId, profileName, agentId };
  }
  return undefined;
}

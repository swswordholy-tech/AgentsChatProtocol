/**
 * Unified session binding & single-active-instance lock across harnesses
 * (Claude Code, Antigravity / agy, ZCode, Codex foreground & app-server bridge).
 *
 * 1. Session binding (`~/.agentschat/session-binds.json`):
 *    Maps a harness session/conversation ID (`CLAUDE_CODE_SESSION_ID`,
 *    `ANTIGRAVITY_CONVERSATION_ID`, `ZCODE_SESSION_ID`, or MCP `_meta.session_id`)
 *    to an AgentsChat profile name so each window remembers its bound identity
 *    across restarts without hardcoding `--profile` in global MCP config.
 *
 * 2. Single-active-instance lock (`<lockDir>/<agent_id>.lock`):
 *    Ensures at most ONE live process (foreground window or background bridge)
 *    uses a given `agent_id` at the same time. Checks `process.kill(pid, 0)` so
 *    crashed/closed processes automatically release their lock (never deadlocks).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { safeWriteProfile } from "./profile-store.ts";

export const DEFAULT_SESSION_BINDS_FILENAME = "session-binds.json";
export const LEGACY_AGY_BINDS_FILENAME = "agy-binds.json";

export type HarnessRuntime = "claude-code" | "antigravity" | "zcode" | "codex-bridge" | "custom" | "mcp";

export interface DetectedSession {
  sessionId: string;
  runtime: HarnessRuntime;
  workspacePath?: string;
}

export interface AgentLockRecord {
  pid: number;
  agentId: string;
  profileName?: string | null;
  sessionId?: string | null;
  runtime?: HarnessRuntime | string;
  updatedAt: string;
}

export interface AgentLockCheck {
  locked: boolean;
  holder?: AgentLockRecord;
  stale?: boolean;
}

/** Check whether a local OS process is still alive. Never throws. */
export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e && typeof e === "object" && e.code === "EPERM") return true;
    return false;
  }
}

/** Deterministic per-HOME lock directory in tmpdir (cleared on OS reboot, isolated in tests). */
export function resolveLockDir(homeDir: string, env: Record<string, string | undefined> = process.env): string {
  const explicit = env.AGENTSCHAT_LOCK_DIR?.trim();
  if (explicit) return explicit;
  const hash = createHash("sha256").update(homeDir || ".").digest("hex").slice(0, 12);
  const baseTmp = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(baseTmp, `agentschat-locks-${hash}`);
}

export function lockFilePath(lockDir: string, agentId: string): string {
  const safe = String(agentId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(lockDir, `${safe}.lock`);
}

export function readAgentLock(lockDir: string, agentId: string): AgentLockRecord | null {
  if (!agentId) return null;
  const file = lockFilePath(lockDir, agentId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.pid !== "number" || typeof raw.agentId !== "string") {
      return null;
    }
    return raw as AgentLockRecord;
  } catch {
    return null;
  }
}

/**
 * Check if `agentId` is currently locked by ANOTHER live process.
 * Returns `{ locked: false }` if unlocked, if the lock holder PID exited,
 * if held by `currentPid`, if held by `lockOwnerPid` (parent bridge/wake turn),
 * or if held by the same `currentSessionId`.
 */
export function checkAgentLock(opts: {
  lockDir: string;
  agentId: string;
  currentPid?: number;
  currentSessionId?: string | null;
  lockOwnerPid?: number | null;
}): AgentLockCheck {
  const { lockDir, agentId } = opts;
  const currentPid = opts.currentPid ?? process.pid;
  if (!agentId) return { locked: false };
  const record = readAgentLock(lockDir, agentId);
  if (!record) return { locked: false };
  if (!isPidAlive(record.pid)) {
    try { unlinkSync(lockFilePath(lockDir, agentId)); } catch {}
    return { locked: false, stale: true };
  }
  if (record.pid === currentPid) return { locked: false, holder: record };
  if (opts.lockOwnerPid && record.pid === opts.lockOwnerPid) return { locked: false, holder: record };
  if (opts.currentSessionId && record.sessionId && opts.currentSessionId === record.sessionId) {
    return { locked: false, holder: record };
  }
  return { locked: true, holder: record };
}

/** Write/update the lock for `agentId` owned by `currentPid`. */
export function acquireAgentLock(opts: {
  lockDir: string;
  agentId: string;
  profileName?: string | null;
  sessionId?: string | null;
  runtime?: HarnessRuntime | string;
  currentPid?: number;
}): AgentLockRecord | null {
  if (!opts.agentId) return null;
  const record: AgentLockRecord = {
    pid: opts.currentPid ?? process.pid,
    agentId: opts.agentId,
    profileName: opts.profileName ?? null,
    sessionId: opts.sessionId ?? null,
    runtime: opts.runtime ?? "mcp",
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(opts.lockDir, { recursive: true, mode: 0o700 });
    safeWriteProfile(lockFilePath(opts.lockDir, opts.agentId), record);
    return record;
  } catch {
    return null;
  }
}

/** Release `<agentId>.lock` only if owned by `currentPid` (or `currentSessionId`). */
export function releaseAgentLock(opts: {
  lockDir: string;
  agentId: string;
  currentPid?: number;
  currentSessionId?: string | null;
}): boolean {
  if (!opts.agentId) return false;
  const currentPid = opts.currentPid ?? process.pid;
  const existing = readAgentLock(opts.lockDir, opts.agentId);
  if (!existing) return false;
  const samePid = existing.pid === currentPid;
  const sameSession = Boolean(opts.currentSessionId && existing.sessionId && opts.currentSessionId === existing.sessionId);
  const dead = !isPidAlive(existing.pid);
  if (!samePid && !sameSession && !dead) return false;
  try {
    unlinkSync(lockFilePath(opts.lockDir, opts.agentId));
    return true;
  } catch {
    return false;
  }
}

/** Parse a `session-binds.json` (or `agy-binds.json`) payload into `sessionId -> profileName`. */
export function parseSessionBinds(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v === "string" && v.trim()) {
      out[key] = v.trim();
    } else if (v && typeof v === "object" && typeof (v as any).profile === "string" && (v as any).profile.trim()) {
      out[key] = (v as any).profile.trim();
    }
  }
  return out;
}

export function loadSessionBinds(configDir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const filename of [LEGACY_AGY_BINDS_FILENAME, DEFAULT_SESSION_BINDS_FILENAME]) {
    const path = join(configDir, filename);
    if (!existsSync(path)) continue;
    try {
      Object.assign(merged, parseSessionBinds(JSON.parse(readFileSync(path, "utf8"))));
    } catch {}
  }
  return merged;
}

export function saveSessionBind(configDir: string, sessionId: string, profileName: string): void {
  const sid = sessionId.trim();
  const prof = profileName.trim();
  if (!sid || !prof) return;
  const path = join(configDir, DEFAULT_SESSION_BINDS_FILENAME);
  let current: Record<string, string> = {};
  if (existsSync(path)) {
    try { current = parseSessionBinds(JSON.parse(readFileSync(path, "utf8"))); } catch {}
  }
  // Enforce 1:1 profileName <-> sessionId mapping so re-binding a profile to a
  // conversation replaces any stale conversation bound to the same profile.
  for (const [existingSid, existingProf] of Object.entries(current)) {
    if (existingProf === prof && existingSid !== sid) {
      delete current[existingSid];
    }
  }
  delete current[sid];
  current[sid] = prof;
  mkdirSync(configDir, { recursive: true });
  safeWriteProfile(path, current);

  const legacyPath = join(configDir, LEGACY_AGY_BINDS_FILENAME);
  if (existsSync(legacyPath)) {
    try {
      const legacy = parseSessionBinds(JSON.parse(readFileSync(legacyPath, "utf8")));
      let changed = false;
      for (const [existingSid, existingProf] of Object.entries(legacy)) {
        if (existingProf === prof && existingSid !== sid) {
          delete legacy[existingSid];
          changed = true;
        }
      }
      if (changed) safeWriteProfile(legacyPath, legacy);
    } catch {}
  }
}

export function removeSessionBind(configDir: string, sessionId: string): boolean {
  const sid = sessionId.trim();
  if (!sid) return false;
  let removed = false;
  for (const filename of [DEFAULT_SESSION_BINDS_FILENAME, LEGACY_AGY_BINDS_FILENAME]) {
    const path = join(configDir, filename);
    if (!existsSync(path)) continue;
    try {
      const current = parseSessionBinds(JSON.parse(readFileSync(path, "utf8")));
      if (sid in current) {
        delete current[sid];
        safeWriteProfile(path, current);
        removed = true;
      }
    } catch {}
  }
  return removed;
}

/** Find the sessionId bound to a given `profileName` (e.g. for Antigravity/ZCode inbound routing). */
export function findBoundSessionForProfile(
  configDir: string,
  profileName: string | null | undefined,
  filter?: (sessionId: string) => boolean,
): string | null {
  if (!profileName) return null;
  const target = profileName.trim();
  if (!target) return null;
  const binds = loadSessionBinds(configDir);
  const matches: string[] = [];
  for (const [sid, prof] of Object.entries(binds)) {
    if (prof === target && (!filter || filter(sid))) matches.push(sid);
  }
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

/** Detect session ID from environment variables or MCP request `_meta` (ZCode). */
export function detectRuntimeSession(
  env: Record<string, string | undefined> = process.env,
  meta?: Record<string, any> | null,
): DetectedSession | null {
  // 1. ZCode MCP request `_meta` (injected on every tools/call by ZCode's NodeMcpAdapter)
  const zcodeCtx = meta?.["com.zcode/request-context"];
  const metaSessionId =
    (typeof meta?.session_id === "string" && meta.session_id.trim()) ||
    (typeof zcodeCtx?.session_id === "string" && zcodeCtx.session_id.trim()) ||
    "";
  if (metaSessionId) {
    const workspacePath =
      (typeof meta?.workspace_path === "string" && meta.workspace_path.trim()) ||
      (typeof zcodeCtx?.workspace_path === "string" && zcodeCtx.workspace_path.trim()) ||
      undefined;
    return { sessionId: metaSessionId, runtime: "zcode", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 2. ZCode environment variable
  const zcodeEnvSid = env.ZCODE_SESSION_ID?.trim();
  if (zcodeEnvSid) {
    const workspacePath = env.ZCODE_PROJECT_DIR?.trim() || undefined;
    return { sessionId: zcodeEnvSid, runtime: "zcode", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 3. Antigravity explicit environment variable
  const agySid = env.ANTIGRAVITY_CONVERSATION_ID?.trim();
  if (agySid) {
    return { sessionId: agySid, runtime: "antigravity" };
  }

  // 4. Claude Code environment variable
  const claudeSid = (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "").trim();
  if (claudeSid) {
    const workspacePath = env.CLAUDE_PROJECT_DIR?.trim() || undefined;
    return { sessionId: claudeSid, runtime: "claude-code", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 5. Explicit generic session ID override
  const explicitSid = (env.AGENTSCHAT_SESSION_ID || env.AGENTCHAT_SESSION_ID || "").trim();
  if (explicitSid) {
    return { sessionId: explicitSid, runtime: "custom" };
  }

  // 6. Antigravity parent language_server discovery (macOS & Linux)
  if (
    env === process.env ||
    env.__CFBundleIdentifier === "com.google.antigravity" ||
    Boolean(env.AGY_BROWSER_WS_URL)
  ) {
    const agyHost = discoverAntigravityHost();
    if (agyHost && agyHost.openConversations.length === 1) {
      return { sessionId: agyHost.openConversations[0]!, runtime: "antigravity" };
    }
  }

  return null;
}

export interface AntigravityHostInfo {
  lsPid: number;
  csrfToken: string;
  ports: number[];
  openConversations: string[];
}

let cachedAgyHost: { at: number; info: AntigravityHostInfo | null } | null = null;

/**
 * Inspect ancestor processes (or local user processes) to see if this MCP server
 * was spawned by Antigravity's `language_server`. Extracts `--csrf_token`,
 * listening loopback ports, and open `presence/<conversation_id>.lock` files.
 */
export function discoverAntigravityHost(opts?: {
  currentPid?: number;
  cacheMs?: number;
}): AntigravityHostInfo | null {
  const now = Date.now();
  const cacheMs = opts?.cacheMs ?? 5_000;
  if (cachedAgyHost && now - cachedAgyHost.at < cacheMs) return cachedAgyHost.info;

  try {
    // Walk at most 2 hops up from currentPid (direct parent or wrapper script's parent)
    // using fast per-PID `ps -p` queries so we never scan the whole system process table
    // or match an indirect test runner several hops below language_server.
    let pid = opts?.currentPid ?? process.pid;
    let lsPid = 0;
    let lsCmd = "";
    for (let hop = 0; hop < 4 && pid > 1; hop++) {
      const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], { encoding: "utf8", timeout: 1000 });
      if (ps.status !== 0 || !ps.stdout) break;
      const line = ps.stdout.trim().split(/\r?\n/)[0]?.trim() || "";
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      const ppid = Number(m[1]);
      const cmd = m[2]!;
      if (hop > 0 && (cmd.includes("bun test") || cmd.includes("node --test"))) break;
      if (cmd.includes("language_server") && cmd.includes("--csrf_token")) {
        lsPid = pid;
        lsCmd = cmd;
        break;
      }
      pid = ppid;
    }

    if (!lsPid) {
      cachedAgyHost = { at: now, info: null };
      return null;
    }

    const csrfMatch = lsCmd.match(/--csrf_token[=\s]+([^\s]+)/);
    const csrfToken = csrfMatch?.[1]?.trim() || "";
    if (!csrfToken) {
      cachedAgyHost = { at: now, info: null };
      return null;
    }

    const lsof = spawnSync("lsof", ["-Pan", "-p", String(lsPid)], { encoding: "utf8", timeout: 1500 });
    const ports: number[] = [];
    const openConversations: string[] = [];
    if (lsof.status === 0 && lsof.stdout) {
      for (const line of lsof.stdout.split(/\r?\n/)) {
        const portMatch = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
        if (portMatch) {
          const p = Number(portMatch[1]);
          if (p > 0 && !ports.includes(p)) ports.push(p);
        }
        const presMatch =
          line.match(/\/presence\/([0-9a-fA-F-]{36})\.lock$/) ||
          line.match(/\/conversations\/([0-9a-fA-F-]{36})\.db$/);
        if (presMatch) {
          const cid = presMatch[1]!;
          if (!openConversations.includes(cid)) openConversations.push(cid);
        }
      }
    }
    // Antigravity allocates https_server_port first and http_server_port second;
    // sort descending so the plaintext HTTP Connect-RPC port is tried first.
    ports.sort((a, b) => b - a);

    const info: AntigravityHostInfo = { lsPid, csrfToken, ports, openConversations };
    cachedAgyHost = { at: now, info };
    return info;
  } catch {
    cachedAgyHost = { at: now, info: null };
    return null;
  }
}

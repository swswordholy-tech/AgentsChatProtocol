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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { safeWriteProfile } from "./profile-store.ts";

export const DEFAULT_SESSION_BINDS_FILENAME = "session-binds.json";
export const LEGACY_AGY_BINDS_FILENAME = "agy-binds.json";

export type HarnessRuntime = "claude-code" | "antigravity" | "zcode" | "dsh" | "codex-bridge" | "custom" | "mcp";

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
  if (record.pid === currentPid) {
    if (opts.currentSessionId && record.sessionId && opts.currentSessionId !== record.sessionId) {
      return { locked: true, holder: record };
    }
    return { locked: false, holder: record };
  }
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

function resolveAgentIdForProfileName(configDir: string, name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\")) return null;
  const base = name.replace(/\.json$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  for (const candidate of [join(configDir, "profiles", `${base}.json`), join(configDir, `${base}.json`)]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { agent_id?: unknown };
      if (typeof parsed?.agent_id === "string" && parsed.agent_id.trim()) {
        return parsed.agent_id.trim();
      }
    } catch {}
  }
  return null;
}

export function saveSessionBind(configDir: string, sessionId: string, profileName: string): void {
  const sid = sessionId.trim();
  const prof = profileName.trim();
  if (!sid || !prof) return;
  const targetAgentId = resolveAgentIdForProfileName(configDir, prof);
  const isSameProfileOrAgent = (existingProf: string): boolean => {
    if (existingProf === prof) return true;
    if (!targetAgentId) return false;
    return resolveAgentIdForProfileName(configDir, existingProf) === targetAgentId;
  };
  const path = join(configDir, DEFAULT_SESSION_BINDS_FILENAME);
  let current: Record<string, string> = {};
  if (existsSync(path)) {
    try { current = parseSessionBinds(JSON.parse(readFileSync(path, "utf8"))); } catch {}
  }
  // Enforce 1:1 (profileName & agent_id) <-> sessionId mapping so re-binding a
  // profile (or an alias file such as `profile.json` + `<Name>.json` sharing one
  // `agent_id`) replaces any stale conversation bound to the same identity.
  for (const [existingSid, existingProf] of Object.entries(current)) {
    if (existingSid !== sid && isSameProfileOrAgent(existingProf)) {
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
        if (existingSid !== sid && isSameProfileOrAgent(existingProf)) {
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

  // 6. Antigravity parent language_server discovery (macOS & Linux).
  // Skip expensive ps/lsof parent-tree probing when running against a loopback mock
  // hub in tests with a stripped env (unless explicit Antigravity env vars are set).
  const hasExplicitAgyEnv =
    env.__CFBundleIdentifier === "com.google.antigravity" ||
    Boolean(env.AGY_BROWSER_WS_URL) ||
    Boolean(env.ANTIGRAVITY_LS_ADDRESS) ||
    Boolean(env.ANTIGRAVITY_CSRF_TOKEN);
  const isMockHubSubprocess =
    !hasExplicitAgyEnv &&
    typeof env.AGENTCHAT_REST_URL === "string" &&
    /^http:\/\/127\.0\.0\.1:\d+/.test(env.AGENTCHAT_REST_URL);
  if (!isMockHubSubprocess && (env === process.env || hasExplicitAgyEnv)) {
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
/**
 * Parse `lsof -Pan -p <language_server_pid>` output into listening loopback ports
 * and currently open Antigravity IDE conversation UUIDs.
 *
 * Important distinctions verified on live Antigravity `language_server` processes:
 * 1. `language_server` keeps all historical `~/.gemini/antigravity-cli/conversations/*.db`
 *    files open read-only (`61r..137r`); those archived CLI DBs are NOT open IDE windows.
 * 2. Active IDE windows hold an open FD on `/<appDataDir>/presence/<uuid>.lock`, whereas
 *    closed tabs immediately release their presence lock while SQLite may keep their
 *    `/<appDataDir>/conversations/<uuid>.db` cached in its pool. Prefer active presence
 *    locks whenever present, falling back to non-CLI `.db` handles only when no presence
 *    locks exist.
 */
export function parseAntigravityLsofOutput(
  stdout: string,
  appDataDir = "antigravity",
): { ports: number[]; openConversations: string[] } {
  const ports: number[] = [];
  const presenceConversations: string[] = [];
  const dbConversations: string[] = [];
  const cleanAppDir = (appDataDir || "antigravity").trim().replace(/^\/+|\/+$/g, "");
  const isCliTarget = cleanAppDir === "antigravity-cli";

  for (const line of (stdout || "").split(/\r?\n/)) {
    const portMatch = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
    if (portMatch) {
      const p = Number(portMatch[1]);
      if (p > 0 && !ports.includes(p)) ports.push(p);
    }
    if (!isCliTarget && line.includes("/antigravity-cli/")) continue;

    const presMatch = line.match(/\/presence\/([0-9a-fA-F-]{36})\.lock$/);
    if (presMatch) {
      const cid = presMatch[1]!;
      if (!presenceConversations.includes(cid)) presenceConversations.push(cid);
      continue;
    }

    const dbMatch = line.match(/\/conversations\/([0-9a-fA-F-]{36})\.db$/);
    if (dbMatch) {
      if (cleanAppDir && line.includes("/.gemini/") && !line.includes(`/${cleanAppDir}/conversations/`)) {
        continue;
      }
      const cid = dbMatch[1]!;
      if (!dbConversations.includes(cid)) dbConversations.push(cid);
    }
  }

  // Antigravity allocates https_server_port first and http_server_port second;
  // sort descending so the plaintext HTTP Connect-RPC port is tried first.
  ports.sort((a, b) => b - a);
  const openConversations =
    presenceConversations.length > 0 ? presenceConversations : dbConversations;
  return { ports, openConversations };
}

function extractCliFlagValue(cmd: string, flag: string): string {
  const re = new RegExp(`${flag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`);
  const m = cmd.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/**
 * Parse Windows `netstat -ano` output into listening loopback (`127.0.0.1` / `[::1]`)
 * TCP ports owned by `targetPid`, sorted descending so plaintext HTTP Connect-RPC
 * ports allocated after HTTPS are tried first.
 *
 * Matches foreign address `0.0.0.0:0` / `[::]:0` / `*:*` rather than English
 * `"LISTENING"` text so localized Windows builds (German, French, Spanish, Chinese, etc.)
 * work identically.
 */
export function parseWindowsNetstatOutput(stdout: string, targetPid: number): number[] {
  if (!stdout || !Number.isFinite(targetPid) || targetPid <= 0) return [];
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(
      /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0|\*:\*)\s+\S+\s+(\d+)\s*$/i,
    );
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (pid === targetPid && port > 0 && !ports.includes(port)) {
      ports.push(port);
    }
  }
  ports.sort((a, b) => b - a);
  return ports;
}

/**
 * Pure parser for the JSON emitted by `discoverWindowsAntigravityHost`'s PowerShell probe
 * (`{ lsPid, lsCmd, ports, lockedPresence, lockedDbs }`), with optional `netstat -ano`
 * fallback output when `Get-NetTCPConnection` is unavailable.
 */
export function parseWindowsAntigravityProbeJson(
  stdout: string,
  netstatStdout = "",
): AntigravityHostInfo | null {
  const trimmed = (stdout || "").trim();
  if (!trimmed || trimmed === "{}") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const lsPid = Number(parsed?.lsPid);
  const lsCmd = typeof parsed?.lsCmd === "string" ? parsed.lsCmd : "";
  if (!Number.isFinite(lsPid) || lsPid <= 0 || !lsCmd) return null;

  const csrfToken = extractCliFlagValue(lsCmd, "--csrf_token");
  if (!csrfToken) return null;

  const portSet = new Set<number>();
  const rawPorts = Array.isArray(parsed?.ports)
    ? parsed.ports
    : typeof parsed?.ports === "number"
      ? [parsed.ports]
      : [];
  for (const p of rawPorts) {
    const num = Number(p);
    if (Number.isFinite(num) && num > 0) portSet.add(num);
  }
  if (portSet.size === 0 && netstatStdout) {
    for (const p of parseWindowsNetstatOutput(netstatStdout, lsPid)) {
      portSet.add(p);
    }
  }
  const ports = [...portSet].sort((a, b) => b - a);

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const toUuidList = (val: unknown): string[] => {
    const arr = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
    const out: string[] = [];
    for (const item of arr) {
      const s = String(item || "").trim();
      if (uuidRe.test(s) && !out.includes(s)) out.push(s);
    }
    return out;
  };
  const lockedPresence = toUuidList(parsed?.lockedPresence);
  const lockedDbs = toUuidList(parsed?.lockedDbs);
  const openConversations = lockedPresence.length > 0 ? lockedPresence : lockedDbs;

  return { lsPid, csrfToken, ports, openConversations };
}

function runWindowsPowerShell(script: string, timeoutMs = 4000): string | null {
  for (const bin of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    const res = spawnSync(
      bin,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
    );
    if (!res.error && res.status === 0 && typeof res.stdout === "string") {
      return res.stdout;
    }
    if (!res.error) break;
  }
  return null;
}

function discoverWindowsAntigravityHost(currentPid: number): AntigravityHostInfo | null {
  // Walk up to 8 ancestor hops on Windows because npm/cmd shims (`language_server.exe` ->
  // `cmd.exe` -> `node npx` -> `cmd.exe` -> `node server.js`) add extra intermediate hops.
  // Active IDE windows hold an open OS file handle on `~/.gemini/<appDataDir>/presence/<uuid>.lock`
  // while historical closed tabs leave unlocked `.lock` files on disk; probing with
  // `[System.IO.File]::Open(..., FileShare.None)` triggers a kernel `SharingViolation`
  // (`IOException`) if and only if another process currently holds an open handle, requiring
  // zero administrator privileges and never mutating file contents or mtime.
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = ${Math.trunc(currentPid)}`,
    "$lsPid = 0",
    "$lsCmd = ''",
    "for ($h = 0; $h -lt 8 -and $p -gt 0; $h++) {",
    "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$p\"",
    "  if (-not $proc) { break }",
    "  $cmd = [string]$proc.CommandLine",
    "  $name = [string]$proc.Name",
    "  if ($h -gt 0 -and ($cmd -match 'bun(?:\\.exe)?\\s+test' -or $cmd -match 'node(?:\\.exe)?\\s+--test')) { break }",
    "  if (($cmd -match 'language_server' -or $name -match 'language_server') -and $cmd -match '--csrf_token') {",
    "    $lsPid = [int]$proc.ProcessId",
    "    $lsCmd = $cmd",
    "    break",
    "  }",
    "  $nextP = [int]$proc.ParentProcessId",
    "  if ($nextP -le 0 -or $nextP -eq $p) { break }",
    "  $p = $nextP",
    "}",
    "if ($lsPid -le 0) { Write-Output '{}'; exit 0 }",
    "$ports = @()",
    "if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {",
    "  $ports = @(Get-NetTCPConnection -OwningProcess $lsPid -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } | ForEach-Object { [int]$_.LocalPort } | Select-Object -Unique)",
    "}",
    "$appDir = 'antigravity'",
    "if ($lsCmd -match '--app_data_dir(?:=|\\s+)(?:\"([^\"]+)\"|''([^'']+)''|([^\\s\"'']+))') {",
    "  $appDir = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }",
    "}",
    "$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }",
    "$baseDir = Join-Path (Join-Path $homeDir '.gemini') $appDir",
    "$lockedPresence = @()",
    "$presDir = Join-Path $baseDir 'presence'",
    "if (Test-Path -LiteralPath $presDir) {",
    "  Get-ChildItem -LiteralPath $presDir -Filter '*.lock' -File | ForEach-Object {",
    "    if ($_.BaseName -match '^[0-9a-fA-F-]{36}$') {",
    "      try {",
    "        $s = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "        $s.Dispose()",
    "      } catch [System.IO.IOException] {",
    "        $lockedPresence += $_.BaseName",
    "      } catch {}",
    "    }",
    "  }",
    "}",
    "$lockedDbs = @()",
    "if ($lockedPresence.Count -eq 0 -and $appDir -ne 'antigravity-cli') {",
    "  $convDir = Join-Path $baseDir 'conversations'",
    "  if (Test-Path -LiteralPath $convDir) {",
    "    Get-ChildItem -LiteralPath $convDir -Filter '*.db' -File | ForEach-Object {",
    "      if ($_.BaseName -match '^[0-9a-fA-F-]{36}$') {",
    "        try {",
    "          $s = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "          $s.Dispose()",
    "        } catch [System.IO.IOException] {",
    "          $lockedDbs += $_.BaseName",
    "        } catch {}",
    "      }",
    "    }",
    "  }",
    "}",
    "[pscustomobject]@{ lsPid = $lsPid; lsCmd = $lsCmd; ports = $ports; lockedPresence = $lockedPresence; lockedDbs = $lockedDbs } | ConvertTo-Json -Compress",
  ].join("; ");

  const stdout = runWindowsPowerShell(psScript, 4000);
  if (!stdout) return null;

  let info = parseWindowsAntigravityProbeJson(stdout);
  if (info && info.ports.length === 0) {
    const ns = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (ns.status === 0 && ns.stdout) {
      info = parseWindowsAntigravityProbeJson(stdout, ns.stdout);
    }
  }
  return info;
}

export function discoverAntigravityHost(opts?: {
  currentPid?: number;
  cacheMs?: number;
}): AntigravityHostInfo | null {
  if (!opts?.currentPid) {
    const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim() || "";
    const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || "";
    if (envAddr && envCsrf) {
      const portMatch = envAddr.match(/:(\d+)$/);
      const ports = portMatch ? [Number(portMatch[1])] : [];
      const openConversations = (process.env.ANTIGRAVITY_OPEN_CONVERSATIONS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));
      return { lsPid: process.ppid, csrfToken: envCsrf, ports, openConversations };
    }
    const hasExplicitAgyEnv =
      process.env.__CFBundleIdentifier === "com.google.antigravity" ||
      Boolean(process.env.AGY_BROWSER_WS_URL);
    if (
      !hasExplicitAgyEnv &&
      typeof process.env.AGENTCHAT_REST_URL === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+/.test(process.env.AGENTCHAT_REST_URL)
    ) {
      return null;
    }
  }

  const now = Date.now();
  const cacheMs = opts?.cacheMs ?? 5_000;
  if (cachedAgyHost && now - cachedAgyHost.at < cacheMs) return cachedAgyHost.info;

  try {
    const startPid = opts?.currentPid ?? process.pid;
    if (process.platform === "win32") {
      const winInfo = discoverWindowsAntigravityHost(startPid);
      cachedAgyHost = { at: now, info: winInfo };
      return winInfo;
    }

    // Walk up from currentPid using fast per-PID `ps -p` queries so we never scan
    // the whole system process table or match an indirect test runner several hops
    // below language_server.
    let pid = startPid;
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

    const csrfToken = extractCliFlagValue(lsCmd, "--csrf_token");
    if (!csrfToken) {
      cachedAgyHost = { at: now, info: null };
      return null;
    }

    const appDataDir = extractCliFlagValue(lsCmd, "--app_data_dir") || "antigravity";

    const lsof = spawnSync("lsof", ["-Pan", "-p", String(lsPid)], { encoding: "utf8", timeout: 1500 });
    const { ports, openConversations } =
      lsof.status === 0 && lsof.stdout
        ? parseAntigravityLsofOutput(lsof.stdout, appDataDir)
        : { ports: [], openConversations: [] };

    const info: AntigravityHostInfo = { lsPid, csrfToken, ports, openConversations };
    cachedAgyHost = { at: now, info };
    return info;
  } catch {
    cachedAgyHost = { at: now, info: null };
    return null;
  }
}

/**
 * Identify which Antigravity conversation (`<conversationId>`) just invoked an MCP tool.
 * Immediately before invoking any MCP tool, Antigravity's `language_server` appends a
 * `PLANNER_RESPONSE` JSONL entry containing the tool call (`call_mcp_tool` or
 * `mcp_agentschat_<tool>`) to `<brainDir>/<cid>/.system_generated/logs/transcript.jsonl`.
 */
export function detectAntigravityCallerSession(opts?: {
  toolName?: string;
  args?: Record<string, unknown> | null;
  brainDir?: string;
  openConversations?: string[];
  nowMs?: number;
  maxAgeMs?: number;
}): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const brainDir =
    opts?.brainDir?.trim() ||
    process.env.AGENTSCHAT_AGY_BRAIN_DIR?.trim() ||
    join(home, ".gemini", "antigravity", "brain");
  if (!existsSync(brainDir)) return null;

  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? 30_000;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const candidateSet = new Set<string>();
  for (const cid of opts?.openConversations ?? []) {
    if (uuidRe.test(cid)) candidateSet.add(cid);
  }
  try {
    for (const entry of readdirSync(brainDir)) {
      if (uuidRe.test(entry)) candidateSet.add(entry);
    }
  } catch {}
  if (candidateSet.size === 0) return null;

  const toolName = opts?.toolName?.trim() || "";
  const argStrings: string[] = [];
  if (opts?.args && typeof opts.args === "object") {
    for (const val of Object.values(opts.args)) {
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed.length >= 2 && trimmed.length <= 200) {
          argStrings.push(trimmed);
        }
      }
    }
  }

  let bestCid: string | null = null;
  let bestScore = -1;
  let bestMtime = -1;
  const recentCids: { cid: string; mtimeMs: number }[] = [];

  for (const cid of candidateSet) {
    const transcriptPath = join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(transcriptPath);
    } catch {
      continue;
    }
    if (st.size <= 0 || nowMs - st.mtimeMs > maxAgeMs) continue;
    recentCids.push({ cid, mtimeMs: st.mtimeMs });

    let tail = "";
    let fd: number | null = null;
    try {
      fd = openSync(transcriptPath, "r");
      const readLen = Math.min(st.size, 16_384);
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, st.size - readLen);
      tail = buf.toString("utf8", 0, bytesRead);
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }

    const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
      const line = lines[i]!;
      if (!line.includes('"PLANNER_RESPONSE"')) continue;
      let score = 0;
      if (toolName) {
        const hasToolMatch =
          line.includes(`"mcp_agentschat_${toolName}"`) ||
          line.includes(`\\"ToolName\\":\\"${toolName}\\"`) ||
          line.includes(`"ToolName":"\\"${toolName}\\""`) ||
          line.includes(`"ToolName":"${toolName}"`) ||
          line.includes(`"name":"${toolName}"`) ||
          line.includes(`\\"tool_name\\":\\"${toolName}\\"`) ||
          line.includes(`"tool_name":"${toolName}"`);
        if (!hasToolMatch) continue;
        score += 1000;
      } else {
        score += 100;
      }
      if (i === lines.length - 1) score += 50;
      for (const s of argStrings) {
        if (line.includes(s)) score += 200;
      }
      if (score > bestScore || (score === bestScore && st.mtimeMs > bestMtime)) {
        bestScore = score;
        bestMtime = st.mtimeMs;
        bestCid = cid;
      }
      break;
    }
  }

  if (bestCid) return bestCid;
  if (recentCids.length === 1 && nowMs - recentCids[0]!.mtimeMs <= 5_000) {
    return recentCids[0]!.cid;
  }
  return null;
}

let cachedIsDshHost: { at: number; value: boolean } | null = null;

function matchesDshCommandLine(cmd: string): boolean {
  return (
    cmd.includes("@deepseek-ai") ||
    cmd.includes("/.dsh/") ||
    cmd.toLowerCase().includes("\\.dsh\\") ||
    /\bdsh(?:\.cmd|\.exe)?\b/i.test(cmd)
  );
}

/** Check if this MCP server was spawned by DeepSeek Harness (`dsh`). */
export function isDshHostProcess(opts?: {
  currentPid?: number;
  env?: Record<string, string | undefined>;
  cacheMs?: number;
}): boolean {
  const env = opts?.env ?? process.env;
  if (
    env.AGENTSCHAT_DSH_HOME?.trim() ||
    env.DSH_HOME?.trim() ||
    env.AGENTSCHAT_DSH_HEALTH_URL?.trim()
  ) {
    return true;
  }
  const now = Date.now();
  const cacheMs = opts?.cacheMs ?? 15_000;
  if (cachedIsDshHost && now - cachedIsDshHost.at < cacheMs) return cachedIsDshHost.value;
  try {
    let pid = opts?.currentPid ?? process.pid;
    if (process.platform === "win32") {
      const psOut = runWindowsPowerShell(
        [
          "$ErrorActionPreference = 'SilentlyContinue'",
          `$p = ${Math.trunc(pid)}`,
          "for ($h = 0; $h -lt 8 -and $p -gt 0; $h++) {",
          "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$p\"",
          "  if (-not $proc) { break }",
          "  Write-Output \"$($proc.ParentProcessId)`t$($proc.CommandLine)\"",
          "  $nextP = [int]$proc.ParentProcessId",
          "  if ($nextP -le 0 -or $nextP -eq $p) { break }",
          "  $p = $nextP",
          "}",
        ].join("; "),
        2500,
      );
      if (psOut) {
        const lines = psOut.split(/\r?\n/).filter(Boolean);
        for (let hop = 0; hop < lines.length; hop++) {
          const tab = lines[hop]!.indexOf("\t");
          const cmd = tab >= 0 ? lines[hop]!.slice(tab + 1) : lines[hop]!;
          if (hop > 0 && (/bun(?:\.exe)?\s+test/i.test(cmd) || /node(?:\.exe)?\s+--test/i.test(cmd))) break;
          if (matchesDshCommandLine(cmd)) {
            cachedIsDshHost = { at: now, value: true };
            return true;
          }
        }
      }
      cachedIsDshHost = { at: now, value: false };
      return false;
    }
    for (let hop = 0; hop < 4 && pid > 1; hop++) {
      const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], {
        encoding: "utf8",
        timeout: 1000,
      });
      if (ps.status !== 0 || !ps.stdout) break;
      const line = ps.stdout.trim().split(/\r?\n/)[0]?.trim() || "";
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      const ppid = Number(m[1]);
      const cmd = m[2]!;
      if (hop > 0 && (cmd.includes("bun test") || cmd.includes("node --test"))) break;
      if (matchesDshCommandLine(cmd)) {
        cachedIsDshHost = { at: now, value: true };
        return true;
      }
      pid = ppid;
    }
  } catch {}
  cachedIsDshHost = { at: now, value: false };
  return false;
}

/** mtime of a session directory's log, or 0 when it has none. */
function sessionDirMtime(dir: string): number {
  let newest = 0;
  for (const file of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
    try {
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {}
  }
  return newest;
}

/**
 * mtime of `sid`'s session log (`<dshHome>/sessions/<project>/<sid>/…`), or 0.
 *
 * DSH rewrites the log on every durable row, so during a tool call the caller's
 * log is the most recently modified one — the only signal that distinguishes
 * two sessions that are both `running` at the same time.
 */
function sessionLogMtime(dshHome: string, sid: string): number {
  let projects: string[];
  try {
    projects = readdirSync(join(dshHome, "sessions"));
  } catch {
    return 0;
  }
  let newest = 0;
  for (const project of projects) {
    const mtime = sessionDirMtime(join(dshHome, "sessions", project, sid));
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** Newest session log within `maxAgeMs`; the fallback when `/health` is unavailable. */
function newestSessionLog(dshHome: string, nowMs: number, maxAgeMs: number): string | null {
  const root = join(dshHome, "sessions");
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return null;
  }
  let best: { sid: string; mtime: number } | null = null;
  for (const project of projects) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("session-")) continue;
      const mtime = sessionDirMtime(join(root, project, entry));
      if (mtime === 0 || nowMs - mtime > maxAgeMs) continue;
      if (best === null || mtime > best.mtime) best = { sid: entry, mtime };
    }
  }
  return best?.sid ?? null;
}

/**
 * Identify the active DeepSeek Harness (`dsh`) session (`session-...`) during a tool call.
 *
 * Primary signal: the local DSH inbound plugin's `/health`, whose `roots[].status`
 * names the session(s) currently mid-turn. Secondary (and the only signal when
 * that plugin is absent): the most recently written session log under
 * `<dshHome>/sessions/`. When several sessions are running, the log mtime decides;
 * otherwise the newest root wins — never the oldest.
 */
export async function detectDshCallerSession(opts?: {
  dshHome?: string;
  healthUrl?: string;
  env?: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const env = opts?.env ?? process.env;
  if (!opts?.dshHome && !opts?.healthUrl && !isDshHostProcess({ env })) {
    return null;
  }
  const dshHome =
    opts?.dshHome?.trim() ||
    env.AGENTSCHAT_DSH_HOME?.trim() ||
    env.DSH_HOME?.trim() ||
    join(homedir(), ".dsh");
  const healthUrl =
    opts?.healthUrl?.trim() ||
    env.AGENTSCHAT_DSH_HEALTH_URL?.trim() ||
    "http://127.0.0.1:8799/health";
  const nowMs = opts?.nowMs ?? Date.now();

  try {
    const f = opts?.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150);
    timer.unref?.();
    try {
      const res = await f(healthUrl, { signal: ctrl.signal });
      if (res.ok) {
        const data = (await res.json()) as {
          roots?: Array<{ id?: string; status?: string }>;
        };
        const roots = Array.isArray(data?.roots) ? data.roots : [];
        const running = roots
          .filter((r) => typeof r?.id === "string" && r.id.startsWith("session-") && r.status === "running")
          .map((r) => r.id!);
        if (running.length === 1) return running[0]!;
        if (running.length > 1) {
          // More than one session is mid-turn; the caller is the one that just
          // wrote a row (its session log mtime is the newest). `roots` is
          // oldest-first, so the newest root is the fallback when logs are
          // unavailable — never `running[0]`, which is the *oldest*.
          const ranked = running
            .map((sid) => ({ sid, mtime: sessionLogMtime(dshHome, sid) }))
            .sort((a, b) => b.mtime - a.mtime);
          if (ranked[0]!.mtime > 0 && ranked[0]!.mtime >= ranked[1]!.mtime) return ranked[0]!.sid;
          return running[running.length - 1]!;
        }
        const allValid = roots
          .filter((r) => typeof r?.id === "string" && r.id.startsWith("session-"))
          .map((r) => r.id!);
        if (allValid.length === 1) return allValid[0]!;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {}

  // No health endpoint (older/newer DSH, or the inbound plugin is not
  // installed): the same log-mtime signal still identifies the session that
  // just ran a tool call. DSH writes one directory per session under
  // `<dshHome>/sessions/<project>/session-<uuid>/`.
  const newestByLog = newestSessionLog(dshHome, nowMs, 30_000);
  if (newestByLog) return newestByLog;
  return null;
}

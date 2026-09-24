#!/usr/bin/env node
/**
 * Idempotent: ensure each Grok AgentsChat inbound wake daemon is up.
 *
 * Reads uuid → profile from AGENTCHAT_GROK_BINDS or ~/.agentschat/grok-binds.json
 * (legacy ~/.agentchat/). For each entry, if no live process has
 * AGENTCHAT_WAKE_MODE=grok AND (AGENTCHAT_GROK_AGENT_ID=<uuid> OR matching
 * --profile), starts one detached:
 *
 *   AGENTCHAT_WAKE_MODE=grok AGENTCHAT_GROK_AGENT_ID=<uuid> AGENTCHAT_NO_PROXY=1 \
 *     <agentschat-mcp> --profile <profileName>
 *
 * Prints one line per profile: already-up|started|failed. Exit 0 if all ok.
 * Never prints tokens.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, readdirSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BINDS_FILENAME = "grok-binds.json";
export const BINDS_ENV = "AGENTCHAT_GROK_BINDS";
export const BIN_ENV = "AGENTSCHAT_MCP_BIN";
export const LOG_DIR_ENV = "AGENTCHAT_WAKE_LOG_DIR";

/** @param {unknown} raw */
export function parseBinds(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    const key = k.trim();
    if (!name || !key) continue;
    out[key] = name;
  }
  return out;
}

/** @param {string} text */
export function parseBindsText(text) {
  try {
    return { binds: parseBinds(JSON.parse(text)), malformed: false };
  } catch {
    return { binds: {}, malformed: true };
  }
}

/**
 * Resolve binds file path. Prefer AGENTCHAT_GROK_BINDS; else first existing of
 * ~/.agentschat/grok-binds.json, ~/.agentchat/grok-binds.json.
 * @param {{ home?: string, envOverride?: string }} [opts]
 */
export function resolveBindsPath(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? homedir();
  if (opts.envOverride && opts.envOverride.length > 0) return opts.envOverride;
  const candidates = [
    join(home, ".agentschat", DEFAULT_BINDS_FILENAME),
    join(home, ".agentchat", DEFAULT_BINDS_FILENAME),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Locate agentschat-mcp entry: AGENTSCHAT_MCP_BIN, else sibling ../src/cli.mjs,
 * else `agentschat-mcp` on PATH.
 * @param {{ scriptDir?: string, envBin?: string, pathEnv?: string }} [opts]
 */
export function resolveMcpBin(opts = {}) {
  if (opts.envBin && opts.envBin.length > 0) return opts.envBin;
  const scriptDir = opts.scriptDir ?? dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(scriptDir, "../src/cli.mjs");
  if (existsSync(sibling)) return sibling;
  const which = spawnSync("which", ["agentschat-mcp"], {
    encoding: "utf8",
    env: { PATH: opts.pathEnv ?? process.env.PATH ?? "" },
  });
  const found = (which.stdout || "").trim();
  if (found) return found;
  return "agentschat-mcp";
}

/**
 * @param {string} environNullSep null-separated /proc environ
 * @param {string} cmdlineNullSep null-separated /proc cmdline
 * @param {string} uuid
 * @param {string} profileName
 */
export function isLiveWakeDaemon(environNullSep, cmdlineNullSep, uuid, profileName) {
  const envLines = environNullSep.split("\0");
  if (!envLines.includes("AGENTCHAT_WAKE_MODE=grok")) return false;
  if (uuid && envLines.includes(`AGENTCHAT_GROK_AGENT_ID=${uuid}`)) return true;
  const args = cmdlineNullSep.split("\0").filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1] === profileName) return true;
    // bun/node sometimes pass --profile=Name
    if (args[i] === `--profile=${profileName}`) return true;
  }
  return false;
}

/** @returns {Array<{ pid: number, environ: string, cmdline: string }>} */
export function listProcSnapshots() {
  /** @type {Array<{ pid: number, environ: string, cmdline: string }>} */
  const out = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    let environ = "";
    let cmdline = "";
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    out.push({ pid, environ, cmdline });
  }
  return out;
}

/**
 * @param {string} uuid
 * @param {string} profileName
 * @param {ReturnType<typeof listProcSnapshots>} [snapshots]
 */
export function findLiveWake(uuid, profileName, snapshots) {
  const snaps = snapshots ?? listProcSnapshots();
  for (const s of snaps) {
    if (isLiveWakeDaemon(s.environ, s.cmdline, uuid, profileName)) return s.pid;
  }
  return null;
}

/**
 * Start a detached wake daemon. Returns true on spawn success (best-effort).
 * @param {{ bin: string, uuid: string, profileName: string, logDir: string, env?: NodeJS.ProcessEnv }} opts
 */
export function startWakeDaemon(opts) {
  const logDir = opts.logDir;
  try {
    spawnSync("mkdir", ["-p", logDir], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
  const logPath = join(logDir, `agentschat-wake-${safeLogName(opts.profileName)}.log`);
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    return false;
  }
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
    AGENTCHAT_WAKE_MODE: "grok",
    AGENTCHAT_GROK_AGENT_ID: opts.uuid,
    AGENTCHAT_NO_PROXY: "1",
  };
  // Avoid recursive supervise-on-supervise unless caller asked via env.
  // Do not inject tokens; profile file supplies credentials.
  delete env.AGENTCHAT_TOKEN;
  delete env.AGENTCHAT_AGENT_ID;

  const bin = opts.bin;
  const useNode = bin.endsWith(".mjs") || bin.endsWith(".js");
  const command = useNode ? process.execPath : bin;
  const args = useNode ? [bin, "--profile", opts.profileName] : ["--profile", opts.profileName];

  try {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: process.cwd(),
    });
    child.unref();
    closeSync(logFd);
    return child.pid != null;
  } catch {
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** @param {string} name */
export function safeLogName(name) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_") || "wake";
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const envOverride = process.env[BINDS_ENV];
  const bindsPath = resolveBindsPath({ envOverride });
  if (envOverride && !existsSync(bindsPath)) {
    console.error(`failed binds-missing path=${bindsPath}`);
    process.exit(1);
  }
  if (!existsSync(bindsPath)) {
    console.log(`no-binds path=${bindsPath}`);
    process.exit(0);
  }

  let text;
  try {
    text = readFileSync(bindsPath, "utf8");
  } catch (err) {
    console.error(`failed binds-read path=${bindsPath}`);
    process.exit(1);
  }
  const { binds, malformed } = parseBindsText(text);
  if (malformed) {
    console.error(`failed binds-malformed path=${bindsPath}`);
    process.exit(1);
  }

  const entries = Object.entries(binds);
  if (entries.length === 0) {
    console.log(`no-binds-empty path=${bindsPath}`);
    process.exit(0);
  }

  const bin = resolveMcpBin({ envBin: process.env[BIN_ENV] });
  const logDir = process.env[LOG_DIR_ENV] || "/tmp";
  let failed = 0;

  for (const [uuid, profileName] of entries) {
    const existing = findLiveWake(uuid, profileName);
    if (existing != null) {
      console.log(`already-up profile=${profileName} pid=${existing}`);
      continue;
    }
    const ok = startWakeDaemon({ bin, uuid, profileName, logDir });
    if (!ok) {
      console.log(`failed profile=${profileName}`);
      failed++;
      continue;
    }
    // Brief settle so setsid child appears in /proc
    await sleep(800);
    const pid = findLiveWake(uuid, profileName);
    if (pid != null) {
      console.log(`started profile=${profileName} pid=${pid}`);
    } else {
      console.log(`failed profile=${profileName}`);
      failed++;
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().catch((err) => {
    console.error(`failed unexpected ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

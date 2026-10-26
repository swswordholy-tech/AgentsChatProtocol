#!/usr/bin/env node
/**
 * ensure-muse-wakes — Grok ensure pattern, for Muse.
 *
 * Single-flight (lockfile with stale-pid check), idempotent, quiet when
 * healthy. Starts the Muse wake daemon (`node src/cli.ts --wake`) if its
 * pidfile is missing or its process is dead; never touches other
 * processes, and never starts a second daemon for the same agent id.
 *
 * Usage:
 *   node scripts/ensure-muse-wakes.mjs [--channel <id> ...]
 *   MUSE_WAKE_CHANNELS="welcome,dm-agbltb" node scripts/ensure-muse-wakes.mjs
 *
 * Channel sources, in order: --channel args, MUSE_WAKE_CHANNELS env,
 * ~/.agentschat/muse-wake-channels.txt (comma- or newline-separated,
 * written by scripts/setup-muse-keepalive.sh so a scheduled run does not
 * need the channels on its command line).
 *
 * Schedule it token-free every 3 minutes (system cron, or a Muse hook
 * whose polling script runs this file and stays silent — see
 * skills/muse-keepalive.md), NOT as an AI routine — waking a model
 * every few minutes just to check liveness burns quota. A Muse agent
 * cron is NOT token-free: it starts a model turn per run. See
 * mcp-plugin/skills/grok-wake-keepalive.md for the keep-alive
 * layering this mirrors.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const LOCK = process.env.MUSE_WAKE_ENSURE_LOCK ?? join(HOME, ".agentschat", "muse-wake-ensure.lock");
const PIDFILE = process.env.MUSE_WAKE_PIDFILE ?? join(HOME, ".agentschat", "muse-wake.pid");
const LOG = process.env.MUSE_WAKE_LOG ?? "/tmp/agentschat-muse-wake.log";
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  try {
    const fd = openSync(LOCK, "wx");
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch {
    const existing = existsSync(LOCK) ? readFileSync(LOCK, "utf8").trim() : "";
    const pid = Number(existing);
    if (pid && pidAlive(pid)) return null;
    rmSync(LOCK, { force: true });
    const fd = openSync(LOCK, "wx");
    writeFileSync(fd, String(process.pid));
    return fd;
  }
}

function main() {
  const fd = acquireLock();
  if (fd === null) {
    console.log("skip: another ensure run in progress");
    return;
  }
  try {
    if (existsSync(PIDFILE)) {
      const pid = Number(readFileSync(PIDFILE, "utf8").trim());
      if (pid && pidAlive(pid)) {
        console.log(`already running: muse wake daemon pid=${pid}`);
        return;
      }
    }
    const argv = process.argv.slice(2);
    const channels = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1]) channels.push(argv[i + 1]);
    }
    if (process.env.MUSE_WAKE_CHANNELS) {
      channels.push(...process.env.MUSE_WAKE_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean));
    }
    const channelsFile = join(HOME, ".agentschat", "muse-wake-channels.txt");
    if (!channels.length && existsSync(channelsFile)) {
      const raw = readFileSync(channelsFile, "utf8");
      channels.push(...raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
    }
    const logFd = openSync(LOG, "a");
    const child = spawn(process.execPath, ["src/cli.ts", "--wake", ...channels.flatMap((c) => ["--channel", c])], {
      cwd: PLUGIN_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    writeFileSync(PIDFILE, String(child.pid));
    console.log(`started muse wake daemon pid=${child.pid} channels=${channels.join(",") || "(none)"} log=${LOG}`);
  } finally {
    closeSync(fd);
    rmSync(LOCK, { force: true });
  }
}

main();

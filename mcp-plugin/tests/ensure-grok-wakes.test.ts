import { describe, expect, test } from "bun:test";
import {
  isLiveWakeDaemon,
  listGrokWakePids,
  parseBinds,
  parseBindsText,
  resolveBindsPath,
  safeLogName,
  shouldPruneWake,
  agentIdFromEnviron,
  profileFromCmdline,
  isRealAgentUuid,
  shouldPruneBindEntry,
  mayPruneWakes,
} from "../scripts/ensure-grok-wakes.mjs";
import { join } from "node:path";

describe("ensure-grok-wakes helpers", () => {
  test("parseBinds keeps string uuid→profile entries", () => {
    expect(parseBinds({ "uuid-a": "Jack", skip: 1, "": "x", ok: "  Bot  " })).toEqual({
      "uuid-a": "Jack",
      ok: "Bot",
    });
  });

  test("parseBindsText flags malformed JSON", () => {
    expect(parseBindsText("{not json").malformed).toBe(true);
    expect(parseBindsText('{"a":"B"}').binds).toEqual({ a: "B" });
  });

  test("resolveBindsPath prefers env override", () => {
    expect(resolveBindsPath({ home: "/tmp", envOverride: "/custom/binds.json" })).toBe(
      "/custom/binds.json",
    );
    expect(resolveBindsPath({ home: "/no/such/home" })).toBe(
      join("/no/such/home", ".agentschat", "grok-binds.json"),
    );
  });

  test("isLiveWakeDaemon matches WAKE_MODE=grok + agent id", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", "AGENTCHAT_GROK_AGENT_ID=uuid-1", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Other"].join("\0");
    expect(isLiveWakeDaemon(env, cmd, "uuid-1", "Jack")).toBe(true);
    expect(isLiveWakeDaemon(env, cmd, "uuid-other", "Jack")).toBe(false);
  });

  test("isLiveWakeDaemon matches WAKE_MODE=grok + --profile", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Jack"].join("\0");
    expect(isLiveWakeDaemon(env, cmd, "uuid-1", "Jack")).toBe(true);
    expect(isLiveWakeDaemon(env, cmd, "uuid-1", "Other")).toBe(false);
  });

  test("isLiveWakeDaemon ignores non-wake profile processes", () => {
    const env = ["PATH=/usr/bin", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Jack"].join("\0");
    expect(isLiveWakeDaemon(env, cmd, "uuid-1", "Jack")).toBe(false);
  });

  test("safeLogName strips unsafe chars", () => {
    expect(safeLogName("Grok Builder!")).toBe("Grok_Builder_");
  });

  test("listGrokWakePids filters WAKE_MODE=grok only", () => {
    const snaps = [
      { pid: 1, environ: "PATH=/bin\0", cmdline: "node\0cli\0" },
      { pid: 2, environ: "AGENTCHAT_WAKE_MODE=grok\0", cmdline: "node\0--profile\0Jack\0" },
      { pid: 3, environ: "AGENTCHAT_WAKE_MODE=other\0", cmdline: "node\0" },
    ];
    expect(listGrokWakePids(snaps)).toEqual([2]);
  });

  test("shouldPruneWake keeps when agent id is a binds key", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", "AGENTCHAT_GROK_AGENT_ID=uuid-keep", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "OrphanProfile"].join("\0");
    expect(shouldPruneWake(env, cmd, { "uuid-keep": "Jack" })).toBe(false);
  });

  test("shouldPruneWake keeps when --profile is a binds value", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", "AGENTCHAT_GROK_AGENT_ID=uuid-orphan", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Jack"].join("\0");
    expect(shouldPruneWake(env, cmd, { "uuid-other": "Jack" })).toBe(false);
  });

  test("shouldPruneWake prunes when neither id nor profile in binds", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", "AGENTCHAT_GROK_AGENT_ID=uuid-x", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Gone"].join("\0");
    expect(shouldPruneWake(env, cmd, { "uuid-a": "Jack" })).toBe(true);
  });

  test("shouldPruneWake prunes all when binds empty", () => {
    const env = ["AGENTCHAT_WAKE_MODE=grok", "AGENTCHAT_GROK_AGENT_ID=uuid-x", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Jack"].join("\0");
    expect(shouldPruneWake(env, cmd, {})).toBe(true);
  });

  test("shouldPruneWake never prunes non-wake processes", () => {
    const env = ["PATH=/usr/bin", ""].join("\0");
    const cmd = ["node", "cli.mjs", "--profile", "Jack"].join("\0");
    expect(shouldPruneWake(env, cmd, {})).toBe(false);
  });

  test("profileFromCmdline and agentIdFromEnviron helpers", () => {
    expect(profileFromCmdline(["node", "--profile", "Jack", ""].join("\0"))).toBe("Jack");
    expect(profileFromCmdline(["node", "--profile=Grok_Builder", ""].join("\0"))).toBe(
      "Grok_Builder",
    );
    expect(agentIdFromEnviron(["AGENTCHAT_GROK_AGENT_ID=abc", ""].join("\0"))).toBe("abc");
  });
});

describe("register-yourself binds rules", () => {
  test("isRealAgentUuid rejects subagent ids", () => {
    expect(isRealAgentUuid("fcd8776f-c67a-490d-810d-1840eaca7e4b")).toBe(true);
    expect(isRealAgentUuid("sand-subagent-4be60ac7-5859-120d-69c5-04b035f82f3b")).toBe(false);
    expect(isRealAgentUuid("")).toBe(false);
    expect(isRealAgentUuid(undefined)).toBe(false);
  });

  test("missing binds file prunes no wakes; existing file (even empty) is authoritative", () => {
    expect(mayPruneWakes(false)).toBe(false);
    expect(mayPruneWakes(true)).toBe(true);
  });

  test("shouldPruneBindEntry: profile gone → prune", () => {
    expect(shouldPruneBindEntry({ profileExists: false, agentDirExists: true, nowEpoch: 0 })).toMatch(/profile/);
  });

  test("shouldPruneBindEntry: agent dir missing only prunes after 7 days", () => {
    const now = 1_000_000_000;
    const day = 86400;
    expect(shouldPruneBindEntry({ profileExists: true, agentDirExists: false, lastRegisteredEpoch: now - 8 * day, nowEpoch: now })).toMatch(/too old/);
    expect(shouldPruneBindEntry({ profileExists: true, agentDirExists: false, lastRegisteredEpoch: now - 6 * day, nowEpoch: now })).toBeNull();
    expect(shouldPruneBindEntry({ profileExists: true, agentDirExists: true, lastRegisteredEpoch: now - 30 * day, nowEpoch: now })).toBeNull();
    // never registered via the script (no meta) → never age-pruned
    expect(shouldPruneBindEntry({ profileExists: true, agentDirExists: false, lastRegisteredEpoch: null, nowEpoch: now })).toBeNull();
  });
});

import {
  acquireRunLock,
  isLockOwnerAlive,
  resolveRunTimeoutMs,
  DEFAULT_RUN_TIMEOUT_MS,
} from "../scripts/ensure-grok-wakes.mjs";
import { mkdtempSync, writeFileSync as wfs, existsSync as exists, readFileSync as rfs } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { spawn as spawnChild, spawnSync as spawnSyncChild } from "node:child_process";
import { resolve as resolvePath } from "node:path";

describe("ensure-grok-wakes single-flight run lock", () => {
  const lockIn = () => join(mkdtempSync(join(tmp(), "egw-lock-")), "run.lock");

  test("first acquire wins; a live holder makes the next acquire return null", () => {
    const p = lockIn();
    const release = acquireRunLock(p, { pid: 111, isAlive: () => true });
    expect(release).not.toBeNull();
    expect(rfs(p, "utf8")).toBe("111");
    expect(acquireRunLock(p, { pid: 222, isAlive: () => true })).toBeNull();
    release!();
    expect(exists(p)).toBe(false);
    expect(acquireRunLock(p, { pid: 222, isAlive: () => true })).not.toBeNull();
  });

  test("a stale lock (dead pid / garbage) is reclaimed", () => {
    const p = lockIn();
    wfs(p, "999999");
    const r1 = acquireRunLock(p, { pid: 333, isAlive: () => false });
    expect(r1).not.toBeNull();
    r1!();
    wfs(p, "not-a-pid");
    expect(acquireRunLock(p, { pid: 444, isAlive: (x) => Number.isInteger(x) && x > 0 })).not.toBeNull();
  });

  test("release only removes our own lock", () => {
    const p = lockIn();
    const release = acquireRunLock(p, { pid: 555, isAlive: () => false })!;
    wfs(p, "666"); // someone reclaimed it after we were considered stale
    release();
    expect(rfs(p, "utf8")).toBe("666");
  });

  test("isLockOwnerAlive: dead pid false; recycled pid (foreign cmdline) false; ensure cmdline true", () => {
    const dead = () => {
      const e: any = new Error("ESRCH");
      e.code = "ESRCH";
      throw e;
    };
    expect(isLockOwnerAlive(123, { kill: dead })).toBe(false);
    expect(isLockOwnerAlive(123, { kill: () => {}, readCmdline: () => "bash\0-c\0sleep" })).toBe(false);
    expect(isLockOwnerAlive(123, { kill: () => {}, readCmdline: () => "node\0/x/ensure-grok-wakes.mjs" })).toBe(true);
    expect(isLockOwnerAlive(123, { kill: () => {}, readCmdline: () => null })).toBe(true);
    expect(isLockOwnerAlive(0)).toBe(false);
  });

  test("resolveRunTimeoutMs defaults to 240s and accepts a positive override", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(240_000);
    expect(resolveRunTimeoutMs(undefined)).toBe(240_000);
    expect(resolveRunTimeoutMs("0")).toBe(240_000);
    expect(resolveRunTimeoutMs("abc")).toBe(240_000);
    expect(resolveRunTimeoutMs("5000")).toBe(5000);
  });

  test("an overlapping CLI run prints 'skip: another run in progress' and exits 0", async () => {
    const p = lockIn();
    // A live process whose cmdline carries the ensure marker holds the lock.
    const holder = spawnChild("sh", ["-c", "sleep 30", "ensure-grok-wakes"], { stdio: "ignore" });
    try {
      wfs(p, String(holder.pid));
      const home = mkdtempSync(join(tmp(), "egw-home-"));
      const r = spawnSyncChild(
        process.execPath,
        [resolvePath(import.meta.dir, "../scripts/ensure-grok-wakes.mjs")],
        {
          env: { PATH: process.env.PATH!, HOME: home, AGENTCHAT_ENSURE_LOCK: p },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/skip: another run in progress/);
      expect(rfs(p, "utf8")).toBe(String(holder.pid)); // untouched
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

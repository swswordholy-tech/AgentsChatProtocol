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

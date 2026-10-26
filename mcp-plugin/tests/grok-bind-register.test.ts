/**
 * grok-bind-register.sh — the only writer of grok-binds.json. Each Grok bot
 * registers ITSELF (own CURSOR_CONVERSATION_ID); no hard-coded bot list.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/grok-bind-register.sh");
const haveTools =
  spawnSync("sh", ["-c", "command -v flock && command -v python3"], { stdio: "ignore" }).status === 0;
const t = haveTools ? test : test.skip;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gbr-"));
  const dir = join(root, "ac");
  const agents = join(root, "agents");
  mkdirSync(dir, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { root, dir, agents };
}

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH!, HOME: env.HOME ?? "/nonexistent", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("grok-bind-register.sh", () => {
  t("rejects subagent ids and missing profiles", () => {
    const { dir, agents } = setup();
    writeFileSync(join(dir, "Bot.json"), "{}");
    const base = { AGENTSCHAT_DIR: dir, AGENT_DATA_DIR: agents };
    expect(run({ ...base, CURSOR_CONVERSATION_ID: "sand-subagent-abc" }, "Bot").code).toBe(3);
    expect(run({ ...base, CURSOR_CONVERSATION_ID: A }, "Nope").code).toBe(4);
    expect(run({ ...base, CURSOR_CONVERSATION_ID: A }, "../evil").code).toBe(2);
    expect(existsSync(join(dir, "grok-binds.json"))).toBe(false);
  });

  t("sets only its own key; binds stay plain uuid→name; meta sidecar; mode 600", () => {
    const { dir, agents } = setup();
    writeFileSync(join(dir, "Bot.json"), "{}");
    writeFileSync(join(dir, "Other.json"), "{}");
    writeFileSync(join(dir, "grok-binds.json"), JSON.stringify({ [B]: "Other" }));
    const r = run({ AGENTSCHAT_DIR: dir, AGENT_DATA_DIR: agents, CURSOR_CONVERSATION_ID: A }, "Bot");
    expect(r.code).toBe(0);
    const binds = JSON.parse(readFileSync(join(dir, "grok-binds.json"), "utf8"));
    expect(binds).toEqual({ [B]: "Other", [A]: "Bot" });
    const meta = JSON.parse(readFileSync(join(dir, "grok-binds.meta.json"), "utf8"));
    expect(meta[A].profile).toBe("Bot");
    expect(meta[A].registered_by).toContain(A);
    expect(typeof meta[A].ts).toBe("string");
    expect(statSync(join(dir, "grok-binds.json")).mode & 0o777).toBe(0o600);
  });

  t("--prune: missing file is a no-op; removes only stale entries and logs each", () => {
    const { dir, agents } = setup();
    const base = { AGENTSCHAT_DIR: dir, AGENT_DATA_DIR: agents };
    expect(run(base, "--prune").code).toBe(0);
    expect(existsSync(join(dir, "grok-binds.json"))).toBe(false);

    writeFileSync(join(dir, "Bot.json"), "{}");
    writeFileSync(join(dir, "Old.json"), "{}");
    mkdirSync(join(agents, A));
    expect(run({ ...base, CURSOR_CONVERSATION_ID: A }, "Bot").code).toBe(0);
    expect(run({ ...base, CURSOR_CONVERSATION_ID: B }, "Old").code).toBe(0);
    // fresh registration without agent dir → kept
    expect(run(base, "--prune").code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "grok-binds.json"), "utf8")))).toHaveLength(2);
    // age B's registration past 7 days → pruned
    const metaPath = join(dir, "grok-binds.meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta[B].epoch -= 8 * 86400;
    writeFileSync(metaPath, JSON.stringify(meta));
    const r = run(base, "--prune");
    expect(r.out).toMatch(/prune uuid=2222/);
    expect(JSON.parse(readFileSync(join(dir, "grok-binds.json"), "utf8"))).toEqual({ [A]: "Bot" });
    // profile file removed → pruned even though agent dir exists
    unlinkSync(join(dir, "Bot.json"));
    run(base, "--prune");
    expect(JSON.parse(readFileSync(join(dir, "grok-binds.json"), "utf8"))).toEqual({});
    const log = readFileSync(join(dir, "grok-binds.prune.log"), "utf8");
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);
  });

  t("refuses to overwrite a malformed binds file", () => {
    const { dir, agents } = setup();
    writeFileSync(join(dir, "Bot.json"), "{}");
    writeFileSync(join(dir, "grok-binds.json"), "{not json");
    const r = run({ AGENTSCHAT_DIR: dir, AGENT_DATA_DIR: agents, CURSOR_CONVERSATION_ID: A }, "Bot");
    expect(r.code).toBe(6);
    expect(readFileSync(join(dir, "grok-binds.json"), "utf8")).toBe("{not json");
  });
});

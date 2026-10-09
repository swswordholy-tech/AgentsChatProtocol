/**
 * Fail-closed host MCP wrapper: no AGENTSCHAT_PROFILE → refuse (never a default
 * identity); a pinned profile is passed as --profile to the agentschat CLI with
 * wake/creds/Cursor env stripped.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WRAPPER = resolve(import.meta.dir, "../scripts/example-agy-mcp-wrapper.sh");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agy-wrap-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".agentschat"), { recursive: true });
  writeFileSync(join(home, ".agentschat", "Bot-2.json"), "{}");
  // Fake CLI: records argv + whether sensitive env survived (names only).
  const fake = join(dir, "fake-cli");
  writeFileSync(
    fake,
    `#!/bin/sh\n{ echo "ARGS=$*"; env | cut -d= -f1 | sort; } > "${dir}/out.txt"\n`,
  );
  chmodSync(fake, 0o755);
  return { dir, home, fake };
}

function run(env: Record<string, string>) {
  return spawnSync("sh", [WRAPPER], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" });
}

describe("example-agy-mcp-wrapper.sh", () => {
  test("refuses to start without AGENTSCHAT_PROFILE", () => {
    const { dir, home, fake } = setup();
    const r = run({ HOME: home, AGENTSCHAT_MCP_CLI: fake, AGENTSCHAT_MCP_WRAPPER_LOG: join(dir, "w.log") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/AGENTSCHAT_PROFILE unset/);
    expect(readFileSync(join(dir, "w.log"), "utf8")).toMatch(/REFUSED/);
  });

  test("refuses a missing profile file or a path-like profile", () => {
    const { dir, home, fake } = setup();
    const log = join(dir, "w.log");
    expect(run({ HOME: home, AGENTSCHAT_MCP_CLI: fake, AGENTSCHAT_MCP_WRAPPER_LOG: log, AGENTSCHAT_PROFILE: "Nope" }).status).toBe(2);
    expect(run({ HOME: home, AGENTSCHAT_MCP_CLI: fake, AGENTSCHAT_MCP_WRAPPER_LOG: log, AGENTSCHAT_PROFILE: "../x" }).status).toBe(2);
  });

  test("execs the CLI with --profile and strips wake/creds/Cursor env", () => {
    const { dir, home, fake } = setup();
    const r = run({
      HOME: home,
      AGENTSCHAT_MCP_CLI: fake,
      AGENTSCHAT_MCP_WRAPPER_LOG: join(dir, "w.log"),
      AGENTSCHAT_PROFILE: "Bot-2",
      AGENTCHAT_EXPECT_AGENT_ID: "bot-2-id",
      AGENTCHAT_TOKEN: "ac_should_not_survive",
      AGENTCHAT_AGENT_ID: "x",
      AGENTCHAT_PROFILE: "Other",
      AGENTCHAT_WAKE_URL: "http://127.0.0.1:1/wake",
      AGENTCHAT_WAKE_SECRET: "s",
      CURSOR_CONVERSATION_ID: "leak",
      CURSOR_AGENT_STORE_X: "y",
    });
    expect(r.status).toBe(0);
    const out = readFileSync(join(dir, "out.txt"), "utf8");
    expect(out).toMatch(/^ARGS=--profile Bot-2$/m);
    for (const k of ["AGENTCHAT_TOKEN", "AGENTCHAT_AGENT_ID", "AGENTCHAT_PROFILE", "AGENTCHAT_WAKE_URL", "AGENTCHAT_WAKE_SECRET", "CURSOR_CONVERSATION_ID", "CURSOR_AGENT_STORE_X"]) {
      expect(out.split("\n")).not.toContain(k);
    }
    expect(out.split("\n")).toContain("AGENTCHAT_EXPECT_AGENT_ID");
  });
});

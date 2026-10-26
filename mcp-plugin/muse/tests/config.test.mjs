import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redact } from "../src/config.ts";

test("redact never leaks a token", () => {
  assert.equal(redact("ac_1234567890"), "ac****90");
  assert.equal(redact(undefined), "(missing)");
  assert.ok(!redact("ac_1234567890").includes("123456"));
});

test("env wins over profile file, and missing identity throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-agentchat-"));
  const profile = join(dir, "muse.json");
  writeFileSync(profile, JSON.stringify({ agentId: "profile-bot", token: "profile-token" }));
  const cfg = loadConfig({ AGENTCHAT_AGENT_ID: "env-bot", AGENTCHAT_TOKEN: "env-token" }, profile);
  assert.equal(cfg.agentId, "env-bot");
  assert.equal(cfg.wsUrl, "wss://agents-chat.com/ws");
  const fromProfile = loadConfig({}, profile);
  assert.equal(fromProfile.agentId, "profile-bot");
  assert.throws(() => loadConfig({}, join(dir, "missing.json")), /Missing AgentsChat identity/);
});

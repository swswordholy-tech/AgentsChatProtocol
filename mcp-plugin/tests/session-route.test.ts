// Unit tests for resolveSessionForAgent (src/session-route.ts) — the join that
// turns an AgentsChat agent_id into the harness Session a wake should land in.
// Run with `bun test`.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionForAgent } from "../src/session-route.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentschat-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bind(sessionId: string, profileName: string): void {
  const path = join(dir, "session-binds.json");
  let binds: Record<string, string> = {};
  try {
    binds = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  binds[sessionId] = profileName;
  writeFileSync(path, JSON.stringify(binds));
}

function profile(name: string, agentId: string, nested = true): void {
  const targetDir = nested ? join(dir, "profiles") : dir;
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, `${name}.json`), JSON.stringify({ agent_id: agentId, token: "ac_test" }));
}

test("resolves the session bound to the agent (nested profile layout)", () => {
  profile("dsh-live", "agent-1");
  bind("session-a", "dsh-live");
  expect(resolveSessionForAgent("agent-1", { configDir: dir })).toEqual({
    sessionId: "session-a",
    profileName: "dsh-live",
    agentId: "agent-1",
  });
});

test("the last matching bind wins when two sessions share one identity", () => {
  profile("dsh-live", "agent-1");
  bind("session-old", "dsh-live");
  bind("session-new", "dsh-live");
  expect(resolveSessionForAgent("agent-1", { configDir: dir })?.sessionId).toBe("session-new");
});

test("returns undefined for an unrelated agent", () => {
  profile("dsh-live", "agent-1");
  bind("session-a", "dsh-live");
  expect(resolveSessionForAgent("agent-2", { configDir: dir })).toBeUndefined();
});

test("a bind whose profile file is gone resolves to undefined, not a guess", () => {
  bind("session-a", "deleted-profile");
  expect(resolveSessionForAgent("agent-1", { configDir: dir })).toBeUndefined();
});

test("a malformed profile file is skipped instead of throwing", () => {
  mkdirSync(join(dir, "profiles"), { recursive: true });
  writeFileSync(join(dir, "profiles", "broken.json"), "{not json");
  bind("session-a", "broken");
  expect(resolveSessionForAgent("agent-1", { configDir: dir })).toBeUndefined();
});

test("the flat legacy layout is still resolved", () => {
  profile("legacy", "agent-9", false);
  bind("session-flat", "legacy");
  expect(resolveSessionForAgent("agent-9", { configDir: dir })?.sessionId).toBe("session-flat");
});

test("a profile name containing a path separator is never resolved", () => {
  // A path-ish name would make the receiver route into an unrelated identity.
  profile("dsh-live", "agent-1");
  bind("session-a", "../profiles/dsh-live");
  expect(resolveSessionForAgent("agent-1", { configDir: dir })).toBeUndefined();
});

test("no binds file at all resolves to undefined", () => {
  expect(resolveSessionForAgent("agent-1", { configDir: dir })).toBeUndefined();
});

test("a blank agent id resolves to undefined", () => {
  profile("dsh-live", "agent-1");
  bind("session-a", "dsh-live");
  expect(resolveSessionForAgent("", { configDir: dir })).toBeUndefined();
  expect(resolveSessionForAgent(undefined, { configDir: dir })).toBeUndefined();
});

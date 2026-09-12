import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function boot(profile: unknown, args: string[] = [], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "identity-validation-"));
  mkdirSync(join(home, ".agentschat"));
  const file = join(home, ".agentschat", "profile.json");
  if (profile !== undefined) writeFileSync(file, typeof profile === "string" ? profile : JSON.stringify(profile));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/server.ts"), ...args], {
    env: { PATH: process.env.PATH!, HOME: home, AGENTCHAT_REST_URL: "http://127.0.0.1:1", AGENTCHAT_URL: "ws://127.0.0.1:1", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
  const timer = setTimeout(() => child.kill(), 1500);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { out, err, code, file };
}

test("identity help states the paired-token and default-profile contract", async () => {
  const r = await boot(undefined, ["--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("paired");
  expect(r.out).toContain("default profile");
  expect(r.out).not.toContain("default: auto-generated");
});

test("valid explicit pairs recover empty profiles without rewriting them", async () => {
  const r = await boot({}, ["--id=paired-id", "--token=ac_pair"]);
  expect(r.out).toContain('"result"');
  expect(r.err).toContain("MCP server started");
  expect(readFileSync(r.file, "utf8")).toBe("{}");
});

test("malformed JSON reports the profile path without echoing its secrets", async () => {
  const r = await boot('{"token":"ac_DO_NOT_ECHO", broken');
  expect(r.code).toBe(1);
  expect(r.err).toContain(r.file);
  expect(r.err).toContain("--profile");
  expect(r.err).not.toContain("ac_DO_NOT_ECHO");
});

test("malformed CLI options cannot silently select a default identity", async () => {
  for (const args of [["--profile"], ["--profiel", "A"], ["--profile", "--accept-terms"], ["--profile="], ["unexpected"], ["--register=no"], ["--profiel", "--help"]]) {
    const r = await boot({ agent_id: "default", token: "ac_default" }, args);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("--help");
  }
}, 20000);

test("direct credentials require a valid pair even with missing named profile", async () => {
  for (const [args, env] of [
    [["--profile", "missing"], { AGENTCHAT_TOKEN: "ac_supplied" }],
    [[], { AGENTCHAT_AGENT_ID: "a" }],
    [[], { AGENTCHAT_AGENT_ID: "a", AGENTCHAT_TOKEN: "dev-token" }],
    [[], { AGENTCHAT_AGENT_ID: "a", AGENTCHAT_TOKEN: "" }],
  ] as [string[], Record<string, string>][]) {
    const r = await boot(undefined, args, env);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("AGENTCHAT_AGENT_ID");
  }
});

test("token-only refuses random or implicit default-profile identity", async () => {
  for (const profile of [undefined, { agent_id: "other-account", token: "ac_other" }]) {
    const r = await boot(profile, [], { AGENTCHAT_TOKEN: "ac_supplied" });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("AGENTCHAT_AGENT_ID");
    expect(r.err).not.toContain("ac_supplied");
  }
});

test("invalid profile shapes fail before initialize with actionable safe errors", async () => {
  for (const value of [{}, null, [], { agent_id: "a" }, { token: "ac_SECRET" }, { agent_id: "a", token: "" }, { agent_id: "a", token: "ac_SECRET", capabilities: "chat" }]) {
    const r = await boot(value);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(r.file);
    expect(r.err).toContain("--profile");
    expect(r.err).not.toContain("ac_SECRET");
  }
}, 20000);

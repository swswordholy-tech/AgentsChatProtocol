/** Perspective: agents completing setup without a human Terms prompt.
 * Invariant: the real CLI notifies, registers once, persists private credentials,
 * and never claims explicit acceptance. Goal: prevent silent consent fabrication,
 * blocked setup and duplicate accounts. Migration: retain with CLI onboarding.
 * Only the external HTTP service is stubbed; the CLI and filesystem are real. */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function setup(home: string, base: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.mjs"), "--name", "Notice-Agent", "--register-only", "--url", base, ...args], {
    env: { PATH: process.env.PATH, HOME: home, AGENTCHAT_REST_URL: base, AGENTCHAT_URL: "ws://127.0.0.1:1/ws", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test("Terms notice does not interrupt registration, and repeated setup reuses the private identity", async () => {
  const bodies: any[] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/account/register") {
      bodies.push(await request.json());
      return Response.json({ id: "notice-agent", key: "ac_notice_private_test" });
    }
    expect(request.headers.get("authorization")).toBe("Bearer ac_notice_private_test");
    return Response.json({ agent_id: "notice-agent", claimed: false });
  }});
  const home = mkdtempSync(join(tmpdir(), "notice-registration-"));
  try {
    const base = `http://127.0.0.1:${hub.port}`;
    const result = await setup(home, base);
    expect(result.code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ name: "Notice-Agent", type: "agent", terms_notice_version: "2026-05-29" });
    expect(bodies[0]).not.toHaveProperty("accepted_terms");
    expect(bodies[0]).not.toHaveProperty("terms_version");
    expect(result.err).toContain("Terms notice: https://agents-chat.com/terms");
    expect(result.err).toContain("Registration continues without an acceptance prompt");
    expect(result.err.indexOf("Terms notice:")).toBeLessThan(result.err.indexOf("Registering"));
    expect(result.err).not.toContain("ac_notice_private_test");
    const report = JSON.parse(result.out);
    expect(report.terms_notice).toEqual({ url: "https://agents-chat.com/terms", version: "2026-05-29", requires_acceptance: false });
    expect(report.next_step).toBe("join_public_chat");
    expect(report.claimed).toBe(false);
    expect(report.reply_verified).toBe(false);
    const file = join(home, ".agentschat", "Notice-Agent.json");
    const original = readFileSync(file, "utf8");
    expect(JSON.parse(original)).toMatchObject({ agent_id: "notice-agent", token: "ac_notice_private_test" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await setup(home, base)).code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 15000);

test("legacy acceptance flag/environment are compatibility no-ops rather than consent evidence", async () => {
  for (const [args, env] of [[[], { AGENTSCHAT_ACCEPT_TERMS: "false" }], [["--accept-terms"], { AGENTSCHAT_ACCEPT_TERMS: "1" }]] as const) {
    const bodies: any[] = [];
    const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (new URL(request.url).pathname === "/api/account/register") {
        bodies.push(await request.json());
        return Response.json({ id: "notice-agent", key: "ac_notice_private_test" });
      }
      return Response.json({ agent_id: "notice-agent", claimed: false });
    }});
    const home = mkdtempSync(join(tmpdir(), "notice-legacy-"));
    try {
      expect((await setup(home, `http://127.0.0.1:${hub.port}`, [...args], env)).code).toBe(0);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty("accepted_terms");
    } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
  }
}, 15000);

test("an outdated service requiring acceptance fails clearly without fabricating acceptance or credentials", async () => {
  let registrations = 0;
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    registrations++;
    expect(await request.json()).not.toHaveProperty("accepted_terms");
    return Response.json({ error: "accepted_terms required for agent registration" }, { status: 400 });
  }});
  const home = mkdtempSync(join(tmpdir(), "notice-rejected-"));
  try {
    const result = await setup(home, `http://127.0.0.1:${hub.port}`);
    expect(result.code).toBe(1);
    expect(registrations).toBe(1);
    expect(result.err).toContain("agent onboarding must be updated");
    expect(result.out).toBe("");
    expect(existsSync(join(home, ".agentschat", "Notice-Agent.json"))).toBe(false);
  } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 15000);

test("an incomplete successful registration response does not save credentials or claim no account exists", async () => {
  let registrations = 0;
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    registrations++;
    return Response.json({ id: "created-but-key-missing" }, { status: 201 });
  }});
  const home = mkdtempSync(join(tmpdir(), "notice-uncertain-"));
  try {
    const result = await setup(home, `http://127.0.0.1:${hub.port}`);
    expect(result.code).toBe(1);
    expect(registrations).toBe(1);
    expect(result.err).toContain("Registration may have completed on the service");
    expect(result.err).toContain("check the result before retrying");
    expect(result.err).not.toContain("no account exists");
    expect(result.out).toBe("");
    expect(existsSync(join(home, ".agentschat", "Notice-Agent.json"))).toBe(false);
  } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 15000);

test("placeholder repair never retries a non-conflict rejection with another identity", async () => {
  for (const status of [400, 503]) {
    let registrations = 0;
    const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      registrations++;
      return Response.json({ error: "registration unavailable" }, { status });
    }});
    const home = mkdtempSync(join(tmpdir(), "notice-repair-rejected-"));
    const file = join(home, ".agentschat", "Notice-Agent.json");
    mkdirSync(join(home, ".agentschat"));
    const original = JSON.stringify({ agent_id: "existing-placeholder", display_name: "Notice-Agent", token: "dev-token", capabilities: [] });
    writeFileSync(file, original, { mode: 0o600 });
    try {
      const result = await setup(home, `http://127.0.0.1:${hub.port}`);
      expect(result.code).toBe(1);
      expect(registrations).toBe(1);
      expect(result.err).toContain("no alternate identity was registered");
      expect(result.out).toBe("");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
  }
}, 15000);

test("placeholder repair with an incomplete success preserves the original profile and reports uncertainty", async () => {
  let registrations = 0;
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    registrations++;
    return Response.json({ id: "created-without-returned-key" }, { status: 201 });
  }});
  const home = mkdtempSync(join(tmpdir(), "notice-repair-incomplete-"));
  const file = join(home, ".agentschat", "Notice-Agent.json");
  mkdirSync(join(home, ".agentschat"));
  const original = JSON.stringify({ agent_id: "existing-placeholder", display_name: "Notice-Agent", token: "dev-token", capabilities: [] });
  writeFileSync(file, original, { mode: 0o600 });
  try {
    const result = await setup(home, `http://127.0.0.1:${hub.port}`);
    expect(result.code).toBe(1);
    expect(registrations).toBe(1);
    expect(result.err).toContain("Check the registration result before retrying");
    expect(result.out).toBe("");
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally { hub.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 15000);

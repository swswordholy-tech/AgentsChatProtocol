/**
 * Integration guard for the identity/registration policy.
 *
 * Unit tests cover the decision function, but they cannot catch the failure that
 * actually shipped: the register call site was hoisted above apiFetch's `const`
 * dependencies, so every /api/account/register threw a TDZ ReferenceError that the
 * surrounding catch reported as "Server unreachable". Registration was silently dead
 * and no unit test noticed. The only probe that proves the claim is one that COUNTS
 * REAL HTTP CALLS against a hub we control.
 *
 * Safety: the hub URL is pinned to a local mock via BOTH --url and AGENTCHAT_REST_URL,
 * and HOME is a throwaway temp dir. Registration creates real, undeletable accounts,
 * so this test must never be able to reach production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
let calls: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}`);
      if (req.method === "POST" && u.pathname === "/api/account/register") {
        return Response.json({ id: "srv-assigned-id", key: "ac_mock_key" });
      }
      return Response.json({});
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});
afterAll(() => hub.stop(true));

const registerCalls = () => calls.filter((c) => c.includes("/api/account/register")).length;

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const callTool = (id: number, name: string, args: any = {}) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** Spawn the real server against the mock hub; send frames one at a time, awaiting each. */
function drive(args: string[], home: string, frames: any[], waitMs = 3000) {
  return new Promise<{ res: Map<number, any>; err: string; code: number | null }>((done) => {
    const child = spawn(process.execPath, [ENTRY, "--url", BASE, ...args], {
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        AGENTCHAT_NO_PROXY: "1",
        AGENTCHAT_REST_URL: BASE, // belt-and-suspenders: never production
        AGENTCHAT_URL: "ws://127.0.0.1:1/ws", // dead WS; we only exercise stdio
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "", code: number | null = null;
    const res = new Map<number, any>();
    child.stdout.on("data", (d) => {
      out += d;
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line) try { const m = JSON.parse(line); if (m.id !== undefined) res.set(m.id, m); } catch {}
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (c) => { code = c; });
    (async () => {
      for (const f of frames) {
        child.stdin.write(JSON.stringify(f) + "\n");
        if (f.id === undefined) continue;
        // Await this id before sending the next — otherwise an async handler (whoami
        // awaits REST) interleaves with a later frame (switch_profile) and we'd assert
        // on the wrong snapshot.
        const deadline = Date.now() + 2000;
        while (!res.has(f.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      }
    })();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done({ res, err, code }); }, waitMs);
  });
}

const freshHome = (tag: string) => mkdtempSync(join(tmpdir(), `acid-${tag}-`));

/** Everything the run persisted under a config dir ([] if the dir was never created). */
const written = (home: string, dir: string) => {
  const p = join(home, dir);
  return existsSync(p) ? readdirSync(p).sort() : [];
};

describe("identity policy, end-to-end against a mock hub", () => {
  test("bare start registers NOTHING and still answers tools/list", async () => {
    calls = [];
    const home = freshHome("bare");
    const { res, err } = await drive([], home, [INIT, INITED, LIST]);

    expect(registerCalls()).toBe(0);
    // "Writes nothing" is a NEW guarantee, not prior behavior: on 0.29.1 a bare-ish run
    // still persisted a dev-token profile (the register-failure fallback). Pin it hard —
    // nothing may land in EITHER config dir, incl. the legacy one nameToPath falls back to.
    expect(written(home, ".agentschat")).toEqual([]);
    expect(written(home, ".agentchat")).toEqual([]);
    expect(err).toMatch(/Refusing to auto-register/);
    // Introspection contract (Glama builds and runs this with zero config) must survive.
    expect(res.get(1)?.result).toBeTruthy();
    expect(res.get(2)?.result?.tools?.length ?? 0).toBeGreaterThan(0);
  }, 15_000);

  test("--name opts in: exactly one register call, profile persisted", async () => {
    calls = [];
    const home = freshHome("name");
    const { err } = await drive(["--name", "Foo"], home, [INIT, INITED, LIST]);

    // Guards the TDZ regression: a swallowed ReferenceError makes this 0.
    expect(registerCalls()).toBe(1);
    expect(err).toMatch(/Registered!/);
    expect(existsSync(join(home, ".agentschat", "Foo.json"))).toBe(true);
    // Control group for the `written(...) === []` assertions above: prove the helper
    // actually observes a persisted profile, so those empty expectations aren't vacuous.
    expect(written(home, ".agentschat")).toEqual(["Foo.json"]);
    // Control for the failure-path test below: on success we must NOT print that line.
    expect(err).not.toMatch(/Registration failed/);
  }, 15_000);

  test("a written profile is 0600 even with a stale world-readable .tmp present", async () => {
    calls = [];
    const home = freshHome("perm");
    mkdirSync(join(home, ".agentschat"), { recursive: true });
    // Crash residue from an earlier run, world-readable. writeFileSync's `mode` is ignored
    // for an existing file and renameSync preserves the source's mode, so without the
    // unlink this .tmp's 0644 would carry straight into the profile that holds the key.
    const stale = join(home, ".agentschat", "Foo.json.tmp");
    writeFileSync(stale, "{}", { mode: 0o644 });
    chmodSync(stale, 0o644);

    const { err } = await drive(["--name", "Foo"], home, [INIT, INITED, LIST]);

    const profilePath = join(home, ".agentschat", "Foo.json");
    expect(registerCalls()).toBe(1);
    expect(statSync(profilePath).mode & 0o777).toBe(0o600); // holds a live agent key
    expect(existsSync(stale)).toBe(false); // no world-readable residue left behind
    expect(err).not.toMatch(/WARNING/); // and nothing degraded silently
  }, 15_000);

  test("a failed registration prints the real cause, not a fabricated one", async () => {
    calls = [];
    // Point at a dead port (last --url wins in parseArgs) so the fetch genuinely throws.
    const home = freshHome("regfail");
    const { err } = await drive(["--name", "Foo", "--url", "http://127.0.0.1:1"], home, [INIT, INITED, LIST]);

    expect(registerCalls()).toBe(0); // never reached the hub
    // The cause must be surfaced. The old code reported every failure — including a TDZ
    // ReferenceError — as "Server unreachable", a fluent lie pointing at the network.
    expect(err).toMatch(/Registration failed: .+/);
    expect(err).not.toMatch(/Server unreachable/);
    // ...and the server still comes up, so this stays a degradation, not a crash.
    expect(err).toMatch(/MCP server started/);
  }, 15_000);

  test("dev-token profile on the shared default path is NOT re-registered", async () => {
    calls = [];
    const home = freshHome("devtok");
    mkdirSync(join(home, ".agentschat"), { recursive: true });
    writeFileSync(
      join(home, ".agentschat", "profile.json"),
      JSON.stringify({ agent_id: "local", display_name: "Ghost", token: "dev-token", capabilities: [] }),
    );
    const { err } = await drive([], home, [INIT, INITED, LIST]);

    expect(registerCalls()).toBe(0);
    expect(err).toMatch(/refusing to auto-register/i);
  }, 15_000);

  test("declared-but-missing profile exits non-zero without registering or writing", async () => {
    calls = [];
    const home = freshHome("missing");
    const { err, code } = await drive(["--profile", "nope"], home, [INIT], 2500);

    expect(registerCalls()).toBe(0);
    expect(code).toBe(1);
    expect(err).toMatch(/nope/);
    expect(written(home, ".agentschat")).toEqual([]);
    expect(written(home, ".agentchat")).toEqual([]);
  }, 15_000);

  test("whoami's `Profile file:` follows switch_profile", async () => {
    calls = [];
    const home = freshHome("switch");
    mkdirSync(join(home, ".agentschat"), { recursive: true });
    for (const n of ["alpha", "beta"]) {
      writeFileSync(
        join(home, ".agentschat", `${n}.json`),
        JSON.stringify({ agent_id: `${n}-id`, display_name: n, token: `ac_${n}`, capabilities: ["chat"] }),
      );
    }
    const { res } = await drive(
      ["--profile", "alpha"],
      home,
      [INIT, INITED, callTool(3, "whoami"), callTool(4, "switch_profile", { profile_name: "beta" }), callTool(5, "whoami")],
      5000,
    );
    const text = (id: number) => res.get(id)?.result?.content?.[0]?.text ?? "";

    expect(text(3)).toMatch(/Agent ID: alpha-id/);
    expect(text(3)).toMatch(/Profile file:.*alpha\.json/);
    expect(text(5)).toMatch(/Agent ID: beta-id/);
    expect(text(5)).toMatch(/Profile file:.*beta\.json/); // was stale: still reported alpha
  }, 15_000);
});

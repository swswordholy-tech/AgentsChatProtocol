import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

const runningLoop = {
  loop_id: "loop-1",
  channel_id: "channel-1",
  interval_ms: 300000,
  mode: "static",
  status: "active",
  paused: false,
  next_tick_ms: 1730000000000,
};
let currentLoop: any = runningLoop;

beforeEach(() => {
  currentLoop = { ...runningLoop };
});

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer ac_test_token_1234567890") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (req.method === "POST" && url.pathname === "/mcp") {
        const rpc = await req.json() as any;
        if (rpc.method === "tools/call" && rpc.params?.name === "agentschat_cloud_agent_wake_health" && rpc.params?.arguments?.channel_id === "channel-1") {
          const payload = {
            channel_id: "channel-1",
            observation_only: true,
            agents: [{
              agent_id: "cloud-peer",
              name: "Cloud Peer",
              runtime: "agy",
              cloud_status: "active",
              wake: { status: "auth_required", last_wake_at: "2026-11-12T02:00:00.000Z", last_duration_ms: 1200 },
              agent_key: "ac_should_not_leak_1234567890",
              raw_stderr: "private provider output",
            }],
            summary: { total: 1, ok: 0, auth_required: 1, timeout: 0, error: 0, unobserved: 0 },
          };
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          } });
        }
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "unsupported" } });
      }
      if (req.method === "GET" && url.pathname === "/api/loops/mine") {
        return Response.json({ loops: [currentLoop] });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/pause") {
        currentLoop = { ...runningLoop, status: "paused", paused: true, next_tick_ms: null };
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/resume") {
        currentLoop = { ...runningLoop };
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  hub.stop(true);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const callTool = (id: number, name: string, args: any = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function makeHomeWithProfile(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-loop-controls-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TestBot.json"), JSON.stringify({
    agent_id: "test-bot-loops",
    token: "ac_test_token_1234567890",
    saved_at: new Date().toISOString(),
  }));
  return home;
}

function drive(frames: any[], waitMs = 2500) {
  return new Promise<{ res: Map<number, any>; err: string }>((done) => {
    const child = spawn(process.execPath, [ENTRY, "--url", BASE, "--profile", "TestBot"], {
      env: {
        PATH: process.env.PATH!,
        HOME: makeHomeWithProfile(),
        AGENTCHAT_NO_PROXY: "1",
        AGENTCHAT_REST_URL: BASE,
        AGENTCHAT_URL: "ws://127.0.0.1:1/ws",
        AGENTSCHAT_TOOL_ONLY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const res = new Map<number, any>();
    child.stdout.on("data", (data) => {
      out += data;
      let newline: number;
      while ((newline = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, newline).trim();
        out = out.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) res.set(message.id, message);
        } catch {}
      }
    });
    child.stderr.on("data", (data) => { err += data; });
    (async () => {
      for (const frame of frames) {
        child.stdin.write(JSON.stringify(frame) + "\n");
        if (frame.id === undefined) continue;
        const deadline = Date.now() + 2000;
        while (!res.has(frame.id) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    })();
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done({ res, err });
    }, waitMs);
  });
}

describe("MCP loop controls", () => {
  test("pause_loop and resume_loop call the server and return its authoritative state", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      LIST,
      callTool(3, "pause_loop", { loop_id: "loop-1" }),
      callTool(4, "resume_loop", { loop_id: "loop-1" }),
    ]);

    const tools = res.get(2)?.result?.tools || [];
    expect(tools.some((tool: any) => tool.name === "pause_loop")).toBe(true);
    expect(tools.some((tool: any) => tool.name === "resume_loop")).toBe(true);

    const paused = JSON.parse(res.get(3)?.result?.content?.[0]?.text || "null");
    expect(paused.loop_id).toBe("loop-1");
    expect(paused.status).toBe("paused");
    expect(paused.next_tick_ms).toBeNull();

    const resumed = JSON.parse(res.get(4)?.result?.content?.[0]?.text || "null");
    expect(resumed.loop_id).toBe("loop-1");
    expect(resumed.status).toBe("active");
    expect(resumed.next_tick_ms).toBe(1730000000000);
  });

  test("cloud_agent_wake_health reuses the HTTP MCP aggregate and keeps only its safe schema", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      LIST,
      callTool(3, "cloud_agent_wake_health", { channel_id: "channel-1" }),
    ]);
    const tools = res.get(2)?.result?.tools || [];
    expect(tools.some((tool: any) => tool.name === "cloud_agent_wake_health")).toBe(true);

    const text = res.get(3)?.result?.content?.[0]?.text || "";
    const payload = JSON.parse(text);
    expect(payload).toEqual({
      channel_id: "channel-1",
      observation_only: true,
      agents: [{
        agent_id: "cloud-peer",
        name: "Cloud Peer",
        runtime: "agy",
        cloud_status: "active",
        wake: { status: "auth_required", last_wake_at: "2026-11-12T02:00:00.000Z", last_duration_ms: 1200 },
      }],
      summary: { total: 1, ok: 0, auth_required: 1, timeout: 0, error: 0, unobserved: 0 },
    });
    expect(text).not.toContain("ac_should_not_leak");
    expect(text).not.toContain("private provider output");
  });

  test("list_loops exposes paused state instead of a misleading countdown", async () => {
    currentLoop = { ...runningLoop, status: "paused", paused: true, next_tick_ms: null };
    const { res } = await drive([INIT, INITED, callTool(3, "list_loops")]);
    const text = res.get(3)?.result?.content?.[0]?.text || "";
    expect(text).toContain("loop-1");
    expect(text).toContain("paused");
    expect(text).not.toContain("next ~?m");
  });
});

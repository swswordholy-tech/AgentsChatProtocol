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
let stallMcpBody = false;
let keepStoppedLoopAlive = false;
let malformedLoopsVerification = false;
let omitCreatedLoopOnVerify = false;
let forceDeduplicatedCreate = false;
let extraLoops: any[] = [];
const memoryStore = new Map<string, { version: number; body_markdown: string; description?: string }>();

beforeEach(() => {
  currentLoop = { ...runningLoop };
  stallMcpBody = false;
  keepStoppedLoopAlive = false;
  malformedLoopsVerification = false;
  omitCreatedLoopOnVerify = false;
  forceDeduplicatedCreate = false;
  extraLoops = [];
  memoryStore.clear();
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
          if (stallMcpBody) {
            return new Response(new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":'));
              },
            }), { headers: { "Content-Type": "application/json" } });
          }
          const payload = {
            channel_id: "channel-1",
            observation_only: true,
            untrusted: true,
            agents: [{
              agent_id: "cloud-peer",
              name: "Cloud Peer sk-proj-1234567890abcdef",
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
        if (malformedLoopsVerification) return Response.json({ ok: true });
        return Response.json({ loops: [...(currentLoop ? [currentLoop] : []), ...extraLoops] });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/pause") {
        currentLoop = { ...runningLoop, status: "paused", paused: true };
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/resume") {
        currentLoop = { ...runningLoop };
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/interval") {
        const body = await req.json() as any;
        currentLoop = { ...currentLoop, interval_ms: body.interval_ms, next_tick_ms: 1730003600000 };
        return Response.json({ ok: true, loop_id: "loop-1", interval_ms: body.interval_ms });
      }
      if (req.method === "POST" && url.pathname === "/api/loops") {
        const body = await req.json() as any;
        const created = {
          loop_id: forceDeduplicatedCreate ? "loop-existing-1" : "loop-created-1",
          channel_id: body.channel_id,
          interval_ms: body.interval_ms ?? 300000,
          mode: body.mode === "prompt" ? "static" : body.mode,
          ...(body.objective_id ? { objective_id: body.objective_id } : {}),
          ...(Array.isArray(body.target_agents) ? { target_agents: body.target_agents } : {}),
          ...(typeof body.watch_idle === "boolean" ? { watch_idle: body.watch_idle } : {}),
          ...(typeof body.watch_supply === "boolean" ? { watch_supply: body.watch_supply } : {}),
          ...(typeof body.stall_minutes === "number" ? { stall_minutes: body.stall_minutes } : {}),
          status: "active",
          paused: false,
          next_tick_ms: 1730000300000,
        };
        if (!omitCreatedLoopOnVerify) {
          currentLoop = created;
        }
        return Response.json(
          { ok: true, ...(forceDeduplicatedCreate ? { deduplicated: true } : {}), loop: created },
          { status: forceDeduplicatedCreate ? 200 : 201 },
        );
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-1/stop") {
        if (!keepStoppedLoopAlive) currentLoop = null;
        return Response.json({ ok: true, stopped: "loop-1" });
      }
      if (url.pathname.startsWith("/api/memory/")) {
        const memName = decodeURIComponent(url.pathname.slice("/api/memory/".length));
        if (req.method === "PUT") {
          const body = await req.json() as any;
          const existing = memoryStore.get(memName);
          if (body.if_match_version !== undefined) {
            const currentVer = existing ? existing.version : 0;
            if (body.if_match_version !== currentVer) {
              return Response.json(
                { error: "version_conflict", code: "MEMORY_VERSION_CONFLICT", current_version: currentVer },
                { status: 409 },
              );
            }
          }
          const nextVer = (existing?.version ?? 0) + 1;
          memoryStore.set(memName, { version: nextVer, body_markdown: body.body_markdown, description: body.description });
          return Response.json({
            ok: true,
            name: memName,
            version: nextVer,
            bytes: String(body.body_markdown || "").length,
          });
        }
        if (req.method === "DELETE") {
          const existing = memoryStore.get(memName);
          const qVerRaw = url.searchParams.get("if_match_version");
          if (qVerRaw !== null) {
            const qVer = Number(qVerRaw);
            if (!existing || existing.version !== qVer) {
              return Response.json(
                { error: "version_conflict", code: "MEMORY_VERSION_CONFLICT", current_version: existing?.version ?? 0 },
                { status: 409 },
              );
            }
          }
          const deleted = memoryStore.delete(memName);
          return Response.json({ ok: true, name: memName, deleted });
        }
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
      untrusted: true,
      agents: [{
        agent_id: "cloud-peer",
        name: "Cloud Peer [REDACTED]",
        runtime: "agy",
        cloud_status: "active",
        wake: { status: "auth_required", last_wake_at: "2026-11-12T02:00:00.000Z", last_duration_ms: 1200 },
      }],
      summary: { total: 1, ok: 0, auth_required: 1, timeout: 0, error: 0, unobserved: 0 },
    });
    expect(text).not.toContain("ac_should_not_leak");
    expect(text).not.toContain("sk-proj-1234567890abcdef");
    expect(text).not.toContain("private provider output");
  });

  test("cloud_agent_wake_health times out when the response body stalls", async () => {
    stallMcpBody = true;
    const { res } = await drive([
      INIT,
      INITED,
      callTool(3, "cloud_agent_wake_health", { channel_id: "channel-1" }),
    ], 7000);
    const result = res.get(3)?.result;
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text || "").toContain("cloud_agent_wake_health error");
  }, 10000);

  test("list_loops exposes paused state instead of a misleading countdown", async () => {
    currentLoop = { ...runningLoop, status: "paused", paused: true, next_tick_ms: null };
    const { res } = await drive([INIT, INITED, callTool(3, "list_loops")]);
    const text = res.get(3)?.result?.content?.[0]?.text || "";
    expect(text).toContain("loop-1");
    expect(text).toContain("paused");
    expect(text).not.toContain("next ~?m");
  });

  test("set_loop_interval and stop_loop validate inputs and verify authoritative /api/loops/mine state", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      LIST,
      callTool(3, "set_loop_interval", { loop_id: "loop-1", interval_ms: 1000 }),
      callTool(4, "set_loop_interval", { loop_id: "../admin", interval_ms: 60000 }),
      callTool(5, "set_loop_interval", { loop_id: "loop-1", interval_ms: 3600000 }),
      callTool(6, "stop_loop", { loop_id: "loop-1" }),
    ]);

    const tools = res.get(2)?.result?.tools || [];
    const intervalTool = tools.find((tool: any) => tool.name === "set_loop_interval");
    expect(intervalTool?.inputSchema?.properties?.interval_ms).toMatchObject({
      type: "integer",
      minimum: 60000,
      maximum: 86400000,
    });
    expect(tools.some((tool: any) => tool.name === "stop_loop")).toBe(true);

    expect(res.get(3)?.result?.isError).toBe(true);
    expect(res.get(4)?.result?.isError).toBe(true);

    const updated = JSON.parse(res.get(5)?.result?.content?.[0]?.text || "null");
    expect(updated).toEqual({
      ok: true,
      loop_id: "loop-1",
      interval_ms: 3600000,
      status: "active",
      next_tick_ms: 1730003600000,
    });

    const stopped = JSON.parse(res.get(6)?.result?.content?.[0]?.text || "null");
    expect(stopped).toEqual({ ok: true, stopped: "loop-1" });
  });

  test("stop_loop fails closed when /api/loops/mine still lists the loop", async () => {
    keepStoppedLoopAlive = true;
    const { res } = await drive([
      INIT,
      INITED,
      callTool(3, "stop_loop", { loop_id: "loop-1" }),
    ]);
    expect(res.get(3)?.result?.isError).toBe(true);
    expect(res.get(3)?.result?.content?.[0]?.text || "").toContain("still present in state verification");
  });

  test("stop_loop fails closed when /api/loops/mine omits the loops array", async () => {
    malformedLoopsVerification = true;
    const { res } = await drive([
      INIT,
      INITED,
      callTool(3, "stop_loop", { loop_id: "loop-1" }),
    ]);
    expect(res.get(3)?.result?.isError).toBe(true);
    expect(res.get(3)?.result?.content?.[0]?.text || "").toContain("malformed loops payload");
  });

  test("create_loop creates or deduplicates okr_wake / okr_watch loops, verifies /api/loops/mine, and list_loops formats okr_watch", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      LIST,
      callTool(3, "create_loop", {
        channel_id: "channel-1",
        mode: "okr_wake",
        interval: "5m",
        objective_id: "obj_mwdznid5_3jvlpq3c",
        target_agents: ["@bot-a", "bot-b"],
      }),
      callTool(4, "create_loop", {
        channel_id: "channel-1",
        mode: "okr_watch",
        interval_ms: 900000,
        objective_id: "obj_mwdznid5_3jvlpq3c",
        watch_idle: true,
        watch_supply: true,
        target_agents: ["bot-a"],
      }),
      callTool(5, "list_loops"),
      callTool(6, "create_loop", {
        channel_id: "channel-1",
        mode: "prompt",
        prompt: "leaked sk-proj-1234567890abcdefghijklmnop",
      }),
    ]);

    const tools = res.get(2)?.result?.tools || [];
    expect(tools.some((tool: any) => tool.name === "create_loop")).toBe(true);

    const createdWake = JSON.parse(res.get(3)?.result?.content?.[0]?.text || "null");
    expect(createdWake).toEqual({
      ok: true,
      deduplicated: false,
      loop: {
        loop_id: "loop-created-1",
        channel_id: "channel-1",
        mode: "okr_wake",
        objective_id: "obj_mwdznid5_3jvlpq3c",
        interval_ms: 300000,
        target_agents: ["bot-a", "bot-b"],
        status: "active",
        paused: false,
        next_tick_ms: 1730000300000,
      },
    });

    const createdWatch = JSON.parse(res.get(4)?.result?.content?.[0]?.text || "null");
    expect(createdWatch.loop.mode).toBe("okr_watch");
    expect(createdWatch.loop.watch_idle).toBe(true);
    expect(createdWatch.loop.watch_supply).toBe(true);

    const listedText = res.get(5)?.result?.content?.[0]?.text || "";
    expect(listedText).toContain("okr_watch(+idle+supply) → obj_mwdznid5_3jvlpq3c @[bot-a]");

    expect(res.get(6)?.result?.isError).toBe(true);
    expect(res.get(6)?.result?.content?.[0]?.text || "").toContain("appears to contain a secret");
  });

  test("create_loop surfaces deduplicated:true when server returns an existing loop", async () => {
    forceDeduplicatedCreate = true;
    const { res: dedupRes } = await drive([
      INIT,
      INITED,
      callTool(3, "create_loop", {
        channel_id: "channel-1",
        mode: "okr_wake",
        objective_id: "obj_mwdznid5_3jvlpq3c",
      }),
    ]);
    const dedupJson = JSON.parse(dedupRes.get(3)?.result?.content?.[0]?.text || "null");
    expect(dedupJson.ok).toBe(true);
    expect(dedupJson.deduplicated).toBe(true);
    expect(dedupJson.loop.loop_id).toBe("loop-existing-1");
  });

  test("create_loop fails closed if absent from /api/loops/mine", async () => {
    omitCreatedLoopOnVerify = true;
    const { res: missingRes } = await drive([
      INIT,
      INITED,
      callTool(3, "create_loop", {
        channel_id: "channel-1",
        mode: "okr_wake",
        objective_id: "obj_mwdznid5_3jvlpq3c",
      }),
    ]);
    expect(missingRes.get(3)?.result?.isError).toBe(true);
    expect(missingRes.get(3)?.result?.content?.[0]?.text || "").toContain("absent from state verification");
  });

  test("create_loop supports stall_minutes, list_loops filters by mode/objective_id/status/channel_id, and delete_memory + save_memory enforce CAS", async () => {
    extraLoops = [
      {
        loop_id: "loop-wake-other",
        channel_id: "channel-2",
        interval_ms: 300000,
        mode: "okr_wake",
        objective_id: "obj_other_999",
        status: "paused",
        paused: true,
        next_tick_ms: 1730000300000,
      },
    ];
    const { res } = await drive([
      INIT,
      INITED,
      LIST,
      callTool(3, "create_loop", {
        channel_id: "channel-1",
        mode: "okr_watch",
        interval: "15m",
        objective_id: "obj_mweop0bd_5nsf2366",
        watch_idle: true,
        watch_supply: true,
        stall_minutes: 20,
      }),
      callTool(4, "list_loops", {
        channel_id: "channel-1",
        mode: "okr_watch",
        objective_id: "obj_mweop0bd_5nsf2366",
        status: "active",
      }),
      callTool(5, "list_loops", {
        mode: "okr_wake",
        status: "active",
      }),
      callTool(6, "save_memory", {
        name: "sprint-note",
        body: "# Sprint Note v1",
        if_match_version: 0,
      }),
      callTool(7, "save_memory", {
        name: "sprint-note",
        body: "# Stale write",
        if_match_version: 0,
      }),
      callTool(8, "delete_memory", {
        name: "sprint-note",
        if_match_version: 2,
      }),
      callTool(9, "delete_memory", {
        name: "sprint-note",
        if_match_version: 1,
      }),
      callTool(10, "delete_memory", {
        name: "sprint-note",
      }),
      callTool(11, "delete_memory", {
        name: "sprint-note",
        allow_missing: true,
      }),
    ]);

    const tools = res.get(2)?.result?.tools || [];
    expect(tools.some((tool: any) => tool.name === "delete_memory")).toBe(true);

    const createdWatch = JSON.parse(res.get(3)?.result?.content?.[0]?.text || "null");
    expect(createdWatch.ok).toBe(true);
    expect(createdWatch.loop.stall_minutes).toBe(20);

    const filteredWatchText = res.get(4)?.result?.content?.[0]?.text || "";
    expect(filteredWatchText).toContain("1 loop(s):");
    expect(filteredWatchText).toContain("okr_watch(+idle+supply+stall=20m) → obj_mweop0bd_5nsf2366");
    expect(filteredWatchText).not.toContain("loop-wake-other");

    expect(res.get(5)?.result?.content?.[0]?.text).toBe("No matching loops found.");

    expect(res.get(6)?.result?.isError).toBeUndefined();
    expect(res.get(6)?.result?.content?.[0]?.text || "").toContain('Saved memory "sprint-note" (v1');

    expect(res.get(7)?.result?.isError).toBe(true);
    expect(res.get(7)?.result?.content?.[0]?.text || "").toContain("409");

    expect(res.get(8)?.result?.isError).toBe(true);
    expect(res.get(8)?.result?.content?.[0]?.text || "").toContain("409");

    const deletedJson = JSON.parse(res.get(9)?.result?.content?.[0]?.text || "null");
    expect(deletedJson).toEqual({ ok: true, name: "sprint-note", deleted: true });

    expect(res.get(10)?.result?.isError).toBe(true);
    expect(res.get(10)?.result?.content?.[0]?.text || "").toContain("does not exist");

    const idempotentJson = JSON.parse(res.get(11)?.result?.content?.[0]?.text || "null");
    expect(idempotentJson).toEqual({ ok: true, name: "sprint-note", deleted: false });
  });
});

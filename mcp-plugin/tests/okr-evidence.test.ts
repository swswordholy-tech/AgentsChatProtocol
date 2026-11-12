import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";
let receivedPatches: Array<{ taskId: string; body: any }> = [];

beforeEach(() => {
  receivedPatches = [];
});

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer ac_test_token_1234567890") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const match = url.pathname.match(/^\/api\/okr\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && match) {
        const body = await req.json();
        const taskId = decodeURIComponent(match[1]);
        receivedPatches.push({ taskId, body });
        return Response.json({
          ok: true,
          task: {
            id: taskId,
            status: body.status ?? "doing",
            evidence: Array.isArray(body.evidence) && body.evidence.length > 0
              ? body.evidence.map((ev: any) => ({
                  ...ev,
                  by: "test-bot-okr",
                  at: "2026-11-12T19:35:00.000Z",
                }))
              : undefined,
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/okr/objectives") {
        const body = await req.json() as any;
        return Response.json({
          ok: true,
          objective: {
            id: "obj_created_123",
            title: body.title,
            horizon: body.horizon,
            discussion_channel_id: body.discussion_channel_id ?? null,
          },
        });
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
const callTool = (id: number, name: string, args: any = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function makeHomeWithProfile(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-okr-evidence-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TestBot.json"), JSON.stringify({
    agent_id: "test-bot-okr",
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

describe("MCP okr_update_task structured evidence", () => {
  test("forwards normalized evidence, supports [] clear, and blocks secret leaks client-side", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      callTool(4, "okr_update_task", {
        task_id: "task_ev_1",
        status: "done",
        evidence: [
          { kind: "commit", ref: " 548958af ", note: "  server TaskEvidence  " },
          { kind: "probe", ref: "bun test 145/145" },
        ],
      }),
      callTool(5, "okr_update_task", {
        task_id: "task_ev_1",
        evidence: [],
      }),
      callTool(6, "okr_update_task", {
        task_id: "task_ev_1",
        evidence: [{ kind: "external", ref: "ac_live_secret_token_1234567890" }],
      }),
      callTool(7, "okr_create_objective", {
        title: "Guarded Room Objective",
        horizon: "week",
        discussion_channel_id: "chan-sprint-1",
      }),
      callTool(8, "okr_create_objective", {
        title: "DM Objective",
        horizon: "week",
        discussion_channel_id: "dm-owner1",
      }),
    ]);

    const tools = res.get(3)?.result?.tools || [];
    const okrUpdateDef = tools.find((t: any) => t.name === "okr_update_task");
    expect(okrUpdateDef?.inputSchema?.properties?.evidence?.type).toBe("array");
    expect(okrUpdateDef?.inputSchema?.properties?.evidence?.items?.properties?.kind?.enum).toEqual([
      "commit",
      "deploy",
      "probe",
      "doc",
      "external",
      "rollout",
    ]);

    expect(res.get(4)?.result?.isError).toBeUndefined();
    expect(res.get(5)?.result?.isError).toBeUndefined();
    expect(res.get(6)?.result?.isError).toBe(true);
    expect(res.get(6)?.result?.content?.[0]?.text).toContain("appears to contain a secret or token");

    expect(receivedPatches).toHaveLength(2);
    expect(receivedPatches[0]).toEqual({
      taskId: "task_ev_1",
      body: {
        status: "done",
        evidence: [
          { kind: "commit", ref: "548958af", note: "server TaskEvidence" },
          { kind: "probe", ref: "bun test 145/145" },
        ],
      },
    });
    expect(receivedPatches[1]).toEqual({
      taskId: "task_ev_1",
      body: {
        evidence: [],
      },
    });

    const createdRoomRaw = String(res.get(7)?.result?.content?.[0]?.text || "").replace(/^Created:\s*/, "");
    const createdRoom = JSON.parse(createdRoomRaw);
    expect(createdRoom.loop_guard_hint).toEqual({
      okr_wake_armed: false,
      recommended_tool: "create_loop",
      recommended_arguments: {
        channel_id: "chan-sprint-1",
        mode: "okr_wake",
        interval: "5m",
        objective_id: "obj_created_123",
      },
    });

    const createdDmRaw = String(res.get(8)?.result?.content?.[0]?.text || "").replace(/^Created:\s*/, "");
    const createdDm = JSON.parse(createdDmRaw);
    expect(createdDm.loop_guard_hint).toBeUndefined();
  });
});

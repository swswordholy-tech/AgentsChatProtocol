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
let receivedObjectives: any[] = [];
let receivedObjectivePatches: Array<{ objectiveId: string; body: any }> = [];
let receivedArchivedObjectives: Array<{ objectiveId: string; body: any }> = [];
let receivedAddedTasks: Array<{ objectiveId: string; body: any }> = [];
let receivedKrPatches: Array<{ krId: string; body: any }> = [];
let receivedKrProgressPatches: Array<{ krId: string; body: any }> = [];
let legacyIgnoreAppend = false;
let storedEvidenceByTask: Record<string, any[]> = {};
let storedContributesByTask: Record<string, string[]> = {};

beforeEach(() => {
  receivedPatches = [];
  receivedObjectives = [];
  receivedObjectivePatches = [];
  receivedArchivedObjectives = [];
  receivedAddedTasks = [];
  receivedKrPatches = [];
  receivedKrProgressPatches = [];
  legacyIgnoreAppend = false;
  storedEvidenceByTask = {};
  storedContributesByTask = {};
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
        const body = await req.json() as any;
        const taskId = decodeURIComponent(match[1]);
        receivedPatches.push({ taskId, body });
        let nextEv = storedEvidenceByTask[taskId];
        if (Array.isArray(body.evidence)) {
          nextEv = body.evidence.map((ev: any) => ({
            ...ev,
            by: ev.by ?? "test-bot-okr",
            at: ev.at ?? "2026-11-12T19:35:00.000Z",
          }));
          storedEvidenceByTask[taskId] = nextEv;
        } else if (!legacyIgnoreAppend && Array.isArray(body.append_evidence)) {
          const base = [...(nextEv ?? [])];
          for (const ev of body.append_evidence) {
            const idx = base.findIndex((item) => item.kind === ev.kind && item.ref === ev.ref);
            const stamped = { ...ev, by: "test-bot-okr", at: "2026-11-12T19:36:00.000Z" };
            if (idx >= 0) base[idx] = stamped;
            else base.push(stamped);
          }
          nextEv = base;
          storedEvidenceByTask[taskId] = nextEv;
        }
        if (Array.isArray(body.contributes_to)) {
          storedContributesByTask[taskId] = body.contributes_to;
        }
        return Response.json({
          ok: true,
          task: {
            id: taskId,
            status: body.status ?? "doing",
            assignee: body.assignee ?? "test-bot-okr",
            updated_at: "2026-11-12T19:36:00.000Z",
            contributes_to: storedContributesByTask[taskId],
            evidence: nextEv && nextEv.length > 0 ? nextEv : undefined,
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/okr/objectives") {
        const body = await req.json() as any;
        receivedObjectives.push(body);
        return Response.json({
          ok: true,
          objective: {
            id: "obj_created_123",
            title: body.title,
            horizon: body.horizon,
            discussion_channel_id: body.discussion_channel_id ?? null,
            narrative: body.narrative,
            linked_channel_docs: body.linked_channel_docs,
          },
        });
      }
      const addTaskMatch = url.pathname.match(/^\/api\/okr\/objectives\/([^/]+)\/tasks$/);
      if (req.method === "POST" && addTaskMatch) {
        const body = await req.json() as any;
        const objectiveId = decodeURIComponent(addTaskMatch[1]);
        receivedAddedTasks.push({ objectiveId, body });
        return Response.json({
          ok: true,
          task: {
            id: "task_created_456",
            objective_id: objectiveId,
            title: body.title,
            assignee: body.assignee,
            depends_on: body.depends_on ?? null,
            linked_channel_docs: body.linked_channel_docs,
          },
        });
      }
      const archiveObjMatch = url.pathname.match(/^\/api\/okr\/objectives\/([^/]+)\/archive$/);
      if (req.method === "POST" && archiveObjMatch) {
        const body = await req.json() as any;
        const objectiveId = decodeURIComponent(archiveObjMatch[1]);
        receivedArchivedObjectives.push({ objectiveId, body });
        return Response.json({
          ok: true,
          objective: {
            id: objectiveId,
            archived: true,
            completion_summary: body.completion_summary,
          },
        });
      }
      const patchObjMatch = url.pathname.match(/^\/api\/okr\/objectives\/([^/]+)$/);
      if (req.method === "PATCH" && patchObjMatch) {
        const body = await req.json() as any;
        const objectiveId = decodeURIComponent(patchObjMatch[1]);
        receivedObjectivePatches.push({ objectiveId, body });
        return Response.json({
          ok: true,
          objective: {
            id: objectiveId,
            title: body.title ?? "Existing Title",
            status: body.status ?? "active",
            horizon: body.horizon ?? "week",
            due: body.due === "" ? undefined : body.due,
            narrative: body.narrative === "" ? undefined : body.narrative,
            completion_summary: body.completion_summary === "" ? undefined : body.completion_summary,
            linked_channel_docs: Array.isArray(body.linked_channel_docs) && body.linked_channel_docs.length === 0
              ? undefined
              : body.linked_channel_docs,
          },
        });
      }
      const patchKrProgressMatch = url.pathname.match(/^\/api\/okr\/krs\/([^/]+)\/progress$/);
      if (req.method === "PATCH" && patchKrProgressMatch) {
        const body = await req.json() as any;
        const krId = decodeURIComponent(patchKrProgressMatch[1]);
        receivedKrProgressPatches.push({ krId, body });
        return Response.json({
          ok: true,
          kr: {
            id: krId,
            current: body.current,
            risk_level: body.risk_level ?? "green",
            updated_at: "2026-11-13T08:40:00.000Z",
          },
        });
      }
      const patchKrMatch = url.pathname.match(/^\/api\/okr\/krs\/([^/]+)$/);
      if (req.method === "PATCH" && patchKrMatch) {
        const body = await req.json() as any;
        const krId = decodeURIComponent(patchKrMatch[1]);
        receivedKrPatches.push({ krId, body });
        return Response.json({
          ok: true,
          kr: {
            id: krId,
            title: body.title ?? "Existing KR",
            metric_type: body.metric_type ?? "count",
            target: body.target ?? 3,
            current: body.current ?? 1,
            risk_level: body.risk_level ?? "green",
            updated_at: "2026-11-13T08:41:00.000Z",
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

  test("supports atomic append_evidence + if_match_updated_at and falls back losslessly on legacy servers", async () => {
    storedEvidenceByTask["task_ev_modern"] = [
      { kind: "commit", ref: "aaa111", note: "initial", by: "peer", at: "2026-11-12T18:00:00.000Z" },
    ];
    const modern = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      callTool(3, "okr_update_task", {
        task_id: "task_ev_modern",
        append_evidence: [{ kind: "probe", ref: " 19/19 pass ", note: " cas verified " }],
        if_match_updated_at: " 2026-11-12T18:00:00.000Z ",
      }),
      callTool(4, "okr_update_task", {
        task_id: "task_ev_modern",
        evidence: [],
        append_evidence: [{ kind: "doc", ref: "spec-1" }],
      }),
      callTool(5, "okr_update_task", {
        task_id: "task_ev_modern",
        append_evidence: [],
      }),
      callTool(6, "okr_update_task", {
        task_id: "task_ev_modern",
        append_evidence: [{ kind: "doc", ref: "agent_key_secret_987654321" }],
      }),
    ], 1500);

    expect(modern.res.get(3)?.result?.isError).toBeUndefined();
    expect(modern.res.get(4)?.result?.isError).toBe(true);
    expect(modern.res.get(4)?.result?.content?.[0]?.text).toContain("cannot pass both evidence and append_evidence");
    expect(modern.res.get(5)?.result?.isError).toBe(true);
    expect(modern.res.get(5)?.result?.content?.[0]?.text).toContain("non-empty array");
    expect(modern.res.get(6)?.result?.isError).toBe(true);
    expect(modern.res.get(6)?.result?.content?.[0]?.text).toContain("appears to contain a secret");
    expect(receivedPatches).toHaveLength(1);
    expect(receivedPatches[0]).toEqual({
      taskId: "task_ev_modern",
      body: {
        append_evidence: [{ kind: "probe", ref: "19/19 pass", note: "cas verified" }],
        if_match_updated_at: "2026-11-12T18:00:00.000Z",
      },
    });
  });

  test("falls back losslessly when a legacy server ignores append_evidence without overwriting capped history", async () => {
    legacyIgnoreAppend = true;
    storedEvidenceByTask["task_ev_legacy"] = [
      { kind: "commit", ref: "legacy-sha", note: "seed", by: "peer", at: "2026-11-12T18:00:00.000Z" },
    ];
    storedEvidenceByTask["task_ev_full"] = Array.from({ length: 10 }, (_, i) => ({
      kind: "commit",
      ref: `sha-${i}`,
      by: "peer",
      at: "2026-11-12T18:00:00.000Z",
    }));

    const legacy = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      callTool(3, "okr_update_task", {
        task_id: "task_ev_legacy",
        status: "done",
        append_evidence: [{ kind: "deploy", ref: "rev-00999", note: "live" }],
      }),
      callTool(4, "okr_update_task", {
        task_id: "task_ev_full",
        append_evidence: [{ kind: "probe", ref: "overflow" }],
      }),
    ], 1500);

    expect(legacy.res.get(3)?.result?.isError).toBeUndefined();
    expect(legacy.res.get(4)?.result?.isError).toBe(true);
    expect(legacy.res.get(4)?.result?.content?.[0]?.text).toContain("evidence_cap_exceeded");
    expect(receivedPatches).toHaveLength(3);
    expect(receivedPatches[1]).toEqual({
      taskId: "task_ev_legacy",
      body: {
        evidence: [
          { kind: "commit", ref: "legacy-sha", note: "seed" },
          { kind: "deploy", ref: "rev-00999", note: "live" },
        ],
        if_match_updated_at: "2026-11-12T19:36:00.000Z",
      },
    });
  });

  test("attaches kr_progress_hint when marking a task done with linked contributes_to KRs", async () => {
    storedContributesByTask["task_with_kr"] = ["kr_alpha", "kr_beta"];
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      callTool(3, "okr_update_task", {
        task_id: "task_with_kr",
        status: "doing",
      }),
      callTool(4, "okr_update_task", {
        task_id: "task_with_kr",
        status: "done",
      }),
    ], 1500);

    const doingRaw = String(out.res.get(3)?.result?.content?.[0]?.text || "").replace(/^Updated:\s*/, "");
    const doingParsed = JSON.parse(doingRaw);
    expect(doingParsed.kr_progress_hint).toBeUndefined();

    const doneRaw = String(out.res.get(4)?.result?.content?.[0]?.text || "").replace(/^Updated:\s*/, "");
    const doneParsed = JSON.parse(doneRaw);
    expect(doneParsed.kr_progress_hint).toEqual({
      contributes_to: ["kr_alpha", "kr_beta"],
      recommended_tool: "okr_set_kr_progress",
      note: "Task marked done; remember to report quantitative progress for linked KR(s): kr_alpha, kr_beta.",
    });
  });

  test("okr_add_kr and okr_set_kr_progress enforce client-side secret screening and metric bounds before network IO", async () => {
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      callTool(3, "okr_add_kr", {
        objective_id: "obj_1",
        title: "Leak agent_key_supersecret12345",
        metric_type: "count",
        target: 5,
      }),
      callTool(4, "okr_add_kr", {
        objective_id: "obj_1",
        title: "Bool bad current",
        metric_type: "bool",
        current: 2,
        target: 1,
      }),
      callTool(5, "okr_add_kr", {
        objective_id: "obj_1",
        title: "Percent bad current",
        metric_type: "percent",
        current: 120,
        target: 100,
      }),
      callTool(6, "okr_set_kr_progress", {
        kr_id: "kr_1",
        current: -5,
        risk_level: "green",
      }),
    ], 1500);

    for (const id of [3, 4, 5, 6]) {
      expect(out.res.get(id)?.result?.isError).toBe(true);
    }
    expect(out.res.get(3)?.result?.content?.[0]?.text).toContain("secret or token");
    expect(out.res.get(4)?.result?.content?.[0]?.text).toContain("bool current must be 0 or 1");
    expect(out.res.get(5)?.result?.content?.[0]?.text).toContain("percent current must be <= 100");
    expect(out.res.get(6)?.result?.content?.[0]?.text).toContain("0..1000000");
  });

  test("okr_update_task supports assignee normalization, contributes_to bind/dedup/clear, and blocks email/secret/oversize inputs client-side", async () => {
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      callTool(4, "okr_update_task", {
        task_id: "task_gov_1",
        assignee: " @codex-staff-engineer-ca7590 ",
        contributes_to: [" kr_1 ", "kr_2", "kr_1"],
      }),
      callTool(5, "okr_update_task", {
        task_id: "task_gov_1",
        contributes_to: [],
      }),
      callTool(6, "okr_update_task", {
        task_id: "task_gov_1",
        assignee: "boss@example.com",
      }),
      callTool(7, "okr_update_task", {
        task_id: "task_gov_1",
        contributes_to: ["kr_1", "kr_2", "kr_3", "kr_4", "kr_5", "kr_6"],
      }),
      callTool(8, "okr_update_task", {
        task_id: "task_gov_1",
        contributes_to: ["agent_key_supersecret123456"],
      }),
      callTool(9, "okr_add_task", {
        objective_id: "obj_1",
        title: "Email assignee blocked",
        assignee: "human@company.io",
      }),
    ], 1800);

    const tools = out.res.get(3)?.result?.tools || [];
    const okrUpdateDef = tools.find((t: any) => t.name === "okr_update_task");
    expect(okrUpdateDef?.inputSchema?.properties?.contributes_to?.type).toBe("array");
    expect(okrUpdateDef?.inputSchema?.properties?.contributes_to?.maxItems).toBe(5);

    expect(out.res.get(4)?.result?.isError).toBeUndefined();
    expect(out.res.get(5)?.result?.isError).toBeUndefined();
    for (const id of [6, 7, 8, 9]) {
      expect(out.res.get(id)?.result?.isError).toBe(true);
    }
    expect(out.res.get(6)?.result?.content?.[0]?.text).toContain("never an email address");
    expect(out.res.get(7)?.result?.content?.[0]?.text).toContain("exceeds max 5");
    expect(out.res.get(8)?.result?.content?.[0]?.text).toContain("secret or token");
    expect(out.res.get(9)?.result?.content?.[0]?.text).toContain("never an email address");

    expect(receivedPatches).toHaveLength(2);
    expect(receivedPatches[0]).toEqual({
      taskId: "task_gov_1",
      body: {
        assignee: "codex-staff-engineer-ca7590",
        contributes_to: ["kr_1", "kr_2"],
      },
    });
    expect(receivedPatches[1]).toEqual({
      taskId: "task_gov_1",
      body: {
        contributes_to: [],
      },
    });
  });

  test("okr_create_objective, okr_add_task, and okr_update_task support linked_channel_docs and validated depends_on while rejecting self-deps, DM channels, and secrets", async () => {
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      callTool(4, "okr_create_objective", {
        title: "Room Objective with Docs",
        horizon: "week",
        discussion_channel_id: "room-alpha",
        narrative: "  Ship clean DAG + skill binding  ",
        linked_channel_docs: [
          { channel_id: " room-alpha ", doc_id: " skill-release " },
          { channel_id: "room-alpha", doc_id: "skill-release" },
        ],
      }),
      callTool(5, "okr_add_task", {
        objective_id: "obj_created_123",
        title: "Implement downstream step",
        assignee: "@claude-code-live",
        depends_on: [" task_up_1 ", "task_up_2", "task_up_1"],
        linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "spec-v2" }],
      }),
      callTool(6, "okr_update_task", {
        task_id: "task_dag_1",
        depends_on: ["task_up_2"],
        linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "runbook-1" }],
      }),
      callTool(7, "okr_update_task", {
        task_id: "task_dag_1",
        depends_on: [],
        linked_channel_docs: [],
      }),
      callTool(8, "okr_update_task", {
        task_id: "task_dag_1",
        depends_on: ["task_dag_1"],
      }),
      callTool(9, "okr_create_objective", {
        title: "Missing discussion channel",
        horizon: "week",
        linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "doc-1" }],
      }),
      callTool(10, "okr_create_objective", {
        title: "Mismatched channel",
        horizon: "week",
        discussion_channel_id: "room-alpha",
        linked_channel_docs: [{ channel_id: "room-beta", doc_id: "doc-1" }],
      }),
      callTool(11, "okr_update_task", {
        task_id: "task_dag_1",
        linked_channel_docs: [{ channel_id: "dm-secret", doc_id: "doc-1" }],
      }),
      callTool(12, "okr_create_objective", {
        title: "Secret narrative",
        horizon: "week",
        narrative: "Token agent_key_supersecret123456",
      }),
    ], 2200);

    const tools = out.res.get(3)?.result?.tools || [];
    const createObjDef = tools.find((t: any) => t.name === "okr_create_objective");
    const addTaskDef = tools.find((t: any) => t.name === "okr_add_task");
    const updateTaskDef = tools.find((t: any) => t.name === "okr_update_task");
    expect(createObjDef?.inputSchema?.properties?.linked_channel_docs?.maxItems).toBe(10);
    expect(addTaskDef?.inputSchema?.properties?.linked_channel_docs?.maxItems).toBe(10);
    expect(updateTaskDef?.inputSchema?.properties?.linked_channel_docs?.maxItems).toBe(10);
    expect(updateTaskDef?.inputSchema?.properties?.depends_on?.maxItems).toBe(20);

    for (const id of [4, 5, 6, 7]) {
      expect(out.res.get(id)?.result?.isError).toBeUndefined();
    }
    for (const id of [8, 9, 10, 11, 12]) {
      expect(out.res.get(id)?.result?.isError).toBe(true);
    }
    expect(out.res.get(8)?.result?.content?.[0]?.text).toContain("cannot reference the task itself");
    expect(out.res.get(9)?.result?.content?.[0]?.text).toContain("discussion_channel_id is required");
    expect(out.res.get(10)?.result?.content?.[0]?.text).toContain("must match discussion_channel_id");
    expect(out.res.get(11)?.result?.content?.[0]?.text).toContain("non-DM room ID");
    expect(out.res.get(12)?.result?.content?.[0]?.text).toContain("secret or token");

    expect(receivedObjectives).toEqual([
      {
        title: "Room Objective with Docs",
        horizon: "week",
        discussion_channel_id: "room-alpha",
        narrative: "Ship clean DAG + skill binding",
        linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "skill-release" }],
      },
    ]);
    expect(receivedAddedTasks).toEqual([
      {
        objectiveId: "obj_created_123",
        body: {
          title: "Implement downstream step",
          assignee: "claude-code-live",
          depends_on: ["task_up_1", "task_up_2"],
          linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "spec-v2" }],
        },
      },
    ]);
    expect(receivedPatches).toEqual([
      {
        taskId: "task_dag_1",
        body: {
          depends_on: ["task_up_2"],
          linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "runbook-1" }],
        },
      },
      {
        taskId: "task_dag_1",
        body: {
          depends_on: [],
          linked_channel_docs: [],
        },
      },
    ]);
  });

  test("okr_update_objective and archive_objective support full lifecycle, metadata/docs clear, and block secrets or >280 summaries", async () => {
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      callTool(4, "okr_update_objective", {
        objective_id: " obj_gov_1 ",
        title: "  Updated Objective Governance  ",
        status: "done",
        horizon: "month",
        due: " 2026-11-30 ",
        narrative: "  Room lifecycle closed  ",
        completion_summary: "  3/3 KRs shipped cleanly  ",
        linked_channel_docs: [
          { channel_id: " room-alpha ", doc_id: " skill-gov " },
          { channel_id: "room-alpha", doc_id: "skill-gov" },
        ],
      }),
      callTool(5, "okr_update_objective", {
        objective_id: "obj_gov_1",
        due: "",
        narrative: "",
        completion_summary: "",
        linked_channel_docs: [],
      }),
      callTool(6, "archive_objective", {
        objective_id: " obj_gov_1 ",
        completion_summary: "  Archived cleanly within 280 chars  ",
      }),
      callTool(7, "okr_update_objective", {
        objective_id: "obj_gov_1",
      }),
      callTool(8, "okr_update_objective", {
        objective_id: "obj_gov_1",
        title: "Token leak ac_live_secret_token_999999",
      }),
      callTool(9, "okr_update_objective", {
        objective_id: "obj_gov_1",
        linked_channel_docs: [
          { channel_id: "room-alpha", doc_id: "doc-1" },
          { channel_id: "room-beta", doc_id: "doc-2" },
        ],
      }),
      callTool(10, "archive_objective", {
        objective_id: "obj_gov_1",
        completion_summary: "x".repeat(281),
      }),
      callTool(11, "archive_objective", {
        objective_id: "obj_gov_1",
        completion_summary: "Secret agent_key_supersecret123456",
      }),
    ], 2400);

    const tools = out.res.get(3)?.result?.tools || [];
    const updateObjDef = tools.find((t: any) => t.name === "okr_update_objective");
    const archiveObjDef = tools.find((t: any) => t.name === "archive_objective");
    expect(updateObjDef?.inputSchema?.properties?.status?.enum).toEqual(["active", "done", "abandoned"]);
    expect(updateObjDef?.inputSchema?.properties?.horizon?.enum).toEqual(["week", "month", "Q"]);
    expect(updateObjDef?.inputSchema?.properties?.linked_channel_docs?.maxItems).toBe(10);
    expect(archiveObjDef?.inputSchema?.properties?.completion_summary?.maxLength).toBe(280);

    for (const id of [4, 5, 6]) {
      expect(out.res.get(id)?.result?.isError).toBeUndefined();
    }
    for (const id of [7, 8, 9, 10, 11]) {
      expect(out.res.get(id)?.result?.isError).toBe(true);
    }
    expect(out.res.get(7)?.result?.content?.[0]?.text).toContain("at least one mutable field");
    expect(out.res.get(8)?.result?.content?.[0]?.text).toContain("secret or token");
    expect(out.res.get(9)?.result?.content?.[0]?.text).toContain("same channel_id");
    expect(out.res.get(10)?.result?.content?.[0]?.text).toContain("exceeds max 280 chars");
    expect(out.res.get(11)?.result?.content?.[0]?.text).toContain("secret or token");

    expect(receivedObjectivePatches).toEqual([
      {
        objectiveId: "obj_gov_1",
        body: {
          title: "Updated Objective Governance",
          status: "done",
          horizon: "month",
          due: "2026-11-30",
          narrative: "Room lifecycle closed",
          completion_summary: "3/3 KRs shipped cleanly",
          linked_channel_docs: [{ channel_id: "room-alpha", doc_id: "skill-gov" }],
        },
      },
      {
        objectiveId: "obj_gov_1",
        body: {
          due: "",
          narrative: "",
          completion_summary: "",
          linked_channel_docs: [],
        },
      },
    ]);
    expect(receivedArchivedObjectives).toEqual([
      {
        objectiveId: "obj_gov_1",
        body: {
          completion_summary: "Archived cleanly within 280 chars",
        },
      },
    ]);
  });

  test("okr_update_kr, okr_set_kr_progress metadata routing, and okr_update_task title/due revision & clear work end-to-end", async () => {
    const out = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "okr" }),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      callTool(4, "okr_update_kr", {
        kr_id: "kr_rev_1",
        title: " Ship 5 verified endpoints ",
        metric_type: "count",
        target: 5,
        current: 2,
        risk_level: "green",
        if_match_updated_at: "2026-11-13T08:00:00.000Z",
      }),
      callTool(5, "okr_set_kr_progress", {
        kr_id: "kr_rev_1",
        current: 3,
        risk_level: "green",
      }),
      callTool(6, "okr_set_kr_progress", {
        kr_id: "kr_rev_1",
        title: "Ship 6 verified endpoints",
        target: 6,
      }),
      callTool(7, "okr_update_task", {
        task_id: "task_meta_1",
        title: " Updated task title ",
        due: "2026-11-20T09:00:00Z",
      }),
      callTool(8, "okr_update_task", {
        task_id: "task_meta_1",
        due: "",
      }),
      callTool(9, "okr_update_task", {
        task_id: "task_meta_1",
        due: "not-an-iso-date",
      }),
      callTool(10, "okr_update_kr", {
        kr_id: "kr_rev_1",
        title: "Leak agent_key_supersecret123456",
      }),
    ], 2400);

    const tools = out.res.get(3)?.result?.tools || [];
    const updateKrDef = tools.find((t: any) => t.name === "okr_update_kr");
    const setKrProgDef = tools.find((t: any) => t.name === "okr_set_kr_progress");
    const updateTaskDef = tools.find((t: any) => t.name === "okr_update_task");
    expect(updateKrDef?.inputSchema?.required).toEqual(["kr_id"]);
    expect(setKrProgDef?.inputSchema?.required).toEqual(["kr_id"]);
    expect(updateTaskDef?.inputSchema?.properties?.title?.maxLength).toBe(200);

    for (const id of [4, 5, 6, 7, 8]) {
      expect(out.res.get(id)?.result?.isError).toBeUndefined();
    }
    for (const id of [9, 10]) {
      expect(out.res.get(id)?.result?.isError).toBe(true);
    }
    expect(out.res.get(9)?.result?.content?.[0]?.text).toContain("ISO-8601");
    expect(out.res.get(10)?.result?.content?.[0]?.text).toContain("secret or token");

    expect(receivedKrProgressPatches).toEqual([
      {
        krId: "kr_rev_1",
        body: { current: 3, risk_level: "green" },
      },
    ]);
    expect(receivedKrPatches).toEqual([
      {
        krId: "kr_rev_1",
        body: {
          title: "Ship 5 verified endpoints",
          metric_type: "count",
          target: 5,
          current: 2,
          risk_level: "green",
          if_match_updated_at: "2026-11-13T08:00:00.000Z",
        },
      },
      {
        krId: "kr_rev_1",
        body: {
          title: "Ship 6 verified endpoints",
          target: 6,
        },
      },
    ]);
    expect(receivedPatches).toEqual([
      {
        taskId: "task_meta_1",
        body: {
          title: "Updated task title",
          due: "2026-11-20T09:00:00Z",
        },
      },
      {
        taskId: "task_meta_1",
        body: {
          due: "",
        },
      },
    ]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateArchiveChannelDocInput,
  validateChannelDocIdInput,
  validateListChannelDocsInput,
  validateUpsertChannelDocInput,
} from "../src/argcheck.ts";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

interface StoredDoc {
  id: string;
  title: string;
  kind: string;
  level: number;
  bodyMarkdown: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  revisions: Array<{
    version: number;
    title: string;
    kind: string;
    level: number;
    bodyMarkdown: string;
    updatedAt: string;
    updatedBy: string;
  }>;
}

let docsByRoom: Record<string, Record<string, StoredDoc>> = {};
let recordedRequests: Array<{ method: string; path: string; search: string; ifMatch: string | null; body: any }> = [];

beforeEach(() => {
  docsByRoom = {};
  recordedRequests = [];
});

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer ac_test_token_1234567890") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const listMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/docs$/);
      if (req.method === "GET" && listMatch) {
        const channelId = decodeURIComponent(listMatch[1]);
        recordedRequests.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
        const levelParam = url.searchParams.get("level");
        const activeOnly = ["1", "true"].includes(url.searchParams.get("active_only") ?? "");
        const roomDocs = Object.values(docsByRoom[channelId] ?? {})
          .filter((d) => !levelParam || d.level === Number(levelParam))
          .filter((d) => !activeOnly || d.bodyMarkdown.length > 0)
          .map((d) => ({
            id: d.id,
            title: d.title,
            kind: d.kind,
            level: d.level,
            bodySummary: d.bodyMarkdown.slice(0, 120),
            version: d.version,
            updatedAt: d.updatedAt,
            updatedBy: d.updatedBy,
            ...(d.bodyMarkdown === "" ? { archived: true } : {}),
          }));
        return Response.json({ channel_id: channelId, docs: roomDocs });
      }
      const revMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/docs\/([^/]+)\/revisions$/);
      if (req.method === "GET" && revMatch) {
        const channelId = decodeURIComponent(revMatch[1]);
        const docId = decodeURIComponent(revMatch[2]);
        recordedRequests.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
        const doc = docsByRoom[channelId]?.[docId];
        if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ channel_id: channelId, doc_id: docId, revisions: doc.revisions });
      }
      const docMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/docs\/([^/]+)$/);
      if (docMatch) {
        const channelId = decodeURIComponent(docMatch[1]);
        const docId = decodeURIComponent(docMatch[2]);
        const ifMatch = req.headers.get("if-match");
        const room = (docsByRoom[channelId] ??= {});
        const existing = room[docId];
        if (req.method === "GET") {
          recordedRequests.push({ method: "GET", path: url.pathname, search: url.search, ifMatch, body: null });
          if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json(existing, { headers: { ETag: `"${existing.version}"` } });
        }
        if (req.method === "PUT") {
          const body = (await req.json()) as any;
          recordedRequests.push({ method: "PUT", path: url.pathname, search: url.search, ifMatch, body });
          const expected = Number(ifMatch);
          const currentVersion = existing?.version ?? 0;
          if (expected !== currentVersion) {
            return Response.json(
              { error: "version_conflict", code: "CHANNEL_DOC_VERSION_CONFLICT", current_version: currentVersion },
              { status: 409 },
            );
          }
          const revisions = existing
            ? [
                ...existing.revisions,
                {
                  version: existing.version,
                  title: existing.title,
                  kind: existing.kind,
                  level: existing.level,
                  bodyMarkdown: existing.bodyMarkdown,
                  updatedAt: existing.updatedAt,
                  updatedBy: existing.updatedBy,
                },
              ]
            : [];
          const next: StoredDoc = {
            id: docId,
            title: body.title,
            kind: body.kind,
            level: body.level,
            bodyMarkdown: body.body_markdown,
            version: currentVersion + 1,
            updatedAt: "2026-11-13T10:35:00.000Z",
            updatedBy: "test-bot-docs",
            revisions,
          };
          room[docId] = next;
          return Response.json(next, { headers: { ETag: `"${next.version}"` } });
        }
        if (req.method === "DELETE") {
          recordedRequests.push({ method: "DELETE", path: url.pathname, search: url.search, ifMatch, body: null });
          if (!existing) return Response.json({ error: "not_found", code: "CHANNEL_DOC_NOT_FOUND" }, { status: 404 });
          const expected = Number(ifMatch);
          if (!Number.isSafeInteger(expected) || expected < 1) {
            return Response.json({ error: "if_match_required", code: "CHANNEL_DOC_IF_MATCH_REQUIRED" }, { status: 428 });
          }
          if (expected !== existing.version) {
            return Response.json(
              { error: "version_conflict", code: "CHANNEL_DOC_VERSION_CONFLICT", current_version: existing.version },
              { status: 409 },
            );
          }
          const tombstone: StoredDoc = {
            ...existing,
            bodyMarkdown: "",
            version: existing.version + 1,
            updatedAt: "2026-11-13T10:36:00.000Z",
            updatedBy: "test-bot-docs",
            revisions: [
              ...existing.revisions,
              {
                version: existing.version,
                title: existing.title,
                kind: existing.kind,
                level: existing.level,
                bodyMarkdown: existing.bodyMarkdown,
                updatedAt: existing.updatedAt,
                updatedBy: existing.updatedBy,
              },
            ],
          };
          room[docId] = tombstone;
          return new Response(null, { status: 204, headers: { ETag: `"${tombstone.version}"` } });
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

function makeHomeWithProfile(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-channel-docs-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "TestBot.json"),
    JSON.stringify({
      agent_id: "test-bot-docs",
      token: "ac_test_token_1234567890",
      saved_at: new Date().toISOString(),
    }),
  );
  return home;
}

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

function drive(frames: any[], maxWaitMs = 3000) {
  return new Promise<{ res: Map<number, any>; err: string }>((done) => {
    let settled = false;
    const finish = (payload: { res: Map<number, any>; err: string }) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      done(payload);
    };
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
    child.stderr.on("data", (data) => {
      err += data;
    });
    const timer = setTimeout(() => finish({ res, err }), maxWaitMs);
    (async () => {
      for (const frame of frames) {
        child.stdin.write(JSON.stringify(frame) + "\n");
        if (frame.id === undefined) continue;
        const deadline = Date.now() + 2000;
        while (!res.has(frame.id) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      clearTimeout(timer);
      finish({ res, err });
    })();
  });
}

describe("channel_docs input validation", () => {
  test("validates list_channel_docs active_only, level, and rejects DM rooms", () => {
    expect(validateListChannelDocsInput({ chat_id: "room-alpha", level: 3, active_only: true })).toEqual({
      ok: true,
      value: { chat_id: "room-alpha", level: 3, active_only: true },
    });
    expect(validateListChannelDocsInput({ chat_id: "dm-secret" }).ok).toBe(false);
    expect(validateListChannelDocsInput({ chat_id: "room-alpha", level: 5 }).ok).toBe(false);
    expect(validateListChannelDocsInput({ chat_id: "room-alpha", active_only: "yes" }).ok).toBe(false);
  });

  test("validates archive_channel_doc positive expected_version CAS and safe doc_id", () => {
    expect(
      validateArchiveChannelDocInput({ chat_id: "room-alpha", doc_id: "skill-deploy_v1", expected_version: 2 }),
    ).toEqual({
      ok: true,
      value: { chat_id: "room-alpha", doc_id: "skill-deploy_v1", expected_version: 2 },
    });
    expect(
      validateArchiveChannelDocInput({ chat_id: "room-alpha", doc_id: "skill-deploy_v1", expected_version: 0 }).ok,
    ).toBe(false);
    expect(
      validateChannelDocIdInput("../escape").ok,
    ).toBe(false);
  });

  test("validates upsert_channel_doc room skills, secrets, and archived:true soft-archive mode", () => {
    const skillCheck = validateUpsertChannelDocInput({
      chat_id: "room-alpha",
      doc_id: "skill-review",
      title: "Review Skill",
      kind: "channel_skill",
      level: 3,
      expected_version: 0,
      body_markdown: "---\nname: review-skill\ndescription: Peer review checklist\n---\n\n# Steps\n1. Verify CAS.",
    });
    expect(skillCheck.ok).toBe(true);

    expect(
      validateUpsertChannelDocInput({
        chat_id: "room-alpha",
        doc_id: "skill-bad",
        title: "Missing Frontmatter",
        kind: "skill",
        level: 3,
        expected_version: 0,
        body_markdown: "# No YAML frontmatter",
      }).ok,
    ).toBe(false);

    const secretToken = ["sk", "proj", "abcdefghijklmnop123456"].join("-");
    expect(
      validateUpsertChannelDocInput({
        chat_id: "room-alpha",
        doc_id: "doc-secret",
        title: "Runbook",
        kind: "context",
        level: 3,
        expected_version: 0,
        body_markdown: `Never leak ${secretToken} in docs`,
      }).ok,
    ).toBe(false);

    const archiveViaUpsert = validateUpsertChannelDocInput({
      chat_id: "room-alpha",
      doc_id: "skill-review",
      expected_version: 1,
      archived: true,
    });
    expect(archiveViaUpsert).toEqual({
      ok: true,
      value: {
        mode: "archive",
        chat_id: "room-alpha",
        doc_id: "skill-review",
        expected_version: 1,
      },
    });
  });
});

describe("MCP channel_docs group end-to-end (skill upsert, CAS soft-archive, active_only, revisions & restore)", () => {
  test("creates channel_skill, soft-archives with If-Match CAS, filters tombstones via active_only, inspects revisions, and revives", async () => {
    const skillBodyV1 = "---\nname: deploy-check\ndescription: Verify clean deploy archive\ntrigger: before deploy\n---\n\n# V1 Steps\nCheck 0 NUL bytes.";
    const skillBodyV3 = "---\nname: deploy-check\ndescription: Verify clean deploy archive\ntrigger: before deploy\n---\n\n# V3 Restored\nRestored from history.";

    const { res } = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "channel_docs" }),
      callTool(3, "upsert_channel_doc", {
        chat_id: "room-eng",
        doc_id: "skill-deploy",
        title: "Deploy Check Skill",
        kind: "channel_skill",
        level: 3,
        expected_version: 0,
        body_markdown: skillBodyV1,
      }),
      callTool(4, "archive_channel_doc", {
        chat_id: "room-eng",
        doc_id: "skill-deploy",
        expected_version: 1,
      }),
      callTool(5, "list_channel_docs", {
        chat_id: "room-eng",
        active_only: true,
      }),
      callTool(6, "list_channel_docs", {
        chat_id: "room-eng",
      }),
      callTool(7, "list_channel_doc_revisions", {
        chat_id: "room-eng",
        doc_id: "skill-deploy",
      }),
      callTool(8, "upsert_channel_doc", {
        chat_id: "room-eng",
        doc_id: "skill-deploy",
        title: "Deploy Check Skill",
        kind: "channel_skill",
        level: 3,
        expected_version: 2,
        body_markdown: skillBodyV3,
      }),
      callTool(9, "upsert_channel_doc", {
        chat_id: "room-eng",
        doc_id: "skill-deploy",
        expected_version: 3,
        archived: true,
      }),
    ]);

    expect(res.get(2)?.result?.isError).toBeUndefined();
    expect(res.get(2)?.result?.content?.[0]?.text).toContain("archive_channel_doc");

    const created = JSON.parse(res.get(3)?.result?.content?.[0]?.text);
    expect(created.version).toBe(1);
    expect(created.kind).toBe("channel_skill");

    const archived = JSON.parse(res.get(4)?.result?.content?.[0]?.text);
    expect(archived.ok).toBe(true);
    expect(archived.archived).toBe(true);
    expect(archived.version).toBe(2);

    const activeList = JSON.parse(res.get(5)?.result?.content?.[0]?.text);
    expect(activeList.docs).toHaveLength(0);

    const fullList = JSON.parse(res.get(6)?.result?.content?.[0]?.text);
    expect(fullList.docs).toHaveLength(1);
    expect(fullList.docs[0].archived).toBe(true);

    const revs = JSON.parse(res.get(7)?.result?.content?.[0]?.text);
    expect(revs.revisions).toHaveLength(1);
    expect(revs.revisions[0].version).toBe(1);
    expect(revs.revisions[0].bodyMarkdown).toBe(skillBodyV1);

    const revived = JSON.parse(res.get(8)?.result?.content?.[0]?.text);
    expect(revived.version).toBe(3);
    expect(revived.bodyMarkdown).toBe(skillBodyV3);
    expect(revived.revisions).toHaveLength(2);

    const rearchived = JSON.parse(res.get(9)?.result?.content?.[0]?.text);
    expect(rearchived.ok).toBe(true);
    expect(rearchived.archived).toBe(true);
    expect(rearchived.version).toBe(4);

    const deleteCalls = recordedRequests.filter((r) => r.method === "DELETE");
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0].ifMatch).toBe("1");
    expect(deleteCalls[1].ifMatch).toBe("3");
  });
});

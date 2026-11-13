import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  derivePersonalSkillSlug,
  validateLoadSkillInput,
  validatePersonalSkillSlugInput,
  validateSaveSkillInput,
} from "../src/argcheck.ts";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

interface StoredPersonalSkill {
  name: string;
  title: string;
  description: string;
  body_markdown: string;
  version: number;
  updated_at: string;
  archived?: boolean;
  skill_meta: { name: string; description: string; trigger?: string; argument_hint?: string };
  revisions: Array<{
    version: number;
    title: string;
    description: string;
    body_markdown: string;
    updated_at: string;
    updated_by: string;
  }>;
}

let personalSkills: Record<string, StoredPersonalSkill> = {};
let channelDocs: Record<string, Record<string, any>> = {};
let recorded: Array<{ method: string; path: string; search: string; ifMatch: string | null; body: any }> = [];

beforeEach(() => {
  personalSkills = {};
  channelDocs = {};
  recorded = [];
});

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer ac_test_token_1234567890") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/api/skills") {
        recorded.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
        const activeOnly = ["1", "true"].includes(url.searchParams.get("active_only") ?? "");
        const skills = Object.values(personalSkills)
          .filter((s) => !activeOnly || (!s.archived && s.body_markdown.length > 0))
          .map(({ revisions: _r, body_markdown: _b, ...rest }) => rest);
        return Response.json({ owner: "user:test***", skills });
      }
      const skillRevMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/revisions$/);
      if (req.method === "GET" && skillRevMatch) {
        const slug = decodeURIComponent(skillRevMatch[1]);
        recorded.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
        const skill = personalSkills[slug];
        if (!skill) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ name: slug, revisions: skill.revisions }, { headers: { ETag: `"${skill.version}"` } });
      }
      const skillItemMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillItemMatch) {
        const slug = decodeURIComponent(skillItemMatch[1]);
        const existing = personalSkills[slug];
        if (req.method === "GET") {
          recorded.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
          if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
          const { revisions: _r, ...view } = existing;
          return Response.json(view, { headers: { ETag: `"${existing.version}"` } });
        }
        if (req.method === "PUT") {
          const body = await req.json();
          const ifMatch = req.headers.get("if-match");
          recorded.push({ method: "PUT", path: url.pathname, search: url.search, ifMatch, body });
          const expected = ifMatch !== null ? Number(ifMatch.replace(/"/g, "")) : body?.if_match_version;
          const currentVer = existing?.version ?? 0;
          if (expected !== undefined && expected !== currentVer) {
            return Response.json(
              { error: "Skill version conflict", code: "SKILL_VERSION_CONFLICT", current_version: currentVer },
              { status: 409 },
            );
          }
          const md = String(body.body_markdown ?? "");
          const nameLine = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? slug;
          const descLine = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
          const trigLine = md.match(/^trigger:\s*(.+)$/m)?.[1]?.trim();
          const nextVer = currentVer + 1;
          const revisions = existing
            ? [
                ...existing.revisions,
                {
                  version: existing.version,
                  title: existing.title,
                  description: existing.description,
                  body_markdown: existing.body_markdown,
                  updated_at: existing.updated_at,
                  updated_by: "test-bot-skills",
                },
              ]
            : [];
          const next: StoredPersonalSkill = {
            name: slug,
            title: nameLine,
            description: descLine,
            body_markdown: md,
            version: nextVer,
            updated_at: "2026-11-13T11:00:00Z",
            skill_meta: { name: nameLine, description: descLine, ...(trigLine ? { trigger: trigLine } : {}) },
            revisions,
          };
          personalSkills[slug] = next;
          return Response.json(
            { ok: true, owner: "user:test***", name: slug, version: nextVer, skill_meta: next.skill_meta },
            { headers: { ETag: `"${nextVer}"` } },
          );
        }
        if (req.method === "DELETE") {
          const ifMatch = req.headers.get("if-match");
          recorded.push({ method: "DELETE", path: url.pathname, search: url.search, ifMatch, body: null });
          if (!ifMatch) return Response.json({ error: "If-Match required", code: "SKILL_IF_MATCH_REQUIRED" }, { status: 428 });
          if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
          if (Number(ifMatch.replace(/"/g, "")) !== existing.version) {
            return Response.json(
              { error: "conflict", code: "SKILL_VERSION_CONFLICT", current_version: existing.version },
              { status: 409 },
            );
          }
          const nextVer = existing.version + 1;
          personalSkills[slug] = {
            ...existing,
            body_markdown: "",
            archived: true,
            version: nextVer,
            revisions: [
              ...existing.revisions,
              {
                version: existing.version,
                title: existing.title,
                description: existing.description,
                body_markdown: existing.body_markdown,
                updated_at: existing.updated_at,
                updated_by: "test-bot-skills",
              },
            ],
          };
          return Response.json(
            { ok: true, name: slug, version: nextVer, archived: true, skill_meta: existing.skill_meta },
            { headers: { ETag: `"${nextVer}"` } },
          );
        }
      }

      const chanListMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/docs$/);
      if (req.method === "GET" && chanListMatch) {
        const room = decodeURIComponent(chanListMatch[1]);
        recorded.push({ method: "GET", path: url.pathname, search: url.search, ifMatch: null, body: null });
        const activeOnly = ["1", "true"].includes(url.searchParams.get("active_only") ?? "");
        const docs = Object.values(channelDocs[room] ?? {}).filter(
          (d) => !activeOnly || (!d.archived && String(d.body_markdown ?? "").length > 0),
        );
        return Response.json({ docs });
      }
      const chanDocMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/docs\/([^/]+)$/);
      if (chanDocMatch && req.method === "DELETE") {
        const room = decodeURIComponent(chanDocMatch[1]);
        const docId = decodeURIComponent(chanDocMatch[2]);
        const ifMatch = req.headers.get("if-match");
        recorded.push({ method: "DELETE", path: url.pathname, search: url.search, ifMatch, body: null });
        const existing = channelDocs[room]?.[docId];
        if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
        const nextVer = existing.version + 1;
        channelDocs[room][docId] = { ...existing, body_markdown: "", archived: true, version: nextVer };
        return new Response(null, { status: 204, headers: { ETag: `"${nextVer}"` } });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  hub.stop(true);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-personal-skills-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "TestBot.json"),
    JSON.stringify({
      agent_id: "test-bot-skills",
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

function drive(frames: any[], maxWaitMs = 3500) {
  return new Promise<{ res: Map<number, any>; err: string; home: string }>((done) => {
    const home = makeHome();
    let settled = false;
    const finish = (payload: { res: Map<number, any>; err: string; home: string }) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      done(payload);
    };
    const child = spawn(process.execPath, [ENTRY, "--url", BASE, "--profile", "TestBot"], {
      env: {
        PATH: process.env.PATH!,
        HOME: home,
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
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) res.set(msg.id, msg);
        } catch {}
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => finish({ res, err, home }), maxWaitMs);
    (async () => {
      for (const frame of frames) {
        child.stdin.write(JSON.stringify(frame) + "\n");
        if (frame.id === undefined) continue;
        const deadline = Date.now() + 2200;
        while (!res.has(frame.id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      clearTimeout(timer);
      finish({ res, err, home });
    })();
  });
}

describe("personal & channel skill MCP validation helpers", () => {
  test("validates personal skill slugs, load_skill disambiguation, and save_skill CAS/archive rules", () => {
    expect(validatePersonalSkillSlugInput("deploy-v2", "load_skill")).toEqual({ ok: true, value: "deploy-v2" });
    expect(validatePersonalSkillSlugInput("../escape", "load_skill").ok).toBe(false);
    expect(derivePersonalSkillSlug(undefined, "Release Checklist!")).toBe("release-checklist");

    expect(validateLoadSkillInput({ name: "deploy", include_revisions: true })).toEqual({
      ok: true,
      value: { scope: "personal", name: "deploy", include_revisions: true },
    });
    expect(validateLoadSkillInput({ name: "deploy", chat_id: "room-1", doc_id: "skill-x" }).ok).toBe(false);
    expect(validateLoadSkillInput({ skill_id: "workspace-driven-eng", include_revisions: true }).ok).toBe(false);

    expect(validateSaveSkillInput({ name: "deploy", archived: true }).ok).toBe(false);
    expect(validateSaveSkillInput({ name: "deploy", archived: true, if_match_version: 2 })).toEqual({
      ok: true,
      value: { scope: "personal", mode: "archive", slug: "deploy", if_match_version: 2 },
    });
    expect(
      validateSaveSkillInput({
        name: "deploy",
        description: "Ship safely",
        body: " sk-proj-1234567890abcdefghijklmnopqrstuv ",
      }).ok,
    ).toBe(false);
  });
});

describe("MCP personal skills full lifecycle (CAS save, load, active_only list, soft-archive, revisions, sync tombstone guard)", () => {
  test("saves with CAS, loads personal skill & revisions, filters active_only, soft-archives, and protects sync_skill cache", async () => {
    channelDocs["room-1"] = {
      "skill-live": {
        id: "skill-live",
        title: "Live Skill",
        kind: "channel_skill",
        level: 3,
        version: 1,
        body_markdown: "---\nname: Live Skill\ndescription: Active\n---\n\nRun it",
        skill_meta: { name: "Live Skill", description: "Active" },
      },
      "skill-archived": {
        id: "skill-archived",
        title: "Old Skill",
        kind: "channel_skill",
        level: 3,
        version: 2,
        archived: true,
        body_markdown: "",
      },
    };

    const { res, home } = await drive([
      INIT,
      INITED,
      callTool(2, "save_skill", {
        name: "Deploy Check",
        doc_id: "deploy-check",
        description: "Pre-deploy checklist",
        trigger: "/deploy-check",
        body: "1. Run tests\n2. Check health",
        if_match_version: 0,
      }),
      callTool(3, "save_skill", {
        name: "Deploy Check",
        doc_id: "deploy-check",
        description: "Stale create attempt",
        body: "Should conflict",
        if_match_version: 0,
      }),
      callTool(4, "load_skill", { name: "deploy-check" }),
      callTool(5, "sync_skill", { name: "deploy-check" }),
      callTool(6, "save_skill", {
        name: "Deploy Check",
        doc_id: "deploy-check",
        archived: true,
        if_match_version: 1,
      }),
      callTool(7, "list_skills", { chat_id: "room-1" }),
      callTool(8, "list_skills", { chat_id: "room-1", active_only: false }),
      callTool(9, "load_skill", { name: "deploy-check", include_revisions: true }),
      callTool(10, "sync_skill", { name: "deploy-check" }),
      callTool(11, "save_skill", {
        chat_id: "room-1",
        doc_id: "skill-live",
        name: "Live Skill",
        archived: true,
        if_match_version: 1,
      }),
    ]);

    expect(res.get(2)?.result?.isError).toBeUndefined();
    expect(res.get(2)?.result?.content?.[0]?.text).toContain('Saved PERSONAL skill "Deploy Check" as "deploy-check" (v1)');

    // Create-only CAS conflict on v1
    expect(res.get(3)?.result?.isError).toBe(true);
    expect(res.get(3)?.result?.content?.[0]?.text).toContain("409");

    // Load active personal skill
    expect(res.get(4)?.result?.isError).toBeUndefined();
    expect(res.get(4)?.result?.content?.[0]?.text).toContain('Personal skill loaded: "deploy-check" (v1).');
    expect(res.get(4)?.result?.content?.[0]?.text).toContain("trigger: /deploy-check");
    expect(res.get(4)?.result?.content?.[0]?.text).toContain("1. Run tests");

    // Initial sync writes local .md cache
    expect(res.get(5)?.result?.isError).toBeUndefined();
    const syncedMdPath = join(home, ".agentchat", "skills", "personal__deploy-check.md");
    expect(readFileSync(syncedMdPath, "utf8")).toContain("1. Run tests");

    // Non-destructive soft-archive via save_skill(archived:true, if_match_version:1)
    expect(res.get(6)?.result?.isError).toBeUndefined();
    expect(res.get(6)?.result?.content?.[0]?.text).toContain('Archived PERSONAL skill "deploy-check" (v2)');

    // Default list_skills excludes archived personal & channel tombstones
    const activeListed = JSON.parse(res.get(7)?.result?.content?.[0]?.text);
    expect(activeListed.personal_skills).toEqual([]);
    expect(activeListed.channel_skills.map((s: any) => s.doc_id)).toEqual(["skill-live"]);

    // active_only=false includes archived tombstones
    const allListed = JSON.parse(res.get(8)?.result?.content?.[0]?.text);
    expect(allListed.personal_skills.map((s: any) => ({ name: s.name, archived: s.archived, version: s.version }))).toEqual([
      { name: "deploy-check", archived: true, version: 2 },
    ]);
    expect(allListed.channel_skills.map((s: any) => s.doc_id)).toEqual(["skill-live", "skill-archived"]);

    // load_skill(name, include_revisions:true) surfaces archived banner + revision snapshot
    const revText = res.get(9)?.result?.content?.[0]?.text ?? "";
    expect(revText).toContain('[ARCHIVED PERSONAL SKILL "deploy-check" (v2)]');
    expect(revText).toContain("1. Run tests");

    // sync_skill refuses to clobber local .md file with empty tombstone
    expect(res.get(10)?.result?.isError).toBe(true);
    expect(readFileSync(syncedMdPath, "utf8")).toContain("1. Run tests");

    // Channel skill archive handles 204 + ETag cleanly
    expect(res.get(11)?.result?.isError).toBeUndefined();
    expect(res.get(11)?.result?.content?.[0]?.text).toContain("Archived CHANNEL skill room-1/skill-live (v2)");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

let mcpUnknownTool = true;
let mcpAccessDenied = false;
let proposals: any[] = [];
const votedBy = new Set<string>();

beforeEach(() => {
  mcpUnknownTool = true;
  mcpAccessDenied = false;
  votedBy.clear();
  proposals = [
    {
      id: "prop-done-1",
      channel_id: "room-1",
      sender_id: "alice@example.com",
      title: "Shipped proposal",
      content: "Already approved",
      consensus_rule: "majority",
      timestamp: "2026-11-13T10:00:00.000Z",
      status: "passed",
      total_voters: 3,
      votes: [{ voter_id: "bob@example.com", voter_type: "human", decision: "approve" }],
      vote_result: { passed: true, is_complete: true, approve_count: 2, reject_count: 0, abstain_count: 0, total_voters: 3 },
    },
  ];
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
        if (rpc.method === "tools/call" && rpc.params?.name === "agentschat_cloud_agent_wake_health") {
          if (mcpAccessDenied) {
            return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Conversation access denied" } });
          }
          if (mcpUnknownTool) {
            return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Unknown tool: agentschat_cloud_agent_wake_health" } });
          }
        }
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "unsupported" } });
      }
      if (req.method === "GET" && url.pathname === "/api/channels/room-1/cloud-wake-health") {
        return Response.json({
          channel_id: "room-1",
          observation_only: true,
          agents: [{
            agent_id: "codex-peer",
            name: "Codex Peer owner@example.com",
            runtime: "codex",
            cloud_status: "active",
            last_wake_status: "ok",
            last_wake_at: "2026-11-13T14:00:00.000Z",
            last_duration_ms: 850,
          }],
        });
      }
      if (req.method === "GET" && url.pathname === "/api/channels/discover") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const rows = [
          {
            id: "chan-swift-1",
            name: "Swift Builders",
            member_count: 6,
            online_agent_count: 3,
            capabilities: ["swift", "ios", "code-review"],
            topic: "iOS 26 & SwiftUI collaboration (contact dev@example.com)",
          },
          {
            id: "chan-rust-1",
            name: "Rust Systems",
            member_count: 10,
            online_agent_count: 0,
            capabilities: [],
            topic: "Systems programming",
          },
        ].filter((c) => !q || c.name.toLowerCase().includes(q) || c.capabilities.some((cap) => cap.includes(q)));
        return Response.json({ channels: rows });
      }
      if (req.method === "GET" && url.pathname === "/api/channels/room-1/proposals") {
        return Response.json({ channel_id: "room-1", proposals });
      }
      if (req.method === "POST" && url.pathname === "/api/channels/room-1/proposals") {
        const body = await req.json() as any;
        const created = {
          id: body.id || "prop-new-1",
          channel_id: "room-1",
          sender_id: body.sender_id || "test-bot",
          title: body.title,
          content: body.content,
          ...(body.code_diff ? { code_diff: body.code_diff } : {}),
          consensus_rule: body.consensus_rule || "majority",
          expires_at: body.expires_at,
          timestamp: "2026-11-13T14:50:00.000Z",
          status: "pending",
          total_voters: 3,
          votes: [],
          vote_result: { passed: false, is_complete: false, approve_count: 0, reject_count: 0, abstain_count: 0, total_voters: 3 },
        };
        proposals.unshift(created);
        return Response.json({ proposal: created }, { status: 201 });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/channels/room-1/proposals/") && url.pathname.endsWith("/votes")) {
        const propId = decodeURIComponent(url.pathname.split("/")[5] || "");
        const body = await req.json() as any;
        const key = `${propId}:${body.voter_id}`;
        if (votedBy.has(key)) {
          return Response.json({ error: "Already voted" }, { status: 409 });
        }
        votedBy.add(key);
        return Response.json({
          proposal_id: propId,
          vote_result: { passed: true, is_complete: true, approve_count: 2, reject_count: 0, abstain_count: 0, total_voters: 3 },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  hub?.stop(true);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
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

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-proposals-mcp-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TestBot.json"), JSON.stringify({
    agent_id: "test-bot-proposals",
    token: "ac_test_token_1234567890",
    saved_at: new Date().toISOString(),
  }));
  return home;
}

function drive(frames: any[], waitMs = 2000) {
  return new Promise<{ res: Map<number, any> }>((done) => {
    const child = spawn(process.execPath, [ENTRY, "--url", BASE, "--profile", "TestBot"], {
      env: {
        PATH: process.env.PATH!,
        HOME: makeHome(),
        AGENTCHAT_NO_PROXY: "1",
        AGENTCHAT_REST_URL: BASE,
        AGENTCHAT_URL: "ws://127.0.0.1:1/ws",
        AGENTSCHAT_TOOL_ONLY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
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
    (async () => {
      for (const f of frames) {
        child.stdin.write(JSON.stringify(f) + "\n");
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, waitMs));
      child.kill();
      done({ res });
    })();
  });
}

describe("MCP REST-first proposals & cloud_agent_wake_health fallback", () => {
  test("propose, list_proposals, and vote work synchronously over REST without WS and redact PII", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "notifications" }),
      callTool(3, "propose", {
        chat_id: "room-1",
        title: "Adopt CAS ballot fencing",
        content: "Ensure cross-pod votes converge.",
        code_diff: "+ castProposalVote()",
        consensus_rule: "majority",
      }),
      callTool(4, "list_proposals", { chat_id: "room-1", status: "all" }),
      callTool(5, "list_proposals", { chat_id: "room-1", status: "pending" }),
    ]);

    const created = JSON.parse(res.get(3)?.result?.content?.[0]?.text || "null");
    expect(created.ok).toBe(true);
    expect(created.transport).toBe("rest");
    expect(created.proposal.title).toBe("Adopt CAS ballot fencing");
    expect(created.proposal.code_diff).toBe("+ castProposalVote()");

    const allText = res.get(4)?.result?.content?.[0]?.text || "";
    const allPayload = JSON.parse(allText);
    expect(allPayload.count).toBe(2);
    expect(allText).not.toContain("alice@example.com");
    expect(allText).not.toContain("bob@example.com");

    const pendingPayload = JSON.parse(res.get(5)?.result?.content?.[0]?.text || "null");
    expect(pendingPayload.count).toBe(1);
    expect(pendingPayload.proposals[0].id).toBe(created.proposal.id);

    const { res: voteRes } = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "notifications" }),
      callTool(3, "vote", { chat_id: "room-1", proposal_id: created.proposal.id, decision: "approve", reason: "LGTM" }),
      callTool(4, "vote", { chat_id: "room-1", proposal_id: created.proposal.id, decision: "approve" }),
    ]);
    const v1 = JSON.parse(voteRes.get(3)?.result?.content?.[0]?.text || "null");
    expect(v1).toMatchObject({
      ok: true,
      transport: "rest",
      proposal_id: created.proposal.id,
      vote_result: { passed: true, is_complete: true, approve_count: 2, total_voters: 3 },
    });
    expect(voteRes.get(4)?.result?.isError).toBe(true);
    expect(voteRes.get(4)?.result?.content?.[0]?.text || "").toContain("409");
  });

  test("cloud_agent_wake_health falls back to REST /cloud-wake-health on Unknown tool (-32602) but not on access denied", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      callTool(3, "cloud_agent_wake_health", { channel_id: "room-1" }),
    ]);
    const text = res.get(3)?.result?.content?.[0]?.text || "";
    const payload = JSON.parse(text);
    expect(payload).toMatchObject({
      channel_id: "room-1",
      observation_only: true,
      untrusted: true,
      summary: { total: 1, ok: 1, auth_required: 0, timeout: 0, error: 0, unobserved: 0 },
    });
    expect(text).not.toContain("owner@example.com");

    mcpAccessDenied = true;
    const { res: deniedRes } = await drive([
      INIT,
      INITED,
      callTool(3, "cloud_agent_wake_health", { channel_id: "room-1" }),
      callTool(4, "list_channels", { query: "swift", limit: 10 }),
    ]);
    expect(deniedRes.get(3)?.result?.isError).toBe(true);
    expect(deniedRes.get(3)?.result?.content?.[0]?.text || "").toContain("Conversation access denied");

    const listText = deniedRes.get(4)?.result?.content?.[0]?.text || "";
    expect(listText).toContain("Swift Builders (chan-swift-1)");
    expect(listText).toContain("🟢 3 online");
    expect(listText).toContain("[swift, ios, code-review]");
    expect(listText).not.toContain("dev@example.com");
  });
});

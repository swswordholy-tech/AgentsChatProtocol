import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/api/channels/chan-room-collab-123456/members") {
        return Response.json({
          members: [
            {
              agent_id: "swswordholy@gmail.com",
              display_name: null,
              role: "owner",
              type: "user",
            },
            {
              agent_id: "+86 138-0013-8088",
              display_name: "+86 138-0013-8088",
              role: "member",
              type: "user",
            },
            {
              agent_id: "knobbly-tangy-beacon",
              display_name: "Codex Live",
              role: "member",
            },
            {
              agent_id: "claude-code-live",
              display_name: "Claude Code Live",
              role: "member",
            },
          ],
        });
      }
      if (req.method === "GET" && u.pathname === "/api/channels/chan-legacy-no-mcp/members") {
        return Response.json({
          members: [
            {
              agent_id: "alice@example.com",
              display_name: "alice@example.com",
              role: "owner",
            },
            {
              agent_id: "spinning-midnight-tunicate",
              display_name: "Antigravity Operator",
              role: "member",
              capabilities: ["orchestration", "typescript"],
            },
          ],
        });
      }
      if (req.method === "GET" && u.pathname === "/api/presence") {
        return Response.json({
          presence: {
            "swswordholy@gmail.com": "online",
            "+86 138-0013-8088": "online",
            "knobbly-tangy-beacon": "online",
            "claude-code-live": "offline",
            "alice@example.com": "online",
            "spinning-midnight-tunicate": "online",
          },
        });
      }
      if (req.method === "GET" && u.pathname === "/api/channels/chan-room-collab-123456/messages") {
        return Response.json({
          messages: [
            {
              id: "m-1",
              channel_id: "chan-room-collab-123456",
              sender_id: "swswordholy@gmail.com",
              content: "请大家一起 review 这个 PR",
              timestamp: "2026-10-30T06:00:00.000Z",
            },
            {
              id: "m-2",
              channel_id: "chan-room-collab-123456",
              sender_id: "knobbly-tangy-beacon",
              content: "收到，我来看 SwiftData 测试",
              timestamp: "2026-10-30T06:01:00.000Z",
            },
          ],
        });
      }
      if (req.method === "POST" && u.pathname === "/mcp") {
        const rpc = (await req.json().catch(() => ({}))) as any;
        if (rpc.method === "tools/call" && rpc.params?.name === "agentschat_get_channel_context") {
          const cid = rpc.params?.arguments?.channel_id;
          if (cid === "chan-room-collab-123456") {
            const payload = {
              channel: {
                id: "chan-room-collab-123456",
                name: "AgentChatDev",
                type: "public",
                topic: "Core multi-agent engineering room",
                member_count: 4,
              },
              agents: [
                {
                  id: "knobbly-tangy-beacon",
                  name: "Codex Live",
                  capabilities: ["swift", "ios", "cloud-subagent"],
                  online: true,
                  is_self: false,
                },
                {
                  id: "claude-code-live",
                  name: "Claude Code Live",
                  capabilities: ["chrome-devtools", "seo", "frontend"],
                  online: false,
                  is_self: false,
                },
              ],
            };
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: payload,
              },
            });
          }
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            error: { code: -32601, message: "Tool unavailable on legacy mock" },
          });
        }
      }
      return Response.json({});
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => hub.stop(true));

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

function drive(home: string, frames: any[], waitMs = 2500) {
  return new Promise<{ res: Map<number, any>; err: string }>((done) => {
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
    child.stdout.on("data", (d) => {
      out += d;
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line) {
          try {
            const m = JSON.parse(line);
            if (m.id !== undefined) res.set(m.id, m);
          } catch {}
        }
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    (async () => {
      for (const f of frames) {
        child.stdin.write(JSON.stringify(f) + "\n");
        if (f.id === undefined) continue;
        const deadline = Date.now() + 2000;
        while (!res.has(f.id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    })();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done({ res, err });
    }, waitMs);
  });
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-member-pii-"));
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "TestBot.json"),
    JSON.stringify({
      agent_id: "test-observer-bot",
      token: "ac_test_token_1234567890",
      saved_at: new Date().toISOString(),
    }),
  );
  return home;
}

describe("Room peer capability discovery & human PII redaction", () => {
  test("list_members prints full @agent_id, peer capabilities, online state, and masks human emails/phones", async () => {
    const home = makeHome();
    const { res } = await drive(home, [
      INIT,
      INITED,
      callTool(2, "list_members", { chat_id: "chan-room-collab-123456" }),
    ]);

    const text: string = res.get(2)?.result?.content?.[0]?.text || "";
    expect(text).toContain("4 members in chan-room-collab-123456:");
    // Full agent handles (never truncated to 12 chars) + capability tags
    expect(text).toContain("Codex Live (@knobbly-tangy-beacon) [member] (online) {capabilities: swift, ios, cloud-subagent}");
    expect(text).toContain("Claude Code Live (@claude-code-live) [member] (offline) {capabilities: chrome-devtools, seo, frontend}");
    // Human PII masked cleanly
    expect(text).toContain("user:sw*** (user:sw***) [owner]");
    expect(text).toContain("user:phone_***88 (user:phone_***88) [member]");
    expect(text).not.toContain("swswordholy@gmail.com");
    expect(text).not.toContain("138-0013-8088");
  });

  test("channel_brief masks online human PII, surfaces agent_peers capabilities, and degrades gracefully without /mcp", async () => {
    const home = makeHome();
    const { res } = await drive(home, [
      INIT,
      INITED,
      callTool(2, "channel_brief", { chat_id: "chan-room-collab-123456" }),
      callTool(3, "channel_brief", { chat_id: "chan-legacy-no-mcp" }),
      callTool(4, "get_history", { chat_id: "chan-room-collab-123456", limit: 10 }),
    ]);

    const briefRaw: string = res.get(2)?.result?.content?.[0]?.text || "{}";
    expect(briefRaw).not.toContain("swswordholy@gmail.com");
    expect(briefRaw).not.toContain("138-0013-8088");
    const brief = JSON.parse(briefRaw);
    expect(brief.channel_name).toBe("AgentChatDev");
    expect(brief.topic).toBe("Core multi-agent engineering room");
    expect(brief.members.online).toContain("user:sw***");
    expect(brief.members.online).toContain("user:phone_***88");
    expect(brief.members.online).toContain("knobbly-tangy-beacon");
    expect(brief.agent_peers).toEqual([
      {
        id: "knobbly-tangy-beacon",
        name: "Codex Live",
        capabilities: ["swift", "ios", "cloud-subagent"],
        online: true,
        is_self: false,
      },
      {
        id: "claude-code-live",
        name: "Claude Code Live",
        capabilities: ["chrome-devtools", "seo", "frontend"],
        online: false,
        is_self: false,
      },
    ]);

    // Legacy fallback when /mcp agentschat_get_channel_context returns error
    const legacyRaw: string = res.get(3)?.result?.content?.[0]?.text || "{}";
    expect(legacyRaw).not.toContain("alice@example.com");
    const legacy = JSON.parse(legacyRaw);
    expect(legacy.members.online).toEqual(["user:al***", "spinning-midnight-tunicate"]);
    expect(legacy.agent_peers).toEqual([
      {
        id: "spinning-midnight-tunicate",
        name: "Antigravity Operator",
        capabilities: ["orchestration", "typescript"],
        online: true,
        is_self: false,
      },
    ]);

    // get_history shows full @agent_id and masks human sender email
    const hist: string = res.get(4)?.result?.content?.[0]?.text || "";
    expect(hist).toContain("user:sw***: 请大家一起 review 这个 PR");
    expect(hist).toContain("knobbly-tangy-beacon: 收到，我来看 SwiftData 测试");
    expect(hist).not.toContain("swswordholy@");
  });
});

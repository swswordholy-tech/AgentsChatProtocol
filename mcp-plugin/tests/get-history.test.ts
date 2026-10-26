import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";

const MSG_1500 =
  "HEADER_START " +
  "A".repeat(350) +
  " TRACK_4_DEEPSEEK_KEY " +
  "B".repeat(900) +
  " TAIL_MARKER_1500";

const MSG_5200 =
  "VERY_LONG_START " +
  "X".repeat(4100) +
  " BEYOND_4000_MARKER " +
  "Y".repeat(1000) +
  " VERY_LONG_END";

const OLDER_EXACT_MSG =
  "OLDER_MSG_START " +
  "Z".repeat(4500) +
  " OLDER_MSG_FULL_TAIL";

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/api/channels/chan-test/messages") {
        return Response.json({
          messages: [
            {
              id: "msg-1500-id",
              channel_id: "chan-test",
              sender_id: "claude-code-live",
              content: MSG_1500,
              timestamp: "2026-10-24T07:22:23.000Z",
            },
            {
              id: "msg-5200-id",
              channel_id: "chan-test",
              sender_id: "spinning-midnight-tunicate",
              content: MSG_5200,
              timestamp: "2026-10-24T07:32:16.000Z",
            },
          ],
        });
      }
      if (req.method === "POST" && u.pathname === "/mcp") {
        const rpc = (await req.json().catch(() => ({}))) as any;
        if (rpc.method === "tools/call" && rpc.params?.name === "agentschat_read_messages") {
          const mid = rpc.params?.arguments?.message_id;
          if (mid === "msg-older-id") {
            const payload = {
              messages: [
                {
                  id: "msg-older-id",
                  channel_id: "chan-test",
                  sender_id: "swswordholy@gmail.com",
                  content: OLDER_EXACT_MSG,
                  timestamp: "2026-10-20T09:00:00.000Z",
                },
              ],
              untrusted: true,
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
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
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

function makeHomeWithProfile(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-hist-"));
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "TestBot.json"),
    JSON.stringify({
      agent_id: "test-bot-hist",
      token: "ac_test_token_1234567890",
      saved_at: new Date().toISOString(),
    }),
  );
  return home;
}

describe("get_history truncation & message_id support (#7)", () => {
  test("preserves messages up to 4000 chars and hints message_id when > 4000 chars", async () => {
    const home = makeHomeWithProfile();
    const { res } = await drive(home, [
      INIT,
      INITED,
      LIST,
      callTool(3, "get_history", { chat_id: "chan-test", limit: 10 }),
    ]);

    const tools = res.get(2)?.result?.tools || [];
    const getHistTool = tools.find((t: any) => t.name === "get_history");
    expect(getHistTool?.inputSchema?.properties?.message_id).toBeDefined();

    const text: string = res.get(3)?.result?.content?.[0]?.text || "";
    // 1500-char message must NOT be truncated at 200 or 300 chars
    expect(text).toContain("TRACK_4_DEEPSEEK_KEY");
    expect(text).toContain("TAIL_MARKER_1500");
    // 5200-char message is truncated at 4000 chars and includes message_id hint
    expect(text).not.toContain("VERY_LONG_END");
    expect(text).toContain("msg-5200-id");
  });

  test("fetches full untruncated message by message_id from recent history or /mcp fallback", async () => {
    const home = makeHomeWithProfile();
    const { res } = await drive(home, [
      INIT,
      INITED,
      callTool(3, "get_history", { chat_id: "chan-test", message_id: "msg-5200-id" }),
      callTool(4, "get_history", { chat_id: "chan-test", message_id: "msg-older-id" }),
    ]);

    const text5200: string = res.get(3)?.result?.content?.[0]?.text || "";
    expect(text5200).toContain("VERY_LONG_START");
    expect(text5200).toContain("BEYOND_4000_MARKER");
    expect(text5200).toContain("VERY_LONG_END");

    const textOlder: string = res.get(4)?.result?.content?.[0]?.text || "";
    expect(textOlder).toContain("OLDER_MSG_START");
    expect(textOlder).toContain("OLDER_MSG_FULL_TAIL");
  });
});

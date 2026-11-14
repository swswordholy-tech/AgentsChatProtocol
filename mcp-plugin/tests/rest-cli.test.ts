import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CURSOR_INIT_KEY,
  CURSOR_LAST_ACTIVE_KEY,
  CURSOR_MAX_IDLE_KEY,
  joinChannelRest,
  parseMaxIdleMs,
  sendRestMessage,
  wakeOnce,
} from "../src/rest-cli.ts";
import { loadCursor } from "../src/read-cursor.ts";

describe("rest-cli (--join, --send, --wake-once) & unified per-channel cursor", () => {
  test("joinChannelRest posts to /api/channels/:id/join with sender_id", async () => {
    const calls: Array<{ url: string; method?: string; body?: any }> = [];
    const res = await joinChannelRest({
      restUrl: "https://agents-chat.com",
      agentId: "bot-1",
      token: "ac_test_token_123456",
      channelId: "welcome",
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || "{}") });
        return Response.json({ ok: true, channel_id: "welcome", name: "Welcome" });
      }) as any,
    });
    expect(res.ok).toBe(true);
    expect(res.channel_id).toBe("welcome");
    expect(res.name).toBe("Welcome");
    expect(calls).toEqual([
      {
        url: "https://agents-chat.com/api/channels/welcome/join",
        method: "POST",
        body: { sender_id: "bot-1" },
      },
    ]);
  });

  test("sendRestMessage posts to /api/channels/:id/messages, redacts ac_ keys, and advances channel cursors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-send-"));
    try {
      let postedBody: any = null;
      const res = await sendRestMessage({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_secret_token_1234567890",
        channelId: "dm-n37rhk",
        text: "Hello! Never leak ac_secret_token_1234567890 in chat",
        replyTo: "msg-001",
        fetchImpl: (async (_url: any, init: any) => {
          postedBody = JSON.parse(init?.body || "{}");
          return Response.json({ ok: true, id: "reply-uuid-1" }, { status: 201 });
        }) as any,
      });

      expect(res.ok).toBe(true);
      expect(res.id).toBe("reply-uuid-1");
      expect(res.in_reply_to).toBe("msg-001");
      expect(postedBody.sender_id).toBe("bot-1");
      expect(postedBody.in_reply_to).toBe("msg-001");
      expect(postedBody.content).not.toContain("ac_secret_token_1234567890");

      const cursorMap = loadCursor(join(dir, "last-seen-msg-ts-bot-1.json"), () => {});
      expect(cursorMap.get("dm-n37rhk")).toBeTruthy();
      const readCursors = JSON.parse(readFileSync(join(dir, "read-cursors.json"), "utf8"));
      expect(readCursors["bot-1:dm-n37rhk"]).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wakeOnce seeds pre-existing group history without replaying, but delivers brand-new DM after __init_ts__", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-wake-"));
    try {
      const initIso = "2026-11-04T13:00:00.000Z";
      const ev = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "opulent-edge-fuji",
        displayName: "Antigravity-Cloud",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        enableSse: false,
        nowIso: () => initIso,
        fetchImpl: (async (url: any) => {
          const u = String(url);
          if (u.endsWith("/join")) {
            return Response.json({ ok: true, channel_id: "welcome" });
          }
          if (u.endsWith("/api/channels/mine")) {
            return Response.json({
              channels: [
                { id: "welcome", last_message_at: "2026-11-04T12:50:00.000Z" },
                { id: "dm-n37rhk", last_message_at: "2026-11-04T13:01:00.000Z" },
              ],
            });
          }
          if (u.includes("/api/channels/welcome/messages")) {
            // Old mention from before initIso -> should seed cursor, NOT wake
            return Response.json({
              messages: [
                {
                  id: "old-welcome-1",
                  channel_id: "welcome",
                  sender_id: "someone",
                  content: "hello @opulent-edge-fuji",
                  timestamp: "2026-11-04T12:50:00.000Z",
                },
              ],
            });
          }
          if (u.includes("/api/channels/dm-n37rhk/messages")) {
            // Brand-new DM after initIso -> must wake immediately, not be swallowed as seed!
            return Response.json({
              messages: [
                {
                  id: "dm-msg-1",
                  channel_id: "dm-n37rhk",
                  sender_id: "owner@example.com",
                  content: "通了？",
                  timestamp: "2026-11-04T13:01:00.000Z",
                },
              ],
            });
          }
          return Response.json({});
        }) as any,
      });

      expect(ev.event).toBe("agentschat_wake");
      expect(ev.channel_id).toBe("dm-n37rhk");
      expect(ev.message_id).toBe("dm-msg-1");
      expect(ev.content).toBe("通了？");

      const cursorMap = loadCursor(join(dir, "last-seen-msg-ts-opulent-edge-fuji.json"), () => {});
      expect(cursorMap.get(CURSOR_INIT_KEY)).toBe(initIso);
      expect(cursorMap.get("welcome")).toBe("2026-11-04T12:50:00.000Z");
      expect(cursorMap.get("dm-n37rhk")).toBe("2026-11-04T13:01:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wakeOnce preserves multi-message turn-gap bursts and cross-channel independence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-burst-"));
    try {
      const cursorFile = join(dir, "last-seen-msg-ts-bot-1.json");
      writeFileSync(
        cursorFile,
        JSON.stringify({
          [CURSOR_INIT_KEY]: "2026-11-04T13:00:00.000Z",
          "dm-a": "2026-11-04T13:01:00.000Z",
          welcome: "2026-11-04T13:01:00.000Z",
        }),
      );

      const mockFetch = (async (url: any) => {
        const u = String(url);
        if (u.endsWith("/api/channels/mine")) {
          return Response.json({
            channels: [
              { id: "dm-a", last_message_at: "2026-11-04T13:02:05.000Z" },
              { id: "welcome", last_message_at: "2026-11-04T13:02:10.000Z" },
            ],
          });
        }
        if (u.includes("/api/channels/dm-a/messages")) {
          return Response.json({
            messages: [
              {
                id: "m1",
                channel_id: "dm-a",
                sender_id: "owner",
                content: "first burst msg",
                timestamp: "2026-11-04T13:02:01.000Z",
              },
              {
                id: "m2",
                channel_id: "dm-a",
                sender_id: "owner",
                content: "second burst msg",
                timestamp: "2026-11-04T13:02:05.000Z",
              },
            ],
          });
        }
        if (u.includes("/api/channels/welcome/messages")) {
          return Response.json({
            messages: [
              {
                id: "w1",
                channel_id: "welcome",
                sender_id: "peer-agent",
                content: "group chat before mention",
                timestamp: "2026-11-04T13:02:08.000Z",
              },
              {
                id: "w2",
                channel_id: "welcome",
                sender_id: "peer-agent",
                content: "hey @bot-1 check this",
                timestamp: "2026-11-04T13:02:10.000Z",
              },
            ],
          });
        }
        return Response.json({ ok: true });
      }) as any;

      // Turn 1: wakes on dm-a with BOTH m1 and m2 batched, leaving welcome cursor at 13:01:00
      const ev1 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_test_token_123456",
        channels: [],
        enableSse: false,
        fetchImpl: mockFetch,
      });
      expect(ev1.channel_id).toBe("dm-a");
      expect(ev1.message_id).toBe("m2");
      expect(ev1.messages).toHaveLength(2);
      expect(ev1.content).toBe("first burst msg\nsecond burst msg");

      const afterTurn1 = loadCursor(cursorFile, () => {});
      expect(afterTurn1.get("dm-a")).toBe("2026-11-04T13:02:05.000Z");
      expect(afterTurn1.get("welcome")).toBe("2026-11-04T13:01:00.000Z");

      // Turn 2: immediately wakes on welcome's pending @mention w2 with group context w1!
      const ev2 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_test_token_123456",
        channels: [],
        enableSse: false,
        fetchImpl: mockFetch,
      });
      expect(ev2.channel_id).toBe("welcome");
      expect(ev2.message_id).toBe("w2");
      expect(ev2.context_prefix).toContain("group chat before mention");

      const afterTurn2 = loadCursor(cursorFile, () => {});
      expect(afterTurn2.get("welcome")).toBe("2026-11-04T13:02:10.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI flags --join and --send execute via server.ts entrypoint and exit 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "rest-cli-e2e-"));
    const hub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/welcome/join" && req.method === "POST") {
          return Response.json({ ok: true, channel_id: "welcome", name: "Welcome" });
        }
        if (url.pathname === "/api/channels/dm-test/messages" && req.method === "POST") {
          const body = (await req.json()) as any;
          return Response.json({ ok: true, id: "msg-999", echo: body.content }, { status: 201 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    try {
      const cfgDir = join(home, ".agentschat");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "TestBot.json"),
        JSON.stringify({ agent_id: "test-bot", display_name: "TestBot", token: "ac_valid_token_123456" }),
        { mode: 0o600 },
      );

      const joinProc = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../src/server.ts"),
          "--profile",
          "TestBot",
          "--url",
          `http://127.0.0.1:${hub.port}`,
          "--join",
          "welcome",
        ],
        { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const [joinOut, joinCode] = await Promise.all([new Response(joinProc.stdout).text(), joinProc.exited]);
      expect(joinCode).toBe(0);
      expect(JSON.parse(joinOut.trim())).toMatchObject({
        ok: true,
        agent_id: "test-bot",
        channel_id: "welcome",
      });

      const sendProc = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../src/server.ts"),
          "--profile",
          "TestBot",
          "--url",
          `http://127.0.0.1:${hub.port}`,
          "--send",
          "dm-test",
          "--reply-to",
          "msg-123",
          "--text",
          "Hello from CLI!",
        ],
        { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const [sendOut, sendCode] = await Promise.all([new Response(sendProc.stdout).text(), sendProc.exited]);
      expect(sendCode).toBe(0);
      expect(JSON.parse(sendOut.trim())).toMatchObject({
        ok: true,
        id: "msg-999",
        agent_id: "test-bot",
        channel_id: "dm-test",
        in_reply_to: "msg-123",
      });
    } finally {
      hub.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wakeOnce returns idle_timeout (should_rearm: true) before maxIdleMs and hibernate (should_rearm: false) after maxIdleMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-hibernate-"));
    try {
      const cursorFile = join(dir, "last-seen-msg-ts-bot-idle.json");
      let currentMs = Date.parse("2026-11-04T13:00:00.000Z");
      const nowIso = () => new Date(currentMs).toISOString();

      const emptyFetch = (async (url: any) => {
        const u = String(url);
        if (u.endsWith("/api/channels/mine")) {
          return Response.json({
            channels: [{ id: "welcome", last_message_at: "2026-11-04T12:00:00.000Z" }],
          });
        }
        if (u.includes("/messages")) {
          return Response.json({ messages: [] });
        }
        return Response.json({ ok: true });
      }) as any;

      // 1st window: 10 minutes elapsed (< 3600s maxIdleMs) -> should_rearm: true
      writeFileSync(
        cursorFile,
        JSON.stringify({
          [CURSOR_INIT_KEY]: "2026-11-04T13:00:00.000Z",
          [CURSOR_LAST_ACTIVE_KEY]: "2026-11-04T13:00:00.000Z",
          welcome: "2026-11-04T12:00:00.000Z",
        }),
      );
      currentMs = Date.parse("2026-11-04T13:10:00.000Z");
      const ev1 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-idle",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        timeoutMs: 20,
        maxIdleMs: 3_600_000,
        pollIntervalMs: 50,
        enableSse: false,
        nowIso,
        fetchImpl: emptyFetch,
      });
      expect(ev1.event).toBe("idle_timeout");
      expect(ev1.should_rearm).toBe(true);
      expect(loadCursor(cursorFile, () => {}).get(CURSOR_LAST_ACTIVE_KEY)).toBe("2026-11-04T13:00:00.000Z");

      // 2nd window: 61 minutes elapsed (>= 3600s maxIdleMs) -> event: "hibernate", should_rearm: false, clears __last_active_ts__
      currentMs = Date.parse("2026-11-04T14:01:00.000Z");
      const ev2 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-idle",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        timeoutMs: 20,
        maxIdleMs: 3_600_000,
        pollIntervalMs: 50,
        enableSse: false,
        nowIso,
        fetchImpl: emptyFetch,
      });
      expect(ev2.event).toBe("hibernate");
      expect(ev2.should_rearm).toBe(false);
      expect(loadCursor(cursorFile, () => {}).get(CURSOR_LAST_ACTIVE_KEY)).toBeUndefined();

      // 3rd check: parseMaxIdleMs supports human units (30m, 2h, 1.5h, 1d, never) and persists across renewals
      expect(parseMaxIdleMs("30m")).toBe(1_800_000);
      expect(parseMaxIdleMs("2h")).toBe(7_200_000);
      expect(parseMaxIdleMs("1.5h")).toBe(5_400_000);
      expect(parseMaxIdleMs("1d")).toBe(86_400_000);
      expect(parseMaxIdleMs("never")).toBe(0);

      currentMs = Date.parse("2026-11-04T15:00:00.000Z");
      const ev3 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-idle",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        timeoutMs: 20,
        maxIdleMs: parseMaxIdleMs("3h"),
        pollIntervalMs: 50,
        enableSse: false,
        nowIso,
        fetchImpl: emptyFetch,
      });
      expect(ev3.max_idle_ms).toBe(10_800_000);
      expect(loadCursor(cursorFile, () => {}).get(CURSOR_MAX_IDLE_KEY)).toBe("10800000");

      // Subsequent renewal without explicit maxIdleMs inherits the persisted 3h setting
      currentMs = Date.parse("2026-11-04T17:00:00.000Z"); // 2h elapsed (< 3h persisted)
      const ev4 = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-idle",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        timeoutMs: 20,
        pollIntervalMs: 50,
        enableSse: false,
        nowIso,
        fetchImpl: emptyFetch,
      });
      expect(ev4.event).toBe("idle_timeout");
      expect(ev4.should_rearm).toBe(true);
      expect(ev4.max_idle_ms).toBe(10_800_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-request HTTP deadlines prevent hung requests from wedging join/send/pollOnce, and SSE strips BOM + releases reader lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-deadline-"));
    try {
      const hungFetch = ((_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason || new Error("Aborted")), { once: true });
        })) as any;

      const joinRes = await joinChannelRest({
        restUrl: "https://agents-chat.com",
        agentId: "bot-deadline",
        token: "ac_test_token_123456",
        channelId: "welcome",
        timeoutMs: 15,
        fetchImpl: hungFetch,
      });
      expect(joinRes.ok).toBe(false);
      expect(joinRes.status).toBe(0);
      expect(joinRes.error).toContain("timed out");

      const sendRes = await sendRestMessage({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-deadline",
        token: "ac_test_token_123456",
        channelId: "dm-test",
        text: "ping",
        timeoutMs: 15,
        fetchImpl: hungFetch,
      });
      expect(sendRes.ok).toBe(false);
      expect(sendRes.status).toBe(0);

      // 1st /api/channels/mine hangs -> aborted by requestTimeoutMs=15ms so 2nd poll succeeds and SSE delivers BOM-prefixed DM!
      let mineCalls = 0;
      let sseStreamRef: ReadableStream<Uint8Array> | null = null;
      const wakeEv = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-deadline",
        token: "ac_test_token_123456",
        timeoutMs: 500,
        requestTimeoutMs: 15,
        pollIntervalMs: 20,
        enableSse: true,
        nowIso: () => "2026-11-14T11:00:00.000Z",
        fetchImpl: (async (url: any, init: any) => {
          const u = String(url);
          if (u.endsWith("/api/channels/mine")) {
            mineCalls++;
            if (mineCalls === 1) return hungFetch(url, init);
            return Response.json({ channels: [{ id: "dm-live", last_message_at: "2026-11-14T11:00:01.000Z" }] });
          }
          if (u.includes("/api/channels/dm-live/stream")) {
            const encoder = new TextEncoder();
            sseStreamRef = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `\uFEFFdata: ${JSON.stringify({
                      id: "sse-dm-1",
                      channel_id: "dm-live",
                      sender_id: "owner",
                      content: "live over sse",
                      timestamp: "2026-11-14T11:00:01.000Z",
                    })}\n\n`,
                  ),
                );
              },
            });
            return new Response(sseStreamRef, { status: 200 });
          }
          return Response.json({ messages: [] });
        }) as any,
      });
      expect(wakeEv.event).toBe("agentschat_wake");
      expect(wakeEv.message_id).toBe("sse-dm-1");
      expect(mineCalls).toBeGreaterThanOrEqual(2);
      // Give the async SSE IIFE microtask a tick to run its finally { reader.releaseLock() }
      await new Promise((r) => setTimeout(r, 5));
      expect(sseStreamRef!.locked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DEFAULT_MAX_IDLE_MS defaults to 0 (infinite standby) so --wake-once never auto-hibernates after 1h unless --max-idle is explicitly set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rest-cli-inf-standby-"));
    try {
      const cursorFile = join(dir, "last-seen-msg-ts-bot-inf.json");
      let currentMs = Date.parse("2026-11-14T12:00:00.000Z");
      writeFileSync(
        cursorFile,
        JSON.stringify({
          [CURSOR_INIT_KEY]: "2026-11-14T12:00:00.000Z",
          [CURSOR_LAST_ACTIVE_KEY]: "2026-11-14T12:00:00.000Z",
          welcome: "2026-11-14T12:00:00.000Z",
        }),
      );
      // 3 hours later with NO explicit maxIdleMs -> must return idle_timeout + should_rearm: true (NOT hibernate!)
      currentMs = Date.parse("2026-11-14T15:05:00.000Z");
      const ev = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-inf",
        token: "ac_test_token_123456",
        channels: ["welcome"],
        timeoutMs: 15,
        pollIntervalMs: 50,
        enableSse: false,
        nowIso: () => new Date(currentMs).toISOString(),
        fetchImpl: (async (url: any) => {
          if (String(url).endsWith("/api/channels/mine")) return Response.json({ channels: [{ id: "welcome" }] });
          return Response.json({ messages: [] });
        }) as any,
      });
      expect(ev.event).toBe("idle_timeout");
      expect(ev.should_rearm).toBe(true);
      expect(ev.max_idle_ms).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

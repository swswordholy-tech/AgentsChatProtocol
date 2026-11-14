import { describe, expect, test } from "bun:test";
import { AgentChatClient } from "../src/client";
import { AgentChatREST } from "../src/rest";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  emitError() {
    this.onerror?.();
  }
}

describe("TypeScript SDK — AgentChatREST timeout & SSE signal discipline (Campaign #85)", () => {
  test("rejects non-positive timeoutMs in constructor", () => {
    expect(() => new AgentChatREST({ baseUrl: "https://agents-chat.com", timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => new AgentChatREST({ baseUrl: "https://agents-chat.com", timeoutMs: -5 })).toThrow("timeoutMs");
  });

  test("aborts stalled REST and SSE handshake calls after timeoutMs", async () => {
    const stalledFetch: typeof fetch = ((_input: any, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(sig.reason ?? new Error("aborted"));
          return;
        }
        sig?.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")), { once: true });
      })) as typeof fetch;

    const rest = new AgentChatREST({
      baseUrl: "https://agents-chat.com/",
      bearerToken: "ac_test_token",
      timeoutMs: 40,
      fetchImpl: stalledFetch,
    });

    await expect(rest.health()).rejects.toThrow("timed out after 40ms");
    await expect(
      rest.savePersonalSkill("my-skill", {
        body_markdown: "---\nname: my-skill\ndescription: demo skill\n---\n# Skill",
      }),
    ).rejects.toThrow("timed out after 40ms");
    await expect(rest.archiveChannelDoc("room-1", "doc-1", 1)).rejects.toThrow("timed out after 40ms");
    await expect(rest.saveMemory("mem-1", { body_markdown: "notes" })).rejects.toThrow("timed out after 40ms");

    await expect(
      rest.streamChannelEvents("room-1", { onEvent: () => {} }),
    ).rejects.toThrow("timed out after 40ms");
  });

  test("streamChannelEvents keeps open stream alive past connect timeoutMs once headers arrive", async () => {
    const te = new TextEncoder();
    const fastHeaderLongBodyFetch: typeof fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(60); // longer than timeoutMs=25!
          controller.enqueue(te.encode('data: {"type":"ping_ok","seq":1}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const rest = new AgentChatREST({
      baseUrl: "https://agents-chat.com",
      timeoutMs: 25,
      fetchImpl: fastHeaderLongBodyFetch,
    });

    const events: Record<string, unknown>[] = [];
    await rest.streamChannelEvents("room-1", {
      onEvent: (ev) => {
        events.push(ev);
      },
    });
    expect(events).toEqual([{ type: "ping_ok", seq: 1 }]);
  });
});

describe("TypeScript SDK — AgentChatClient auth_error, shard_moved, onerror & async handler safety (Campaign #85)", () => {
  test("auth_error during handshake rejects connect immediately and closes socket", async () => {
    let sock!: FakeWebSocket;
    const errors: Array<{ code: number; msg: string }> = [];
    const client = new AgentChatClient({
      url: "wss://agents-chat.com/ws",
      agentId: "bot-1",
      token: "bad-key",
      connectTimeoutMs: 5_000,
      wsFactory: () => {
        sock = new FakeWebSocket();
        queueMicrotask(() => {
          sock.emitOpen();
          sock.emitMessage({ type: "auth_error", reason: "invalid key" });
        });
        return sock as unknown as WebSocket;
      },
    });
    client.onError((code, msg) => errors.push({ code, msg }));

    await expect(client.connect()).rejects.toThrow("Auth failed: invalid key");
    expect(sock.closed).toBe(true);
    expect(client.isConnected).toBe(false);
    expect(errors).toEqual([{ code: 401, msg: "invalid key" }]);
  });

  test("mid-session shard_moved stops heartbeat, notifies onReconnectNeeded, and closes socket", async () => {
    let sock!: FakeWebSocket;
    const reconnects: Array<{ reason: string; targetUrl?: string }> = [];
    const presenceEvents: any[] = [];
    const threadEvents: any[] = [];

    const client = new AgentChatClient({
      url: "wss://agents-chat.com/ws",
      agentId: "bot-1",
      heartbeatInterval: 20,
      wsFactory: () => {
        sock = new FakeWebSocket();
        queueMicrotask(() => {
          sock.emitOpen();
          sock.emitMessage({ type: "auth_ok", session_id: "sess-99" });
        });
        return sock as unknown as WebSocket;
      },
    });

    // Async throwing handler must be isolated without unhandledRejection
    client.onPresence(async () => {
      throw new Error("async handler boom");
    });
    client.onPresence((p) => {
      presenceEvents.push(p);
    });
    client.onThread((t) => {
      threadEvents.push(t);
    });
    client.onReconnectNeeded((info) => {
      reconnects.push(info);
    });

    await client.connect();
    expect(client.isConnected).toBe(true);

    // agent_offline omitting display_name & capabilities
    sock.emitMessage({ type: "agent_offline", agent_id: "peer-7" });
    // thread_reply using gateway thread_id alias
    sock.emitMessage({
      type: "thread_reply",
      id: "tr-1",
      thread_id: "root-msg-1",
      channel_id: "ch-1",
      sender_id: "peer-7",
      sender_type: "agent",
      content: "hello",
      timestamp: "2026-11-14T00:00:00Z",
    });
    // shard_moved drain frame
    sock.emitMessage({ type: "shard_moved", target_url: "wss://shard2.agents-chat.com/ws" });

    await Bun.sleep(35);
    const sentCountAfterClose = sock.sent.length;
    await Bun.sleep(35);
    // Heartbeat timer stopped -> zero additional pings sent
    expect(sock.sent.length).toBe(sentCountAfterClose);
    expect(sock.closed).toBe(true);
    expect(client.isConnected).toBe(false);
    expect(presenceEvents).toEqual([
      { type: "agent_offline", agent_id: "peer-7", display_name: "peer-7", capabilities: [] },
    ]);
    expect(threadEvents[0]?.parent_id).toBe("root-msg-1");
    expect(reconnects).toEqual([
      { reason: "shard_moved", targetUrl: "wss://shard2.agents-chat.com/ws" },
    ]);
  });

  test("onerror before auth closes socket and rejects connect", async () => {
    let sock!: FakeWebSocket;
    const client = new AgentChatClient({
      url: "wss://agents-chat.com/ws",
      agentId: "bot-1",
      wsFactory: () => {
        sock = new FakeWebSocket();
        queueMicrotask(() => sock.emitError());
        return sock as unknown as WebSocket;
      },
    });
    await expect(client.connect()).rejects.toThrow("WebSocket error");
    expect(sock.closed).toBe(true);
    expect(client.isConnected).toBe(false);
  });
});

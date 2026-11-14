import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentChatClient } = await jiti.import("../src/agentchat-client.ts");
const { getMentionCursor, setMentionCursor } = await jiti.import("../src/state.ts");
const { buildInboundPolicy } = await jiti.import("../src/policy.ts");

async function startMockServer(onConnection) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    close: async () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch {}
      }
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("connectTimeoutMs rejects hung handshakes when server never replies with auth_ok", async () => {
  const srv = await startMockServer(() => {
    // Accept socket, intentionally never send auth_ok
  });
  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-timeout",
    connectTimeoutMs: 60,
    reconnect: false,
  });
  try {
    await assert.rejects(() => client.connect(), /timed out/i);
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("malformed JSON frames, throwing handlers, inbound/outbound thread_reply, and channel_created tracking", async () => {
  const serverReceived = [];
  let serverSocket = null;
  const srv = await startMockServer((ws) => {
    serverSocket = ws;
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      serverReceived.push(parsed);
      if (parsed.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: "sess-1" }));
      }
    });
  });

  const delivered = [];
  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-thread",
    reconnect: false,
  });

  // First handler throws synchronously; second rejects asynchronously; third still receives all valid messages.
  client.onMessage(() => {
    throw new Error("sync boom");
  });
  client.onMessage(async () => {
    throw new Error("async boom");
  });
  client.onMessage((msg) => {
    delivered.push(msg);
  });

  try {
    await client.connect();
    client.joinChannel("room-main");

    // Send malformed JSON + non-object JSON + dynamic channel_created + thread_reply
    serverSocket.send("{not-valid-json");
    serverSocket.send("null");
    serverSocket.send(JSON.stringify({ type: "channel_created", channel_id: "room-dynamic" }));
    serverSocket.send(JSON.stringify({
      type: "thread_reply",
      id: "tr-1",
      channel_id: "room-main",
      parent_id: "root-msg-99",
      sender_id: "alice",
      sender_type: "human",
      content: "@bot-thread reply in thread",
      content_type: "text",
      timestamp: "2026-11-14T12:00:00.000Z",
    }));

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(client.getJoinedChannels(), ["room-main", "room-dynamic"]);
    assert.ok(
      serverReceived.some((m) => m.type === "join_channel" && m.channel_id === "room-dynamic"),
      "channel_created must immediately send join_channel over the live WebSocket",
    );
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, "tr-1");
    assert.equal(delivered[0].thread_id, "root-msg-99");

    // Outbound thread reply uses protocol type "thread_reply" + parent_id
    client.sendMessage("room-main", "threaded answer", "root-msg-99");
    await new Promise((r) => setTimeout(r, 30));
    const outboundThread = serverReceived.find((m) => m.type === "thread_reply");
    assert.ok(outboundThread, "expected outbound thread_reply frame");
    assert.equal(outboundThread.parent_id, "root-msg-99");
    assert.equal(outboundThread.channel_id, "room-main");
    assert.equal(outboundThread.content, "threaded answer");
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("auth_error during reconnect immediately halts reconnect loop and resolves lifecycle", async () => {
  let connections = 0;
  const sockets = [];
  const srv = await startMockServer((ws) => {
    connections += 1;
    sockets.push(ws);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.type !== "auth") return;
      if (connections === 1) {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: "sess-ok" }));
      } else {
        ws.send(JSON.stringify({ type: "auth_error", message: "token revoked" }));
      }
    });
  });

  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-revoked",
    initialReconnectDelayMs: 20,
    maxReconnectDelayMs: 40,
  });

  try {
    await client.connect();
    assert.equal(connections, 1);
    // Drop connection #1 -> triggers reconnect #2 -> receives auth_error -> must stop reconnecting!
    sockets[0].close();
    await client.waitUntilClosed();
    assert.equal(connections, 2);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(connections, 2, "must not reconnect after terminal auth_error");
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("shard_moved triggers fast reconnect and invokes onReconnect", async () => {
  let connections = 0;
  let reconnected = 0;
  const sockets = [];
  const srv = await startMockServer((ws) => {
    connections += 1;
    sockets.push(ws);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: `sess-${connections}` }));
      }
    });
  });

  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-drain",
    initialReconnectDelayMs: 5_000,
    maxReconnectDelayMs: 40,
    onReconnect: () => {
      reconnected += 1;
    },
  });

  try {
    await client.connect();
    sockets[0].send(JSON.stringify({ type: "shard_moved" }));
    const deadline = Date.now() + 2_000;
    while ((connections < 2 || reconnected < 1) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(connections, 2);
    assert.equal(reconnected, 1);
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("mentionCursors caps at 2000 entries (FIFO) and history fetch passes an AbortSignal timeout", async () => {
  for (let i = 0; i < 2_005; i += 1) {
    setMentionCursor("acc-cap", `conv-${i}`, `2026-11-14T00:00:${String(i % 60).padStart(2, "0")}Z`);
  }
  assert.equal(getMentionCursor("acc-cap", "conv-0"), undefined);
  assert.equal(getMentionCursor("acc-cap", "conv-4"), undefined);
  assert.ok(getMentionCursor("acc-cap", "conv-5"));
  assert.ok(getMentionCursor("acc-cap", "conv-2004"));

  let receivedSignal = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    receivedSignal = init?.signal ?? null;
    return Response.json({ messages: [] });
  };
  try {
    await buildInboundPolicy({
      account: {
        accountId: "acc-sig",
        agentId: "sig-bot",
        wsUrl: "wss://agents-chat.com/ws",
        token: "tok",
        enabled: true,
      },
      accountId: "acc-sig",
      message: {
        type: "message",
        id: "m-sig",
        channel_id: "room-sig",
        sender_id: "alice",
        sender_type: "human",
        content: "@sig-bot ping",
        content_type: "text",
        timestamp: "2026-11-14T12:00:00.000Z",
      },
    });
    assert.ok(receivedSignal instanceof AbortSignal, "fetchChannelHistory must pass an AbortSignal");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("post-auth_ok socket error keeps waitUntilClosed() pending, reconnects cleanly, and leaves zero zombie timers on disconnect", async () => {
  let connections = 0;
  let reconnected = 0;
  const sockets = [];
  const srv = await startMockServer((ws) => {
    connections += 1;
    sockets.push(ws);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: `sess-err-${connections}` }));
      }
    });
  });

  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-tcp-reset",
    initialReconnectDelayMs: 25,
    maxReconnectDelayMs: 50,
    onReconnect: () => {
      reconnected += 1;
    },
  });

  try {
    await client.connect();
    let lifecycleSettled = false;
    let lifecycleRejected = null;
    const closedPromise = client
      .waitUntilClosed()
      .then(() => {
        lifecycleSettled = true;
      })
      .catch((err) => {
        lifecycleRejected = err;
      });

    // Simulate a live TCP socket error (`onerror` fires BEFORE `onclose` on the client socket)
    client.ws.onerror?.(new Error("read ECONNRESET"));
    sockets[0].terminate();

    await new Promise((r) => setTimeout(r, 90));
    assert.equal(lifecycleRejected, null, "waitUntilClosed() must not reject on transient post-auth socket error");
    assert.equal(lifecycleSettled, false, "waitUntilClosed() must remain open while auto-reconnect recovers");
    assert.equal(connections, 2, "client must reconnect after transient socket error");
    assert.equal(reconnected, 1, "onReconnect callback must fire once re-authenticated");

    client.disconnect();
    await closedPromise;
    assert.equal(lifecycleSettled, true);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(connections, 2, "disconnect() must stop all further reconnects");
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("post-auth_ok socket error rejects waitUntilClosed() when reconnect is explicitly disabled", async () => {
  let serverSocket = null;
  const srv = await startMockServer((ws) => {
    serverSocket = ws;
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: "sess-noreconnect" }));
      }
    });
  });

  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-no-reconnect",
    reconnect: false,
  });

  try {
    await client.connect();
    const waitPromise = client.waitUntilClosed();
    client.ws.onerror?.(new Error("read ECONNRESET"));
    serverSocket.terminate();
    await assert.rejects(() => waitPromise, /WebSocket error/i);
  } finally {
    client.disconnect();
    await srv.close();
  }
});

test("skips __typing__ frames, queues sendMessage during transient reconnect, throws when disconnected, and recovers stale half-open sockets", async () => {
  const serverReceived = [];
  let connections = 0;
  const sockets = [];
  const srv = await startMockServer((ws) => {
    connections += 1;
    const connNum = connections;
    sockets.push(ws);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      serverReceived.push({ connNum, frame: parsed });
      if (parsed.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: `sess-q-${connNum}` }));
      } else if (parsed.type === "ping" && connNum >= 2) {
        // Connection #1 intentionally blackholes pings (half-open); #2+ responds with pong
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });
  });

  const delivered = [];
  const client = new AgentChatClient({
    url: srv.url,
    agentId: "bot-queue-stale",
    heartbeatInterval: 20,
    initialReconnectDelayMs: 20,
    maxReconnectDelayMs: 40,
    onReconnect: () => {
      client.joinChannel("room-q");
    },
  });
  client.onMessage((msg) => delivered.push(msg));

  try {
    await client.connect();
    client.joinChannel("room-q");

    // Ephemeral __typing__ must not fire messageHandlers; reply_to maps to thread_id
    sockets[0].send(JSON.stringify({
      type: "message",
      id: "typing-1",
      channel_id: "room-q",
      sender_id: "alice",
      content: "__typing__",
    }));
    sockets[0].send(JSON.stringify({
      type: "message",
      id: "real-1",
      channel_id: "room-q",
      sender_id: "alice",
      reply_to: "parent-42",
      content: "hi",
    }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, "real-1");
    assert.equal(delivered[0].thread_id, "parent-42");

    // Connection #1 stops sending anything -> stale heartbeat (> 60ms) terminates and reconnects to #2!
    const deadline = Date.now() + 1000;
    while (connections < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(connections >= 2, "stale half-open socket must trigger heartbeat termination and reconnect");

    // Now drop connection #2 and call sendMessage while reconnecting -> must flush on connection #3!
    sockets[1].close();
    await new Promise((r) => setTimeout(r, 5));
    client.sendMessage("room-q", "buffered-during-reconnect");
    const flushDeadline = Date.now() + 1000;
    while (
      !serverReceived.some((x) => x.frame.type === "message" && x.frame.content === "buffered-during-reconnect") &&
      Date.now() < flushDeadline
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const flushedIdx = serverReceived.findIndex(
      (x) => x.frame.type === "message" && x.frame.content === "buffered-during-reconnect",
    );
    const rejoinIdx = serverReceived.findIndex(
      (x) => x.connNum === 3 && x.frame.type === "join_channel" && x.frame.channel_id === "room-q",
    );
    assert.ok(flushedIdx > rejoinIdx && rejoinIdx >= 0, "queued message must flush after onReconnect join_channel");

    // Explicit disconnect() rejects further sendMessage calls instead of silently dropping
    client.disconnect();
    assert.throws(() => client.sendMessage("room-q", "after-stop"), /not connected/i);
  } finally {
    client.disconnect();
    await srv.close();
  }
});

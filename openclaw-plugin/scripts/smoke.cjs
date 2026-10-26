const http = require("node:http");
const { URL } = require("node:url");
const { WebSocketServer } = require("ws");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(check, timeoutMs = 3_000, intervalMs = 25) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function main() {
  const { agentChatGateway } = await jiti.import("../src/gateway.ts");

  const historyRequests = [];
  const outboundMessages = [];
  const dispatchContexts = [];
  const sessionRecords = [];
  const joinedChannels = [];
  let currentStatus = {};

  const mentionMessage = {
    type: "message",
    id: "m-mention",
    channel_id: "room-1",
    sender_id: "alice",
    sender_type: "human",
    content: "@claw-bot hello there",
    content_type: "text",
    timestamp: "2026-04-15T10:00:02.000Z",
  };

  const channelHistory = {
    "room-1": [
      {
        type: "message",
        id: "m-1",
        channel_id: "room-1",
        sender_id: "bob",
        sender_type: "human",
        content: "older context one",
        content_type: "text",
        timestamp: "2026-04-15T10:00:00.000Z",
      },
      {
        type: "message",
        id: "m-2",
        channel_id: "room-1",
        sender_id: "charlie",
        sender_type: "agent",
        content: "older context two",
        content_type: "text",
        timestamp: "2026-04-15T10:00:01.000Z",
      },
      mentionMessage,
    ],
    "dm-1": [
      {
        type: "message",
        id: "dm-1",
        channel_id: "dm-1",
        sender_id: "human-1",
        sender_type: "human",
        content: "hi from dm",
        content_type: "text",
        timestamp: "2026-04-15T10:01:00.000Z",
      },
    ],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.startsWith("/api/channels/") && url.pathname.endsWith("/messages")) {
      const channelId = decodeURIComponent(url.pathname.split("/")[3]);
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") || "50");
      historyRequests.push({ channelId, after, limit });
      const messages = (channelHistory[channelId] || [])
        .filter((message) => !after || message.timestamp > after)
        .slice(-limit);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new WebSocketServer({ server });
  let socket;

  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_ok", session_id: "smoke-session" }));
        return;
      }

      if (message.type === "join_channel") {
        joinedChannels.push(message.channel_id);
        return;
      }

      if (message.type === "message") {
        outboundMessages.push(message);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const runtime = {
    routing: {
      resolveAgentRoute: ({ accountId, peer }) => ({
        agentId: "openclaw-agent",
        channel: "agentchat",
        accountId: accountId ?? "default",
        sessionKey: `session:${peer?.id ?? "default"}`,
        mainSessionKey: `main:${peer?.id ?? "default"}`,
        lastRoutePolicy: "session",
        matchedBy: "default",
      }),
    },
    session: {
      resolveStorePath: () => "/tmp/openclaw-smoke-session.json",
      recordInboundSession: async ({ ctx, sessionKey }) => {
        sessionRecords.push({ ctx, sessionKey });
      },
    },
    reply: {
      finalizeInboundContext: (ctx) => ({
        ...ctx,
        CommandAuthorized: ctx.CommandAuthorized ?? false,
      }),
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }) => {
        dispatchContexts.push(ctx);
        await dispatcherOptions.deliver({ text: `pong:${ctx.RawBody}` });
      },
    },
  };

  const abortController = new AbortController();
  const ctx = {
    cfg: {},
    accountId: "bot-account",
    account: {
      accountId: "bot-account",
      agentId: "claw-bot",
      token: "test-token",
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      defaultChannelId: "room-1",
      enabled: true,
      name: "Claw Bot",
    },
    runtime: {},
    abortSignal: abortController.signal,
    channelRuntime: runtime,
    getStatus: () => currentStatus,
    setStatus: (next) => {
      currentStatus = next;
    },
    log: {
      info: () => {},
      warn: () => {},
      error: (...args) => console.error("[smoke:error]", ...args),
      debug: () => {},
    },
  };

  // startAccount is a long-lived run loop: openclaw's host (see
  // server-channels' trackedPromise) runs it as a background task and only
  // sees it resolve when the channel shuts down — a normal resolve is even
  // logged as "channel exited". So we must NOT await it inline here; fire it
  // as a background task, drive the assertions, then stop to let it resolve.
  const startTask = Promise.resolve(agentChatGateway.startAccount(ctx)).catch(
    (err) => console.error("[smoke:startAccount]", err),
  );
  await waitFor(() => joinedChannels.includes("room-1"));

  socket.send(JSON.stringify({
    type: "message",
    id: "m-silent",
    channel_id: "room-1",
    sender_id: "bob",
    sender_type: "human",
    content: "no mention here",
    content_type: "text",
    timestamp: "2026-04-15T10:00:01.500Z",
  }));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(outboundMessages.length === 0, "non-mention group message should not trigger outbound reply");

  socket.send(JSON.stringify(mentionMessage));
  await waitFor(() => outboundMessages.length === 1);
  assert(outboundMessages[0].channel_id === "room-1", "mention reply should go back to same room");
  assert(outboundMessages[0].content === "pong:@claw-bot hello there", "mention reply payload mismatch");
  assert(historyRequests.length === 1, "mention should fetch exactly one history window");
  assert(dispatchContexts.length >= 1, "mention should dispatch inbound context");
  assert(
    String(dispatchContexts[0].BodyForAgent || "").includes("[频道上下文 -"),
    "mention dispatch should include MCP-style context prefix",
  );
  assert(
    String(dispatchContexts[0].BodyForAgent || "").includes("bob: older context one"),
    "mention dispatch should include prior history",
  );

  socket.send(JSON.stringify(channelHistory["dm-1"][0]));
  await waitFor(() => outboundMessages.length === 2);
  assert(outboundMessages[1].channel_id === "dm-1", "dm reply should go back to dm channel");
  assert(outboundMessages[1].content === "pong:hi from dm", "dm reply payload mismatch");
  assert(historyRequests.length === 1, "dm path should not fetch channel history");

  await agentChatGateway.stopAccount(ctx);
  await startTask; // confirm the run loop unwinds cleanly on shutdown
  wss.close();
  await new Promise((resolve) => server.close(resolve));

  console.log("smoke ok");
  console.log(
    JSON.stringify(
      {
        joinedChannels,
        outboundCount: outboundMessages.length,
        historyRequests,
        sessionRecordCount: sessionRecords.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

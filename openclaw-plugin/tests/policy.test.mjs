// Unit tests for buildInboundPolicy (src/policy.ts) — the inbound gate that
// decides whether a message dispatches to the agent and assembles the context
// prefix. Network is stubbed via globalThis.fetch; mention-cursor state is the
// real in-memory store (tests use distinct channel ids for isolation).
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildInboundPolicy } = await jiti.import("../src/policy.ts");
const { getMentionCursor } = await jiti.import("../src/state.ts");
const { buildConversationId } = await jiti.import("../src/conversation.ts");

const ACCOUNT = {
  accountId: "acc-1",
  agentId: "claw-bot",
  name: "Claw Bot",
  wsUrl: "wss://example.com/ws",
  token: "tok-123",
  enabled: true,
};

function message(overrides = {}) {
  return {
    type: "message",
    id: "m-now",
    channel_id: "room-1",
    sender_id: "alice",
    sender_type: "human",
    content: "@claw-bot hello there",
    content_type: "text",
    timestamp: "2026-04-15T10:00:02.000Z",
    ...overrides,
  };
}

// Replace globalThis.fetch for the duration of fn, then restore.
async function withFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function okHistory(messages) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages }),
  });
}

test("group message without a mention does not dispatch and never fetches", async () => {
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      return okHistory([])();
    },
    async () => {
      const result = await buildInboundPolicy({
        account: ACCOUNT,
        accountId: ACCOUNT.accountId,
        message: message({ channel_id: "room-nomention", content: "just chatting, nobody pinged" }),
      });
      assert.equal(result.shouldDispatch, false);
      assert.equal(result.bodyForAgent, "just chatting, nobody pinged");
    },
  );
  assert.equal(fetched, false, "history must not be fetched when not dispatching");
});

test("direct message dispatches without a mention and without fetching history", async () => {
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      return okHistory([])();
    },
    async () => {
      const result = await buildInboundPolicy({
        account: ACCOUNT,
        accountId: ACCOUNT.accountId,
        message: message({ channel_id: "dm-acc-1-alice", content: "hi privately" }),
      });
      assert.equal(result.shouldDispatch, true);
      assert.equal(result.bodyForAgent, "hi privately");
    },
  );
  assert.equal(fetched, false, "DMs skip the history fetch");
});

test("group @id mention dispatches, prepends history context, advances cursor", async () => {
  const channelId = "room-mention-id";
  const history = [
    { id: "h1", channel_id: channelId, sender_id: "bob", content: "earlier one", timestamp: "2026-04-15T09:59:00.000Z" },
    { id: "h2", channel_id: channelId, sender_id: "carol", content: "earlier two", timestamp: "2026-04-15T09:59:30.000Z" },
  ];
  await withFetch(okHistory(history), async () => {
    const msg = message({ channel_id: channelId });
    const result = await buildInboundPolicy({
      account: ACCOUNT,
      accountId: ACCOUNT.accountId,
      message: msg,
    });
    assert.equal(result.shouldDispatch, true);
    assert.match(result.bodyForAgent, /\[频道上下文/);
    assert.match(result.bodyForAgent, /bob: earlier one/);
    assert.match(result.bodyForAgent, /carol: earlier two/);
    // current message body is appended after the prefix
    assert.ok(result.bodyForAgent.endsWith("alice: @claw-bot hello there"));
    // cursor advanced to this message's timestamp
    assert.equal(
      getMentionCursor(ACCOUNT.accountId, buildConversationId(channelId)),
      msg.timestamp,
    );
  });
});

test("group display-name mention @Name(id) also dispatches", async () => {
  await withFetch(okHistory([]), async () => {
    const result = await buildInboundPolicy({
      account: ACCOUNT,
      accountId: ACCOUNT.accountId,
      message: message({
        channel_id: "room-mention-display",
        content: "hey @Claw Bot(claw-bot) can you help",
      }),
    });
    assert.equal(result.shouldDispatch, true);
  });
});

test("the current message and __typing__ noise are filtered out of context", async () => {
  const channelId = "room-filter";
  const history = [
    { id: "m-now", channel_id: channelId, sender_id: "alice", content: "should be excluded (current)", timestamp: "2026-04-15T10:00:02.000Z" },
    { id: "t1", channel_id: channelId, sender_id: "bob", content: "__typing__", timestamp: "2026-04-15T09:59:50.000Z" },
    { id: "h9", channel_id: channelId, sender_id: "dave", content: "real prior line", timestamp: "2026-04-15T09:59:00.000Z" },
  ];
  await withFetch(okHistory(history), async () => {
    const result = await buildInboundPolicy({
      account: ACCOUNT,
      accountId: ACCOUNT.accountId,
      message: message({ channel_id: channelId }),
    });
    assert.match(result.bodyForAgent, /dave: real prior line/);
    assert.doesNotMatch(result.bodyForAgent, /should be excluded/);
    assert.doesNotMatch(result.bodyForAgent, /__typing__/);
  });
});

test("history fetch failure still dispatches, with no prefix and a warn log", async () => {
  const logs = [];
  await withFetch(
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => {
      const channelId = "room-fetchfail";
      const msg = message({ channel_id: channelId });
      const result = await buildInboundPolicy({
        account: ACCOUNT,
        accountId: ACCOUNT.accountId,
        message: msg,
        log: (level, message, meta) => logs.push({ level, message, meta }),
      });
      assert.equal(result.shouldDispatch, true);
      // no context prefix when history is unavailable — falls back to raw body
      assert.equal(result.bodyForAgent, "@claw-bot hello there");
      // cursor still advances so we don't re-pull the same window next time
      assert.equal(
        getMentionCursor(ACCOUNT.accountId, buildConversationId(channelId)),
        msg.timestamp,
      );
    },
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.match(logs[0].message, /history fetch failed/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import { shouldDispatch, isMentioned, buildContext, MAX_CONTEXT_BYTES } from "../src/policy.ts";

const msg = (over = {}) => ({
  id: "1",
  channel_id: "general",
  sender_id: "alice",
  sender_type: "agent",
  content: "hello",
  content_type: "text",
  timestamp: new Date().toISOString(),
  ...over,
});

test("DM always dispatches, group requires a mention", () => {
  assert.equal(shouldDispatch(msg(), { agentId: "muse-bot", channelKind: "direct" }), true);
  assert.equal(shouldDispatch(msg(), { agentId: "muse-bot", channelKind: "group" }), false);
  assert.equal(
    shouldDispatch(msg({ content: "hey @muse-bot what do you think?" }), { agentId: "muse-bot", channelKind: "group" }),
    true,
  );
  assert.equal(
    shouldDispatch(msg({ content: "hey @muse, ping" }), { agentId: "muse-bot", channelKind: "group" }),
    true,
  );
});

test("own messages never dispatch", () => {
  assert.equal(
    shouldDispatch(msg({ sender_id: "muse-bot" }), { agentId: "muse-bot", channelKind: "direct" }),
    false,
  );
});

test("isMentioned is case-insensitive and honours display names", () => {
  assert.equal(isMentioned("Hi @Muse-Bot", "muse-bot"), true);
  assert.equal(isMentioned("Hi @LinWan", "muse-bot", "LinWan"), true);
  assert.equal(isMentioned("hi there", "muse-bot"), false);
});

test("buildContext caps history and total bytes", () => {
  const messages = Array.from({ length: 100 }, (_, i) => msg({ id: String(i), content: `message ${i} `.repeat(200) }));
  const ctx = buildContext(messages, "muse-bot");
  assert.ok(new TextEncoder().encode(ctx).length <= MAX_CONTEXT_BYTES);
  assert.ok(ctx.includes("message 99"));
});

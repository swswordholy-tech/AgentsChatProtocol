// Unit tests for the conversation-id codec (src/conversation.ts).
// Run via `npm test` (node --test). TS is loaded through jiti, matching
// the toolchain already used by scripts/smoke.cjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildConversationId, parseConversationId } = await jiti.import("../src/conversation.ts");

const PREFIX = "agentchat:channel:";

test("buildConversationId: channel only when no thread", () => {
  assert.equal(buildConversationId("room-1"), `${PREFIX}room-1`);
});

test("buildConversationId: empty / null / undefined thread → base only", () => {
  assert.equal(buildConversationId("room-1", undefined), `${PREFIX}room-1`);
  assert.equal(buildConversationId("room-1", null), `${PREFIX}room-1`);
  assert.equal(buildConversationId("room-1", ""), `${PREFIX}room-1`);
});

test("buildConversationId: appends string and numeric thread ids", () => {
  assert.equal(buildConversationId("room-1", "t1"), `${PREFIX}room-1:thread:t1`);
  assert.equal(buildConversationId("room-1", 5), `${PREFIX}room-1:thread:5`);
});

test("parseConversationId: base form yields undefined thread", () => {
  assert.deepEqual(parseConversationId(`${PREFIX}room-1`), {
    channelId: "room-1",
    threadId: undefined,
  });
});

test("parseConversationId: thread form splits channel and thread", () => {
  assert.deepEqual(parseConversationId(`${PREFIX}room-1:thread:t1`), {
    channelId: "room-1",
    threadId: "t1",
  });
});

test("parseConversationId: trailing separator with empty thread → undefined", () => {
  assert.deepEqual(parseConversationId(`${PREFIX}room-1:thread:`), {
    channelId: "room-1",
    threadId: undefined,
  });
});

test("parseConversationId: non-prefixed id returns null", () => {
  assert.equal(parseConversationId("not-a-conversation"), null);
  assert.equal(parseConversationId(""), null);
});

test("round-trip: parse(build(channel, thread)) recovers inputs", () => {
  for (const [channel, thread] of [
    ["room-1", undefined],
    ["room-1", "t1"],
    ["dm-alice-bob", "42"],
  ]) {
    const parsed = parseConversationId(buildConversationId(channel, thread));
    assert.equal(parsed.channelId, channel);
    assert.equal(parsed.threadId, thread === undefined ? undefined : String(thread));
  }
});

test("parseConversationId: first ':thread:' wins for an embedded separator", () => {
  // Documents current behavior: a channel id that itself contains the
  // separator is split at the first occurrence.
  const parsed = parseConversationId(`${PREFIX}weird:thread:inner:thread:t1`);
  assert.equal(parsed.channelId, "weird");
  assert.equal(parsed.threadId, "inner:thread:t1");
});

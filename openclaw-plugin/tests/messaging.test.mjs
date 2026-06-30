// Unit tests for the messaging adapter's conversation resolution
// (src/messaging.ts). Pure functions — no network. TS via jiti.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentChatMessaging } = await jiti.import("../src/messaging.ts");
const { buildConversationId } = await jiti.import("../src/conversation.ts");

test("normalizeTarget: trims, and maps blank to undefined", () => {
  assert.equal(agentChatMessaging.normalizeTarget("  room-1 "), "room-1");
  assert.equal(agentChatMessaging.normalizeTarget("   "), undefined);
  assert.equal(agentChatMessaging.normalizeTarget(""), undefined);
});

test("resolveInboundConversation: prefers conversationId, then to, then from", () => {
  assert.equal(
    agentChatMessaging.resolveInboundConversation({ from: "room-1" }).conversationId,
    buildConversationId("room-1"),
  );
  assert.equal(
    agentChatMessaging.resolveInboundConversation({ to: "room-2", from: "room-1" }).conversationId,
    buildConversationId("room-2"),
  );
  assert.equal(
    agentChatMessaging.resolveInboundConversation({ conversationId: "room-3", to: "room-2" })
      .conversationId,
    buildConversationId("room-3"),
  );
});

test("resolveInboundConversation: thread sets parentConversationId to the base", () => {
  const result = agentChatMessaging.resolveInboundConversation({ from: "room-1", threadId: "t1" });
  assert.equal(result.conversationId, buildConversationId("room-1", "t1"));
  assert.equal(result.parentConversationId, buildConversationId("room-1"));
});

test("resolveInboundConversation: no base id → null", () => {
  assert.equal(agentChatMessaging.resolveInboundConversation({}), null);
});

test("resolveDeliveryTarget: parses channel + thread from conversationId", () => {
  assert.deepEqual(
    agentChatMessaging.resolveDeliveryTarget({
      conversationId: buildConversationId("room-1", "t1"),
    }),
    { to: "room-1", threadId: "t1" },
  );
});

test("resolveDeliveryTarget: falls back to parentConversationId when conversationId unparseable", () => {
  assert.deepEqual(
    agentChatMessaging.resolveDeliveryTarget({
      conversationId: "garbage",
      parentConversationId: buildConversationId("room-2"),
    }),
    { to: "room-2", threadId: undefined },
  );
});

test("resolveDeliveryTarget: nothing parseable → null", () => {
  assert.equal(agentChatMessaging.resolveDeliveryTarget({ conversationId: "garbage" }), null);
});

test("resolveSessionConversation: thread id exposes base + parent candidates", () => {
  const result = agentChatMessaging.resolveSessionConversation({
    rawId: buildConversationId("room-1", "t1"),
  });
  assert.equal(result.id, buildConversationId("room-1", "t1"));
  assert.equal(result.threadId, "t1");
  assert.equal(result.baseConversationId, buildConversationId("room-1"));
  assert.deepEqual(result.parentConversationCandidates, [buildConversationId("room-1")]);
});

test("resolveSessionConversation: no thread → null threadId, no parent candidates", () => {
  const result = agentChatMessaging.resolveSessionConversation({
    rawId: buildConversationId("room-1"),
  });
  assert.equal(result.threadId, null);
  assert.equal(result.parentConversationCandidates, undefined);
});

test("resolveSessionConversation: unparseable rawId → null", () => {
  assert.equal(agentChatMessaging.resolveSessionConversation({ rawId: "garbage" }), null);
});

test("resolveSessionTarget: builds a conversation id from id + thread", () => {
  assert.equal(
    agentChatMessaging.resolveSessionTarget({ id: "room-1", threadId: "t1" }),
    buildConversationId("room-1", "t1"),
  );
  assert.equal(
    agentChatMessaging.resolveSessionTarget({ id: "room-1" }),
    buildConversationId("room-1"),
  );
});

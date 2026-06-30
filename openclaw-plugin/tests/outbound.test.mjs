// Unit tests for the outbound adapter (src/outbound.ts). The gateway client is
// faked and injected through the real in-memory gateway-state store.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentChatOutbound } = await jiti.import("../src/outbound.ts");
const { setGatewayState, deleteGatewayState } = await jiti.import("../src/state.ts");
const { buildConversationId } = await jiti.import("../src/conversation.ts");

function seedClient(accountId) {
  const sent = [];
  setGatewayState(accountId, {
    client: { sendMessage: (to, text) => sent.push({ to, text }) },
    abortHandler: () => {},
  });
  return sent;
}

test("deliveryMode is gateway", () => {
  assert.equal(agentChatOutbound.deliveryMode, "gateway");
});

test("resolveTarget trims a valid target", () => {
  assert.deepEqual(agentChatOutbound.resolveTarget({ to: "  room-1 " }), { ok: true, to: "room-1" });
});

test("resolveTarget rejects blank / missing targets", () => {
  const blank = agentChatOutbound.resolveTarget({ to: "   " });
  assert.equal(blank.ok, false);
  assert.ok(blank.error instanceof Error);

  const missing = agentChatOutbound.resolveTarget({ to: undefined });
  assert.equal(missing.ok, false);
  assert.ok(missing.error instanceof Error);
});

test("sendText delivers via the gateway client and returns a result envelope", async () => {
  const accountId = "acc-out-ok";
  const sent = seedClient(accountId);
  try {
    const result = await agentChatOutbound.sendText({
      accountId,
      to: "room-x",
      text: "hello world",
      threadId: undefined,
    });
    assert.deepEqual(sent, [{ to: "room-x", text: "hello world" }]);
    assert.equal(result.channelId, "room-x");
    assert.equal(result.conversationId, buildConversationId("room-x"));
    assert.equal(typeof result.messageId, "string");
    assert.ok(result.messageId.length > 0);
    assert.equal(typeof result.timestamp, "number");
  } finally {
    deleteGatewayState(accountId);
  }
});

test("sendText carries the threadId into the conversation id", async () => {
  const accountId = "acc-out-thread";
  seedClient(accountId);
  try {
    const result = await agentChatOutbound.sendText({
      accountId,
      to: "room-y",
      text: "threaded",
      threadId: "t7",
    });
    assert.equal(result.conversationId, buildConversationId("room-y", "t7"));
  } finally {
    deleteGatewayState(accountId);
  }
});

test("sendText throws when accountId is missing", async () => {
  await assert.rejects(
    () => agentChatOutbound.sendText({ to: "room-x", text: "hi" }),
    /requires accountId/,
  );
});

test("sendText throws when the gateway is not running for the account", async () => {
  await assert.rejects(
    () => agentChatOutbound.sendText({ accountId: "acc-out-absent", to: "room-x", text: "hi" }),
    /not running for account/,
  );
});

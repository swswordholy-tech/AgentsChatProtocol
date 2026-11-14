import test from "node:test";
import assert from "node:assert/strict";
import { MuseBridge } from "../src/bridge.ts";
import { MuseAgentChatClient } from "../src/client.ts";

function stubBridge(replies) {
  const client = new MuseAgentChatClient({ url: "ws://127.0.0.1:1", agentId: "muse-bot", token: "x" });
  const sent = [];
  client.sendMessage = (channelId, content) => sent.push({ channelId, content });
  const bridge = new MuseBridge(client, {
    agentId: "muse-bot",
    channels: ["general"],
    channelKinds: { general: "group", dm1: "direct" },
    responder: async () => replies,
  });
  return { bridge, sent };
}

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

test("group message without mention stays silent", async () => {
  const { bridge, sent } = stubBridge("hi");
  await bridge.handleMessage(msg());
  assert.deepEqual(sent, []);
});

test("group @mention and DM dispatch a reply to the same channel", async () => {
  const { bridge, sent } = stubBridge("pong");
  await bridge.handleMessage(msg({ content: "hey @muse-bot" }));
  await bridge.handleMessage(msg({ channel_id: "dm1", content: "hello" }));
  assert.deepEqual(sent, [
    { channelId: "general", content: "pong" },
    { channelId: "dm1", content: "pong" },
  ]);
});

test("own messages and null replies stay silent", async () => {
  const { bridge, sent } = stubBridge(null);
  await bridge.handleMessage(msg({ sender_id: "muse-bot", channel_id: "dm1" }));
  await bridge.handleMessage(msg({ channel_id: "dm1" }));
  assert.deepEqual(sent, []);
});

test("responder failure still stops typing indicator in finally", async () => {
  const client = new MuseAgentChatClient({ url: "ws://127.0.0.1:1", agentId: "muse-bot", token: "x" });
  let typingFrames = 0;
  client.sendTyping = () => {
    typingFrames += 1;
  };
  const bridge = new MuseBridge(client, {
    agentId: "muse-bot",
    channels: ["dm1"],
    channelKinds: { dm1: "direct" },
    responder: async () => {
      throw new Error("llm_down");
    },
  });
  await assert.rejects(() => bridge.handleMessage(msg({ channel_id: "dm1", content: "ping" })), /llm_down/);
  assert.equal(typingFrames, 1);
  // Wait longer than typing interval safeguard or verify stopAll leaves 0 active timers
  bridge.stop();
});

test("Campaign #93: MuseAgentChatClient ignores __typing__ frames and MuseBridge forwards thread_id as reply_to", async () => {
  const client = new MuseAgentChatClient({ url: "ws://127.0.0.1:1", agentId: "muse-bot", token: "x" });
  const sent = [];
  client.sendMessage = (channelId, content, contentType, replyTo) =>
    sent.push({ channelId, content, contentType, replyTo });
  let capturedHistory = [];
  const bridge = new MuseBridge(client, {
    agentId: "muse-bot",
    channels: ["general"],
    channelKinds: { general: "group" },
    responder: async (ctx) => {
      capturedHistory = ctx.history;
      return "threaded-reply";
    },
  });

  // Feed 60 ephemeral __typing__ frames over the client wire parser; none should enter bridge history!
  for (let i = 0; i < 60; i++) {
    client.handleMessage(
      JSON.stringify({
        type: "message",
        id: `t-${i}`,
        channel_id: "general",
        sender_id: "alice",
        content: "__typing__",
      }),
    );
  }
  await bridge.handleMessage(msg({ id: "real-1", content: "context line" }));
  await bridge.handleMessage(msg({ id: "tr-2", content: "hey @muse-bot", thread_id: "root-msg-1" }));
  assert.equal(capturedHistory.length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, "root-msg-1");
});

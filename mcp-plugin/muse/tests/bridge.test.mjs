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

// Smoke test: policy + config only (no network, no tokens).
import assert from "node:assert/strict";
import { shouldDispatch } from "../src/policy.ts";
import { redact } from "../src/config.ts";

const base = {
  id: "1",
  channel_id: "dm1",
  sender_id: "alice",
  sender_type: "agent",
  content: "hi",
  content_type: "text",
  timestamp: new Date().toISOString(),
};
assert.equal(shouldDispatch(base, { agentId: "muse-bot", channelKind: "direct" }), true);
assert.equal(redact("ac_123456").includes("123456"), false);
console.log("mcp-plugin/muse smoke: ok");

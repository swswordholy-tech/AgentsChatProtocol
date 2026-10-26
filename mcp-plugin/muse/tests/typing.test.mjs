import test from "node:test";
import assert from "node:assert/strict";
import { TypingHeartbeat, TYPING_HEARTBEAT_MS } from "../src/typing.ts";

test("typing heartbeat pulses immediately and stops", async () => {
  let pulses = 0;
  const hb = new TypingHeartbeat(() => pulses++);
  hb.start("dm-1");
  assert.equal(pulses, 1, "first pulse is immediate");
  await new Promise((r) => setTimeout(r, TYPING_HEARTBEAT_MS + 200));
  assert.ok(pulses >= 2, "heartbeat keeps pulsing");
  hb.stop("dm-1");
  const stopped = pulses;
  await new Promise((r) => setTimeout(r, TYPING_HEARTBEAT_MS + 200));
  assert.equal(pulses, stopped, "stop ends the heartbeat");
  hb.stopAll();
});

test("typing heartbeat respects AGENTSCHAT_AUTO_TYPING=0", () => {
  process.env.AGENTSCHAT_AUTO_TYPING = "0";
  let pulses = 0;
  const hb = new TypingHeartbeat(() => pulses++);
  hb.start("dm-1");
  assert.equal(pulses, 0);
  delete process.env.AGENTSCHAT_AUTO_TYPING;
});

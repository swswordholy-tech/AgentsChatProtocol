import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendWakeQueue,
  buildMuseWakePrompt,
  buildWakePayload,
  fireWake,
  signWakeBody,
  verifyWakeSignature,
} from "../src/wake.ts";

test("wake payload caps content and redacts tokens", () => {
  const p = buildWakePayload({
    id: "m1",
    channel_id: "welcome",
    sender_id: "alice",
    content: "hi ac_1234567890 " + "x".repeat(1000),
  });
  assert.equal(p.message_id, "m1");
  assert.ok(!p.content.includes("ac_1234567890"));
  assert.ok(p.content.length <= 500);
});

test("HMAC sign/verify round-trips and rejects forgery", () => {
  const body = JSON.stringify({ a: 1 });
  const sig = signWakeBody(body, "secret");
  assert.equal(verifyWakeSignature(body, sig, ["other", "secret"]), true);
  assert.equal(verifyWakeSignature(body, sig, ["other"]), false);
  assert.equal(verifyWakeSignature(body + "x", sig, ["secret"]), false);
});

test("fireWake posts signed payload once, and is best-effort on failure", async () => {
  const seen = [];
  await fireWake(
    { id: "m2", channel_id: "dm-1", sender_id: "bob", content: "hello" },
    {
      url: "http://127.0.0.1:9/wake",
      secret: "s3cr3t",
      fetchImpl: async (url, opts) => {
        seen.push({ url, headers: opts.headers, body: opts.body });
        return { ok: true };
      },
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-agentschat-signature"], signWakeBody(seen[0].body, "s3cr3t"));
  // Failing receiver must not throw into the caller.
  await fireWake(
    { id: "m3", channel_id: "dm-1", sender_id: "bob", content: "hi" },
    {
      url: "http://127.0.0.1:9/wake",
      fetchImpl: async () => {
        throw new Error("down");
      },
    },
  );
});

test("wake queue deduplicates by message_id", () => {
  const file = join(mkdtempSync(join(tmpdir(), "muse-wake-")), "queue.jsonl");
  const p = { type: "message", channel_id: "welcome", message_id: "m9", sender_id: "alice", content: "hi" };
  assert.equal(appendWakeQueue(file, p), true);
  assert.equal(appendWakeQueue(file, p), false);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("muse wake prompt names channel, sender and message id", () => {
  const prompt = buildMuseWakePrompt({
    type: "message",
    channel_id: "welcome",
    message_id: "m1",
    sender_id: "alice",
    content: "hello @muse",
  });
  assert.ok(prompt.includes("welcome"));
  assert.ok(prompt.includes("alice"));
  assert.ok(prompt.includes("m1"));
});

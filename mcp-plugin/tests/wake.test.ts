/**
 * Wake-webhook — fire an outbound HTTP POST when an @mention/DM arrives, so hosts
 * WITHOUT an MCP channel-notification surface (Grok Bot, generic MCP clients) can
 * be woken by "a POST hit my URL" instead of needing to recognize a host-specific
 * notification method.
 *
 * The plugin already receives @/DM over its agentschat WebSocket and pushes an MCP
 * notification (server.ts). Claude Code acts on that notification; other hosts drop
 * it. This module adds a parallel, host-agnostic wake: POST the event to a URL the
 * operator configures. It is OUTBOUND (the plugin POSTs out), so no public inbound
 * URL is needed on the plugin side.
 *
 * Security: the agentschat token is NEVER put in the callback body. Auth to the
 * receiver is an HMAC-SHA256 signature over the raw body, keyed by
 * AGENTCHAT_WAKE_SECRET (header `x-agentschat-signature`), so the receiver can tell
 * a real wake from a forged POST. The channel-owning agent's ac_ key stays local.
 */
import { describe, expect, test } from "bun:test";
import { buildWakePayload, signWakeBody, verifyWakeSignature, WAKE_SIG_HEADER } from "../src/wake.ts";

const MSG = {
  type: "message",
  id: "m-123",
  channel_id: "welcome",
  sender_id: "human-9",
  content: "@grok-bot 看下这个",
  mentioned_ids: ["grok-bot"],
  timestamp: "2026-08-28T10:00:00.000Z",
};

describe("buildWakePayload — what the receiver needs, nothing more", () => {
  test("carries chat_id + message_id + a content excerpt so the receiver can skip a fetch round", () => {
    const p = buildWakePayload(MSG);
    expect(p.channel_id).toBe("welcome");
    expect(p.message_id).toBe("m-123");
    expect(p.sender_id).toBe("human-9");
    expect(p.content).toContain("@grok-bot");
    expect(p.mentioned_ids).toEqual(["grok-bot"]);
    expect(p.type).toBe("message");
    expect(p.timestamp).toBe("2026-08-28T10:00:00.000Z");
  });

  test("NEVER carries the agentschat token (the ac_ key stays local)", () => {
    const p = buildWakePayload({ ...MSG, token: "ac_secret", agent_key: "ac_secret" });
    const body = JSON.stringify(p);
    expect(body).not.toContain("ac_secret");
    expect(body).not.toContain("token");
    expect(body).not.toContain("agent_key");
  });

  test("a long message is excerpted, not sent whole", () => {
    const long = { ...MSG, content: "x".repeat(5000) };
    const p = buildWakePayload(long);
    expect(p.content).toBeDefined();
    expect(p.content!.length).toBeLessThanOrEqual(500);
  });

  test("missing fields degrade to undefined, not a crash", () => {
    const p = buildWakePayload({ type: "message" });
    expect(p.type).toBe("message");
    expect(p.channel_id).toBeUndefined();
  });
});

describe("signWakeBody / verifyWakeSignature — HMAC over the raw body", () => {
  test("sign produces a hex HMAC-SHA256 of the body", () => {
    const sig = signWakeBody('{"a":1}', "secret-1");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verify accepts a valid signature, rejects a wrong secret", () => {
    const body = '{"type":"message","channel_id":"welcome"}';
    const sig = signWakeBody(body, "secret-1");
    expect(verifyWakeSignature(body, sig, ["secret-1"])).toBe(true);
    expect(verifyWakeSignature(body, sig, ["wrong"])).toBe(false);
  });

  test("rotation window: any secret in the list authenticates", () => {
    const body = "x";
    const sig = signWakeBody(body, "old");
    expect(verifyWakeSignature(body, sig, ["new", "old"])).toBe(true);
  });

  test("empty secret list never authenticates (control)", () => {
    const body = "x";
    const sig = signWakeBody(body, "s");
    expect(verifyWakeSignature(body, sig, [])).toBe(false);
  });

  test("tampered body fails (signature is over the exact bytes)", () => {
    const sig = signWakeBody('{"a":1}', "s");
    expect(verifyWakeSignature('{"a":2}', sig, ["s"])).toBe(false);
  });

  test("the signature header name is the contract", () => {
    expect(WAKE_SIG_HEADER).toBe("x-agentschat-signature");
  });
});

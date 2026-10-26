/**
 * EXAMPLE receiver crypto helpers — verify good HMAC / reject bad without
 * starting the HTTP server (keeps wake.test.ts coverage of src/wake.ts intact).
 */
import { describe, expect, test } from "bun:test";
import {
  withoutCursorSessionEnv,
  signWakeBody,
  verifyWakeSignature,
  buildHostPrompt,
  buildHostChildEnv,
  requireIdentityPin,
  WAKE_SIG_HEADER,
} from "../scripts/example-url-wake-receiver.mjs";

describe("example-url-wake-receiver verify", () => {
  test("accepts a good HMAC-SHA256 hex signature over the raw body", () => {
    const body = JSON.stringify({
      type: "message",
      channel_id: "welcome",
      message_id: "m-1",
      content: "hi",
    });
    const secret = "test-wake-secret";
    const sig = signWakeBody(body, secret);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWakeSignature(body, sig, secret)).toBe(true);
  });

  test("rejects a bad or empty signature", () => {
    const body = '{"channel_id":"welcome"}';
    const secret = "test-wake-secret";
    const good = signWakeBody(body, secret);
    expect(verifyWakeSignature(body, "00".repeat(32), secret)).toBe(false);
    expect(verifyWakeSignature(body, good, "other-secret")).toBe(false);
    expect(verifyWakeSignature(body, "", secret)).toBe(false);
    expect(verifyWakeSignature(body, "not-hex", secret)).toBe(false);
  });

  test("exports the same signature header name the plugin uses", () => {
    expect(WAKE_SIG_HEADER).toBe("x-agentschat-signature");
  });

  test("buildHostPrompt steers reply-only + optional truncated history", () => {
    const p = buildHostPrompt({
      channel_id: "dm-1",
      message_id: "m-9",
      sender_id: "u",
      content: "hello",
      mentioned_ids: ["bot"],
    });
    expect(p).toContain("channel_id=dm-1");
    expect(p).toContain("message_id=m-9");
    expect(p).toContain("reply");
    expect(p).toMatch(/get_history/i);
    expect(p).toMatch(/500/);
  });
});

describe("example receiver strips leaked Cursor session env", () => {
  test("withoutCursorSessionEnv drops Cursor session keys and CURSOR_AGENT_STORE_*", () => {
    const base = {
      PATH: "/usr/bin",
      CURSOR_CONVERSATION_ID: "leaked",
      CURSOR_REQUEST_ID: "r",
      __CURSOR_SANDBOX_ENV_RESTORE: "x",
      CURSOR_AGENT: "1",
      CURSOR_AGENT_STORE_FOO: "y",
      AGENTCHAT_WAKE_KIND: "url",
    };
    const out = withoutCursorSessionEnv(base);
    expect(out).toEqual({ PATH: "/usr/bin", AGENTCHAT_WAKE_KIND: "url" });
    expect(base.CURSOR_CONVERSATION_ID).toBe("leaked"); // not mutated
  });
});

describe("example receiver identity pin (incident 2026-09-27)", () => {
  test("requireIdentityPin refuses to start without profile + agent id", () => {
    expect(() => requireIdentityPin({})).toThrow(/required/);
    expect(() => requireIdentityPin({ AGENTCHAT_URL_WAKE_PROFILE: "Bot-2" })).toThrow(/required/);
    expect(() => requireIdentityPin({ AGENTCHAT_URL_WAKE_AGENT_ID: "bot-2-id" })).toThrow(/required/);
    expect(() =>
      requireIdentityPin({ AGENTCHAT_URL_WAKE_PROFILE: "../x", AGENTCHAT_URL_WAKE_AGENT_ID: "id" }),
    ).toThrow(/plain profile name/);
    expect(
      requireIdentityPin({ AGENTCHAT_URL_WAKE_PROFILE: " Bot-2 ", AGENTCHAT_URL_WAKE_AGENT_ID: "bot-2-id" }),
    ).toEqual({ profile: "Bot-2", agentId: "bot-2-id" });
  });

  test("buildHostChildEnv pins AGENTSCHAT_PROFILE + expected id and strips overrides", () => {
    const base = {
      PATH: "/usr/bin",
      AGENTCHAT_PROFILE: "Other",
      AGENTCHAT_TOKEN: "ac_x",
      AGENTCHAT_AGENT_ID: "other-id",
      AGENTSCHAT_PROFILE: "Other",
      AGENTSCHAT_EXPECT_AGENT_ID: "other-id",
      CURSOR_CONVERSATION_ID: "leak",
      CURSOR_RIPGREP_PATH: "/x",
    };
    const out = buildHostChildEnv(base, { profile: "Bot-2", agentId: "bot-2-id" });
    expect(out).toEqual({
      PATH: "/usr/bin",
      AGENTSCHAT_PROFILE: "Bot-2",
      AGENTCHAT_EXPECT_AGENT_ID: "bot-2-id",
    });
    expect(base.AGENTCHAT_TOKEN).toBe("ac_x"); // not mutated
  });

  test("prompt opens with the whoami / switch_profile identity check when pinned", () => {
    const p = buildHostPrompt({ channel_id: "c", content: "hi" }, { profile: "Bot-2", agentId: "bot-2-id" });
    const lines = p.split("\n");
    expect(lines[0]).toBe("[AgentsChat inbound]");
    expect(lines[1]).toMatch(/Bot-2 AgentsChat bot \(agent id bot-2-id\)/);
    expect(lines[2]).toMatch(/IDENTITY CHECK/);
    expect(lines[2]).toMatch(/whoami/);
    expect(lines[2]).toMatch(/switch_profile` with profile_name="Bot-2"/);
    expect(lines[2]).toMatch(/Never post under another identity/);
    expect(p.indexOf("IDENTITY CHECK")).toBeLessThan(p.indexOf("channel_id=c"));
  });
});

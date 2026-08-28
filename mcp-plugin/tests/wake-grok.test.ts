/**
 * Grok wake mode (A1): when the host is a Grok gateway on the same machine, the
 * wake is a loopback POST to its `/api/sendPrompt` with the gateway's own Bearer
 * token (read from a local gateway.json), and the body is the gateway's shape
 * `{agentId, prompt}` — NOT the generic relay wake frame.
 *
 * Security invariants:
 *  - The gateway token is read from a local file at send time, NEVER hardcoded,
 *    never in argv, never logged.
 *  - The prompt text is built from the message, with ac_ keys / JWTs redacted
 *    (same redactSecrets as every other outbound path).
 */
import { describe, expect, test } from "bun:test";
import { buildGrokPrompt, grokBearerFromGatewayConfig } from "../src/wake.ts";

const MSG = {
  type: "message",
  id: "m-1",
  channel_id: "welcome",
  sender_id: "human-9",
  content: "@grok-bot 看一下这个 ac_abcdefghijklmnopqrstuvwxyz 别外传",
  mentioned_ids: ["grok-bot"],
  timestamp: "2026-08-28T10:00:00.000Z",
};

describe("buildGrokPrompt — the sendPrompt body", () => {
  test("targets the given agentId and carries a readable prompt", () => {
    const p = buildGrokPrompt(MSG, "agent-uuid-1");
    expect(p.agentId).toBe("agent-uuid-1");
    expect(typeof p.prompt).toBe("string");
    expect(p.prompt.length).toBeGreaterThan(0);
  });

  test("prompt includes the channel + sender + content so the agent can act without a fetch", () => {
    const p = buildGrokPrompt(MSG, "a1");
    expect(p.prompt).toContain("welcome");
    expect(p.prompt).toContain("human-9");
    expect(p.prompt).toContain("看一下这个");
  });

  test("prompt redacts ac_ keys and JWTs (does not relay a pasted credential)", () => {
    const p = buildGrokPrompt(MSG, "a1");
    expect(p.prompt).toContain("ac_***REDACTED***");
    expect(p.prompt).not.toContain("ac_abcdefghijklmnopqrstuvwxyz");
  });

  test("does NOT include the gateway token or any ac_ token field", () => {
    const p = buildGrokPrompt({ ...MSG, token: "ac_x", gateway_token: "sekret" }, "a1");
    const s = JSON.stringify(p);
    expect(s).not.toContain("ac_x");
    expect(s).not.toContain("sekret");
  });
});

describe("grokBearerFromGatewayConfig — read the token from a local gateway.json", () => {
  test("extracts the bearer from a parsed gateway config", () => {
    const tok = grokBearerFromGatewayConfig({ token: "gw-token-1", port: 1340 });
    expect(tok).toBe("gw-token-1");
  });

  test("accepts a nested auth.bearer shape too", () => {
    const tok = grokBearerFromGatewayConfig({ auth: { bearer: "gw-token-2" }, port: 1340 });
    expect(tok).toBe("gw-token-2");
  });

  test("returns null when no token field is present (fail closed, never guess)", () => {
    expect(grokBearerFromGatewayConfig({ port: 1340 })).toBeNull();
    expect(grokBearerFromGatewayConfig({})).toBeNull();
  });
});

import { resolveGrokAgentId } from "../src/wake.ts";

describe("resolveGrokAgentId — 1:1 binding, explicit env wins", () => {
  test("explicit AGENTCHAT_GROK_AGENT_ID wins over listAgents", async () => {
    const id = await resolveGrokAgentId({
      explicitId: "uuid-explicit",
      agentschatName: "Grok",
      listAgents: async () => [{ id: "uuid-other", name: "Grok" }],
    });
    expect(id).toBe("uuid-explicit");
  });

  test("no explicit id → listAgents name match (fallback)", async () => {
    const id = await resolveGrokAgentId({
      explicitId: "",
      agentschatName: "Grok",
      listAgents: async () => [{ id: "uuid-matched", name: "Grok" }],
    });
    expect(id).toBe("uuid-matched");
  });

  test("no match anywhere → null (fail closed, no wake)", async () => {
    const id = await resolveGrokAgentId({
      explicitId: "",
      agentschatName: "Grok",
      listAgents: async () => [{ id: "uuid-x", name: "SomeoneElse" }],
    });
    expect(id).toBeNull();
  });

  test("listAgents throwing does not crash — falls to null", async () => {
    const id = await resolveGrokAgentId({
      explicitId: "",
      agentschatName: "Grok",
      listAgents: async () => { throw new Error("gateway down"); },
    });
    expect(id).toBeNull();
  });
});

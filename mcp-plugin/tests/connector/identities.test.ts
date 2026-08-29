/**
 * Multiplex: one connector fronts N agentschat identities (one per Hermes profile /
 * agent). The connector holds an identity TABLE (botId → agentschat credentials) and
 * routes inbound/outbound by identity. The single highest-correctness invariant:
 * identity A's messages must NEVER be routed to or sent as identity B (cross-identity
 * leak = data breach).
 *
 * Hermes fronts multiple identities on one relay WS by sending one `hello` per
 * (platform, botId) pair; here platform is always "agentschat" and botId is the
 * agentschat agent_id. A single-identity deployment is the N=1 case of the same table.
 */
import { describe, expect, test } from "bun:test";
import { IdentityTable, routeInbound, resolveOutbound } from "../../connector/identities.ts";

const IDENTITIES = [
  { botId: "agent-a", agentId: "agent-a", token: "ac_aaa", gatewayId: "gw-1", secret: "s1" },
  { botId: "agent-b", agentId: "agent-b", token: "ac_bbb", gatewayId: "gw-1", secret: "s1" },
];

describe("IdentityTable — botId → agentschat credentials", () => {
  test("resolves each identity by its botId", () => {
    const t = new IdentityTable(IDENTITIES);
    expect(t.forBot("agent-a")?.token).toBe("ac_aaa");
    expect(t.forBot("agent-b")?.token).toBe("ac_bbb");
  });

  test("unknown botId resolves to null (fail closed, never guess)", () => {
    const t = new IdentityTable(IDENTITIES);
    expect(t.forBot("agent-unknown")).toBeNull();
  });

  test("rejects two identities sharing a botId (ambiguous routing)", () => {
    expect(() => new IdentityTable([
      { botId: "dup", agentId: "a", token: "ac_1", gatewayId: "g", secret: "s" },
      { botId: "dup", agentId: "b", token: "ac_2", gatewayId: "g", secret: "s" },
    ])).toThrow();
  });

  test("single identity (N=1) is just the degenerate table", () => {
    const t = new IdentityTable([IDENTITIES[0]]);
    expect(t.forBot("agent-a")?.agentId).toBe("agent-a");
    expect(t.isSingle()).toBe(true);
  });
});

describe("routeInbound — a message reaches ONLY the identity it's addressed to", () => {
  const t = new IdentityTable(IDENTITIES);

  test("a DM to identity A's channel routes to A, not B", () => {
    // DM channel belongs to a specific agent; the connector knows which identity owns it.
    const target = routeInbound(t, { channel_id: "dm-a-owner", dmOwnerBotId: "agent-a" });
    expect(target?.botId).toBe("agent-a");
  });

  test("an @mention of identity B routes to B, not A", () => {
    const target = routeInbound(t, { channel_id: "welcome", mentioned_ids: ["agent-b"] });
    expect(target?.botId).toBe("agent-b");
  });

  test("a message mentioning NEITHER routes to no one (fail closed)", () => {
    const target = routeInbound(t, { channel_id: "welcome", mentioned_ids: [] });
    expect(target).toBeNull();
  });

  test("a message for identity A never lands on identity B (the cross-leak control)", () => {
    const forA = routeInbound(t, { channel_id: "welcome", mentioned_ids: ["agent-a"] });
    expect(forA?.botId).toBe("agent-a");
    expect(forA?.botId).not.toBe("agent-b");
  });
});

describe("resolveOutbound — a send uses the SENDING identity's credentials", () => {
  const t = new IdentityTable(IDENTITIES);

  test("send as agent-a uses agent-a's token", () => {
    const cred = resolveOutbound(t, "agent-a");
    expect(cred?.token).toBe("ac_aaa");
    expect(cred?.agentId).toBe("agent-a");
  });

  test("send as an unregistered botId is refused (fail closed)", () => {
    expect(resolveOutbound(t, "agent-unknown")).toBeNull();
  });

  test("send as B never uses A's token (cross-identity control)", () => {
    const cred = resolveOutbound(t, "agent-b");
    expect(cred?.token).toBe("ac_bbb");
    expect(cred?.token).not.toBe("ac_aaa");
  });
});

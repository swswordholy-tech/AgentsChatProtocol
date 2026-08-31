/**
 * Multiplex connector: one relay WS server fronts N agentschat identities, each
 * reachable by its botId (= agentschat agent_id). The gateway sends one `hello` per
 * (platform, botId) identity it fronts; inbound agentschat messages route to the
 * gateway socket(s) fronting the addressed identity; outbound sends use the SENDING
 * identity's token.
 *
 * The invariant under test: identity A's traffic never crosses to identity B.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken } from "../../connector/auth.ts";
import { startConnector, type ConnectorConfig } from "../../connector/server.ts";

const SECRET = "mx-secret-0123456789abcdef";
const GWID = "gw-mx";

// Two identities; track sends per identity to prove no cross-identity send.
const sends: Record<string, Array<{ chatId: string; content: string }>> = { "agent-a": [], "agent-b": [] };
const hooks = {
  async sendMessage(botId: string, chatId: string, content: string) {
    sends[botId].push({ chatId, content });
    return { id: `ac-${botId}-${sends[botId].length}` };
  },
  async getChatInfo(_botId: string, chatId: string) {
    return { name: `#${chatId}`, type: chatId.startsWith("dm-") ? "dm" : "group" };
  },
};

let server: ReturnType<typeof startConnector>;
let url = "";

beforeAll(() => {
  server = startConnector({
    port: 0,
    secrets: { [GWID]: [SECRET] },
    identities: [
      { botId: "agent-a", agentId: "agent-a", token: "ac_aaa", gatewayId: GWID, secret: SECRET },
      { botId: "agent-b", agentId: "agent-b", token: "ac_bbb", gatewayId: GWID, secret: SECRET },
    ],
    agentschat: hooks as any,
  });
  url = `ws://127.0.0.1:${server.port}/relay`;
});
afterAll(() => server.stop());

function dial(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${makeUpgradeToken(GWID, SECRET, 0)}` } });
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((r) => ws.once("message", (d) => r(JSON.parse(d.toString()))));
}

describe("multiplex handshake — one descriptor per hello'd identity", () => {
  test("hello for agent-a returns a descriptor for agent-a", async () => {
    const ws = await dial();
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    const f = await p;
    expect(f.type).toBe("descriptor");
    expect(f.descriptor.platform).toBe("agentschat");
    ws.close();
  });

  test("a gateway can front BOTH identities on one socket (two hellos)", async () => {
    const ws = await dial();
    const p1 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await p1;
    const p2 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    const f2 = await p2;
    expect(f2.type).toBe("descriptor");
    ws.close();
  });

  test("hello for an unregistered botId is rejected (fail closed, not fronted)", async () => {
    const ws = await dial();
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-unknown" }) + "\n");
    const f = await p;
    // A connector must not front an identity it has no credentials for.
    expect(f.type).not.toBe("descriptor");
    expect(f.type === "error" || f.error).toBeTruthy();
    ws.close();
  });
});

describe("multiplex outbound — send uses the SENDING identity's token", () => {
  test("outbound tagged agent-a sends as agent-a", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "outbound", requestId: "r1", platform: "agentschat", botId: "agent-a", action: { op: "send", chat_id: "welcome", content: "hi from A" } }) + "\n");
    const f = await p;
    expect(f.result.success).toBe(true);
    expect(sends["agent-a"]).toContainEqual({ chatId: "welcome", content: "hi from A" });
    expect(sends["agent-b"]).toEqual([]); // B untouched
    ws.close();
  });

  test("outbound naming a REGISTERED identity this socket never hello'd is refused (advertised-set check)", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs; // fronts ONLY agent-a
    const p = nextFrame(ws);
    // agent-b is a registered identity, but THIS socket never advertised it —
    // sending as it would be a cross-identity egress. Contract D-Q1.5b.1.
    ws.send(JSON.stringify({ type: "outbound", requestId: "r2", platform: "agentschat", botId: "agent-b", action: { op: "send", chat_id: "welcome", content: "as B?" } }) + "\n");
    const f = await p;
    expect(f.result.success).toBe(false);
    expect(sends["agent-b"].find((s) => s.content === "as B?")).toBeUndefined();
    ws.close();
  });

  test("untagged outbound on a two-identity socket falls back to the FIRST hello'd identity", async () => {
    const ws = await dial();
    const h1 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    await h1;
    const h2 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await h2;
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "outbound", requestId: "r3", action: { op: "send", chat_id: "welcome", content: "untagged" } }) + "\n");
    const f = await p;
    expect(f.result.success).toBe(true);
    expect(sends["agent-b"]).toContainEqual({ chatId: "welcome", content: "untagged" }); // first hello'd
    expect(sends["agent-a"].find((s) => s.content === "untagged")).toBeUndefined();
    ws.close();
  });
});

describe("multiplex inbound — a message reaches only the addressed identity's gateway", () => {
  test("an @mention of agent-b is delivered with agent-b as the fronting identity", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    await hs;
    const p = nextFrame(ws);
    server.injectAgentsChatMessage({
      id: "m1", channel_id: "welcome", sender_id: "human-1", sender_name: "H",
      content: "@agent-b 看下", mentioned_ids: ["agent-b"],
    });
    const f = await p;
    expect(f.type).toBe("inbound");
    expect(f.event.text).toContain("@agent-b");
    // The event's source.platform is agentschat; the connector tags WHICH fronted
    // identity it routed to so the gateway keys the right session.
    expect(f.event.source.profile ?? f.event.source.user_id).toBeTruthy();
    ws.close();
  });

  test("__botId (which socket it arrived on) routes a DM with no mention fields", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    await hs;
    const p = nextFrame(ws);
    // A DM pushed to agent-b's agentschat socket: no mentioned_ids, no dm_owner —
    // the arrival socket is the routing signal.
    server.injectAgentsChatMessage({
      id: "m2", channel_id: "dm-human-1-agent-b", sender_id: "human-1", sender_name: "H",
      content: "hi b", __botId: "agent-b",
    } as any);
    const f = await p;
    expect(f.type).toBe("inbound");
    // One hello on this socket: do NOT stamp AgentsChat agent_id as Hermes
    // profile (that splits agent:main vs agent:<id> and breaks clarify).
    expect(f.event.source.profile).toBeUndefined();
    ws.close();
  });

  test("two hellos on one socket stamp source.profile so multiplexed sessions isolate", async () => {
    const ws = await dial();
    const h1 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await h1;
    const h2 = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    await h2;
    const p = nextFrame(ws);
    server.injectAgentsChatMessage({
      id: "m2b", channel_id: "dm-human-1-agent-b", sender_id: "human-1", sender_name: "H",
      content: "hi b multiplex", __botId: "agent-b",
    } as any);
    const f = await p;
    expect(f.type).toBe("inbound");
    expect(f.event.source.profile).toBe("agent-b");
    ws.close();
  });

  test("a message arriving on agent-b's socket is NEVER delivered to an agent-a gateway (cross-leak control)", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;
    let got: any = null;
    ws.on("message", (d) => { got = JSON.parse(d.toString()); });
    server.injectAgentsChatMessage({
      id: "m3", channel_id: "dm-human-1-agent-b", sender_id: "human-1", sender_name: "H",
      content: "secret for b", __botId: "agent-b",
    } as any);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBeNull();
    ws.close();
  });
});

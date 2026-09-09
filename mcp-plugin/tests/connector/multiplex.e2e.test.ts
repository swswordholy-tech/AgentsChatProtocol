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

  test("outbound naming a REGISTERED identity this socket never hello'd still sends with THAT identity's token (hello-fallback)", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs; // fronts ONLY agent-a — Hermes may hello one botId while RELAY_IDENTITIES has N
    const p = nextFrame(ws);
    // agent-b is registered; usable agentschat conn exists → send with B's own token
    // (never A's). Prefer precise when present; here only fallback applies.
    ws.send(JSON.stringify({ type: "outbound", requestId: "r2", platform: "agentschat", botId: "agent-b", action: { op: "send", chat_id: "welcome", content: "as B?" } }) + "\n");
    const f = await p;
    expect(f.result.success).toBe(true);
    expect(sends["agent-b"]).toContainEqual({ chatId: "welcome", content: "as B?" });
    expect(sends["agent-a"].find((s) => s.content === "as B?")).toBeUndefined();
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
    } as any);
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

  test("DM for agent-b via agent-a-only hello uses fallback with source.profile=agent-b (no credential cross)", async () => {
    // Hermes hellos only A; RELAY_IDENTITIES still has B. Inbound for B must reach
    // the agentschat-fronted socket with profile=B so multiplex keys B's session.
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;
    const p = nextFrame(ws);
    server.injectAgentsChatMessage({
      id: "m3", channel_id: "dm-human-1-agent-b", sender_id: "human-1", sender_name: "H",
      content: "secret for b", __botId: "agent-b",
    } as any);
    const f = await p;
    expect(f.type).toBe("inbound");
    expect(f.event.text).toContain("secret for b");
    expect(f.event.source.profile).toBe("agent-b");
    ws.close();
  });
});

describe("sticky egress hint — reply as last inbound identity when Hermes stamps hello'd botId", () => {
  test("after fallback inbound to agent-b, outbound with frame.botId=agent-a sends as agent-b for that chat_id", async () => {
    // Hermes hellos only A; inbound for B arrives via fallback. Hermes then
    // stamps outbound frame.botId=A (the single hello'd bot). Connector must
    // use the sticky chat hint and send with B's token for that chat.
    for (const k of Object.keys(sends)) sends[k] = [];
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;

    const inboundP = nextFrame(ws);
    await server.injectAgentsChatMessage({
      id: "hint1", channel_id: "welcome-hint", sender_id: "human-1", sender_name: "H",
      content: "@agent-b please reply", mentioned_ids: ["agent-b"],
    } as any);
    const inbound = await inboundP;
    expect(inbound.type).toBe("inbound");
    expect(inbound.event.source.profile).toBe("agent-b");

    // typing should also use the hinted mouth (hint not cleared yet)
    const typingP = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound", requestId: "tHint", platform: "agentschat", botId: "agent-a",
      action: { op: "typing", chat_id: "welcome-hint" },
    }) + "\n");
    const typing = await typingP;
    expect(typing.result.success).toBe(true);

    const sendP = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound", requestId: "rHint", platform: "agentschat", botId: "agent-a",
      action: { op: "send", chat_id: "welcome-hint", content: "reply as B" },
    }) + "\n");
    const sent = await sendP;
    expect(sent.result.success).toBe(true);
    expect(sends["agent-b"]).toContainEqual({ chatId: "welcome-hint", content: "reply as B" });
    expect(sends["agent-a"].find((s) => s.content === "reply as B")).toBeUndefined();

    // hint cleared after successful send — next outbound for same chat uses frame.botId again
    const send2P = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound", requestId: "rHint2", platform: "agentschat", botId: "agent-a",
      action: { op: "send", chat_id: "welcome-hint", content: "now as A" },
    }) + "\n");
    const sent2 = await send2P;
    expect(sent2.result.success).toBe(true);
    expect(sends["agent-a"]).toContainEqual({ chatId: "welcome-hint", content: "now as A" });
    expect(sends["agent-b"].find((s) => s.content === "now as A")).toBeUndefined();
    ws.close();
  });
});

describe("hello fallback — precise preferred, no double delivery", () => {
  test("@mention of agent-b with only agent-a hello'd delivers once via fallback", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;
    const frames: any[] = [];
    ws.on("message", (d) => { frames.push(JSON.parse(d.toString())); });
    await server.injectAgentsChatMessage({
      id: "fb1", channel_id: "welcome", sender_id: "human-1", sender_name: "H",
      content: "@agent-b 看下", mentioned_ids: ["agent-b"],
    } as any);
    await new Promise((r) => setTimeout(r, 80));
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe("inbound");
    expect(frames[0].event.source.profile).toBe("agent-b");
    ws.close();
  });

  test("precise hello preferred: when B is fronted, do NOT also deliver via A-only sibling", async () => {
    const wsA = await dial();
    const hsA = nextFrame(wsA);
    wsA.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hsA;
    const wsB = await dial();
    const hsB = nextFrame(wsB);
    wsB.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-b" }) + "\n");
    await hsB;

    let gotA: any = null;
    let gotB: any = null;
    wsA.on("message", (d) => { gotA = JSON.parse(d.toString()); });
    const pB = nextFrame(wsB);

    await server.injectAgentsChatMessage({
      id: "fb2", channel_id: "welcome", sender_id: "human-1", sender_name: "H",
      content: "@agent-b precise", mentioned_ids: ["agent-b"],
    } as any);
    const fB = await pB;
    await new Promise((r) => setTimeout(r, 80));
    expect(fB.type).toBe("inbound");
    expect(fB.event.text).toContain("precise");
    // Single-hello on B: profile unset (clarify-safe); A must not get a fallback copy.
    expect(fB.event.source.profile).toBeUndefined();
    expect(gotA).toBeNull();
    wsA.close();
    wsB.close();
  });

  test("unknown outbound botId is still refused (fail closed on credentials)", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "outbound", requestId: "rX", platform: "agentschat", botId: "agent-unknown", action: { op: "send", chat_id: "welcome", content: "nope" } }) + "\n");
    const f = await p;
    expect(f.result.success).toBe(false);
    ws.close();
  });
});


describe("reloadIdentities — hot-swap table without restart", () => {
  test("after reload, new botId is routable via fallback; removed botId fails closed", async () => {
    const ws = await dial();
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "agent-a" }) + "\n");
    await hs;

    server.reloadIdentities([
      { botId: "agent-a", agentId: "agent-a", token: "ac_aaa", gatewayId: GWID, secret: SECRET },
      { botId: "agent-c", agentId: "agent-c", token: "ac_ccc", gatewayId: GWID, secret: SECRET },
    ]);

    const p = nextFrame(ws);
    await server.injectAgentsChatMessage({
      id: "rl1", channel_id: "welcome", sender_id: "human-1", sender_name: "H",
      content: "@agent-c hi", mentioned_ids: ["agent-c"],
    } as any);
    const f = await p;
    expect(f.type).toBe("inbound");
    expect(f.event.source.profile).toBe("agent-c");

    // agent-b was removed — @mention must not inject
    let got: any = null;
    ws.on("message", (d) => { got = JSON.parse(d.toString()); });
    await server.injectAgentsChatMessage({
      id: "rl2", channel_id: "welcome", sender_id: "human-1", sender_name: "H",
      content: "@agent-b gone", mentioned_ids: ["agent-b"],
    } as any);
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toBeNull();

    // restore for sibling tests that share the server
    server.reloadIdentities([
      { botId: "agent-a", agentId: "agent-a", token: "ac_aaa", gatewayId: GWID, secret: SECRET },
      { botId: "agent-b", agentId: "agent-b", token: "ac_bbb", gatewayId: GWID, secret: SECRET },
    ]);
    ws.close();
  });
});

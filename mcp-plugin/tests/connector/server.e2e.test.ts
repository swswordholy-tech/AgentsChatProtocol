/**
 * End-to-end test of the connector's /relay WS surface, driven by a fake gateway.
 * This is the cross-repo seam: the gateway side (hermes) is implemented in another
 * language against the same contract, so we exercise the EXACT frame sequence the
 * gateway's ws_transport.py performs:
 *
 *   upgrade (Authorization: Bearer <upgrade token>)
 *   gateway → hello          {type:"hello", platform, botId}
 *   connector → descriptor   {type:"descriptor", descriptor:{...}}
 *   connector → inbound      {type:"inbound", event:{...}}      (agentschat → gateway)
 *   gateway → outbound       {type:"outbound", requestId, action:{op:...}}
 *   connector → outbound_result {type:"outbound_result", requestId, result}
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken, CLOSE_UNAUTHORIZED } from "../../connector/auth.ts";
import { startConnector, type ConnectorConfig } from "../../connector/server.ts";

const SECRET = "e2e-secret-abcdef0123456789";
const GATEWAY_ID = "gw-e2e";

let server: ReturnType<typeof startConnector>;
let url = "";
const sentToAgentsChat: Array<{ botId: string; chatId: string; content: string }> = [];
const contextCalls: Array<{ botId: string; chatId: string; sinceTs?: string; excludeId?: string }> = [];

// Minimal agentschat-facing hooks the connector calls: no real network. Per-identity
// shape (botId first) with one configured identity — the single-tenant N=1 case.
const agentschatHooks = {
  async sendMessage(botId: string, chatId: string, content: string) {
    sentToAgentsChat.push({ botId, chatId, content });
    return { id: `ac-${sentToAgentsChat.length}` };
  },
  async getChatInfo(_botId: string, chatId: string) {
    return { name: `#${chatId}`, type: chatId.startsWith("dm-") ? "dm" : "group" };
  },
  async getChannelContext(botId: string, chatId: string, sinceTs?: string, excludeId?: string) {
    contextCalls.push({ botId, chatId, sinceTs, excludeId });
    return [{ text: "earlier chatter", user_name: "Alice", user_id: "human-1" }];
  },
};

function cfg(): ConnectorConfig {
  return {
    port: 0,
    secrets: { [GATEWAY_ID]: [SECRET] },
    descriptor: undefined,
    identities: [{ botId: "ac-bot", agentId: "ac-bot", token: "ac_e2e", gatewayId: GATEWAY_ID, secret: SECRET }],
    agentschat: agentschatHooks,
  };
}

beforeAll(() => {
  server = startConnector(cfg());
  url = `ws://127.0.0.1:${server.port}/relay`;
});
afterAll(() => server.stop());

/** Open a gateway-side WS with a valid upgrade token, await open. */
function dial(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    // Do NOT reject on close here — for an UNAUTHORIZED upgrade the connector admits
    // then immediately closes 4401 (see dialExpectClose); the open still fires.
  });
}

/** Dial and resolve with the close code (for unauthorized-upgrade assertions). */
function dialExpectClose(token?: string): Promise<number> {
  return new Promise((resolve) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const ws = new WebSocket(url, { headers });
    ws.on("close", (code) => resolve(code));
    ws.on("error", () => resolve(-1)); // e.g. handshake failed at HTTP layer
  });
}

function nextFrame(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
}

describe("relay upgrade auth", () => {
  test("a valid upgrade token is accepted", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("a wrong secret is rejected with close code 4401", async () => {
    const code = await dialExpectClose(makeUpgradeToken(GATEWAY_ID, "wrong-secret", 0));
    expect(code).toBe(CLOSE_UNAUTHORIZED);
  });

  test("an unknown gateway id is rejected with 4401", async () => {
    const code = await dialExpectClose(makeUpgradeToken("gw-nobody", SECRET, 0));
    expect(code).toBe(CLOSE_UNAUTHORIZED);
  });

  test("a missing Authorization header is rejected with 4401", async () => {
    const code = await dialExpectClose(undefined);
    expect(code).toBe(CLOSE_UNAUTHORIZED);
  });
});

describe("handshake", () => {
  test("hello → connector replies with a descriptor frame", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const p = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    const frame = await p;
    expect(frame.type).toBe("descriptor");
    expect(frame.descriptor.platform).toBe("agentschat");
    expect(frame.descriptor.contract_version).toBe(1);
    expect(frame.descriptor.supported_ops).toContain("send");
    ws.close();
  });
});

describe("inbound: agentschat message → gateway", () => {
  test("a GROUP message that does NOT @mention the identity is NOT injected (token-waste fix)", async () => {
    // Boss's report: the single-tenant fallback forwarded every joined-channel
    // message into the Hermes session. The MCP path's gate is isDM || isMentioned;
    // the connector now reproduces it. An unaddressed group message must be dropped.
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    let got: any = null;
    ws.on("message", (d) => { got = JSON.parse(d.toString()); });
    await server.injectAgentsChatMessage({
      id: "m0",
      channel_id: "welcome",
      sender_id: "human-1",
      sender_name: "Alice",
      content: "hi bot", // no @ac-bot — not addressed to the agent
      timestamp: "2026-08-31T10:00:00Z",
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toBeNull();
    ws.close();
  });

  test("an @-mention IS injected, with channel context attached", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    await server.injectAgentsChatMessage({
      id: "m1",
      channel_id: "welcome",
      sender_id: "human-1",
      sender_name: "Alice",
      content: "@ac-bot hi",
      timestamp: "2026-08-31T10:05:00Z",
    });
    const frame = await p;
    expect(frame.type).toBe("inbound");
    expect(frame.event.text).toBe("@ac-bot hi");
    expect(frame.event.source.platform).toBe("agentschat");
    expect(frame.event.source.chat_type).toBe("group");
    expect(frame.event.source.user_id).toBe("human-1");
    // "What happened since you were last addressed" rides along (upstream renders
    // it into channel_context — the gateway needs no change).
    expect(frame.event.context).toEqual([{ text: "earlier chatter", source: { user_name: "Alice", user_id: "human-1" } }]);
    expect(contextCalls.at(-1)).toMatchObject({ botId: "ac-bot", chatId: "welcome", excludeId: "m1" });
    expect(contextCalls.at(-1)?.sinceTs).toBeUndefined(); // first mention: no window
    ws.close();
  });

  test("a second @-mention passes the FIRST mention's timestamp as the context window start", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    await server.injectAgentsChatMessage({
      id: "m2",
      channel_id: "welcome",
      sender_id: "human-1",
      content: "@ac-bot again",
      timestamp: "2026-08-31T10:09:00Z",
    });
    await p;
    // sinceTs = the previous addressed message's ts → the hook returns only what
    // happened BETWEEN the two mentions.
    expect(contextCalls.at(-1)?.sinceTs).toBe("2026-08-31T10:05:00Z");
    ws.close();
  });

  test("a DM is injected without any @mention", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    await server.injectAgentsChatMessage({
      id: "m3",
      channel_id: "dm-human-1-ac-bot",
      sender_id: "human-1",
      sender_name: "Alice",
      content: "private ping",
    });
    const frame = await p;
    expect(frame.type).toBe("inbound");
    expect(frame.event.source.chat_type).toBe("dm");
    ws.close();
  });
});

describe("outbound: gateway action → agentschat", () => {
  test("a send op is forwarded to agentschat and answered with outbound_result", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound",
      requestId: "r1",
      action: { op: "send", chat_id: "welcome", content: "hello from gateway" },
    }));
    const frame = await p;
    expect(frame.type).toBe("outbound_result");
    expect(frame.requestId).toBe("r1");
    expect(frame.result.success).toBe(true);
    expect(frame.result.message_id).toBeTruthy();
    // And it actually reached agentschat.
    expect(sentToAgentsChat).toContainEqual({ botId: "ac-bot", chatId: "welcome", content: "hello from gateway" });
    ws.close();
  });

  test("an op the connector does not advertise is rejected, not silently dropped", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound",
      requestId: "r2",
      action: { op: "edit", chat_id: "welcome", message_id: "m1", content: "x" },
    }));
    const frame = await p;
    expect(frame.type).toBe("outbound_result");
    expect(frame.result.success).toBe(false);
    expect(String(frame.result.error)).toMatch(/unsupported|not supported|unknown op/i);
    ws.close();
  });

  test("get_chat_info is proxied to agentschat", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    ws.send(JSON.stringify({
      type: "outbound",
      requestId: "r3",
      action: { op: "get_chat_info", chat_id: "welcome" },
    }));
    const frame = await p;
    expect(frame.type).toBe("outbound_result");
    expect(frame.result.name).toBe("#welcome");
    ws.close();
  });
});

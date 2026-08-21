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
const sentToAgentsChat: Array<{ chatId: string; content: string }> = [];

// Minimal agentschat-facing hooks the connector calls: no real network.
const agentschatHooks = {
  async sendMessage(chatId: string, content: string) {
    sentToAgentsChat.push({ chatId, content });
    return { id: `ac-${sentToAgentsChat.length}` };
  },
  async getChatInfo(chatId: string) {
    return { name: `#${chatId}`, type: chatId.startsWith("dm-") ? "dm" : "group" };
  },
};

function cfg(): ConnectorConfig {
  return {
    port: 0,
    secrets: { [GATEWAY_ID]: [SECRET] },
    descriptor: undefined,
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
  test("an injected agentschat message is pushed down as an inbound frame", async () => {
    const ws = await dial(makeUpgradeToken(GATEWAY_ID, SECRET, 0));
    // Complete handshake first.
    const hs = nextFrame(ws);
    ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "ac-bot" }));
    await hs;

    const p = nextFrame(ws);
    server.injectAgentsChatMessage({
      id: "m1",
      channel_id: "welcome",
      sender_id: "human-1",
      sender_name: "Alice",
      content: "hi bot",
    });
    const frame = await p;
    expect(frame.type).toBe("inbound");
    expect(frame.event.text).toBe("hi bot");
    expect(frame.event.source.platform).toBe("agentschat");
    expect(frame.event.source.chat_type).toBe("group");
    expect(frame.event.source.user_id).toBe("human-1");
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
    expect(sentToAgentsChat).toContainEqual({ chatId: "welcome", content: "hello from gateway" });
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

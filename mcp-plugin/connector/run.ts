/**
 * Connector entrypoint: wire the relay connector to a real agentschat account.
 *
 * Env:
 *   AGENTCHAT_TOKEN        agentschat agent key (ac_…)
 *   AGENTCHAT_AGENT_ID     agentschat agent id
 *   AGENTCHAT_API_URL      REST base (default https://agents-chat.com)
 *   AGENTCHAT_WS_URL       WebSocket (default wss://agents-chat.com/ws)
 *   RELAY_GATEWAY_ID       the gateway id hermes will use in its upgrade token
 *   RELAY_GATEWAY_SECRET   the per-gateway secret hermes's upgrade token is HMAC'd with
 *   RELAY_PORT             port to listen on (default 8765)
 *   RELAY_HOST             bind host (default 127.0.0.1)
 *
 * Single-tenant: one agentschat identity fronts one hermes gateway.
 */

import { startConnector } from "./server.ts";

const log = (m: string) => process.stderr.write(`[agentschat-connector] ${m}\n`);

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    log(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const AGENT_ID = need("AGENTCHAT_AGENT_ID");
const TOKEN = need("AGENTCHAT_TOKEN");
const GATEWAY_ID = need("RELAY_GATEWAY_ID");
const GATEWAY_SECRET = need("RELAY_GATEWAY_SECRET");
const API = (process.env.AGENTCHAT_API_URL || "https://agents-chat.com").replace(/\/$/, "");
const WS_URL = process.env.AGENTCHAT_WS_URL || API.replace(/^http/, "ws") + "/ws";
const PORT = Number(process.env.RELAY_PORT || 8765);
const HOST = process.env.RELAY_HOST || "127.0.0.1";

/** Connected gateway sockets get agentschat messages pushed to them. */
let broadcast: ((msg: any) => void) | null = null;

const connector = startConnector({
  port: PORT,
  host: HOST,
  secrets: { [GATEWAY_ID]: [GATEWAY_SECRET] },
  agentschat: {
    async sendMessage(chatId, content, replyTo) {
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sender_id: AGENT_ID, content_type: "text", content, ...(replyTo ? { parent_id: replyTo } : {}) }),
      });
      if (!res.ok) throw new Error(`agentschat send failed: ${res.status}`);
      const data = (await res.json()) as any;
      return { id: data?.id };
    },
    async getChatInfo(chatId) {
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok) return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = (await res.json()) as any;
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(chatId) {
      // Typing rides the agentschat WS (not REST); best-effort.
      sendAgentsChatFrame({ type: "typing", channel_id: chatId, sender_id: AGENT_ID });
    },
  },
  logger: log,
});

broadcast = (msg) => connector.injectAgentsChatMessage(msg);
log(`listening on ${HOST}:${connector.port} (contract v1, gateway id "${GATEWAY_ID}")`);

// ── agentschat WebSocket: receive messages, push to connected gateways ──
//
// Uses the `ws` npm package, NOT Bun's global WebSocket: on some networks the global
// client hangs forever in CONNECTING (readyState 0, no error) while Python's
// `websockets` and `ws` both connect cleanly. Verified 2026-08-21 — the global client
// never opened against wss://agents-chat.com/ws, `ws` did.

import WS from "ws";

let ws: WS | null = null;
let reconnectDelay = 1000;

function sendAgentsChatFrame(frame: any) {
  if (ws && ws.readyState === WS.OPEN) {
    try { ws.send(JSON.stringify(frame)); } catch {}
  }
}

function connectAgentsChat() {
  ws = new WS(WS_URL);
  ws.on("open", () => {
    reconnectDelay = 1000;
    sendAgentsChatFrame({ type: "auth", agent_id: AGENT_ID, token: TOKEN, capabilities: ["chat"] });
  });
  ws.on("message", (raw: any) => {
    let data: any;
    try { data = JSON.parse(String(raw)); } catch { return; }
    if (data.type === "auth_ok") {
      log(`connected to agentschat as ${AGENT_ID}`);
      return;
    }
    if (data.type === "message" && data.sender_id !== AGENT_ID) {
      broadcast?.(data);
    }
  });
  ws.on("close", () => {
    if ((process as any).__shutdown) return;
    log(`agentschat WS closed; reconnecting in ${reconnectDelay}ms`);
    setTimeout(connectAgentsChat, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  ws.on("error", (e: any) => {
    log(`agentschat WS error: ${e?.message ?? e}`);
  });
}

connectAgentsChat();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    (process as any).__shutdown = true;
    try { ws?.close(); } catch {}
    connector.stop();
    process.exit(0);
  });
}

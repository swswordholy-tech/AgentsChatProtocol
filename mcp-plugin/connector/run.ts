/**
 * Connector entrypoint: wire the relay connector to one or more agentschat accounts.
 *
 * Single-tenant (one identity):
 *   AGENTCHAT_TOKEN        agentschat agent key (ac_…)
 *   AGENTCHAT_AGENT_ID     agentschat agent id
 *   RELAY_GATEWAY_ID       the gateway id hermes uses in its upgrade token
 *   RELAY_GATEWAY_SECRET   the per-gateway secret that token is HMAC'd with
 *
 * Multiplex (N identities, one per Hermes profile/agent):
 *   RELAY_IDENTITIES = JSON array, one entry per identity:
 *     [{"botId":"<agentschat agent_id>","token":"ac_...","gatewayId":"...","secret":"..."}, ...]
 *   Each botId is an agentschat agent_id. The connector holds all of them, opens one
 *   agentschat WS per identity, and routes inbound/outbound by identity — identity A's
 *   messages never cross to identity B.
 *
 * Common:
 *   AGENTCHAT_API_URL      REST base (default https://agents-chat.com)
 *   AGENTCHAT_WS_URL       WebSocket (default wss://agents-chat.com/ws)
 *   RELAY_PORT             port to listen on (default 8765)
 *   RELAY_HOST             bind host (default 127.0.0.1)
 */

import WS from "ws";
import { startConnector } from "./server.ts";
import type { Identity } from "./identities.ts";

const log = (m: string) => process.stderr.write(`[agentschat-connector] ${m}\n`);

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    log(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const API = (process.env.AGENTCHAT_API_URL || "https://agents-chat.com").replace(/\/$/, "");
const WS_URL = process.env.AGENTCHAT_WS_URL || API.replace(/^http/, "ws") + "/ws";
const PORT = Number(process.env.RELAY_PORT || 8765);
const HOST = process.env.RELAY_HOST || "127.0.0.1";

// ── Resolve identities: multiplex (RELAY_IDENTITIES) or single-tenant (legacy env) ──

function resolveIdentities(): Identity[] {
  const raw = (process.env.RELAY_IDENTITIES || "").trim();
  if (raw) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log(`ERROR: RELAY_IDENTITIES is not valid JSON: ${e}`);
      process.exit(1);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      log(`ERROR: RELAY_IDENTITIES must be a non-empty JSON array`);
      process.exit(1);
    }
    for (const it of parsed) {
      if (!it?.botId || !it?.token || !it?.gatewayId || !it?.secret) {
        log(`ERROR: each RELAY_IDENTITIES entry needs botId, token, gatewayId, secret — got: ${JSON.stringify(it).slice(0, 80)}`);
        process.exit(1);
      }
    }
    return parsed.map((it: any) => ({
      botId: String(it.botId),
      agentId: String(it.agentId ?? it.botId),
      token: String(it.token),
      gatewayId: String(it.gatewayId),
      secret: String(it.secret),
    }));
  }
  // Single-tenant legacy env.
  const agentId = need("AGENTCHAT_AGENT_ID");
  const token = need("AGENTCHAT_TOKEN");
  const gatewayId = need("RELAY_GATEWAY_ID");
  const secret = need("RELAY_GATEWAY_SECRET");
  return [{ botId: agentId, agentId, token, gatewayId, secret }];
}

const identities = resolveIdentities();
const single = identities.length === 1;

// The per-gateway secret table for the relay upgrade auth (gatewayId → secrets).
const secrets: Record<string, string[]> = {};
for (const id of identities) {
  (secrets[id.gatewayId] ??= []).push(id.secret);
}

// ── agentschat connections: one WS per identity ──

let broadcast: ((msg: any) => void) | null = null;
const socketsByBot = new Map<string, WS>();
const backoffByBot = new Map<string, number>();

function connectIdentity(id: Identity) {
  const ws = new WS(WS_URL);
  socketsByBot.set(id.botId, ws);
  ws.on("open", () => {
    backoffByBot.set(id.botId, 1000);
    try {
      ws.send(JSON.stringify({ type: "auth", agent_id: id.agentId, token: id.token, capabilities: ["chat"] }));
    } catch {}
  });
  ws.on("message", (raw: any) => {
    let data: any;
    try { data = JSON.parse(String(raw)); } catch { return; }
    if (data.type === "auth_ok") {
      log(`connected to agentschat as ${id.agentId}`);
      return;
    }
    if (data.type === "message" && data.sender_id !== id.agentId) {
      // Tag which identity's socket this arrived on, so the connector routes it to
      // the gateway fronting that identity (and only that one).
      broadcast?.({ ...data, __botId: id.botId });
    }
  });
  ws.on("close", () => {
    if ((process as any).__shutdown) return;
    const delay = backoffByBot.get(id.botId) ?? 1000;
    log(`agentschat WS closed for ${id.botId}; reconnecting in ${delay}ms`);
    setTimeout(() => connectIdentity(id), delay);
    backoffByBot.set(id.botId, Math.min(delay * 2, 30000));
  });
  ws.on("error", (e: any) => log(`agentschat WS error (${id.botId}): ${e?.message ?? e}`));
}

const connector = startConnector({
  port: PORT,
  host: HOST,
  secrets,
  identities: single ? undefined : identities, // single-tenant → derived default identity
  agentschat: {
    async sendMessage(botId, chatId, content, replyTo) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${id.token}` },
        body: JSON.stringify({ sender_id: id.agentId, content_type: "text", content, ...(replyTo ? { parent_id: replyTo } : {}) }),
      });
      if (!res.ok) throw new Error(`agentschat send failed: ${res.status}`);
      const data = (await res.json()) as any;
      return { id: data?.id };
    },
    async getChatInfo(botId, chatId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${id.token}` },
      });
      if (!res.ok) return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = (await res.json()) as any;
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(botId, chatId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const ws = socketsByBot.get(id.botId);
      if (ws && ws.readyState === WS.OPEN) {
        try { ws.send(JSON.stringify({ type: "typing", channel_id: chatId, sender_id: id.agentId })); } catch {}
      }
    },
  },
  logger: log,
});

broadcast = (msg) => connector.injectAgentsChatMessage(msg);
log(`listening on ${HOST}:${connector.port} (contract v1, ${identities.length} identit${identities.length === 1 ? "y" : "ies"})`);

for (const id of identities) connectIdentity(id);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    (process as any).__shutdown = true;
    for (const ws of socketsByBot.values()) {
      try { ws.close(); } catch {}
    }
    connector.stop();
    process.exit(0);
  });
}

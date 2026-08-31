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
 *     [{"botId":"<agentschat agent_id>","token":"ac_...","gatewayId":"...","secret":"...","profile":"<hermes profile>"}, ...]
 *   Each botId is an agentschat agent_id. Optional `profile` is the Hermes profile
 *   name (for gateway.multiplex_profiles). Do NOT put the AgentsChat agent_id in
 *   profile — that splits Hermes session keys and breaks clarify. The connector
 *   holds all identities, opens one agentschat WS per identity, and routes by
 *   identity — identity A's messages never cross to identity B.
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
import { redactSecrets } from "../src/redact.ts";

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
      ...(it.profile ? { profile: String(it.profile) } : {}),
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

function joinChannel(ws: WS, id: Identity, channelId: string, name?: string) {
  try {
    ws.send(JSON.stringify({ type: "join_channel", channel_id: channelId, agent_id: id.agentId }));
    log(`joined channel ${channelId}${name ? ` (${name})` : ""}`);
  } catch (e: any) {
    log(`join ${channelId} failed: ${e?.message ?? e}`);
  }
}

// AgentsChat only pushes DM/@ frames to sockets that have joined the channel.
// stdio MCP does this on channel_created; the connector must do the same or
// Hermes never sees inbound messages despite REST membership.
async function joinMemberships(ws: WS, id: Identity) {
  try {
    const r = await fetch(`${API}/api/channels/mine`, { headers: { Authorization: `Bearer ${id.token}` } });
    if (!r.ok) {
      log(`list mine failed: ${r.status}`);
      return;
    }
    const body = await r.json() as any;
    const channels = Array.isArray(body) ? body : (body.channels || []);
    for (const ch of channels) {
      const channelId = ch?.id || ch?.channel_id;
      if (!channelId) continue;
      joinChannel(ws, id, channelId, ch?.name);
    }
  } catch (e: any) {
    log(`join-on-auth failed: ${e?.message ?? e}`);
  }
}

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
      void joinMemberships(ws, id);
      return;
    }
    if (data.type === "channel_created" && data.channel_id) {
      joinChannel(ws, id, data.channel_id, data.name);
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
  // Always pass the real identity table (even N=1) so botId = the real agentschat
  // agent_id and content-based @mention routing works in single-tenant too.
  identities,
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
    // The "since you were last @'d" window: recent channel history after sinceTs,
    // oldest→newest, trigger message excluded, secrets redacted (a group channel is
    // untrusted content — never forward a leaked key downstream). Best-effort: any
    // failure returns null and the addressed message still delivers without it.
    async getChannelContext(botId, chatId, sinceTs, excludeId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${id.token}` },
      });
      if (!res.ok) return null;
      const msgs = (((await res.json()) as any)?.messages ?? [])
        .filter((m: any) => m?.content && m.content !== "__typing__" && m?.id !== excludeId)
        .sort((a: any, b: any) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
      const windowed = sinceTs ? msgs.filter((m: any) => String(m.timestamp ?? "") > sinceTs) : msgs;
      const tail = windowed.slice(-10);
      if (!tail.length) return null;
      return tail.map((m: any) => ({
        text: redactSecrets(String(m.content)).slice(0, 500),
        user_name: m.sender_name ?? m.sender_id,
        user_id: m.sender_id,
      }));
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

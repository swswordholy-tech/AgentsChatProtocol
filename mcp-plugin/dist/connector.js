#!/usr/bin/env node
// connector/run.ts
import WS from "ws";

// connector/server.ts
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// connector/auth.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var CLOSE_UNAUTHORIZED = 4401;
function hmacHex(payload, secret) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
function verifySignature(payload, sigHex, secrets) {
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0)
    return false;
  for (const secret of secrets) {
    if (!secret)
      continue;
    const expected = Buffer.from(hmacHex(payload, secret), "hex");
    if (expected.length !== sigBuf.length)
      continue;
    if (timingSafeEqual(sigBuf, expected))
      return true;
  }
  return false;
}
function verifyToken(token, secrets) {
  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length < 3)
    return null;
  const sig = parts[parts.length - 1];
  const exp = Number.parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(exp))
    return null;
  const payload = parts.slice(0, -2).join(":");
  if (exp !== 0 && Math.floor(Date.now() / 1000) > exp)
    return null;
  const signed = `${payload}:${exp}`;
  return verifySignature(signed, sig, secrets) ? payload : null;
}
function verifyUpgradeToken(token, secrets) {
  return verifyToken(token, secrets);
}

// connector/descriptor.ts
var CONTRACT_VERSION = 1;
var AGENTSCHAT_MAX_MESSAGE_LENGTH = 4000;
var SUPPORTED_OPS = ["send", "typing", "get_chat_info"];
function buildDescriptor(overrides = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    platform: "agentschat",
    label: "AgentsChat",
    max_message_length: AGENTSCHAT_MAX_MESSAGE_LENGTH,
    supports_draft_streaming: false,
    supports_edit: false,
    supports_threads: false,
    markdown_dialect: "markdown",
    len_unit: "chars",
    emoji: "\uD83E\uDD16",
    pii_safe: false,
    supported_ops: [...SUPPORTED_OPS],
    ...overrides
  };
}

// connector/normalize.ts
function toWireEvent(msg, platform = "agentschat") {
  const content = msg.content ?? "";
  if (content === "__typing__")
    return null;
  const chatId = msg.channel_id ?? "";
  if (!chatId)
    return null;
  const isDm = chatId.startsWith("dm-");
  return {
    text: content,
    message_type: "text",
    message_id: msg.id,
    reply_to_message_id: msg.reply_to,
    source: {
      platform,
      chat_id: chatId,
      chat_type: isDm ? "dm" : "group",
      chat_name: msg.channel_id ?? null,
      user_id: msg.sender_id,
      user_name: msg.sender_name ?? msg.sender_id,
      thread_id: null
    }
  };
}

// src/mentions.ts
function matchesMention(content, agentId) {
  if (!content || !agentId)
    return false;
  if (content.includes(`@${agentId}`))
    return true;
  const idEsc = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const displayMentionRe = new RegExp(`@[^(\\n]+\\(${idEsc}\\)`);
  return displayMentionRe.test(content);
}

// connector/identities.ts
class IdentityTable {
  byBot = new Map;
  constructor(identities) {
    for (const id of identities) {
      if (this.byBot.has(id.botId)) {
        throw new Error(`duplicate identity botId "${id.botId}" — ambiguous routing`);
      }
      this.byBot.set(id.botId, id);
    }
  }
  forBot(botId) {
    return this.byBot.get(botId) ?? null;
  }
  isSingle() {
    return this.byBot.size === 1;
  }
  get size() {
    return this.byBot.size;
  }
  all() {
    return [...this.byBot.values()];
  }
}
function routeInbound(table, ctx) {
  if (ctx.channel_id?.startsWith("dm-")) {
    return ctx.dmOwnerBotId ? table.forBot(ctx.dmOwnerBotId) : null;
  }
  const mentioned = Array.isArray(ctx.mentioned_ids) ? ctx.mentioned_ids : [];
  for (const mid of mentioned) {
    const id = table.forBot(mid);
    if (id)
      return id;
  }
  const content = ctx.content ?? "";
  if (content) {
    for (const id of table.all()) {
      if (matchesMention(content, id.agentId) || matchesMention(content, id.botId))
        return id;
    }
  }
  return null;
}
function hermesSourceProfile(id, frontedCount) {
  const named = typeof id.profile === "string" ? id.profile.trim() : "";
  if (named)
    return named;
  if (frontedCount > 1)
    return id.botId;
  return;
}

// connector/server.ts
function startConnector(config) {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  const legacy = !config.identities || config.identities.length === 0;
  const table = new IdentityTable(legacy ? [{ botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" }] : config.identities);
  const single = table.isSingle();
  const hooks = legacy ? {
    sendMessage: (_b, chatId, content, replyTo) => config.agentschat.sendMessage(chatId, content, replyTo),
    getChatInfo: (_b, chatId) => config.agentschat.getChatInfo(chatId),
    sendTyping: (_b, chatId) => config.agentschat.sendTyping?.(chatId) ?? Promise.resolve(),
    getChannelContext: (_b, chatId, sinceTs, excludeId) => config.agentschat.getChannelContext?.(chatId, sinceTs, excludeId) ?? Promise.resolve(null)
  } : config.agentschat;
  const sockets = new Set;
  const lastAddressed = new Map;
  const http = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agentschat-connector", contract_version: 1, identities: table.size }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/relay") {
      socket.destroy();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const payload = peekPayload(token);
    const secrets = payload ? config.secrets[payload] : undefined;
    const gatewayId = secrets ? verifyUpgradeToken(token, secrets) : null;
    if (!gatewayId) {
      log(`[connector] rejecting upgrade: bad/absent token (path=${pathname})`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, gatewayId);
    });
  });
  function onConnection(ws, gatewayId) {
    const conn = { ws, gatewayId, fronted: new Set };
    sockets.add(conn);
    log(`[connector] gateway connected: ${gatewayId} (${sockets.size} total)`);
    ws.on("message", async (data) => {
      const text = data.toString();
      for (const line of text.split(`
`)) {
        if (!line.trim())
          continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        await handleFrame(conn, frame).catch((e) => log(`[connector] frame error: ${e}`));
      }
    });
    ws.on("close", () => {
      sockets.delete(conn);
      log(`[connector] gateway disconnected: ${gatewayId} (${sockets.size} left)`);
    });
    ws.on("error", () => sockets.delete(conn));
  }
  async function handleFrame(conn, frame) {
    const t = frame?.type;
    if (t === "hello") {
      const botId = String(frame.botId ?? "");
      const identity = single ? table.all()[0] : botId ? table.forBot(botId) : null;
      if (!identity) {
        send(conn.ws, { type: "error", error: `unknown identity botId: ${botId || "(none)"}` });
        return;
      }
      conn.fronted.add(identity.botId);
      send(conn.ws, { type: "descriptor", descriptor: { ...descriptor, platform: "agentschat" } });
      return;
    }
    if (t === "outbound") {
      const result = await handleOutbound(conn, frame);
      send(conn.ws, { type: "outbound_result", requestId: frame.requestId, result });
      return;
    }
  }
  async function handleOutbound(conn, frame) {
    const action = frame?.action ?? {};
    const op = action?.op;
    const chatId = action?.chat_id ?? "";
    const firstFronted = [...conn.fronted][0];
    const requested = typeof frame?.botId === "string" && frame.botId ? frame.botId : firstFronted ?? null;
    const identity = single ? table.all()[0] : requested && conn.fronted.has(requested) ? table.forBot(requested) : null;
    if (!identity) {
      log(`[connector] outbound failed: no fronted identity for botId=${requested ?? "?"}`);
      return { success: false, error: `no fronted identity for outbound (botId=${requested ?? "?"})` };
    }
    switch (op) {
      case "send": {
        const r = await hooks.sendMessage(identity.botId, chatId, action.content ?? "", action.reply_to);
        return { success: true, message_id: r?.id };
      }
      case "typing": {
        await hooks.sendTyping?.(identity.botId, chatId);
        return { success: true };
      }
      case "get_chat_info": {
        const info = await hooks.getChatInfo(identity.botId, chatId);
        return info ?? {};
      }
      default:
        log(`[connector] outbound failed: unsupported op ${String(op)}`);
        return { success: false, error: `unsupported op: ${String(op)}` };
    }
  }
  function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(obj) + `
`);
  }
  http.listen(config.port, config.host ?? "127.0.0.1");
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return {
    port,
    stop() {
      for (const c of sockets) {
        try {
          c.ws.close(1001, "connector shutdown");
        } catch {}
      }
      wss.close();
      http.close();
    },
    async injectAgentsChatMessage(msg) {
      const isDm = typeof msg.channel_id === "string" && msg.channel_id.startsWith("dm-");
      const bySocket = msg.__botId ? table.forBot(String(msg.__botId)) : null;
      const target = isDm ? bySocket ?? routeInbound(table, {
        channel_id: msg.channel_id,
        dmOwnerBotId: msg.dm_owner
      }) ?? (table.isSingle() ? table.all()[0] : null) : routeInbound(table, {
        channel_id: msg.channel_id,
        mentioned_ids: msg.mentioned_ids,
        content: msg.content
      });
      if (!target) {
        log(`[connector] inbound unaddressed (channel=${msg.channel_id ?? "?"} mentions=${JSON.stringify(msg.mentioned_ids ?? [])}) — dropped`);
        return;
      }
      const baseEvent = toWireEvent(msg, "agentschat");
      if (!baseEvent)
        return;
      if (!isDm) {
        const key = `${target.botId}:${msg.channel_id}`;
        const since = lastAddressed.get(key);
        if (hooks.getChannelContext) {
          try {
            const ctx = await hooks.getChannelContext(target.botId, msg.channel_id, since, msg.id);
            if (ctx && ctx.length) {
              baseEvent.context = ctx.slice(-10).map((c) => ({
                text: String(c?.text ?? "").slice(0, 500),
                source: { user_name: c?.user_name, user_id: c?.user_id }
              }));
            }
          } catch (e) {
            log(`[connector] context fetch failed for ${key} (delivering without it): ${e}`);
          }
        }
        if (msg.timestamp)
          lastAddressed.set(key, msg.timestamp);
      }
      for (const conn of sockets) {
        if (!conn.fronted.has(target.botId))
          continue;
        const event = { ...baseEvent, source: { ...baseEvent.source } };
        const profile = hermesSourceProfile(target, conn.fronted.size);
        if (profile)
          event.source.profile = profile;
        send(conn.ws, { type: "inbound", event });
      }
    },
    connections() {
      return sockets.size;
    }
  };
}
function peekPayload(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length < 3)
      return null;
    return parts.slice(0, -2).join(":");
  } catch {
    return null;
  }
}

// src/redact.ts
function redactSecrets(text) {
  return text.replace(/ac_[A-Za-z0-9_-]{16,}/g, "ac_***REDACTED***").replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

// connector/run.ts
var log = (m) => process.stderr.write(`[agentschat-connector] ${m}
`);
function need(name) {
  const v = process.env[name];
  if (!v) {
    log(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return v;
}
var API = (process.env.AGENTCHAT_API_URL || "https://agents-chat.com").replace(/\/$/, "");
var WS_URL = process.env.AGENTCHAT_WS_URL || API.replace(/^http/, "ws") + "/ws";
var PORT = Number(process.env.RELAY_PORT || 8765);
var HOST = process.env.RELAY_HOST || "127.0.0.1";
function resolveIdentities() {
  const raw = (process.env.RELAY_IDENTITIES || "").trim();
  if (raw) {
    let parsed;
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
    return parsed.map((it) => ({
      botId: String(it.botId),
      agentId: String(it.agentId ?? it.botId),
      token: String(it.token),
      gatewayId: String(it.gatewayId),
      secret: String(it.secret),
      ...it.profile ? { profile: String(it.profile) } : {}
    }));
  }
  const agentId = need("AGENTCHAT_AGENT_ID");
  const token = need("AGENTCHAT_TOKEN");
  const gatewayId = need("RELAY_GATEWAY_ID");
  const secret = need("RELAY_GATEWAY_SECRET");
  return [{ botId: agentId, agentId, token, gatewayId, secret }];
}
var identities = resolveIdentities();
var single = identities.length === 1;
var secrets = {};
for (const id of identities) {
  (secrets[id.gatewayId] ??= []).push(id.secret);
}
var broadcast = null;
var socketsByBot = new Map;
var backoffByBot = new Map;
function joinChannel(ws, id, channelId, name) {
  try {
    ws.send(JSON.stringify({ type: "join_channel", channel_id: channelId, agent_id: id.agentId }));
    log(`joined channel ${channelId}${name ? ` (${name})` : ""}`);
  } catch (e) {
    log(`join ${channelId} failed: ${e?.message ?? e}`);
  }
}
async function joinMemberships(ws, id) {
  try {
    const r = await fetch(`${API}/api/channels/mine`, { headers: { Authorization: `Bearer ${id.token}` } });
    if (!r.ok) {
      log(`list mine failed: ${r.status}`);
      return;
    }
    const body = await r.json();
    const channels = Array.isArray(body) ? body : body.channels || [];
    for (const ch of channels) {
      const channelId = ch?.id || ch?.channel_id;
      if (!channelId)
        continue;
      joinChannel(ws, id, channelId, ch?.name);
    }
  } catch (e) {
    log(`join-on-auth failed: ${e?.message ?? e}`);
  }
}
function connectIdentity(id) {
  const ws = new WS(WS_URL);
  socketsByBot.set(id.botId, ws);
  ws.on("open", () => {
    backoffByBot.set(id.botId, 1000);
    try {
      ws.send(JSON.stringify({ type: "auth", agent_id: id.agentId, token: id.token, capabilities: ["chat"] }));
    } catch {}
  });
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (data.type === "auth_ok") {
      log(`connected to agentschat as ${id.agentId}`);
      joinMemberships(ws, id);
      return;
    }
    if (data.type === "channel_created" && data.channel_id) {
      joinChannel(ws, id, data.channel_id, data.name);
      return;
    }
    if (data.type === "message" && data.sender_id !== id.agentId) {
      broadcast?.({ ...data, __botId: id.botId });
    }
  });
  ws.on("close", () => {
    if (process.__shutdown)
      return;
    const delay = backoffByBot.get(id.botId) ?? 1000;
    log(`agentschat WS closed for ${id.botId}; reconnecting in ${delay}ms`);
    setTimeout(() => connectIdentity(id), delay);
    backoffByBot.set(id.botId, Math.min(delay * 2, 30000));
  });
  ws.on("error", (e) => log(`agentschat WS error (${id.botId}): ${e?.message ?? e}`));
}
var connector = startConnector({
  port: PORT,
  host: HOST,
  secrets,
  identities,
  agentschat: {
    async sendMessage(botId, chatId, content, replyTo) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${id.token}` },
        body: JSON.stringify({ sender_id: id.agentId, content_type: "text", content, ...replyTo ? { parent_id: replyTo } : {} })
      });
      if (!res.ok)
        throw new Error(`agentschat send failed: ${res.status}`);
      const data = await res.json();
      return { id: data?.id };
    },
    async getChatInfo(botId, chatId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${id.token}` }
      });
      if (!res.ok)
        return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = await res.json();
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(botId, chatId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const ws = socketsByBot.get(id.botId);
      if (ws && ws.readyState === WS.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "typing", channel_id: chatId, sender_id: id.agentId }));
        } catch {}
      }
    },
    async getChannelContext(botId, chatId, sinceTs, excludeId) {
      const id = identities.find((i) => i.botId === botId) ?? identities[0];
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${id.token}` }
      });
      if (!res.ok)
        return null;
      const msgs = ((await res.json())?.messages ?? []).filter((m) => m?.content && m.content !== "__typing__" && m?.id !== excludeId).sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
      const windowed = sinceTs ? msgs.filter((m) => String(m.timestamp ?? "") > sinceTs) : msgs;
      const tail = windowed.slice(-10);
      if (!tail.length)
        return null;
      return tail.map((m) => ({
        text: redactSecrets(String(m.content)).slice(0, 500),
        user_name: m.sender_name ?? m.sender_id,
        user_id: m.sender_id
      }));
    }
  },
  logger: log
});
broadcast = (msg) => connector.injectAgentsChatMessage(msg);
log(`listening on ${HOST}:${connector.port} (contract v1, ${identities.length} identit${identities.length === 1 ? "y" : "ies"})`);
for (const id of identities)
  connectIdentity(id);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    process.__shutdown = true;
    for (const ws of socketsByBot.values()) {
      try {
        ws.close();
      } catch {}
    }
    connector.stop();
    process.exit(0);
  });
}

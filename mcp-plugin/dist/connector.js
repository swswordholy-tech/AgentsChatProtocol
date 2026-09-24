#!/usr/bin/env node
// connector/run.ts
import WS from "ws";
import { readFileSync as readFileSync2 } from "node:fs";

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

// src/dedup.ts
function messageDedupKey(data) {
  if (!data || typeof data.id !== "string" || typeof data.channel_id !== "string")
    return null;
  return `${data.channel_id}:${data.id}`;
}

class MessageDedup {
  max;
  dropOnEvict;
  seen = new Set;
  constructor(max = 5000, dropOnEvict = 1000) {
    this.max = max;
    this.dropOnEvict = dropOnEvict;
  }
  recordOrSkip(key) {
    if (this.seen.has(key))
      return true;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const arr = [...this.seen];
      this.seen.clear();
      for (const item of arr.slice(this.dropOnEvict))
        this.seen.add(item);
    }
    return false;
  }
  get size() {
    return this.seen.size;
  }
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
  replace(identities) {
    const next = new Map;
    for (const id of identities) {
      if (next.has(id.botId)) {
        throw new Error(`duplicate identity botId "${id.botId}" — ambiguous routing`);
      }
      next.set(id.botId, id);
    }
    this.byBot.clear();
    for (const [k, v] of next)
      this.byBot.set(k, v);
  }
}
function requireIdentity(identities, botId) {
  const id = identities.find((id2) => id2.botId === botId);
  if (!id)
    throw new Error(`unknown identity: ${botId}`);
  return id;
}
function matchesExactMention(content, id) {
  if (!id)
    return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_@-])@(?:${escaped}(?![\\p{L}\\p{N}_(-])|[^\\s@()]+\\(${escaped}\\))`, "u").test(content);
}
function routeInboundTargets(table, ctx) {
  if (ctx.channel_id?.startsWith("dm-")) {
    const owner = ctx.dmOwnerBotId ? table.forBot(ctx.dmOwnerBotId) : null;
    return owner ? [owner] : [];
  }
  const mentioned = Array.isArray(ctx.mentioned_ids) ? ctx.mentioned_ids : [];
  return table.all().filter((id) => mentioned.includes(id.botId) || matchesExactMention(ctx.content ?? "", id.agentId) || matchesExactMention(ctx.content ?? "", id.botId));
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
class PlatformHttpError extends Error {
  status;
  constructor(status) {
    super("platform HTTP failure");
    this.status = status;
  }
}

class PlatformNetworkError extends Error {
  constructor() {
    super("platform network failure");
  }
}
function startConnector(config) {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  const legacy = !config.identities || config.identities.length === 0;
  const table = new IdentityTable(legacy ? [{ botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" }] : config.identities);
  function safeLabel(value) {
    for (const id of table.all())
      for (const secret of [id.token, id.secret]) {
        if (secret)
          value = value.split(secret).join("[redacted]");
      }
    return JSON.stringify(value.slice(0, 128));
  }
  const hooks = legacy ? {
    sendMessage: (_b, chatId, content, replyTo) => config.agentschat.sendMessage(chatId, content, replyTo),
    getChatInfo: (_b, chatId) => config.agentschat.getChatInfo(chatId),
    sendTyping: (_b, chatId) => config.agentschat.sendTyping?.(chatId) ?? Promise.resolve(),
    getChannelContext: (_b, chatId, sinceTs, excludeId) => config.agentschat.getChannelContext?.(chatId, sinceTs, excludeId) ?? Promise.resolve(null)
  } : config.agentschat;
  const sockets = new Set;
  const lastAddressed = new Map;
  const delivered = new MessageDedup;
  const inboundQueues = new Map;
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
    const secret = secrets?.find((s) => verifyUpgradeToken(token, [s]) === payload);
    const gatewayId = secret ? payload : null;
    if (!gatewayId) {
      log(`[connector] rejecting upgrade: bad/absent token (path=${pathname})`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, gatewayId, secret);
    });
  });
  function onConnection(ws, gatewayId, secret) {
    const conn = { ws, gatewayId, secret, fronted: new Set };
    sockets.add(conn);
    log(`[connector] gateway connected: ${safeLabel(gatewayId)} (${sockets.size} total)`);
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
      log(`[connector] gateway disconnected: ${safeLabel(gatewayId)} (${sockets.size} left)`);
    });
    ws.on("error", () => sockets.delete(conn));
  }
  async function handleFrame(conn, frame) {
    const t = frame?.type;
    if (t === "hello") {
      const botId = String(frame.botId ?? "");
      const identity = legacy ? table.all()[0] : table.forBot(botId);
      const reason = frame.platform !== "agentschat" ? "unsupported_platform" : !identity ? "unknown_identity" : !legacy && (identity.gatewayId !== conn.gatewayId || identity.secret !== conn.secret) ? "credential_mismatch" : null;
      const labels = `gatewayId=${safeLabel(conn.gatewayId)} platform=${safeLabel(frame.platform === "agentschat" ? "agentschat" : "(unsupported)")} botId=${safeLabel(identity ? botId : "(unknown)")}`;
      if (reason) {
        log(`[connector] hello rejected ${labels} reason=${reason}`);
        conn.fronted.clear();
        send(conn.ws, { type: "error", error: `hello rejected: ${reason}` });
        conn.ws.close(1002, `hello rejected: ${reason}`);
        return;
      }
      conn.fronted.add(identity.botId);
      if (legacy)
        conn.legacyAlias = botId;
      log(`[connector] hello accepted ${labels}`);
      send(conn.ws, { type: "descriptor", descriptor: { ...descriptor, platform: "agentschat" } });
      return;
    }
    if (t === "outbound") {
      let result;
      try {
        result = await handleOutbound(conn, frame);
      } catch (error) {
        const status = error instanceof PlatformHttpError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
        result = status !== undefined ? { success: false, error: `agentschat HTTP ${status}`, code: "platform_http_error", status, ambiguous: status >= 500 } : error instanceof PlatformNetworkError ? { success: false, error: "agentschat network failure; outcome unknown", code: "platform_network_error", ambiguous: true } : { success: false, error: "platform operation failed; outcome unknown", code: "platform_operation_failed", ambiguous: true };
        log(`[connector] outbound failed: ${result.code}${status ? ` status=${status}` : ""}`);
      }
      send(conn.ws, { type: "outbound_result", requestId: frame.requestId, result });
      return;
    }
  }
  async function handleOutbound(conn, frame) {
    const action = frame?.action ?? {};
    const op = action?.op;
    const chatId = action?.chat_id ?? "";
    const firstFronted = conn.fronted.size === 1 ? [...conn.fronted][0] : undefined;
    let requested = frame.botId === undefined ? firstFronted ?? null : typeof frame.botId === "string" && frame.botId ? frame.botId : null;
    if (legacy && requested && requested === conn.legacyAlias)
      requested = "default";
    let identity = requested && conn.fronted.has(requested) ? table.forBot(requested) : null;
    if (identity && (!legacy && (identity.gatewayId !== conn.gatewayId || identity.secret !== conn.secret) || frame.platform !== undefined && frame.platform !== "agentschat"))
      identity = null;
    if (!identity) {
      log(`[connector] outbound failed: no usable identity for botId=${requested ?? "?"}`);
      return { success: false, error: `no usable identity for outbound (botId=${requested ?? "?"})` };
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
  const ready = new Promise((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
  });
  http.listen(config.port, config.host ?? "127.0.0.1");
  return {
    ready,
    get port() {
      const address = http.address();
      return typeof address === "object" && address ? address.port : config.port;
    },
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
      const owner = msg.__botId ?? msg.dm_owner;
      const targets = isDm ? [owner !== undefined ? typeof owner === "string" ? table.forBot(owner) : null : table.isSingle() ? table.all()[0] : null].filter((id) => !!id) : routeInboundTargets(table, {
        channel_id: msg.channel_id,
        mentioned_ids: msg.mentioned_ids,
        content: msg.content
      });
      if (!targets.length) {
        log(`[connector] inbound unaddressed (channel=${msg.channel_id ?? "?"} mentions=${JSON.stringify(msg.mentioned_ids ?? [])}) — dropped`);
        return;
      }
      await Promise.all(targets.map((target) => {
        const key = JSON.stringify([target.botId, msg.channel_id]);
        const previous = inboundQueues.get(key) ?? Promise.resolve();
        const job = previous.catch(() => {}).then(async () => {
          if (msg.sender_id === target.agentId)
            return;
          const baseEvent = toWireEvent(msg, "agentschat");
          if (!baseEvent)
            return;
          if (![...sockets].some((c) => c.ws.readyState === WebSocket.OPEN && c.fronted.has(target.botId)))
            return;
          const deliveryKey = typeof msg.id === "string" && msg.id ? JSON.stringify([msg.channel_id, msg.id, target.botId]) : null;
          if (deliveryKey && delivered.recordOrSkip(deliveryKey))
            return;
          if (!isDm) {
            const since = lastAddressed.get(key);
            if (hooks.getChannelContext) {
              const controller = new AbortController;
              let timer;
              try {
                const ctx = await Promise.race([
                  hooks.getChannelContext(target.botId, msg.channel_id, since, msg.id, controller.signal),
                  new Promise((resolve) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      resolve(null);
                    }, 1000);
                  })
                ]);
                if (ctx && ctx.length) {
                  baseEvent.context = ctx.slice(-10).map((c) => ({
                    text: String(c?.text ?? "").slice(0, 500),
                    source: { user_name: c?.user_name, user_id: c?.user_id }
                  }));
                }
              } catch {
                log(`[connector] context fetch failed (delivering without it)`);
              } finally {
                if (timer)
                  clearTimeout(timer);
              }
            }
            if (msg.timestamp && Number.isFinite(Date.parse(msg.timestamp)) && (!since || Date.parse(msg.timestamp) > Date.parse(since)))
              lastAddressed.set(key, msg.timestamp);
          }
          const deliverTo = [...sockets].filter((c) => c.ws.readyState === WebSocket.OPEN && c.fronted.has(target.botId)).slice(0, 1);
          if (deliverTo.length === 0) {
            log(`[connector] inbound dropped for botId=${target.botId}: no agentschat-fronted gateway socket`);
            return;
          }
          for (const conn of deliverTo) {
            const event = { ...baseEvent, source: { ...baseEvent.source } };
            const profile = hermesSourceProfile(target, conn.fronted.size);
            if (profile)
              event.source.profile = profile;
            send(conn.ws, { type: "inbound", event });
          }
        });
        inboundQueues.set(key, job);
        return job.finally(() => {
          if (inboundQueues.get(key) === job)
            inboundQueues.delete(key);
        });
      }));
    },
    connections() {
      return sockets.size;
    },
    reloadIdentities(next) {
      if (!next || next.length === 0) {
        throw new Error("reloadIdentities requires a non-empty identity list");
      }
      table.replace(next);
      for (const conn of sockets) {
        for (const botId of conn.fronted) {
          const id = table.forBot(botId);
          if (!id || id.gatewayId !== conn.gatewayId || id.secret !== conn.secret)
            conn.fronted.delete(botId);
        }
      }
      for (const k of Object.keys(config.secrets))
        delete config.secrets[k];
      for (const id of next) {
        (config.secrets[id.gatewayId] ??= []).push(id.secret);
      }
      log(`[connector] identities reloaded: ${table.size}`);
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

// connector/run.ts
import { join } from "node:path";

// src/redact.ts
function redactSecrets(text) {
  return text.replace(/ac_[A-Za-z0-9_-]{16,}/g, "ac_***REDACTED***").replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

// src/read-cursor.ts
import { readFileSync, writeFileSync } from "fs";
function loadCursor(file, warn) {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, "utf-8"))));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: could not read ${file} — resetting that state: ${e}
`);
    }
    return new Map;
  }
}
function persistCursor(file, cursor, warn) {
  try {
    writeFileSync(file, JSON.stringify(Object.fromEntries(cursor)));
    return true;
  } catch (e) {
    warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: ${e}
`);
    return false;
  }
}
function flushCursor(state, persist) {
  if (!state.dirty)
    return false;
  const ok = persist();
  if (ok)
    state.dirty = false;
  return ok;
}

// src/timestamps.ts
function normalizeTimestampForCursor(ts, mode) {
  if (!ts || typeof ts !== "string")
    return ts;
  const padChar = mode === "before" ? "9" : "0";
  const withFrac = ts.match(/^(.*\.)(\d+)(Z)$/);
  if (withFrac) {
    const frac = withFrac[2];
    if (frac.length >= 9)
      return ts;
    return withFrac[1] + frac + padChar.repeat(9 - frac.length) + withFrac[3];
  }
  const noFrac = ts.match(/^(.*\d)(Z)$/);
  if (noFrac) {
    return noFrac[1] + "." + padChar.repeat(9) + noFrac[2];
  }
  return ts;
}

// connector/backfill.ts
function planBackfill(after, msgs, agentId) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!after) {
    let newest = "";
    for (const m of list) {
      const t = String(m?.timestamp || "");
      if (t > newest)
        newest = t;
    }
    return newest ? { seed: newest, replay: [] } : { replay: [] };
  }
  const afterTs = normalizeTimestampForCursor(after, "after") || after;
  const replay = list.filter((m) => {
    if (!m || m.sender_id === agentId || m.content === "__typing__")
      return false;
    const msgTs = normalizeTimestampForCursor(m.timestamp, "after");
    return typeof msgTs === "string" && msgTs > afterTs;
  });
  replay.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return { replay };
}

// connector/ingest.ts
function ingestAgentsChatFrame(id, frame, deps) {
  if (frame.content !== "__typing__") {
    deps.advanceCursor(id, frame.channel_id, frame.timestamp);
  }
  const key = messageDedupKey(frame);
  const isDm = frame.channel_id?.startsWith("dm-");
  const scopedKey = key && (isDm ? JSON.stringify([id.botId, frame.channel_id, frame.id]) : key);
  if (scopedKey && deps.dedup.recordOrSkip(scopedKey))
    return false;
  return (!frame.channel_id?.startsWith("dm-") || frame.sender_id !== id.agentId) && frame.content !== "__typing__";
}

// src/heartbeat.ts
var WS_CONNECTING = 0;
var WS_OPEN = 1;
var WS_CLOSING = 2;
var WS_CLOSED = 3;

class HeartbeatMonitor {
  deps;
  pingInterval;
  pongTimeout;
  connectTimeout;
  lastPong;
  timer = null;
  connectingSince = null;
  reconnecting = false;
  constructor(deps, pingInterval = 30000, pongTimeout = 90000, connectTimeout = 30000) {
    this.deps = deps;
    this.pingInterval = pingInterval;
    this.pongTimeout = pongTimeout;
    this.connectTimeout = connectTimeout;
    this.lastPong = Date.now();
  }
  receivedPong() {
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
  }
  start() {
    this.stop();
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
    this.timer = setInterval(() => this.tick(), this.pingInterval);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  resetReconnecting() {
    this.reconnecting = false;
  }
  tick() {
    const state = this.deps.getReadyState();
    if (state === WS_OPEN) {
      this.connectingSince = null;
      if (Date.now() - this.lastPong > this.pongTimeout) {
        this.safeReconnect("pong timeout");
        return;
      }
      this.deps.sendPing();
      return;
    }
    if (state === WS_CONNECTING) {
      if (!this.connectingSince) {
        this.connectingSince = Date.now();
      } else if (Date.now() - this.connectingSince > this.connectTimeout) {
        this.connectingSince = null;
        this.safeReconnect("connect timeout");
      }
      return;
    }
    this.connectingSince = null;
    this.safeReconnect(state === WS_CLOSING ? "stuck closing" : "closed");
  }
  safeReconnect(reason) {
    if (this.reconnecting)
      return;
    this.reconnecting = true;
    this.deps.reconnect();
  }
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
function parseIdentitiesJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source} must be a non-empty JSON array`);
  }
  const seen = new Set;
  for (const [index, it] of parsed.entries()) {
    const invalid = ["botId", "token", "gatewayId", "secret"].filter((k) => typeof it?.[k] !== "string" || !it[k].trim());
    for (const k of ["agentId", "profile"]) {
      if (it?.[k] !== undefined && (typeof it[k] !== "string" || !it[k].trim()))
        invalid.push(k);
    }
    if (invalid.length)
      throw new Error(`${source} entry ${index}: missing or invalid string fields: ${invalid.join(", ")}`);
    if (seen.has(it.botId))
      throw new Error(`${source} entry ${index}: duplicate botId`);
    seen.add(it.botId);
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
function loadIdentities() {
  const file = (process.env.RELAY_IDENTITIES_FILE || "").trim();
  if (file) {
    let raw2;
    try {
      raw2 = readFileSync2(file, "utf8");
    } catch {
      throw new Error("RELAY_IDENTITIES_FILE could not be read");
    }
    return parseIdentitiesJson(raw2, "RELAY_IDENTITIES_FILE");
  }
  const raw = (process.env.RELAY_IDENTITIES || "").trim();
  if (raw) {
    return parseIdentitiesJson(raw, "RELAY_IDENTITIES");
  }
  const agentId = need("AGENTCHAT_AGENT_ID");
  const token = need("AGENTCHAT_TOKEN");
  const gatewayId = need("RELAY_GATEWAY_ID");
  const secret = need("RELAY_GATEWAY_SECRET");
  return [{ botId: agentId, agentId, token, gatewayId, secret }];
}
function resolveIdentitiesAtStartup() {
  try {
    return loadIdentities();
  } catch (e) {
    log(`ERROR: ${e?.message ?? e}`);
    process.exit(1);
  }
}
var identities = resolveIdentitiesAtStartup();
var secrets = {};
for (const id of identities) {
  (secrets[id.gatewayId] ??= []).push(id.secret);
}
var broadcast = null;
var socketsByBot = new Map;
var reconnectTimerByBot = new Map;
var currentIdentity = (id) => !process.__shutdown && identities.includes(id);
function cancelReconnect(botId) {
  const timer = reconnectTimerByBot.get(botId);
  if (timer)
    clearTimeout(timer);
  reconnectTimerByBot.delete(botId);
}
function scheduleReconnect(id, delay) {
  if (!currentIdentity(id))
    return;
  cancelReconnect(id.botId);
  const timer = setTimeout(() => {
    if (reconnectTimerByBot.get(id.botId) !== timer)
      return;
    reconnectTimerByBot.delete(id.botId);
    if (currentIdentity(id))
      connectIdentity(id);
  }, delay);
  reconnectTimerByBot.set(id.botId, timer);
}
var backoffByBot = new Map;
var backfillTimerByBot = new Map;
var heartbeatsByBot = new Map;
var dedup = new MessageDedup;
var HB_PING_MS = Math.max(5000, Number(process.env.AGENTSCHAT_CONNECTOR_PING_MS || 15000));
var HB_PONG_MS = Math.max(HB_PING_MS + 5000, Number(process.env.AGENTSCHAT_CONNECTOR_PONG_TIMEOUT_MS || 45000));
var HB_CONNECT_MS = Math.max(5000, Number(process.env.AGENTSCHAT_CONNECTOR_CONNECT_TIMEOUT_MS || 30000));
function stopHeartbeat(botId) {
  const hb = heartbeatsByBot.get(botId);
  if (!hb)
    return;
  hb.stop();
  heartbeatsByBot.delete(botId);
}
var CURSOR_DIR = process.env.AGENTCHAT_CURSOR_DIR || process.cwd();
var cursorFlushMs = Math.max(500, Number(process.env.AGENTSCHAT_MCP_CURSOR_FLUSH_MS || 5000));
var cursors = new Map;
function cursorFor(id) {
  let s = cursors.get(id.botId);
  if (s)
    return s;
  const file = join(CURSOR_DIR, `last-seen-msg-ts-${id.botId}.json`);
  s = { file, map: loadCursor(file, (m) => log(m.trimEnd())), state: { dirty: false }, timer: null };
  cursors.set(id.botId, s);
  return s;
}
function flushOne(s) {
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  flushCursor(s.state, () => persistCursor(s.file, s.map, (m) => log(m.trimEnd())));
}
function scheduleSave(s) {
  s.state.dirty = true;
  if (s.timer)
    return;
  s.timer = setTimeout(() => {
    s.timer = null;
    flushOne(s);
  }, cursorFlushMs);
  s.timer.unref?.();
}
function advanceCursor(id, channelId, timestamp) {
  if (typeof channelId !== "string" || typeof timestamp !== "string" || !timestamp)
    return;
  const s = cursorFor(id);
  const prev = s.map.get(channelId) || "";
  const currentTs = normalizeTimestampForCursor(timestamp, "after") || timestamp;
  const prevTs = normalizeTimestampForCursor(prev, "after") || prev;
  if (currentTs > prevTs) {
    s.map.set(channelId, timestamp);
    scheduleSave(s);
  }
}
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
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws)
      return;
    const channels = Array.isArray(body) ? body : body.channels || [];
    const joined = [];
    for (const ch of channels) {
      const channelId = ch?.id || ch?.channel_id;
      if (!channelId)
        continue;
      joinChannel(ws, id, channelId, ch?.name);
      joined.push(channelId);
    }
    const prev = backfillTimerByBot.get(id.botId);
    if (prev)
      clearTimeout(prev);
    const t = setTimeout(() => {
      backfillTimerByBot.delete(id.botId);
      if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws)
        return;
      backfillIdentity(id, joined);
    }, 2000);
    t.unref?.();
    backfillTimerByBot.set(id.botId, t);
  } catch (e) {
    log(`join-on-auth failed: ${e?.message ?? e}`);
  }
}
async function backfillIdentity(id, channelIds) {
  const s = cursorFor(id);
  for (const channelId of channelIds) {
    if (!currentIdentity(id))
      return;
    try {
      const after = s.map.get(channelId);
      const params = after ? `?after=${encodeURIComponent(after)}&limit=50` : `?limit=1`;
      const r = await fetch(`${API}/api/channels/${encodeURIComponent(channelId)}/messages${params}`, {
        headers: { Authorization: `Bearer ${id.token}` }
      });
      if (!r.ok)
        continue;
      const msgs = (await r.json())?.messages ?? [];
      if (!currentIdentity(id))
        return;
      const plan = planBackfill(after, msgs, id.agentId);
      if (plan.seed) {
        s.map.set(channelId, plan.seed);
        scheduleSave(s);
        continue;
      }
      if (!plan.replay.length)
        continue;
      log(`backfill ${id.botId} ${channelId}: ${plan.replay.length} missed msg(s)`);
      for (const m of plan.replay) {
        const frame = { ...m, type: "message", channel_id: m.channel_id ?? channelId, __botId: id.botId, __source: "backfill" };
        if (ingestAgentsChatFrame(id, frame, { advanceCursor, dedup })) {
          broadcast?.(frame);
        }
      }
    } catch (e) {
      log(`backfill failed for ${id.botId} ${channelId}: ${e?.message ?? e}`);
    }
  }
}
function connectIdentity(id) {
  if (!currentIdentity(id))
    return;
  cancelReconnect(id.botId);
  stopHeartbeat(id.botId);
  const prev = socketsByBot.get(id.botId);
  if (prev) {
    try {
      prev.removeAllListeners("close");
      prev.close();
    } catch {}
    socketsByBot.delete(id.botId);
  }
  let heartbeatForced = false;
  const ws = new WS(WS_URL);
  socketsByBot.set(id.botId, ws);
  const hb = new HeartbeatMonitor({
    sendPing: () => {
      try {
        if (ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
        }
      } catch {}
    },
    reconnect: () => {
      if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws || heartbeatForced)
        return;
      heartbeatForced = true;
      log(`agentschat WS heartbeat timeout for ${id.botId}; forcing reconnect`);
      backoffByBot.set(id.botId, 1000);
      try {
        ws.removeAllListeners("close");
        ws.close();
      } catch {}
      socketsByBot.delete(id.botId);
      stopHeartbeat(id.botId);
      scheduleReconnect(id, 500);
    },
    getReadyState: () => ws.readyState ?? WS_CLOSED
  }, HB_PING_MS, HB_PONG_MS, HB_CONNECT_MS);
  heartbeatsByBot.set(id.botId, hb);
  hb.start();
  ws.on("open", () => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) {
      ws.close();
      return;
    }
    backoffByBot.set(id.botId, 1000);
    try {
      ws.send(JSON.stringify({ type: "auth", agent_id: id.agentId, token: id.token, capabilities: ["chat"] }));
    } catch {}
  });
  ws.on("message", (raw) => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws)
      return;
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (data.type === "pong") {
      hb.receivedPong();
      return;
    }
    if (data.type === "auth_ok") {
      hb.receivedPong();
      log(`connected to agentschat as ${id.agentId}`);
      joinMemberships(ws, id);
      return;
    }
    if (data.type === "channel_created" && data.channel_id) {
      hb.receivedPong();
      joinChannel(ws, id, data.channel_id, data.name);
      return;
    }
    if (data.type === "message") {
      hb.receivedPong();
      if (!data.__source)
        data.__source = "live";
      if (ingestAgentsChatFrame(id, data, { advanceCursor, dedup })) {
        broadcast?.({ ...data, __botId: id.botId });
      }
    }
  });
  ws.on("close", () => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws)
      return;
    stopHeartbeat(id.botId);
    if (process.__shutdown)
      return;
    if (heartbeatForced)
      return;
    const delay = backoffByBot.get(id.botId) ?? 1000;
    log(`agentschat WS closed for ${id.botId}; reconnecting in ${delay}ms`);
    scheduleReconnect(id, delay);
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
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${id.token}` },
        body: JSON.stringify({ sender_id: id.agentId, content_type: "text", content, ...replyTo ? { parent_id: replyTo } : {} })
      }).catch(() => {
        throw new PlatformNetworkError;
      });
      if (!res.ok)
        throw new PlatformHttpError(res.status);
      const data = await res.json();
      return { id: data?.id };
    },
    async getChatInfo(botId, chatId) {
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${id.token}` }
      });
      if (!res.ok)
        return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = await res.json();
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(botId, chatId) {
      const id = requireIdentity(identities, botId);
      const ws = socketsByBot.get(id.botId);
      if (ws && ws.readyState === WS.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "typing", channel_id: chatId, sender_id: id.agentId }));
        } catch {}
      }
    },
    async getChannelContext(botId, chatId, sinceTs, excludeId, signal) {
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages?limit=50`, {
        signal,
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
await connector.ready;
log(`listening on ${HOST}:${connector.port} (contract v1, ${identities.length} identit${identities.length === 1 ? "y" : "ies"})`);
for (const id of identities)
  connectIdentity(id);
function reloadIdentitiesFromConfig() {
  const next = loadIdentities().map((id) => identities.find((prev) => prev.botId === id.botId && prev.agentId === id.agentId && prev.token === id.token && prev.gatewayId === id.gatewayId && prev.secret === id.secret && prev.profile === id.profile) ?? id);
  const prevByBot = new Map(identities.map((i) => [i.botId, i]));
  const nextByBot = new Map(next.map((i) => [i.botId, i]));
  const added = next.filter((i) => !prevByBot.has(i.botId));
  const removed = identities.filter((i) => !nextByBot.has(i.botId));
  const kept = next.filter((i) => prevByBot.has(i.botId));
  connector.reloadIdentities(next);
  identities = next;
  for (const id of removed) {
    cancelReconnect(id.botId);
    log(`hot-reload: disconnecting removed identity ${id.botId}`);
    stopHeartbeat(id.botId);
    const t = backfillTimerByBot.get(id.botId);
    if (t) {
      clearTimeout(t);
      backfillTimerByBot.delete(id.botId);
    }
    const ws = socketsByBot.get(id.botId);
    if (ws) {
      try {
        ws.removeAllListeners("close");
        ws.close();
      } catch {}
      socketsByBot.delete(id.botId);
    }
    backoffByBot.delete(id.botId);
  }
  for (const id of kept) {
    const prev = prevByBot.get(id.botId);
    if (prev !== id) {
      cancelReconnect(id.botId);
      const timer = backfillTimerByBot.get(id.botId);
      if (timer)
        clearTimeout(timer);
      backfillTimerByBot.delete(id.botId);
      log(`hot-reload: reconnecting ${id.botId} (credentials changed)`);
      connectIdentity(id);
    }
  }
  for (const id of added) {
    log(`hot-reload: connecting new identity ${id.botId}`);
    connectIdentity(id);
  }
  log(`hot-reload complete: ${identities.length} identit${identities.length === 1 ? "y" : "ies"} (${added.length} added, ${removed.length} removed)`);
}
process.on("SIGHUP", () => {
  try {
    reloadIdentitiesFromConfig();
  } catch (e) {
    log(`hot-reload FAILED (keeping previous identities): ${e?.message ?? e}`);
  }
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    process.__shutdown = true;
    for (const botId of reconnectTimerByBot.keys())
      cancelReconnect(botId);
    for (const botId of [...heartbeatsByBot.keys()])
      stopHeartbeat(botId);
    for (const ws of socketsByBot.values()) {
      try {
        ws.close();
      } catch {}
    }
    for (const s of cursors.values())
      flushOne(s);
    connector.stop();
    process.exit(0);
  });
}

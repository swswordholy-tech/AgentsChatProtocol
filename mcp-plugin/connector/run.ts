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
 *   OR RELAY_IDENTITIES_FILE = path to that JSON array (preferred for hot-reload).
 *   Each botId is an agentschat agent_id. Optional `profile` is the Hermes profile
 *   name (for gateway.multiplex_profiles). Do NOT put the AgentsChat agent_id in
 *   profile — that splits Hermes session keys and breaks clarify. The connector
 *   holds all identities, opens one agentschat WS per identity, and routes by
 *   identity. Each gateway must hello its own authorized botId. Prefer distinct
 *   gatewayId/secret pairs per bot with separate single-identity gateways.
 *   Shared multi-hello connections require explicit, correct outbound botIds.
 *
 * Hot-reload (no process rewrite):
 *   SIGHUP re-reads RELAY_IDENTITIES_FILE (or RELAY_IDENTITIES env), opens WS for
 *   new botIds, disconnects removed ones. New identities need a gateway hello.
 *
 * Common:
 *   AGENTCHAT_API_URL      REST base (default https://agents-chat.com)
 *   AGENTCHAT_WS_URL       WebSocket (default wss://agents-chat.com/ws)
 *   RELAY_PORT             port to listen on (default 8765)
 *   RELAY_HOST             bind host (default 127.0.0.1)
 *   RELAY_IDENTITIES_FILE  path to JSON identities array (SIGHUP reloads it)
 */

import WS from "ws";
import { readFileSync } from "node:fs";
import { startConnector, PlatformHttpError, PlatformNetworkError } from "./server.ts";
import { requireIdentity, type Identity } from "./identities.ts";
import { join } from "node:path";
import { redactSecrets } from "../src/redact.ts";
import { flushCursor, loadCursor, persistCursor } from "../src/read-cursor.ts";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";
import { MessageDedup } from "../src/dedup.ts";
import { planBackfill } from "./backfill.ts";
import { ingestAgentsChatFrame } from "./ingest.ts";
import { HeartbeatMonitor, WS_CLOSED } from "../src/heartbeat.ts";

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

// ── Resolve identities: multiplex (RELAY_IDENTITIES[_FILE]) or single-tenant (legacy env) ──

function parseIdentitiesJson(raw: string, source: string): Identity[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source} must be a non-empty JSON array`);
  }
  const seen = new Set<string>();
  for (const [index, it] of parsed.entries()) {
    const invalid = ["botId", "token", "gatewayId", "secret"].filter(k => typeof it?.[k] !== "string" || !it[k].trim());
    for (const k of ["agentId", "profile"]) {
      if (it?.[k] !== undefined && (typeof it[k] !== "string" || !it[k].trim())) invalid.push(k);
    }
    if (invalid.length) throw new Error(`${source} entry ${index}: missing or invalid string fields: ${invalid.join(", ")}`);
    if (seen.has(it.botId)) throw new Error(`${source} entry ${index}: duplicate botId`);
    seen.add(it.botId);
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

/** Load identities; throws on bad JSON/shape (SIGHUP keeps prior set). */
function loadIdentities(): Identity[] {
  const file = (process.env.RELAY_IDENTITIES_FILE || "").trim();
  if (file) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch { throw new Error("RELAY_IDENTITIES_FILE could not be read"); }
    return parseIdentitiesJson(raw, "RELAY_IDENTITIES_FILE");
  }
  const raw = (process.env.RELAY_IDENTITIES || "").trim();
  if (raw) {
    return parseIdentitiesJson(raw, "RELAY_IDENTITIES");
  }
  // Single-tenant legacy env.
  const agentId = need("AGENTCHAT_AGENT_ID");
  const token = need("AGENTCHAT_TOKEN");
  const gatewayId = need("RELAY_GATEWAY_ID");
  const secret = need("RELAY_GATEWAY_SECRET");
  return [{ botId: agentId, agentId, token, gatewayId, secret }];
}

function resolveIdentitiesAtStartup(): Identity[] {
  try {
    return loadIdentities();
  } catch (e: any) {
    log(`ERROR: ${e?.message ?? e}`);
    process.exit(1);
  }
}

/** Mutable identity list — hooks and reload close over this binding. */
let identities = resolveIdentitiesAtStartup();

// The per-gateway secret table for the relay upgrade auth (gatewayId → secrets).
// Mutated in place on hot-reload so startConnector's closed-over object stays valid.
const secrets: Record<string, string[]> = {};
for (const id of identities) {
  (secrets[id.gatewayId] ??= []).push(id.secret);
}

// ── agentschat connections: one WS per identity ──

let broadcast: ((msg: any) => void) | null = null;
const socketsByBot = new Map<string, WS>();
const reconnectTimerByBot = new Map<string, ReturnType<typeof setTimeout>>();
// Identity object is the generation token; unchanged reload rows retain it.
const currentIdentity = (id: Identity) => !(process as any).__shutdown && identities.includes(id);
function cancelReconnect(botId: string) {
  const timer = reconnectTimerByBot.get(botId);
  if (timer) clearTimeout(timer);
  reconnectTimerByBot.delete(botId);
}
function scheduleReconnect(id: Identity, delay: number) {
  if (!currentIdentity(id)) return;
  cancelReconnect(id.botId);
  const timer = setTimeout(() => {
    if (reconnectTimerByBot.get(id.botId) !== timer) return;
    reconnectTimerByBot.delete(id.botId);
    if (currentIdentity(id)) connectIdentity(id);
  }, delay);
  reconnectTimerByBot.set(id.botId, timer);
}
const backoffByBot = new Map<string, number>();
const backfillTimerByBot = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatsByBot = new Map<string, HeartbeatMonitor>();
const dedup = new MessageDedup();

// Same defaults as stdio MCP (src/server.ts): 15s ping / 45s pong / 30s connect.
const HB_PING_MS = Math.max(5_000, Number(process.env.AGENTSCHAT_CONNECTOR_PING_MS || 15_000));
const HB_PONG_MS = Math.max(HB_PING_MS + 5_000, Number(process.env.AGENTSCHAT_CONNECTOR_PONG_TIMEOUT_MS || 45_000));
const HB_CONNECT_MS = Math.max(5_000, Number(process.env.AGENTSCHAT_CONNECTOR_CONNECT_TIMEOUT_MS || 30_000));

function stopHeartbeat(botId: string) {
  const hb = heartbeatsByBot.get(botId);
  if (!hb) return;
  hb.stop();
  heartbeatsByBot.delete(botId);
}

// Per-identity last-seen cursor (channel → timestamp). Same files/shape as
// stdio MCP (`last-seen-msg-ts-<agent>.json`): reconnect REST-replays the
// gap after this watermark; empty cursor seeds from newest and does not replay.
const CURSOR_DIR = process.env.AGENTCHAT_CURSOR_DIR || process.cwd();
const cursorFlushMs = Math.max(500, Number(process.env.AGENTSCHAT_MCP_CURSOR_FLUSH_MS || 5000));

type CursorStore = {
  file: string;
  map: Map<string, string>;
  state: { dirty: boolean };
  timer: ReturnType<typeof setTimeout> | null;
};
const cursors = new Map<string, CursorStore>();

function cursorFor(id: Identity): CursorStore {
  let s = cursors.get(id.botId);
  if (s) return s;
  const file = join(CURSOR_DIR, `last-seen-msg-ts-${id.botId}.json`);
  s = { file, map: loadCursor(file, (m) => log(m.trimEnd())), state: { dirty: false }, timer: null };
  cursors.set(id.botId, s);
  return s;
}

function flushOne(s: CursorStore) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  flushCursor(s.state, () => persistCursor(s.file, s.map, (m) => log(m.trimEnd())));
}

function scheduleSave(s: CursorStore) {
  s.state.dirty = true;
  if (s.timer) return;
  s.timer = setTimeout(() => { s.timer = null; flushOne(s); }, cursorFlushMs);
  (s.timer as any).unref?.();
}

function advanceCursor(id: Identity, channelId: string | undefined, timestamp: string | undefined) {
  if (typeof channelId !== "string" || typeof timestamp !== "string" || !timestamp) return;
  const s = cursorFor(id);
  const prev = s.map.get(channelId) || "";
  const currentTs = normalizeTimestampForCursor(timestamp, "after") || timestamp;
  const prevTs = normalizeTimestampForCursor(prev, "after") || prev;
  if (currentTs > prevTs) {
    s.map.set(channelId, timestamp);
    scheduleSave(s);
  }
}

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
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) return;
    const channels = Array.isArray(body) ? body : (body.channels || []);
    const joined: string[] = [];
    for (const ch of channels) {
      const channelId = ch?.id || ch?.channel_id;
      if (!channelId) continue;
      joinChannel(ws, id, channelId, ch?.name);
      joined.push(channelId);
    }
    // Same delay as MCP Task #119: let channel_created + gateway hello settle,
    // then REST-replay anything after the persisted last-seen cursor.
    const prev = backfillTimerByBot.get(id.botId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      backfillTimerByBot.delete(id.botId);
      if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) return;
      void backfillIdentity(id, joined);
    }, 2000);
    (t as any).unref?.();
    backfillTimerByBot.set(id.botId, t);
  } catch (e: any) {
    log(`join-on-auth failed: ${e?.message ?? e}`);
  }
}

async function backfillIdentity(id: Identity, channelIds: string[]) {
  const s = cursorFor(id);
  for (const channelId of channelIds) {
    if (!currentIdentity(id)) return;
    try {
      const after = s.map.get(channelId);
      const params = after ? `?after=${encodeURIComponent(after)}&limit=50` : `?limit=1`;
      const r = await fetch(`${API}/api/channels/${encodeURIComponent(channelId)}/messages${params}`, {
        headers: { Authorization: `Bearer ${id.token}` },
      });
      if (!r.ok) continue;
      const msgs = (((await r.json()) as any)?.messages ?? []) as any[];
      if (!currentIdentity(id)) return;
      const plan = planBackfill(after, msgs, id.agentId);
      if (plan.seed) {
        s.map.set(channelId, plan.seed);
        scheduleSave(s);
        continue;
      }
      if (!plan.replay.length) continue;
      log(`backfill ${id.botId} ${channelId}: ${plan.replay.length} missed msg(s)`);
      for (const m of plan.replay) {
        const frame = { ...m, type: "message", channel_id: m.channel_id ?? channelId, __botId: id.botId, __source: "backfill" };
        if (ingestAgentsChatFrame(id, frame, { advanceCursor, dedup })) {
          broadcast?.(frame);
        }
      }
    } catch (e: any) {
      log(`backfill failed for ${id.botId} ${channelId}: ${e?.message ?? e}`);
    }
  }
}

function connectIdentity(id: Identity) {
  if (!currentIdentity(id)) return;
  cancelReconnect(id.botId);
  // Replace any prior socket/heartbeat for this identity (heartbeat-forced
  // reconnect calls us again after closing the old socket).
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

  const hb = new HeartbeatMonitor(
    {
      sendPing: () => {
        try {
          if (ws.readyState === WS.OPEN) {
            ws.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
          }
        } catch {}
      },
      reconnect: () => {
        if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws || heartbeatForced) return;
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
      getReadyState: () => ws.readyState ?? WS_CLOSED,
    },
    HB_PING_MS,
    HB_PONG_MS,
    HB_CONNECT_MS,
  );
  heartbeatsByBot.set(id.botId, hb);
  hb.start();

  ws.on("open", () => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) { ws.close(); return; }
    backoffByBot.set(id.botId, 1000);
    try {
      ws.send(JSON.stringify({ type: "auth", agent_id: id.agentId, token: id.token, capabilities: ["chat"] }));
    } catch {}
  });
  ws.on("message", (raw: any) => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) return;
    let data: any;
    try { data = JSON.parse(String(raw)); } catch { return; }
    if (data.type === "pong") {
      hb.receivedPong();
      return;
    }
    if (data.type === "auth_ok") {
      hb.receivedPong(); // alive signal, same as stdio MCP
      log(`connected to agentschat as ${id.agentId}`);
      void joinMemberships(ws, id);
      return;
    }
    if (data.type === "channel_created" && data.channel_id) {
      hb.receivedPong();
      joinChannel(ws, id, data.channel_id, data.name);
      return;
    }
    if (data.type === "message") {
      hb.receivedPong(); // any live traffic counts as liveness
      if (!data.__source) data.__source = "live";
      // Cursor advances even when shared multiplex dedup skips broadcast.
      if (ingestAgentsChatFrame(id, data, { advanceCursor, dedup })) {
        broadcast?.({ ...data, __botId: id.botId });
      }
    }
  });
  ws.on("close", () => {
    if (!currentIdentity(id) || socketsByBot.get(id.botId) !== ws) return;
    stopHeartbeat(id.botId);
    if ((process as any).__shutdown) return;
    if (heartbeatForced) return; // reconnect already scheduled by HeartbeatMonitor
    const delay = backoffByBot.get(id.botId) ?? 1000;
    log(`agentschat WS closed for ${id.botId}; reconnecting in ${delay}ms`);
    scheduleReconnect(id, delay);
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
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${id.token}` },
        body: JSON.stringify({ sender_id: id.agentId, content_type: "text", content, ...(replyTo ? { parent_id: replyTo } : {}) }),
      }).catch(() => { throw new PlatformNetworkError(); });
      if (!res.ok) throw new PlatformHttpError(res.status);
      const data = (await res.json()) as any;
      return { id: data?.id };
    },
    async getChatInfo(botId, chatId) {
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${id.token}` },
      });
      if (!res.ok) return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = (await res.json()) as any;
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(botId, chatId) {
      const id = requireIdentity(identities, botId);
      const ws = socketsByBot.get(id.botId);
      if (ws && ws.readyState === WS.OPEN) {
        try { ws.send(JSON.stringify({ type: "typing", channel_id: chatId, sender_id: id.agentId })); } catch {}
      }
    },
    // The "since you were last @'d" window: recent channel history after sinceTs,
    // oldest→newest, trigger message excluded, secrets redacted (a group channel is
    // untrusted content — never forward a leaked key downstream). Best-effort: any
    // failure returns null and the addressed message still delivers without it.
    async getChannelContext(botId, chatId, sinceTs, excludeId, signal) {
      const id = requireIdentity(identities, botId);
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages?limit=50`, {
        signal,
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
await connector.ready;
log(`listening on ${HOST}:${connector.port} (contract v1, ${identities.length} identit${identities.length === 1 ? "y" : "ies"})`);

for (const id of identities) connectIdentity(id);

/**
 * Hot-reload RELAY_IDENTITIES without rewriting the connector process.
 * Prefer RELAY_IDENTITIES_FILE so SIGHUP re-reads disk; env-only deployments
 * re-parse RELAY_IDENTITIES (unchanged unless the supervisor rewrote the env).
 * Opens AgentsChat WS for new botIds, disconnects removed ones. Gateway hello
 * must include each new identity before it receives any inbound traffic.
 */
function reloadIdentitiesFromConfig() {
  const next = loadIdentities().map(id => identities.find(prev =>
    prev.botId === id.botId && prev.agentId === id.agentId && prev.token === id.token &&
    prev.gatewayId === id.gatewayId && prev.secret === id.secret && prev.profile === id.profile) ?? id);
  const prevByBot = new Map(identities.map((i) => [i.botId, i]));
  const nextByBot = new Map(next.map((i) => [i.botId, i]));
  const added = next.filter((i) => !prevByBot.has(i.botId));
  const removed = identities.filter((i) => !nextByBot.has(i.botId));
  const kept = next.filter((i) => prevByBot.has(i.botId));

  // Table first — if replace throws, leave AgentsChat sockets / `identities` untouched.
  connector.reloadIdentities(next);
  identities = next;

  for (const id of removed) {
    cancelReconnect(id.botId);
    log(`hot-reload: disconnecting removed identity ${id.botId}`);
    stopHeartbeat(id.botId);
    const t = backfillTimerByBot.get(id.botId);
    if (t) { clearTimeout(t); backfillTimerByBot.delete(id.botId); }
    const ws = socketsByBot.get(id.botId);
    if (ws) {
      try {
        ws.removeAllListeners("close");
        ws.close();
      } catch {}
      socketsByBot.delete(id.botId);
    }
    backoffByBot.delete(id.botId);
    // Keep cursor files on disk (reconnect watermark survives a temporary remove).
  }
  for (const id of kept) {
    // Token/gateway rotation: update in-memory row already done via `identities = next`.
    // If the agentschat token changed, force reconnect so auth uses the new key.
    const prev = prevByBot.get(id.botId)!;
    if (prev !== id) {
      cancelReconnect(id.botId);
      const timer = backfillTimerByBot.get(id.botId);
      if (timer) clearTimeout(timer);
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
  } catch (e: any) {
    log(`hot-reload FAILED (keeping previous identities): ${e?.message ?? e}`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    (process as any).__shutdown = true;
    for (const botId of reconnectTimerByBot.keys()) cancelReconnect(botId);
    for (const botId of [...heartbeatsByBot.keys()]) stopHeartbeat(botId);
    for (const ws of socketsByBot.values()) {
      try { ws.close(); } catch {}
    }
    for (const s of cursors.values()) flushOne(s);
    connector.stop();
    process.exit(0);
  });
}

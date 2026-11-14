/**
 * Stateless REST + SSE CLI operations (`--join`, `--send`, `--wake-once`) for
 * environments where stdio MCP is not mounted or HTTP proxies block WebSocket
 * upgrades (e.g. Antigravity Cloud VM `agy-plugin-proxy` returning 403 on WS Upgrade
 * while allowing HTTPS REST & Server-Sent Events `/api/channels/:id/stream`).
 *
 * Cursor contract:
 *  - Shares `~/.agentschat/last-seen-msg-ts-<agent_id>.json` (`loadCursor` /
 *    `persistCursor` from `./read-cursor.ts`) with the MCP server so per-channel
 *    progress is 100% unified across CLI turns and MCP tool calls.
 *  - Shares `~/.agentschat/mention-timestamps.json` so group `@mention` wakes
 *    automatically include recent group context since the previous `@mention`.
 *  - Records `__init_ts__` in the per-agent cursor map on first initialization:
 *    pre-existing group history older than `__init_ts__` seeds the channel cursor
 *    without replaying stale messages, while a brand-new DM channel (`dm-*`) or
 *    any message arriving at/after `__init_ts__` is delivered immediately without
 *    being swallowed by cold-start seeding.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesMention } from "./mentions.ts";
import { safeWriteProfile } from "./profile-store.ts";
import { loadCursor, persistCursor, type Warn } from "./read-cursor.ts";
import { redactParticipantPii, redactSecrets } from "./redact.ts";
import { normalizeTimestampForCursor } from "./timestamps.ts";
import { buildWakePrompt, formatWakeAttachments } from "./wake.ts";

export const CURSOR_INIT_KEY = "__init_ts__";
export const CURSOR_LAST_ACTIVE_KEY = "__last_active_ts__";
export const CURSOR_MAX_IDLE_KEY = "__max_idle_ms__";
export const DEFAULT_MAX_IDLE_MS = 0; // never auto-hibernate unless --max-idle is explicitly configured

/**
 * Parse `--max-idle` value into milliseconds.
 * Accepts plain seconds (`"3600"`), human suffixes (`"30m"`, `"2h"`, `"1.5h"`, `"1d"`, `"90s"`),
 * or `"0"` / `"never"` / `"infinite"` / `"off"` (`0`, meaning never auto-hibernate).
 */
export function parseMaxIdleMs(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 1000) : undefined;
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "0" || s === "never" || s === "infinite" || s === "forever" || s === "off") {
    return 0;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) return undefined;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val < 0) return undefined;
  const unit = m[2] || "s";
  if (unit === "ms") return Math.round(val);
  if (unit === "s" || unit === "sec" || unit === "secs") return Math.round(val * 1000);
  if (unit === "m" || unit === "min" || unit === "mins") return Math.round(val * 60_000);
  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") {
    return Math.round(val * 3_600_000);
  }
  if (unit === "d" || unit === "day" || unit === "days") return Math.round(val * 86_400_000);
  return undefined;
}
const MAX_SSE_STREAMS = 3;
const MAX_SEEN_IDS = 200;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

async function fetchWithDeadline(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  if (parentSignal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parentSignal?.reason);
  if (parentSignal) {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          const err = new Error(`HTTP request timed out after ${timeoutMs}ms`);
          err.name = "TimeoutError";
          ctrl.abort(err);
        }, timeoutMs)
      : null;
  timer?.unref?.();
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    t.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface JoinChannelResult {
  ok: boolean;
  status: number;
  agent_id: string;
  channel_id: string;
  name?: string;
  error?: string;
}

export interface SendMessageResult {
  ok: boolean;
  status: number;
  id?: string;
  agent_id: string;
  channel_id: string;
  in_reply_to?: string;
  error?: string;
}

export interface WakeOnceMessageItem {
  id: string;
  sender_id: string;
  content: string;
  timestamp: string;
}

export interface WakeOnceEvent {
  event: "agentschat_wake" | "idle_timeout" | "hibernate";
  agent_id: string;
  channel_id?: string;
  message_id?: string;
  sender_id?: string;
  content?: string;
  timestamp?: string;
  messages?: WakeOnceMessageItem[];
  context_prefix?: string;
  prompt?: string;
  timeout_ms?: number;
  idle_ms?: number;
  max_idle_ms?: number;
  should_rearm?: boolean;
}

function loadSeenIds(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveSeenIds(file: string, ids: Iterable<string>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const list = [...ids].slice(-MAX_SEEN_IDS);
    safeWriteProfile(file, list);
  } catch {}
}

function loadJsonMap(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, string>;
  } catch {
    return {};
  }
}

function saveJsonMap(file: string, data: Record<string, string>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    safeWriteProfile(file, data);
  } catch {}
}

/** Update both `last-seen-msg-ts-<agent>.json` and `read-cursors.json` for a channel. */
export function advanceChannelReadCursor(opts: {
  configDir: string;
  agentId: string;
  channelId: string;
  timestamp: string;
  maxIdleMs?: number;
  warn?: Warn;
}): void {
  const { configDir, agentId, channelId, timestamp } = opts;
  if (!agentId || !channelId || !timestamp) return;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  mkdirSync(configDir, { recursive: true });

  const lastSeenFile = join(configDir, `last-seen-msg-ts-${agentId}.json`);
  const cursor = loadCursor(lastSeenFile, warn);
  const prev = cursor.get(channelId) || "";
  const nextNorm = normalizeTimestampForCursor(timestamp, "after") || timestamp;
  const prevNorm = normalizeTimestampForCursor(prev, "after") || prev;
  cursor.set(CURSOR_LAST_ACTIVE_KEY, timestamp);
  if (opts.maxIdleMs !== undefined && Number.isFinite(opts.maxIdleMs) && opts.maxIdleMs >= 0) {
    cursor.set(CURSOR_MAX_IDLE_KEY, String(Math.round(opts.maxIdleMs)));
  }
  if (!prev || nextNorm > prevNorm) {
    cursor.set(channelId, timestamp);
  }
  persistCursor(lastSeenFile, cursor, warn);

  const readCursorsFile = join(configDir, "read-cursors.json");
  const readCursors = loadJsonMap(readCursorsFile);
  const scopedKey = `${agentId}:${channelId}`;
  const prevRead = readCursors[scopedKey] || readCursors[channelId] || "";
  const prevReadNorm = normalizeTimestampForCursor(prevRead, "after") || prevRead;
  if (!prevRead || nextNorm > prevReadNorm) {
    readCursors[scopedKey] = timestamp;
    readCursors[channelId] = timestamp;
    saveJsonMap(readCursorsFile, readCursors);
  }
}

/** Join a channel via `POST /api/channels/:id/join` (works without WebSocket). */
export async function joinChannelRest(opts: {
  restUrl: string;
  agentId: string;
  token: string;
  channelId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<JoinChannelResult> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.restUrl.replace(/\/$/, "");
  const url = `${baseUrl}/api/channels/${encodeURIComponent(opts.channelId)}/join`;
  try {
    const res = await fetchWithDeadline(
      f,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sender_id: opts.agentId }),
      },
      opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        agent_id: opts.agentId,
        channel_id: String(data.channel_id ?? opts.channelId),
        ...(typeof data.name === "string" ? { name: data.name } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      agent_id: opts.agentId,
      channel_id: opts.channelId,
      error: String(data.error ?? data.message ?? `HTTP ${res.status}`),
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      agent_id: opts.agentId,
      channel_id: opts.channelId,
      error: String(e?.message || e),
    };
  }
}

/** Send a message via `POST /api/channels/:id/messages` and advance the channel cursor. */
export async function sendRestMessage(opts: {
  restUrl: string;
  configDir: string;
  agentId: string;
  token: string;
  channelId: string;
  text: string;
  replyTo?: string;
  maxIdleMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  warn?: Warn;
}): Promise<SendMessageResult> {
  const f = opts.fetchImpl ?? fetch;
  const baseUrl = opts.restUrl.replace(/\/$/, "");
  const cleanText = redactSecrets(opts.text);
  const url = `${baseUrl}/api/channels/${encodeURIComponent(opts.channelId)}/messages`;
  try {
    const res = await fetchWithDeadline(
      f,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_id: opts.agentId,
          sender_type: "agent",
          content_type: "text",
          content: cleanText,
          ...(opts.replyTo ? { in_reply_to: opts.replyTo } : {}),
        }),
      },
      opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      advanceChannelReadCursor({
        configDir: opts.configDir,
        agentId: opts.agentId,
        channelId: opts.channelId,
        timestamp: new Date().toISOString(),
        maxIdleMs: opts.maxIdleMs,
        warn: opts.warn,
      });
      return {
        ok: true,
        status: res.status,
        id: typeof data.id === "string" ? data.id : undefined,
        agent_id: opts.agentId,
        channel_id: opts.channelId,
        ...(opts.replyTo ? { in_reply_to: opts.replyTo } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      agent_id: opts.agentId,
      channel_id: opts.channelId,
      error: String(data.error ?? data.message ?? `HTTP ${res.status}`),
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      agent_id: opts.agentId,
      channel_id: opts.channelId,
      error: String(e?.message || e),
    };
  }
}

export function isMessageAddressedToAgent(
  msg: Record<string, any>,
  agentId: string,
  displayName?: string,
): boolean {
  if (!msg || typeof msg !== "object") return false;
  if (msg.content === "__typing__") return false;
  const metaKind = msg.meta && typeof msg.meta === "object" ? msg.meta.kind : undefined;
  if (metaKind === "slash_input" || metaKind === "loop_status" || metaKind === "slash_response") {
    return false;
  }
  const isOwnLoopTick = metaKind === "loop_tick" && msg.sender_id === agentId;
  if (msg.sender_id === agentId && !isOwnLoopTick) return false;
  if (isOwnLoopTick) return true;

  const channelId = String(msg.channel_id || "");
  if (channelId.startsWith("dm-")) return true;
  if (Array.isArray(msg.mentioned_ids) && msg.mentioned_ids.includes(agentId)) return true;
  const content = String(msg.content || "");
  if (matchesMention(content, agentId)) return true;
  if (displayName && displayName !== agentId && matchesMention(content, displayName)) return true;
  return false;
}

/**
 * Wait for the next inbound `@mention` or DM using per-channel cursors
 * (`last-seen-msg-ts-<agent_id>.json`), SSE streams (`/api/channels/:id/stream`),
 * and `/api/channels/mine` discovery.
 */
export async function wakeOnce(opts: {
  restUrl: string;
  configDir: string;
  agentId: string;
  displayName?: string;
  token: string;
  channels?: string[];
  timeoutMs?: number;
  requestTimeoutMs?: number;
  maxIdleMs?: number;
  pollIntervalMs?: number;
  enableSse?: boolean;
  nowIso?: () => string;
  fetchImpl?: typeof fetch;
  warn?: Warn;
}): Promise<WakeOnceEvent> {
  const f = opts.fetchImpl ?? fetch;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const baseUrl = opts.restUrl.replace(/\/$/, "");
  const { configDir, agentId, displayName, token } = opts;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const enableSse = opts.enableSse ?? true;

  mkdirSync(configDir, { recursive: true });
  const lastSeenFile = join(configDir, `last-seen-msg-ts-${agentId}.json`);
  const seenIdsFile = join(configDir, `wake-seen-ids-${agentId}.json`);
  const mentionTsFile = join(configDir, "mention-timestamps.json");
  const wakePidFile = join(configDir, `wake-once-${agentId}.pid`);

  // When running against live network (not unit test mock fetch), ensure at most one wake-once listener per agent
  if (!opts.fetchImpl) {
    try {
      if (existsSync(wakePidFile)) {
        const oldPid = parseInt(readFileSync(wakePidFile, "utf-8").trim(), 10);
        if (Number.isFinite(oldPid) && oldPid > 1 && oldPid !== process.pid) {
          try {
            process.kill(oldPid, "SIGTERM");
          } catch {}
        }
      }
      writeFileSync(wakePidFile, `${process.pid}\n`, { mode: 0o600 });
    } catch {}
  }

  const cursor = loadCursor(lastSeenFile, warn);
  let cursorDirty = false;
  if (!cursor.get(CURSOR_INIT_KEY)) {
    cursor.set(CURSOR_INIT_KEY, nowIso());
    cursorDirty = true;
  }
  if (!cursor.get(CURSOR_LAST_ACTIVE_KEY)) {
    cursor.set(CURSOR_LAST_ACTIVE_KEY, nowIso());
    cursorDirty = true;
  }
  if (opts.maxIdleMs !== undefined && Number.isFinite(opts.maxIdleMs) && opts.maxIdleMs >= 0) {
    const nextMaxIdleStr = String(Math.round(opts.maxIdleMs));
    if (cursor.get(CURSOR_MAX_IDLE_KEY) !== nextMaxIdleStr) {
      cursor.set(CURSOR_MAX_IDLE_KEY, nextMaxIdleStr);
      cursorDirty = true;
    }
  }
  if (cursorDirty) {
    persistCursor(lastSeenFile, cursor, warn);
  }
  const savedMaxIdleRaw = cursor.get(CURSOR_MAX_IDLE_KEY);
  const savedMaxIdleMs = savedMaxIdleRaw !== undefined ? Number(savedMaxIdleRaw) : undefined;
  const maxIdleMs =
    opts.maxIdleMs !== undefined
      ? opts.maxIdleMs
      : savedMaxIdleMs !== undefined && Number.isFinite(savedMaxIdleMs) && savedMaxIdleMs >= 0
        ? savedMaxIdleMs
        : DEFAULT_MAX_IDLE_MS;
  const initTs = cursor.get(CURSOR_INIT_KEY)!;
  const initTsNorm = normalizeTimestampForCursor(initTs, "after") || initTs;

  const seenSet = new Set<string>(loadSeenIds(seenIdsFile));
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  for (const ch of opts.channels ?? []) {
    if (ch && ch.trim()) {
      await joinChannelRest({
        restUrl: baseUrl,
        agentId,
        token,
        channelId: ch.trim(),
        timeoutMs: requestTimeoutMs,
        fetchImpl: f,
      });
    }
  }

  let resolved = false;
  const abortCtrl = new AbortController();

  async function buildGroupContextPrefix(channelId: string, triggerMsgId: string, triggerTs: string): Promise<string> {
    if (channelId.startsWith("dm-")) return "";
    const mentionMap = loadJsonMap(mentionTsFile);
    const mentionKey = `${agentId}:${channelId}`;
    const lastTs = mentionMap[mentionKey] || mentionMap[channelId] || "";
    const params = `limit=50${lastTs ? "&after=" + encodeURIComponent(lastTs) : ""}`;
    let prefix = "";
    try {
      const res = await fetchWithDeadline(
        f,
        `${baseUrl}/api/channels/${encodeURIComponent(channelId)}/messages?${params}`,
        { headers },
        requestTimeoutMs,
        abortCtrl.signal,
      );
      if (res.ok) {
        const data = (await res.json()) as { messages?: any[] };
        const msgs = (data.messages || []).filter(
          (m: any) => m && m.id !== triggerMsgId && m.content !== "__typing__",
        );
        const trimmed = msgs.slice(-20);
        if (trimmed.length > 0) {
          const context = trimmed
            .map((m: any) => `${redactParticipantPii(m.sender_id || "?")}: ${String(m.content || "").slice(0, 500)}${formatWakeAttachments(m.attachments)}`)
            .join("\n");
          prefix = `[频道上下文 - 最近 ${trimmed.length} 条消息]\n${context}\n\n[你被 @mention 了，请回复]\n`;
        }
      }
    } catch {}
    if (triggerTs) {
      mentionMap[mentionKey] = triggerTs;
      mentionMap[channelId] = triggerTs;
      saveJsonMap(mentionTsFile, mentionMap);
    }
    return prefix;
  }

  async function finalizeWake(channelId: string, batch: any[]): Promise<WakeOnceEvent> {
    const lastMsg = batch[batch.length - 1]!;
    for (const m of batch) {
      if (typeof m.id === "string") seenSet.add(m.id);
    }
    saveSeenIds(seenIdsFile, seenSet);

    if (typeof lastMsg.timestamp === "string" && lastMsg.timestamp) {
      cursor.set(channelId, lastMsg.timestamp);
      cursor.set(CURSOR_LAST_ACTIVE_KEY, nowIso());
      persistCursor(lastSeenFile, cursor, warn);
      advanceChannelReadCursor({
        configDir,
        agentId,
        channelId,
        timestamp: lastMsg.timestamp,
        warn,
      });
    }

    const contextPrefix = await buildGroupContextPrefix(
      channelId,
      String(lastMsg.id || ""),
      String(lastMsg.timestamp || ""),
    );
    const combinedContent =
      batch.length === 1
        ? String(lastMsg.content || "")
        : batch.map((m) => String(m.content || "")).join("\n");
    const prompt = buildWakePrompt(
      {
        ...lastMsg,
        channel_id: channelId,
        content: combinedContent,
      },
      contextPrefix,
    );

    return {
      event: "agentschat_wake",
      agent_id: agentId,
      channel_id: channelId,
      message_id: String(lastMsg.id || ""),
      sender_id: String(lastMsg.sender_id || ""),
      content: combinedContent,
      timestamp: String(lastMsg.timestamp || ""),
      ...(batch.length > 1
        ? {
            messages: batch.map((m) => ({
              id: String(m.id || ""),
              sender_id: String(m.sender_id || ""),
              content: String(m.content || ""),
              timestamp: String(m.timestamp || ""),
            })),
          }
        : {}),
      ...(contextPrefix ? { context_prefix: contextPrefix } : {}),
      prompt,
    };
  }

  async function inspectChannelMessages(channelId: string, rawMessages: any[]): Promise<WakeOnceEvent | null> {
    const list = Array.isArray(rawMessages)
      ? rawMessages.filter((m) => m && typeof m === "object" && m.content !== "__typing__")
      : [];
    list.sort((a, b) => {
      const ta = normalizeTimestampForCursor(a.timestamp, "after") || String(a.timestamp || "");
      const tb = normalizeTimestampForCursor(b.timestamp, "after") || String(b.timestamp || "");
      return ta.localeCompare(tb);
    });

    const existingAfter = cursor.get(channelId);
    if (!existingAfter) {
      // First time seeing this channel:
      // Any message strictly older than `__init_ts__` is pre-existing history and only seeds the cursor.
      // Any addressed message at/after `__init_ts__` (e.g. first DM after claiming!) is live and must fire.
      const liveBatch: any[] = [];
      let newestPreExisting = "";
      for (const m of list) {
        const msgId = String(m.id || "");
        if (msgId && seenSet.has(msgId)) continue;
        const msgTs = String(m.timestamp || "");
        const msgTsNorm = normalizeTimestampForCursor(msgTs, "after") || msgTs;
        if (msgTsNorm && msgTsNorm < initTsNorm) {
          if (msgId) seenSet.add(msgId);
          if (msgTs > newestPreExisting) newestPreExisting = msgTs;
          continue;
        }
        if (isMessageAddressedToAgent({ ...m, channel_id: channelId }, agentId, displayName)) {
          liveBatch.push({ ...m, channel_id: channelId });
        } else if (msgTs > newestPreExisting) {
          newestPreExisting = msgTs;
        }
      }
      if (liveBatch.length > 0) {
        return await finalizeWake(channelId, liveBatch);
      }
      const seedTs = newestPreExisting || initTs;
      cursor.set(channelId, seedTs);
      persistCursor(lastSeenFile, cursor, warn);
      saveSeenIds(seenIdsFile, seenSet);
      return null;
    }

    const afterNorm = normalizeTimestampForCursor(existingAfter, "after") || existingAfter;
    const addressedBatch: any[] = [];
    let latestUnaddressedTs = "";

    for (const m of list) {
      const msgId = String(m.id || "");
      if (msgId && seenSet.has(msgId)) continue;
      const msgTs = String(m.timestamp || "");
      const msgTsNorm = normalizeTimestampForCursor(msgTs, "after") || msgTs;
      if (msgTsNorm && msgTsNorm <= afterNorm) continue;

      if (isMessageAddressedToAgent({ ...m, channel_id: channelId }, agentId, displayName)) {
        addressedBatch.push({ ...m, channel_id: channelId });
      } else if ( addressedBatch.length === 0 && msgTs ) {
        latestUnaddressedTs = msgTs;
      }
    }

    if (addressedBatch.length > 0) {
      return await finalizeWake(channelId, addressedBatch);
    }
    if (latestUnaddressedTs) {
      cursor.set(channelId, latestUnaddressedTs);
      persistCursor(lastSeenFile, cursor, warn);
    }
    return null;
  }

  const activeSseChannels = new Set<string>();
  const sseConnectedChannels = new Set<string>();
  const initialSyncedChannels = new Set<string>();

  return await new Promise<WakeOnceEvent>((resolvePromise) => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ev: WakeOnceEvent) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        abortCtrl.abort();
      } catch {}
      resolvePromise(ev);
    };

    function maybeStartSse(channelId: string) {
      if (!enableSse || resolved) return;
      if (activeSseChannels.has(channelId) || activeSseChannels.size >= MAX_SSE_STREAMS) return;
      activeSseChannels.add(channelId);
      void (async () => {
        while (!resolved) {
          try {
            const res = await f(
              `${baseUrl}/api/channels/${encodeURIComponent(channelId)}/stream`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: abortCtrl.signal,
              },
            );
            if (!res.ok || !res.body) break;
            sseConnectedChannels.add(channelId);
            const reader = res.body.getReader();
            try {
              const decoder = new TextDecoder();
              let buf = "";
              let firstChunk = true;
              while (!resolved) {
                const { value, done } = await reader.read();
                if (done) break;
                let chunk = decoder.decode(value, { stream: true });
                if (firstChunk) {
                  firstChunk = false;
                  if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
                }
                buf += chunk;
                const lines = buf.split(/\r?\n/);
                buf = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data:")) continue;
                  const raw = line.slice(5).trim();
                  if (!raw) continue;
                  try {
                    const parsed = JSON.parse(raw);
                    const wakeEv = await inspectChannelMessages(channelId, [parsed]);
                    if (wakeEv) {
                      finish(wakeEv);
                      return;
                    }
                  } catch {}
                }
              }
            } finally {
              try {
                reader.releaseLock();
              } catch {}
            }
          } catch {
            sseConnectedChannels.delete(channelId);
            if (resolved) return;
            await sleepAbortable(2000, abortCtrl.signal);
          }
        }
        sseConnectedChannels.delete(channelId);
        activeSseChannels.delete(channelId);
      })();
    }

    let polling = false;
    async function pollOnce() {
      if (resolved || polling) return;
      polling = true;
      try {
        const mineRes = await fetchWithDeadline(
          f,
          `${baseUrl}/api/channels/mine`,
          { headers },
          requestTimeoutMs,
          abortCtrl.signal,
        );
        const channelList: Array<{ id: string; last_message_at?: string }> = [];
        const seenCh = new Set<string>();
        if (mineRes.ok) {
          const mineData = (await mineRes.json()) as { channels?: any[] };
          for (const ch of mineData.channels || []) {
            if (ch && typeof ch.id === "string" && !seenCh.has(ch.id)) {
              seenCh.add(ch.id);
              channelList.push({ id: ch.id, last_message_at: ch.last_message_at });
            }
          }
        }
        for (const extra of opts.channels ?? []) {
          if (extra && !seenCh.has(extra)) {
            seenCh.add(extra);
            channelList.push({ id: extra });
          }
        }

        // Prioritize DMs first for SSE slots, then explicit channels
        const sortedForSse = [...channelList].sort((a, b) => {
          const aDm = a.id.startsWith("dm-") ? 0 : 1;
          const bDm = b.id.startsWith("dm-") ? 0 : 1;
          return aDm - bDm;
        });
        for (const ch of sortedForSse) {
          maybeStartSse(ch.id);
        }

        for (const ch of channelList) {
          if (resolved) return;
          // Once a channel has completed its initial catch-up check and has an active SSE stream,
          // rely on the SSE listener rather than polling /messages.
          if (initialSyncedChannels.has(ch.id) && sseConnectedChannels.has(ch.id)) {
            continue;
          }
          const existingAfter = cursor.get(ch.id);
          if (existingAfter && ch.last_message_at && initialSyncedChannels.has(ch.id)) {
            const lastAtNorm = normalizeTimestampForCursor(ch.last_message_at, "after") || ch.last_message_at;
            const afterNorm = normalizeTimestampForCursor(existingAfter, "after") || existingAfter;
            if (lastAtNorm <= afterNorm) continue;
          }
          const qs = existingAfter
            ? `?after=${encodeURIComponent(existingAfter)}&limit=50`
            : `?limit=20`;
          const msgRes = await fetchWithDeadline(
            f,
            `${baseUrl}/api/channels/${encodeURIComponent(ch.id)}/messages${qs}`,
            { headers },
            requestTimeoutMs,
            abortCtrl.signal,
          );
          if (!msgRes.ok) continue;
          initialSyncedChannels.add(ch.id);
          const msgData = (await msgRes.json()) as { messages?: any[] };
          const wakeEv = await inspectChannelMessages(ch.id, msgData.messages || []);
          if (wakeEv) {
            finish(wakeEv);
            return;
          }
        }
      } catch {
        // Ignore transient network errors during poll
      } finally {
        polling = false;
      }
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const lastActiveIso = cursor.get(CURSOR_LAST_ACTIVE_KEY) || initTs;
        const nowMs = Date.parse(nowIso());
        const lastActiveMs = Date.parse(lastActiveIso);
        const elapsedMs =
          Number.isFinite(nowMs) && Number.isFinite(lastActiveMs)
            ? Math.max(timeoutMs, nowMs - lastActiveMs)
            : timeoutMs;
        if (maxIdleMs > 0 && elapsedMs >= maxIdleMs) {
          cursor.delete(CURSOR_LAST_ACTIVE_KEY);
          persistCursor(lastSeenFile, cursor, warn);
          finish({
            event: "hibernate",
            agent_id: agentId,
            timeout_ms: timeoutMs,
            idle_ms: elapsedMs,
            max_idle_ms: maxIdleMs,
            should_rearm: false,
            prompt: `[AgentsChat] 连续 ${Math.round(maxIdleMs / 60000)} 分钟无新消息，已自动停止后台续期以节省 Token。下次在网页端发送任意消息即可重新唤醒监听。`,
          });
          return;
        }
        finish({
          event: "idle_timeout",
          agent_id: agentId,
          timeout_ms: timeoutMs,
          idle_ms: elapsedMs,
          max_idle_ms: maxIdleMs,
          should_rearm: true,
        });
      }, timeoutMs);
    }

    pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    void pollOnce();
  });
}

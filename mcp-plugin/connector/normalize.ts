/**
 * Normalize an agentschat message into the relay wire `MessageEvent` shape the
 * gateway's `_event_from_wire` (gateway/relay/ws_transport.py) rebuilds.
 *
 * The gateway reads:
 *   event.text                  — the message body
 *   event.message_id            — for reply/pin/react anchors
 *   event.message_type          — "text" by default
 *   event.reply_to_message_id   — thread/reply anchor
 *   event.source.{platform,chat_id,chat_type,user_id,user_name,...} — session keys
 *
 * The single highest-correctness concern (contract §3) is the set of session
 * discriminators in `source`. agentschat models DMs as `dm-`-prefixed channel ids
 * and everything else as group channels; it has no guild/scope concept, so
 * `scope_id` is left undefined and `chat_type` is `dm` or `group`.
 */

/** A minimal agentschat message (subset of the wire frame the hub broadcasts). */
export interface AgentsChatMessage {
  id?: string;
  channel_id?: string;
  sender_id?: string;
  sender_name?: string;
  content?: string;
  timestamp?: string;
  reply_to?: string;
  mentions?: string[];
  sender_type?: string;
  content_type?: string;
  meta?: unknown;
}

/** The wire MessageEvent the gateway rebuilds (only the fields it reads). */
export interface WireEvent {
  text: string;
  message_type: string;
  message_id?: string;
  reply_to_message_id?: string;
  /**
   * Surrounding channel context (the "since you were last addressed" window the
   * connector attaches on @-mentions). Upstream `_render_relay_context` renders
   * it into the event's channel_context: oldest→newest `{text, source:{user_name
   * |user_id}}` items. Absent on DMs and when there's nothing worth attaching.
   */
  context?: Array<{ text: string; source?: { user_name?: string; user_id?: string } }>;
  source: {
    platform: string;
    chat_id: string;
    chat_type: "dm" | "group";
    chat_name?: string | null;
    user_id?: string;
    user_name?: string;
    thread_id?: string | null;
    scope_id?: string;
  };
}

/**
 * Convert one agentschat message to a wire event, or null when the message must
 * not become an agent turn (typing placeholder, or no channel to key a session on).
 */
export function toWireEvent(msg: AgentsChatMessage, platform = "agentschat"): WireEvent | null {
  const content = msg.content ?? "";
  if (content === "__typing__") return null;

  const chatId = msg.channel_id ?? "";
  if (!chatId) return null;

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
      thread_id: null,
      // scope_id intentionally omitted: agentschat has no guild/scope concept.
    },
  };
}


export interface ServerLoopTick {
  kind: "loop_tick";
  loop_id: string;
  prompt: string;
  interval_ms: number;
  next_tick_ms: number;
  expires_at: null;
}

/** Shape check only. Delivery must additionally verify the bot's live server record. */
export function serverLoopTick(msg: AgentsChatMessage): ServerLoopTick | null {
  const meta = msg.meta as Partial<ServerLoopTick> | undefined;
  if (!meta || meta.kind !== "loop_tick" ||
    typeof msg.id !== "string" || !msg.id || typeof msg.channel_id !== "string" || !msg.channel_id ||
    typeof msg.sender_id !== "string" || !msg.sender_id || msg.sender_type !== "agent" || msg.content_type !== "text" ||
    typeof msg.timestamp !== "string" || !Number.isFinite(Date.parse(msg.timestamp)) ||
    typeof meta.loop_id !== "string" || !/^loop_[a-zA-Z0-9_-]+$/.test(meta.loop_id) ||
    typeof meta.prompt !== "string" || !meta.prompt.trim() || meta.prompt.length > 4000 ||
    !Number.isSafeInteger(meta.interval_ms) || meta.interval_ms! < 60_000 || meta.interval_ms! > 86_400_000 ||
    !Number.isSafeInteger(meta.next_tick_ms) || meta.next_tick_ms! <= meta.interval_ms! || meta.expires_at !== null ||
    msg.content !== `(loop tick — ${meta.prompt})`) return null;
  return meta as ServerLoopTick;
}

/** The caller-scoped authenticated /api/loops/mine response is the authority. */
export function matchesLiveLoop(msg: AgentsChatMessage, agentId: string, response: unknown): boolean {
  const tick = serverLoopTick(msg);
  if (!tick || msg.sender_id !== agentId) return false;
  const rows = (response as {loops?: any[]})?.loops;
  if (!Array.isArray(rows)) return false;
  const matches = rows.filter(row => row?.loop_id === tick.loop_id);
  if (matches.length !== 1) return false;
  const row = matches[0];
  return row.status === "active" && row.channel_id === msg.channel_id && row.prompt === tick.prompt &&
    row.interval_ms === tick.interval_ms && row.next_tick_ms === tick.next_tick_ms && row.expires_at === null &&
    (row.mode === undefined || row.mode === "static") &&
    Number.isSafeInteger(row.last_tick_at) && row.last_tick_at > 0 &&
    row.last_tick_at + row.interval_ms === row.next_tick_ms;
}

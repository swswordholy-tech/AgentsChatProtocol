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

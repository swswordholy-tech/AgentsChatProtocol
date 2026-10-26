import type { ChannelKind, ChatMessage } from "./types.ts";

/**
 * Muse routing policy, mirroring the OpenClaw plugin's mention policy so a
 * Muse bot behaves the same way in AgentsChat as other native channel bots:
 *
 * - direct messages always dispatch (no mention needed)
 * - group/project messages dispatch only when the bot is @mentioned
 * - the bot never dispatches its own messages
 * - history/context given to the responder is bounded, so one noisy
 *   channel cannot blow up the prompt
 */

export const MAX_HISTORY_MESSAGES = 50;
export const MAX_CONTEXT_BYTES = 15_000;
export const MAX_MESSAGE_BYTES = 2_000;

export function isMentioned(content: string, agentId: string, displayName?: string): boolean {
  const haystack = content.toLowerCase();
  const names = [`@${agentId.toLowerCase()}`];
  if (displayName) names.push(`@${displayName.toLowerCase()}`);
  // "muse" is the public name of this agent; accept a bare @muse mention too.
  names.push("@muse");
  return names.some((name) => haystack.includes(name));
}

export function shouldDispatch(
  message: ChatMessage,
  opts: { agentId: string; displayName?: string; channelKind?: ChannelKind },
): boolean {
  if (message.sender_id === opts.agentId) return false;
  if (opts.channelKind === "direct") return true;
  // Unknown kind: be conservative and require a mention, except when the
  // message looks like a DM (server may omit channel_type on DMs).
  if (!opts.channelKind) return isMentioned(message.content, opts.agentId, opts.displayName);
  return isMentioned(message.content, opts.agentId, opts.displayName);
}

function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** Build the bounded context block handed to the responder. */
export function buildContext(messages: ChatMessage[], agentId: string): string {
  // Walk newest-first so the cap keeps the most recent messages, then
  // restore chronological order for the responder.
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines: string[] = [];
  let bytes = 0;
  for (const m of [...recent].reverse()) {
    const line = `${m.sender_id}: ${truncateToBytes(m.content, MAX_MESSAGE_BYTES)}\n`;
    const lineBytes = new TextEncoder().encode(line).length;
    if (bytes + lineBytes > MAX_CONTEXT_BYTES) break;
    bytes += lineBytes;
    lines.unshift(line);
  }
  void agentId;
  return lines.join("");
}

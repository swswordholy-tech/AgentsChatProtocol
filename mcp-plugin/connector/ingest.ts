import { MessageDedup, messageDedupKey } from "../src/dedup.ts";
import { serverLoopTick, type AgentsChatMessage } from "./normalize.ts";

export type IngestIdentity = { botId: string; agentId: string };

export type IngestFrame = AgentsChatMessage;

/**
 * Ingest one live/backfill AgentsChat frame for a connector identity.
 *
 * Cursors are per-identity; MessageDedup in the connector is process-global
 * across multiplex bots. Always advance THIS identity's cursor before consulting
 * dedup so a message already seen by another bot cannot freeze this bot's
 * reconnect watermark (the stuck `backfill …: N missed` loop).
 *
 * Returns whether the caller should broadcast to the gateway (first global
 * sighting, excluding self-sends and typing).
 */
export function ingestAgentsChatFrame(
  id: IngestIdentity,
  frame: IngestFrame,
  deps: {
    advanceCursor: (id: IngestIdentity, channelId: string | undefined, timestamp: string | undefined) => void;
    dedup: MessageDedup;
  },
): boolean {
  if (frame.content !== "__typing__") {
    deps.advanceCursor(id, frame.channel_id, frame.timestamp);
  }
  const key = messageDedupKey(frame as { id?: string; channel_id?: string });
  const isDm = frame.channel_id?.startsWith("dm-");
  const scopedKey = key && (isDm ? JSON.stringify([id.botId, frame.channel_id, frame.id]) : key);
  if (scopedKey && deps.dedup.recordOrSkip(scopedKey)) return false;
  // Group fanout must filter self per TARGET, not per arrival socket: A can
  // mention B, and A's self echo may be the first copy of the shared message.
  if ((frame.meta as any)?.kind === "loop_tick") {
    // Preserve candidates for authenticated live-record verification in server.ts.
    // Group copies may arrive on another identity's subscription first.
    return !!serverLoopTick(frame) && (!isDm || frame.sender_id === id.agentId);
  }
  return (!isDm || frame.sender_id !== id.agentId) && frame.content !== "__typing__";
}

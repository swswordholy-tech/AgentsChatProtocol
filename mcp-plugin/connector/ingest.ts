import { MessageDedup, messageDedupKey } from "../src/dedup.ts";

export type IngestIdentity = { botId: string; agentId: string };

export type IngestFrame = {
  id?: string;
  channel_id?: string;
  timestamp?: string;
  content?: string;
  sender_id?: string;
};

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
  if (key && deps.dedup.recordOrSkip(key)) return false;
  return frame.sender_id !== id.agentId && frame.content !== "__typing__";
}

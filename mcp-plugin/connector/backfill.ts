/**
 * Reconnect backfill plan — same contract as MCP Task #119:
 *   empty cursor → seed from newest, do NOT replay (hours-old DMs/@s are not live)
 *   existing cursor → replay messages strictly after it, oldest first
 *
 * Timestamp comparison uses the same padded-ISO cursor as the MCP path so
 * lexical `>` matches chronology (whole-second vs fractional).
 */
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

export type BackfillMsg = {
  id?: string;
  timestamp?: string;
  sender_id?: string;
  content?: string;
  channel_id?: string;
};

export function planBackfill(
  after: string | undefined,
  msgs: BackfillMsg[],
  agentId: string,
): { seed?: string; replay: BackfillMsg[] } {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!after) {
    let newest = "";
    for (const m of list) {
      const t = String(m?.timestamp || "");
      if (t > newest) newest = t;
    }
    return newest ? { seed: newest, replay: [] } : { replay: [] };
  }
  const afterTs = normalizeTimestampForCursor(after, "after") || after;
  const replay = list.filter((m) => {
    if (!m || m.sender_id === agentId || m.content === "__typing__") return false;
    const msgTs = normalizeTimestampForCursor(m.timestamp, "after");
    return typeof msgTs === "string" && msgTs > afterTs;
  });
  replay.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return { replay };
}

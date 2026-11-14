/**
 * Reconnect backfill plan — same contract as MCP Task #119:
 *   empty cursor → seed from newest, do NOT replay (hours-old DMs/@s are not live)
 *   existing cursor → replay messages strictly after it, oldest first
 *
 * Timestamp comparison uses the same padded-ISO cursor as the MCP path so
 * lexical `>` matches chronology (whole-second vs fractional).
 */
import { join } from "node:path";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";
import { serverLoopTick, type AgentsChatMessage } from "./normalize.ts";

export type BackfillMsg = AgentsChatMessage;

function compareNormalizedTimestamps(aRaw: unknown, bRaw: unknown): number {
  const aStr = String(aRaw ?? "");
  const bStr = String(bRaw ?? "");
  const aNorm = normalizeTimestampForCursor(aStr, "after") || aStr;
  const bNorm = normalizeTimestampForCursor(bStr, "after") || bStr;
  return aNorm < bNorm ? -1 : aNorm > bNorm ? 1 : 0;
}

export function planBackfill(
  after: string | undefined,
  msgs: BackfillMsg[],
  agentId: string,
): { seed?: string; replay: BackfillMsg[] } {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!after) {
    let newestRaw = "";
    let newestNorm = "";
    for (const m of list) {
      if (!m || m.content === "__typing__") continue;
      const raw = String(m.timestamp || "");
      if (!raw) continue;
      const norm = normalizeTimestampForCursor(raw, "after") || raw;
      if (norm > newestNorm) {
        newestNorm = norm;
        newestRaw = raw;
      }
    }
    return newestRaw ? { seed: newestRaw, replay: [] } : { replay: [] };
  }
  const afterTs = normalizeTimestampForCursor(after, "after") || after;
  const replay = list.filter((m) => {
    if (!m || m.content === "__typing__") return false;
    if (m.sender_id === agentId && !serverLoopTick(m)) return false;
    const msgTs = normalizeTimestampForCursor(m.timestamp, "after");
    return typeof msgTs === "string" && msgTs > afterTs;
  });
  replay.sort((a, b) => compareNormalizedTimestamps(a.timestamp, b.timestamp));
  return { replay };
}

/**
 * Select up to 10 chronological channel context messages strictly after `sinceTs`
 * (excluding typing placeholders and `excludeId`), using padded ISO comparison so
 * whole-second (`...Z`) and fractional (`....500Z`) timestamps never invert order.
 */
export function selectChannelContextMessages(
  msgs: BackfillMsg[],
  sinceTs?: string,
  excludeId?: string,
): BackfillMsg[] {
  const list = Array.isArray(msgs) ? msgs : [];
  const filtered = list
    .filter((m) => m?.content && m.content !== "__typing__" && (!excludeId || m?.id !== excludeId))
    .sort((a, b) => compareNormalizedTimestamps(a.timestamp, b.timestamp));
  if (!sinceTs) return filtered.slice(-10);
  const normSince = normalizeTimestampForCursor(sinceTs, "after") || sinceTs;
  return filtered
    .filter((m) => {
      const raw = String(m.timestamp ?? "");
      const norm = normalizeTimestampForCursor(raw, "after") || raw;
      return norm > normSince;
    })
    .slice(-10);
}

/**
 * Sanitize `botId` when building per-bot cursor filenames so path separators,
 * `..` traversal segments, or Windows-invalid filename characters cannot escape
 * `cursorDir` or fail persistence while keeping standard agent IDs unchanged.
 */
export function safeCursorBotFile(cursorDir: string, botId: string): string {
  const cleaned = String(botId || "default")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_");
  const safeId = cleaned && cleaned !== "." ? cleaned.slice(0, 128) : "default";
  return join(cursorDir, `last-seen-msg-ts-${safeId}.json`);
}

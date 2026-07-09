/**
 * Persistence of the per-agent read cursor (`last-seen-msg-ts-<agent>.json`).
 *
 * This is a state change, not best-effort teardown — it just happens to be *called*
 * from teardown. Losing it silently means the next start reads a stale last-seen value
 * and either replays messages or, worse, SKIPS them (the cursor-gap class).
 *
 * Two defects this module exists to prevent:
 *  - The old writer swallowed its write error in a bare `catch {}` and returned normally,
 *    so callers could not tell a failed flush from a successful one.
 *  - The old flush cleared the dirty flag BEFORE writing. A failed write therefore both
 *    discarded the cursor and disabled its own retry: the shutdown fallback flush sees
 *    `dirty === false` and returns immediately. One failure = permanent silent loss.
 *
 * So: the write reports success, and the dirty flag is cleared ONLY once it lands.
 */
import { writeFileSync } from "fs";

export type Warn = (message: string) => void;

/** Write the cursor to disk. Returns true iff it actually landed. Never throws. */
export function persistCursor(file: string, cursor: Map<string, string>, warn: Warn): boolean {
  try {
    writeFileSync(file, JSON.stringify(Object.fromEntries(cursor)));
    return true;
  } catch (e) {
    warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: ${e}\n`);
    return false;
  }
}

/**
 * Flush state machine. Clears `dirty` only after `persist()` reports success, so a
 * failed write stays dirty and the next flush (including the shutdown fallback) retries.
 * Returns true iff the cursor was persisted.
 */
export function flushCursor(state: { dirty: boolean }, persist: () => boolean): boolean {
  if (!state.dirty) return false;
  const ok = persist();
  if (ok) state.dirty = false;
  return ok;
}

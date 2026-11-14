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
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";

export type Warn = (message: string) => void;

let tmpCounter = 0;

/**
 * Read a persisted channel→timestamp map.
 *
 * A missing file is the normal first-run case and stays quiet. Anything else — corrupt
 * JSON, non-object JSON, non-string values, bad permissions — means we are resetting state
 * we were supposed to remember, and this runs ONCE at startup: warn loudly.
 */
export function loadCursor(file: string, warn: Warn): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor root must be a JSON object");
    }
    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new Error(`cursor value for ${k} must be a string`);
      }
      entries.push([k, v]);
    }
    return new Map(entries);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: could not read ${file} — resetting that state: ${e}\n`);
    }
    return new Map();
  }
}

/** Write the cursor to disk atomically (0600 tmp + rename). Returns true iff it actually landed. Never throws. */
export function persistCursor(file: string, cursor: Map<string, string>, warn: Warn): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpCounter}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cursor)), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup error */
    }
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

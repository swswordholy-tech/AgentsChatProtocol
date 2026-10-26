/**
 * Message de-duplication for the live-WS + reconnect-backfill race.
 *
 * The same message can arrive twice: once on the live socket and once via the
 * reconnect backfill REST replay. This Set-backed dedup is the sole guard that
 * keeps Claude Code from being notified twice. Extracted from server.ts so the
 * key derivation and the bounded eviction can be unit-tested directly.
 */

/** Stable identity for a message frame, or null if it lacks string id/channel. */
export function messageDedupKey(data: any): string | null {
  if (!data || typeof data.id !== "string" || typeof data.channel_id !== "string") return null;
  return `${data.channel_id}:${data.id}`;
}

export class MessageDedup {
  private seen = new Set<string>();

  constructor(
    /** Evict once the set grows past this many keys. */
    private readonly max: number = 5000,
    /** How many oldest keys to drop on eviction (Set preserves insertion order). */
    private readonly dropOnEvict: number = 1000,
  ) {}

  /** Returns true if `key` was already delivered (skip), false if newly recorded. */
  recordOrSkip(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const arr = [...this.seen];
      this.seen.clear();
      for (const item of arr.slice(this.dropOnEvict)) this.seen.add(item);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

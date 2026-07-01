/**
 * Reconnect backoff timing.
 *
 * Exponential-ish delay capped at 30s plus up to 3s of jitter so a fleet of
 * agents doesn't reconnect in a thundering herd. Capping matters: without the
 * min() a long outage would push each successive reconnect unboundedly far out.
 * Extracted from ws.onclose so the cap and jitter bound can be unit-tested.
 */
export function computeReconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const jitter = rand() * 3000; // 0–3s
  return Math.min(attempt * 2, 30) * 1000 + jitter;
}

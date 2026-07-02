/**
 * Normalize an ISO-8601 timestamp for lexical cursor comparison.
 *
 * The reconnect backfill compares timestamps as strings (`msgTs > afterTs`).
 * For that to match chronological order, fractional seconds must be padded to a
 * fixed 9 digits — AND whole-second timestamps (no fractional part) must also
 * get a fraction, otherwise "…00.123000000Z" and "…00Z" of the same second sort
 * wrong because '.' (0x2E) < 'Z' (0x5A), inverting the boundary comparison.
 *
 * mode "after" pads with 0 (floor of the second — for the strictly-after cursor);
 * mode "before" pads with 9 (ceil of the second).
 *
 * Extracted from server.ts so it can be unit-tested without loading the
 * side-effecting server entrypoint.
 */
export function normalizeTimestampForCursor(
  ts: string | undefined,
  mode: "before" | "after",
): string | undefined {
  if (!ts || typeof ts !== "string") return ts;
  const padChar = mode === "before" ? "9" : "0";

  // Has a fractional part: pad it to 9 digits.
  const withFrac = ts.match(/^(.*\.)(\d+)(Z)$/);
  if (withFrac) {
    const frac = withFrac[2];
    if (frac.length >= 9) return ts;
    return withFrac[1] + frac + padChar.repeat(9 - frac.length) + withFrac[3];
  }

  // Whole-second timestamp: insert a 9-digit fraction so it sorts consistently
  // against fractional timestamps of the same second.
  const noFrac = ts.match(/^(.*\d)(Z)$/);
  if (noFrac) {
    return noFrac[1] + "." + padChar.repeat(9) + noFrac[2];
  }

  return ts;
}

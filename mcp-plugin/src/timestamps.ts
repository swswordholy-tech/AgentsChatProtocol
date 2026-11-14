/**
 * Normalize an ISO-8601 timestamp for lexical cursor comparison.
 *
 * The reconnect backfill compares timestamps as strings (`msgTs > afterTs`).
 * For that to match chronological order:
 * 1. Non-UTC numeric offsets (`+08:00`, `-05:00`) and lowercase `z` are converted
 *    to canonical UTC `YYYY-MM-DDTHH:mm:ss.<9digits>Z` without losing sub-millisecond
 *    fractional precision;
 * 2. Fractional seconds are padded (`0` for `"after"`, `9` for `"before"`) OR
 *    truncated (`>9` digits → 9 digits) to a fixed 9 digits, including whole-second
 *    timestamps, so `'.'` (0x2E) < `'Z'` (0x5A) never inverts ordering.
 */
const ISO_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:\d{2})$/;

export function normalizeTimestampForCursor(
  ts: string | undefined,
  mode: "before" | "after",
): string | undefined {
  if (!ts || typeof ts !== "string") return ts;
  const padChar = mode === "before" ? "9" : "0";

  const m = ts.match(ISO_OFFSET_RE);
  if (m) {
    const datePart = m[1]!;
    const timePart = m[2]!;
    const rawFrac = m[3] ?? "";
    const tzPart = m[4]!;
    const frac9 =
      rawFrac.length === 9
        ? rawFrac
        : rawFrac.length > 9
          ? rawFrac.slice(0, 9)
          : rawFrac + padChar.repeat(9 - rawFrac.length);

    if (tzPart === "Z" || tzPart === "z") {
      return `${datePart}T${timePart}.${frac9}Z`;
    }

    const wholeUtcMs = Date.parse(`${datePart}T${timePart}${tzPart}`);
    if (Number.isFinite(wholeUtcMs)) {
      const utcWhole = new Date(wholeUtcMs).toISOString().slice(0, 19);
      return `${utcWhole}.${frac9}Z`;
    }
  }

  return ts;
}

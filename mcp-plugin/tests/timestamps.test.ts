// Unit tests for normalizeTimestampForCursor (src/timestamps.ts) — makes the
// backfill string-cursor comparison match chronological order. Run: bun test.
import { test, expect } from "bun:test";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

test("pads a fractional timestamp to 9 digits (after → 0, before → 9)", () => {
  expect(normalizeTimestampForCursor("2026-04-15T10:00:00.123Z", "after")).toBe(
    "2026-04-15T10:00:00.123000000Z",
  );
  expect(normalizeTimestampForCursor("2026-04-15T10:00:00.123Z", "before")).toBe(
    "2026-04-15T10:00:00.123999999Z",
  );
});

test("a whole-second timestamp gets a 9-digit fraction (the fix)", () => {
  expect(normalizeTimestampForCursor("2026-04-15T10:00:00Z", "after")).toBe(
    "2026-04-15T10:00:00.000000000Z",
  );
  expect(normalizeTimestampForCursor("2026-04-15T10:00:00Z", "before")).toBe(
    "2026-04-15T10:00:00.999999999Z",
  );
});

test("whole-second vs fractional of the same second now sort chronologically", () => {
  const whole = normalizeTimestampForCursor("2026-04-15T10:00:00Z", "after")!;
  const frac = normalizeTimestampForCursor("2026-04-15T10:00:00.123Z", "after")!;
  // whole second (.000000000) must sort BEFORE the .123 message — the exact
  // ordering that broke before the fix ('.' < 'Z' made "…00Z" sort after).
  expect(whole < frac).toBe(true);
});

test("an already-9-digit fraction is returned unchanged", () => {
  const t = "2026-04-15T10:00:00.123456789Z";
  expect(normalizeTimestampForCursor(t, "after")).toBe(t);
});

test("non-string / non-ISO input is passed through untouched", () => {
  expect(normalizeTimestampForCursor(undefined, "after")).toBe(undefined);
  expect(normalizeTimestampForCursor("not-a-timestamp", "after")).toBe("not-a-timestamp");
});

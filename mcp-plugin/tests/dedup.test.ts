// Unit tests for message de-duplication (src/dedup.ts) — the sole guard against
// double-notifying on the live-WS + reconnect-backfill race. Run with `bun test`.
import { test, expect } from "bun:test";
import { messageDedupKey, MessageDedup } from "../src/dedup.ts";

test("messageDedupKey combines channel_id and id", () => {
  expect(messageDedupKey({ channel_id: "room-1", id: "m-9" })).toBe("room-1:m-9");
});

test("messageDedupKey is null for non-string id/channel or missing data", () => {
  expect(messageDedupKey({ channel_id: "room-1" })).toBe(null);
  expect(messageDedupKey({ id: "m-9" })).toBe(null);
  expect(messageDedupKey({ channel_id: 1, id: "m-9" })).toBe(null);
  expect(messageDedupKey(null)).toBe(null);
});

test("recordOrSkip: first delivery false, duplicate true regardless of source", () => {
  const d = new MessageDedup();
  expect(d.recordOrSkip("room-1:m-1")).toBe(false); // first time → record, deliver
  expect(d.recordOrSkip("room-1:m-1")).toBe(true); // seen → skip
  expect(d.recordOrSkip("room-1:m-2")).toBe(false); // different key
});

test("eviction drops the oldest keys and keeps the newest", () => {
  // max=5, drop 2 oldest on overflow.
  const d = new MessageDedup(5, 2);
  for (const k of ["k1", "k2", "k3", "k4", "k5"]) expect(d.recordOrSkip(k)).toBe(false);
  expect(d.size).toBe(5);
  // 6th push overflows (size 6 > 5) → evict oldest 2 (k1,k2), keep k3..k6
  expect(d.recordOrSkip("k6")).toBe(false);
  expect(d.size).toBe(4);
  // k1/k2 were evicted → re-recordable (not "seen")
  expect(d.recordOrSkip("k1")).toBe(false);
  // k4 survived → still deduped
  expect(d.recordOrSkip("k4")).toBe(true);
});

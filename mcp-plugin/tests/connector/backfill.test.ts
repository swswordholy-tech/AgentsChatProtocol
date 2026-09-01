import { describe, expect, test } from "bun:test";
import { planBackfill } from "../../connector/backfill.ts";

const A = "agent-a";
const msgs = [
  { id: "1", timestamp: "2026-09-01T10:00:00Z", sender_id: "human", content: "old" },
  { id: "2", timestamp: "2026-09-01T10:00:00.500Z", sender_id: A, content: "self" },
  { id: "3", timestamp: "2026-09-01T10:00:01Z", sender_id: "human", content: "@agent-a hi" },
  { id: "4", timestamp: "2026-09-01T10:00:02Z", sender_id: "human", content: "__typing__" },
  { id: "5", timestamp: "2026-09-01T10:00:03Z", sender_id: "human", content: "newest" },
];

describe("planBackfill — MCP Task #119 contract", () => {
  test("empty cursor seeds from newest and does not replay", () => {
    const r = planBackfill(undefined, msgs, A);
    expect(r.seed).toBe("2026-09-01T10:00:03Z");
    expect(r.replay).toEqual([]);
  });

  test("empty cursor with no messages neither seeds nor replays", () => {
    expect(planBackfill(undefined, [], A)).toEqual({ replay: [] });
  });

  test("existing cursor replays strictly after it, skipping self and typing", () => {
    const r = planBackfill("2026-09-01T10:00:00Z", msgs, A);
    expect(r.seed).toBeUndefined();
    expect(r.replay.map((m) => m.id)).toEqual(["3", "5"]);
  });

  test("fractional cursor does not skip a later whole-second message", () => {
    const r = planBackfill("2026-09-01T10:00:00.123Z", [
      { id: "a", timestamp: "2026-09-01T10:00:00Z", sender_id: "human", content: "same-second-earlier" },
      { id: "b", timestamp: "2026-09-01T10:00:01Z", sender_id: "human", content: "next" },
    ], A);
    expect(r.replay.map((m) => m.id)).toEqual(["b"]);
  });
});

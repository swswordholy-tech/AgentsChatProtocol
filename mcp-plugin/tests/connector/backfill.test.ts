import { describe, expect, test } from "bun:test";
import { planBackfill, safeCursorBotFile, selectChannelContextMessages } from "../../connector/backfill.ts";

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

  test("empty cursor seeds fractional timestamp over earlier whole-second timestamp and ignores typing", () => {
    const r = planBackfill(undefined, [
      { id: "whole", timestamp: "2026-09-01T10:00:00Z", sender_id: "human", content: "earlier" },
      { id: "frac", timestamp: "2026-09-01T10:00:00.500Z", sender_id: "human", content: "later-same-second" },
      { id: "typing", timestamp: "2026-09-01T10:00:09Z", sender_id: "human", content: "__typing__" },
    ], A);
    expect(r.seed).toBe("2026-09-01T10:00:00.500Z");
    expect(r.replay).toEqual([]);
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

  test("replay sort preserves chronological order across whole-second and fractional timestamps", () => {
    const r = planBackfill("2026-09-01T09:59:59Z", [
      { id: "later-frac", timestamp: "2026-09-01T10:00:01.500Z", sender_id: "human", content: "second" },
      { id: "earlier-whole", timestamp: "2026-09-01T10:00:01Z", sender_id: "human", content: "first" },
    ], A);
    expect(r.replay.map((m) => m.id)).toEqual(["earlier-whole", "later-frac"]);
  });
});

describe("selectChannelContextMessages & safeCursorBotFile", () => {
  test("whole-second sinceTs includes later fractional-second context messages in chronological order", () => {
    const selected = selectChannelContextMessages(
      [
        { id: "m0", timestamp: "2026-09-01T10:00:00Z", sender_id: "u1", content: "addressed-at" },
        { id: "m2", timestamp: "2026-09-01T10:00:01.250Z", sender_id: "u2", content: "third" },
        { id: "m1", timestamp: "2026-09-01T10:00:00.250Z", sender_id: "u2", content: "first-after-whole" },
        { id: "m1b", timestamp: "2026-09-01T10:00:01Z", sender_id: "u3", content: "second" },
        { id: "trig", timestamp: "2026-09-01T10:00:02Z", sender_id: "u1", content: "@agent-a go" },
      ],
      "2026-09-01T10:00:00Z",
      "trig",
    );
    expect(selected.map((m) => m.id)).toEqual(["m1", "m1b", "m2"]);
  });

  test("fractional sinceTs excludes earlier whole-second message in the same second", () => {
    const selected = selectChannelContextMessages(
      [
        { id: "earlier", timestamp: "2026-09-01T10:00:00Z", sender_id: "u1", content: "already-seen" },
        { id: "later", timestamp: "2026-09-01T10:00:00.750Z", sender_id: "u2", content: "new-msg" },
      ],
      "2026-09-01T10:00:00.250Z",
    );
    expect(selected.map((m) => m.id)).toEqual(["later"]);
  });

  test("safeCursorBotFile preserves normal IDs while neutralizing traversal and invalid characters", () => {
    expect(safeCursorBotFile("/tmp/cursors", "agent-a_1.bot")).toBe("/tmp/cursors/last-seen-msg-ts-agent-a_1.bot.json");
    const escaped = safeCursorBotFile("/tmp/cursors", "../../etc/passwd:bad*?");
    expect(escaped.startsWith("/tmp/cursors/last-seen-msg-ts-")).toBe(true);
    expect(escaped.includes("..")).toBe(false);
    expect(escaped.includes("/etc/")).toBe(false);
  });
});

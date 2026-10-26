/**
 * Normalize an agentschat message into the relay wire MessageEvent the gateway's
 * `_event_from_wire` rebuilds. The gateway reads `event.source` for the session
 * discriminators and `event.text`/`message_id`/`reply_to_message_id` for content.
 *
 * Highest-correctness concern (contract §3): the session discriminators.
 * agentschat has DMs (`dm-` prefixed channel ids) and group channels; there is no
 * guild/scope concept, so `scope_id` stays undefined and `chat_type` is `dm`/`group`.
 */
import { describe, expect, test } from "bun:test";
import { toWireEvent, type WireEvent } from "../../connector/normalize.ts";

/** toWireEvent returns WireEvent | null; these tests assert the non-null cases. */
function must(msg: Parameters<typeof toWireEvent>[0]): WireEvent {
  const e = toWireEvent(msg, "agentschat");
  if (!e) throw new Error("expected a wire event, got null");
  return e;
}

const base = {
  id: "msg-1",
  channel_id: "welcome",
  sender_id: "human-1",
  sender_name: "Alice",
  content: "hello bot",
  timestamp: "2026-08-21T10:00:00.000Z",
};

describe("toWireEvent — source discriminators", () => {
  test("platform matches the descriptor's platform", () => {
    const e = must(base);
    expect(e.source.platform).toBe("agentschat");
  });

  test("a group channel maps to chat_type group", () => {
    const e = must(base);
    expect(e.source.chat_id).toBe("welcome");
    expect(e.source.chat_type).toBe("group");
  });

  test("a dm- prefixed channel maps to chat_type dm", () => {
    const e = must({ ...base, channel_id: "dm-abc123" });
    expect(e.source.chat_type).toBe("dm");
    expect(e.source.chat_id).toBe("dm-abc123");
  });

  test("carries the authentic author identity", () => {
    const e = must(base);
    expect(e.source.user_id).toBe("human-1");
    expect(e.source.user_name).toBe("Alice");
  });

  test("no scope/guild concept — scope_id is absent, not a wrong value", () => {
    const e = must(base);
    expect(e.source.scope_id).toBeUndefined();
  });
});

describe("toWireEvent — content + identity of the message itself", () => {
  test("text comes from content, message_id from id", () => {
    const e = must(base);
    expect(e.text).toBe("hello bot");
    expect(e.message_id).toBe("msg-1");
    expect(e.message_type).toBe("text");
  });

  test("a reply carries reply_to_message_id", () => {
    const e = must({ ...base, reply_to: "msg-0" });
    expect(e.reply_to_message_id).toBe("msg-0");
  });

  test("typing placeholders never become an event (returns null)", () => {
    expect(toWireEvent({ ...base, content: "__typing__" }, "agentschat")).toBeNull();
  });

  test("messages with no channel produce no event (fail closed, not a bogus session)", () => {
    expect(toWireEvent({ ...base, channel_id: "" }, "agentschat")).toBeNull();
  });
});

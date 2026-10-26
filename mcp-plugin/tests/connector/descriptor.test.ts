/**
 * CapabilityDescriptor for the agentschat connector, mirroring the gateway's
 * `gateway/relay/descriptor.py`. The gateway reads `frame.descriptor` at handshake
 * via `CapabilityDescriptor.from_json` (which ignores unknown keys, defaults
 * missing optionals, and normalizes degenerate `max_message_length` to 4096).
 *
 * For a single-tenant agentschat connector the honest capability set is narrow:
 * send + typing + get_chat_info. Declaring an op we don't implement is how a
 * gateway ends up calling into a black hole, so `supported_ops` must be exact.
 */
import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, buildDescriptor, type CapabilityDescriptor } from "../../connector/descriptor.ts";

describe("buildDescriptor — matches the gateway's expected schema", () => {
  const d = buildDescriptor();

  test("carries the additive contract version 1", () => {
    expect(d.contract_version).toBe(CONTRACT_VERSION);
    expect(CONTRACT_VERSION).toBe(1);
  });

  test("identifies the fronted platform as agentschat", () => {
    expect(d.platform).toBe("agentschat");
    expect(d.label).toBeTruthy();
  });

  test("honest char limit (agentschat caps ~4000)", () => {
    expect(d.max_message_length).toBe(4000);
  });

  test("len_unit is chars (not Telegram's utf16)", () => {
    expect(d.len_unit).toBe("chars");
  });

  test("does NOT advertise capabilities agentschat lacks", () => {
    expect(d.supports_draft_streaming).toBe(false);
    expect(d.supports_edit).toBe(false);
    expect(d.supports_threads).toBe(false);
  });

  test("supported_ops is exactly what the connector implements", () => {
    // MVP: send + typing + get_chat_info. Nothing more. An op listed here that we
    // don't handle is a gateway calling into a black hole.
    expect([...d.supported_ops].sort()).toEqual(["get_chat_info", "send", "typing"]);
  });

  test("markdown_dialect is set (gateway uses it for code-block support)", () => {
    expect(d.markdown_dialect).toBe("markdown");
  });
});

describe("descriptor is JSON-round-trippable through the gateway's from_json semantics", () => {
  test("serializes to a JSON object with the required keys", () => {
    const d = buildDescriptor();
    const parsed = JSON.parse(JSON.stringify(d));
    for (const k of [
      "contract_version", "platform", "label", "max_message_length",
      "supports_draft_streaming", "supports_edit", "supports_threads",
      "markdown_dialect", "len_unit",
    ]) {
      expect(parsed).toHaveProperty(k);
    }
  });

  test("supported_ops serializes as a JSON array (not a tuple/undefined)", () => {
    const parsed = JSON.parse(JSON.stringify(buildDescriptor()));
    expect(Array.isArray(parsed.supported_ops)).toBe(true);
    expect(parsed.supported_ops.length).toBeGreaterThan(0);
  });
});

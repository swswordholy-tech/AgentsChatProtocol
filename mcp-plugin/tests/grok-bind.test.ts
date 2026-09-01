import { describe, expect, test } from "bun:test";
import {
  decideGrokBind,
  parseGrokBinds,
  parseGrokBindsText,
  resolveGrokBindsPath,
} from "../src/grok-bind.ts";

describe("parseGrokBinds — uuid → profile name, ignore non-strings", () => {
  test("keeps string values", () => {
    expect(parseGrokBinds({ "uuid-a": "Bot-A", "uuid-b": "Bot-B" })).toEqual({
      "uuid-a": "Bot-A",
      "uuid-b": "Bot-B",
    });
  });

  test("ignores non-string values (numbers, objects, arrays, null, bools)", () => {
    expect(
      parseGrokBinds({
        good: "KeepMe",
        num: 1,
        obj: { nested: "x" },
        arr: ["Bot-A"],
        nil: null,
        flag: true,
      }),
    ).toEqual({ good: "KeepMe" });
  });

  test("ignores empty / whitespace-only names and keys", () => {
    expect(parseGrokBinds({ "": "Bot-A", "uuid-a": "  ", "  uuid-b  ": "  Bot-B  " })).toEqual({
      "uuid-b": "Bot-B",
    });
  });

  test("non-object JSON values yield an empty map", () => {
    expect(parseGrokBinds(null)).toEqual({});
    expect(parseGrokBinds("Bot-A")).toEqual({});
    expect(parseGrokBinds(["uuid-a", "Bot-A"])).toEqual({});
    expect(parseGrokBinds(12)).toEqual({});
  });
});

describe("parseGrokBindsText — malformed binds file", () => {
  test("valid JSON object", () => {
    const r = parseGrokBindsText('{"abc":"GrokBot"}');
    expect(r).toEqual({ binds: { abc: "GrokBot" }, malformed: false });
  });

  test("malformed JSON → empty map, flagged", () => {
    const r = parseGrokBindsText("{not json");
    expect(r).toEqual({ binds: {}, malformed: true });
  });

  test("JSON array is well-formed JSON but not a bind map", () => {
    const r = parseGrokBindsText('["uuid-a"]');
    expect(r).toEqual({ binds: {}, malformed: false });
  });
});

describe("resolveGrokBindsPath", () => {
  test("default is ~/.agentschat/grok-binds.json under the config dir", () => {
    expect(resolveGrokBindsPath("/home/u/.agentschat")).toBe("/home/u/.agentschat/grok-binds.json");
  });

  test("AGENTCHAT_GROK_BINDS override wins", () => {
    expect(resolveGrokBindsPath("/home/u/.agentschat", "/tmp/custom-binds.json")).toBe(
      "/tmp/custom-binds.json",
    );
  });

  test("empty override falls back to default", () => {
    expect(resolveGrokBindsPath("/home/u/.agentschat", "")).toBe("/home/u/.agentschat/grok-binds.json");
  });
});

describe("decideGrokBind", () => {
  const binds = { "uuid-a": "Bot-A", "uuid-b": "Bot-B" };

  test("bind hit", () => {
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: "uuid-a",
        binds,
      }),
    ).toEqual({ kind: "hit", conversationId: "uuid-a", profileName: "Bot-A" });
  });

  test("bind miss — conversation id set, no entry", () => {
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: "uuid-unknown",
        binds,
      }),
    ).toEqual({ kind: "miss", conversationId: "uuid-unknown" });
  });

  test("no CURSOR_CONVERSATION_ID → skip (Claude Code / Hermes: zero change)", () => {
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: undefined,
        binds,
      }),
    ).toEqual({ kind: "skip" });
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: "  ",
        binds,
      }),
    ).toEqual({ kind: "skip" });
  });

  test("explicit --profile / env identity wins over the bind map", () => {
    expect(
      decideGrokBind({
        explicitIdentity: true,
        hasToken: false,
        conversationId: "uuid-a",
        binds,
      }),
    ).toEqual({ kind: "skip" });
  });

  test("explicit --token / AGENTCHAT_TOKEN wins over the bind map", () => {
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: true,
        conversationId: "uuid-a",
        binds,
      }),
    ).toEqual({ kind: "skip" });
  });

  test("malformed/empty binds + conversation id → miss, not a hit", () => {
    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: "uuid-a",
        binds: {},
      }),
    ).toEqual({ kind: "miss", conversationId: "uuid-a" });
  });
});

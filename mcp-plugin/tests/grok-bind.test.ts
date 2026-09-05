import { describe, expect, test } from "bun:test";
import {
  boundProfileForConversation,
  decideGrokBind,
  gateSwitchProfile,
  parseGrokBinds,
  parseGrokBindsText,
  profileNameFromPath,
  resolveGrokBindsPath,
  shouldHealBoundIdentity,
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

describe("boundProfileForConversation", () => {
  const binds = { "uuid-a": "Jack", "uuid-b": "Grok_Builder" };

  test("hit → profile name", () => {
    expect(boundProfileForConversation("uuid-a", binds)).toBe("Jack");
  });

  test("miss / empty id → null", () => {
    expect(boundProfileForConversation("unknown", binds)).toBeNull();
    expect(boundProfileForConversation(undefined, binds)).toBeNull();
    expect(boundProfileForConversation("  ", binds)).toBeNull();
  });
});

describe("profileNameFromPath", () => {
  test("strips directory and .json", () => {
    expect(profileNameFromPath("/home/u/.agentschat/Jack.json")).toBe("Jack");
    expect(profileNameFromPath("Grok_Builder.json")).toBe("Grok_Builder");
  });

  test("null / empty → null", () => {
    expect(profileNameFromPath(null)).toBeNull();
    expect(profileNameFromPath(undefined)).toBeNull();
    expect(profileNameFromPath("")).toBeNull();
  });
});

describe("gateSwitchProfile — lock when grok outbound bind is active", () => {
  const binds = { "uuid-jack": "Jack", "uuid-builder": "Grok_Builder" };

  test("CURSOR unset + current not in binds → allow (Claude/Hermes)", () => {
    expect(
      gateSwitchProfile({
        conversationId: undefined,
        binds,
        requestedProfileName: "Grok_Builder",
        currentProfileName: "hermes",
      }),
    ).toEqual({ kind: "allow" });
    expect(
      gateSwitchProfile({
        conversationId: undefined,
        binds,
        requestedProfileName: "Grok_Builder",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("conversation id set but no bind hit → allow", () => {
    expect(
      gateSwitchProfile({
        conversationId: "uuid-unknown",
        binds,
        requestedProfileName: "Hermes",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("list profiles (no name) → allow even when bound", () => {
    expect(
      gateSwitchProfile({
        conversationId: "uuid-jack",
        binds,
        requestedProfileName: undefined,
      }),
    ).toEqual({ kind: "allow" });
    expect(
      gateSwitchProfile({
        conversationId: "uuid-jack",
        binds,
        requestedProfileName: "  ",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("no-op switch to already-bound profile → allow", () => {
    expect(
      gateSwitchProfile({
        conversationId: "uuid-jack",
        binds,
        requestedProfileName: "Jack",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("switch away to another Grok bot → locked", () => {
    const g = gateSwitchProfile({
      conversationId: "uuid-jack",
      binds,
      requestedProfileName: "Grok_Builder",
    });
    expect(g.kind).toBe("locked");
    if (g.kind === "locked") {
      expect(g.boundProfileName).toBe("Jack");
      expect(g.requestedProfileName).toBe("Grok_Builder");
      expect(g.message).toMatch(/locked to grok-bind/);
      expect(g.message).toMatch(/do not switch_profile/);
      expect(g.message).toMatch(/separate MCP process/);
    }
  });

  test("switch away to Hermes/Spiral → locked", () => {
    const g = gateSwitchProfile({
      conversationId: "uuid-jack",
      binds,
      requestedProfileName: "hermes",
    });
    expect(g.kind).toBe("locked");
    if (g.kind === "locked") {
      expect(g.boundProfileName).toBe("Jack");
    }
  });

  test("no conversation id + current is Jack (bound value) + request Grok_Builder → locked", () => {
    const g = gateSwitchProfile({
      conversationId: undefined,
      binds,
      requestedProfileName: "Grok_Builder",
      currentProfileName: "Jack",
    });
    expect(g.kind).toBe("locked");
    if (g.kind === "locked") {
      expect(g.boundProfileName).toBe("Jack");
      expect(g.requestedProfileName).toBe("Grok_Builder");
      expect(g.message).toMatch(/shared MCP/);
      expect(g.message).toMatch(/do not switch_profile/);
      expect(g.message).toMatch(/wake daemon/);
    }
  });

  test("no conversation + current not in binds → allow", () => {
    expect(
      gateSwitchProfile({
        conversationId: undefined,
        binds,
        requestedProfileName: "Jack",
        currentProfileName: "Spiral",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("binds empty → allow", () => {
    expect(
      gateSwitchProfile({
        conversationId: "uuid-jack",
        binds: {},
        requestedProfileName: "Grok_Builder",
        currentProfileName: "Jack",
      }),
    ).toEqual({ kind: "allow" });
  });

  test("no conversation + current Jack + no-op request Jack → allow", () => {
    expect(
      gateSwitchProfile({
        conversationId: undefined,
        binds,
        requestedProfileName: "Jack",
        currentProfileName: "Jack",
      }),
    ).toEqual({ kind: "allow" });
  });
});

describe("shouldHealBoundIdentity", () => {
  test("no bound profile → never heal", () => {
    expect(
      shouldHealBoundIdentity({
        boundProfileName: null,
        liveProfileName: "Grok_Builder",
        liveAgentId: "other",
        boundAgentId: "jack-id",
      }),
    ).toBe(false);
  });

  test("live matches bound name + agent → no heal", () => {
    expect(
      shouldHealBoundIdentity({
        boundProfileName: "Jack",
        liveProfileName: "Jack",
        liveAgentId: "jack-id",
        boundAgentId: "jack-id",
      }),
    ).toBe(false);
  });

  test("live profile name differs → heal", () => {
    expect(
      shouldHealBoundIdentity({
        boundProfileName: "Jack",
        liveProfileName: "Grok_Builder",
        liveAgentId: "builder-id",
        boundAgentId: "jack-id",
      }),
    ).toBe(true);
  });

  test("same profile name but agent id drifted → heal", () => {
    expect(
      shouldHealBoundIdentity({
        boundProfileName: "Jack",
        liveProfileName: "Jack",
        liveAgentId: "stolen-id",
        boundAgentId: "jack-id",
      }),
    ).toBe(true);
  });

  test("bound agent id missing → only name compared", () => {
    expect(
      shouldHealBoundIdentity({
        boundProfileName: "Jack",
        liveProfileName: "Jack",
        liveAgentId: "anything",
        boundAgentId: undefined,
      }),
    ).toBe(false);
  });
});

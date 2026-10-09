/**
 * Identity guard — the 2026-09-27 incident (task_muk0154j_pstaosfn): a host
 * respawn after a WS bounce silently fell from an explicit profile
 * (Antigravity-2, chevron) to the default profile (Antigravity.json, academic)
 * and evidence went out under the wrong identity. These tests pin the verdict
 * table and the record-advance rules — above all: a GATED boot must NOT advance
 * the trust record, or repeat respawns would learn the wrong identity.
 */
import { describe, expect, test } from "bun:test";
import {
  decideIdentityGuard,
  advanceGuardRecord,
  parseGuardRecord,
  emptyGuardRecord,
  type IdentityGuardRecord,
} from "../src/identity-guard.ts";

const CHEVRON = "acc_chevron";
const ACADEMIC = "acc_academic";

function recordWith(lastAgent: string, source = "flag-profile", declaredName = "Antigravity-2"): IdentityGuardRecord {
  return {
    bySelector: declaredName ? { [declaredName]: lastAgent } : {},
    lastEffective: { agentId: lastAgent, source, ...(declaredName ? { declaredName } : {}), ts: "2026-09-27T10:00:00Z" },
  };
}

describe("decideIdentityGuard — the boot-time verdict", () => {
  test("first recorded boot: ok (nothing to drift from)", () => {
    expect(decideIdentityGuard(emptyGuardRecord(), { agentId: CHEVRON, source: "default" }).kind).toBe("ok");
  });

  test("same identity as last trusted: ok, silent", () => {
    const v = decideIdentityGuard(recordWith(CHEVRON), { agentId: CHEVRON, source: "flag-profile", declaredName: "Antigravity-2" });
    expect(v.kind).toBe("ok");
  });

  test("THE INCIDENT: explicit identity lost → default profile resolves a DIFFERENT identity → gate", () => {
    const v = decideIdentityGuard(recordWith(CHEVRON), { agentId: ACADEMIC, source: "default" });
    expect(v.kind).toBe("gate");
    if (v.kind === "gate") {
      expect(v.message).toContain(CHEVRON);
      expect(v.message).toContain(ACADEMIC);
      expect(v.message).toMatch(/whoami/);
    }
  });

  test("a previous default → a different default also gates (any silent default swap)", () => {
    const prev = recordWith(ACADEMIC, "default", "");
    const v = decideIdentityGuard(prev, { agentId: CHEVRON, source: "default" });
    expect(v.kind).toBe("gate");
  });

  test("same selector, different identity (edited profile): warn, not gate", () => {
    const v = decideIdentityGuard(recordWith(CHEVRON), { agentId: "acc_newchevron", source: "flag-profile", declaredName: "Antigravity-2" });
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") expect(v.message).toContain("Antigravity-2");
  });

  test("a deliberately different explicit profile: ok (normal multi-profile use)", () => {
    const v = decideIdentityGuard(recordWith(CHEVRON), { agentId: ACADEMIC, source: "flag-profile", declaredName: "Antigravity" });
    expect(v.kind).toBe("ok");
  });

  test("env-creds boot with a different identity: ok (explicit token is a declaration)", () => {
    const v = decideIdentityGuard(recordWith(CHEVRON), { agentId: ACADEMIC, source: "env-creds" });
    expect(v.kind).toBe("ok");
  });

  test("anonymous boot (no agent id): ok — guard only speaks for real identities", () => {
    expect(decideIdentityGuard(recordWith(CHEVRON), { agentId: "", source: "default" }).kind).toBe("ok");
  });
});

describe("advanceGuardRecord — the trust ledger", () => {
  test("a GATED boot must NOT advance lastEffective (repeat respawns keep alarming)", () => {
    const prev = recordWith(CHEVRON);
    const next = advanceGuardRecord(prev, { agentId: ACADEMIC, source: "default" }, "2026-09-27T11:00:00Z", false);
    expect(next.lastEffective?.agentId).toBe(CHEVRON); // still the trusted one
  });

  test("a trusted boot advances lastEffective and records the selector", () => {
    const prev = recordWith(CHEVRON);
    const next = advanceGuardRecord(prev, { agentId: CHEVRON, source: "flag-profile", declaredName: "Antigravity-2" }, "2026-09-27T11:00:00Z", true);
    expect(next.lastEffective?.agentId).toBe(CHEVRON);
    expect(next.bySelector["Antigravity-2"]).toBe(CHEVRON);
  });

  test("whoami confirmation after a gate promotes the new identity (alarm stops next boot)", () => {
    const prev = recordWith(CHEVRON);
    const gated = advanceGuardRecord(prev, { agentId: ACADEMIC, source: "default" }, "2026-09-27T11:00:00Z", false);
    const confirmed = advanceGuardRecord(gated, { agentId: ACADEMIC, source: "default" }, "2026-09-27T11:01:00Z", true);
    expect(confirmed.lastEffective?.agentId).toBe(ACADEMIC);
    // Next boot as ACADEMIC via default is now fine.
    expect(decideIdentityGuard(confirmed, { agentId: ACADEMIC, source: "default" }).kind).toBe("ok");
  });

  test("does not mutate the previous record", () => {
    const prev = recordWith(CHEVRON);
    advanceGuardRecord(prev, { agentId: ACADEMIC, source: "flag-profile", declaredName: "Antigravity" }, "t", true);
    expect(prev.lastEffective?.agentId).toBe(CHEVRON);
    expect(prev.bySelector["Antigravity"]).toBeUndefined();
  });
});

describe("parseGuardRecord — never blocks boot", () => {
  test("null/garbage → empty record", () => {
    expect(parseGuardRecord(null)).toEqual(emptyGuardRecord());
    expect(parseGuardRecord("not json")).toEqual(emptyGuardRecord());
    expect(parseGuardRecord("{}")).toEqual(emptyGuardRecord());
  });

  test("round-trips a real record", () => {
    const rec = recordWith(CHEVRON);
    const parsed = parseGuardRecord(JSON.stringify(rec));
    expect(parsed.lastEffective?.agentId).toBe(CHEVRON);
    expect(parsed.bySelector["Antigravity-2"]).toBe(CHEVRON);
  });
});

import {
  expectedAgentIdFromEnv,
  expectedAgentIdViolation,
  EXPECT_PIN_EXEMPT_TOOLS,
} from "../src/identity-guard.ts";

describe("expected agent id pin (AGENTCHAT_EXPECT_AGENT_ID)", () => {
  test("canonical plural wins; blank/unset → null", () => {
    expect(expectedAgentIdFromEnv({})).toBeNull();
    expect(expectedAgentIdFromEnv({ AGENTCHAT_EXPECT_AGENT_ID: "  " })).toBeNull();
    expect(expectedAgentIdFromEnv({ AGENTCHAT_EXPECT_AGENT_ID: "a" })).toBe("a");
    expect(expectedAgentIdFromEnv({ AGENTSCHAT_EXPECT_AGENT_ID: "b", AGENTCHAT_EXPECT_AGENT_ID: "a" })).toBe("b");
  });

  test("violation only on mismatch; message names both ids and the fix", () => {
    expect(expectedAgentIdViolation(null, "x")).toBeNull();
    expect(expectedAgentIdViolation("x", "x")).toBeNull();
    const m = expectedAgentIdViolation("chevron", "academic")!;
    expect(m).toMatch(/"academic".*"chevron"/);
    expect(m).toMatch(/switch_profile/);
    expect(m).not.toMatch(/ac_/);
  });

  test("whoami and switch_profile stay callable while violated", () => {
    expect(EXPECT_PIN_EXEMPT_TOOLS.has("whoami")).toBe(true);
    expect(EXPECT_PIN_EXEMPT_TOOLS.has("switch_profile")).toBe(true);
    expect(EXPECT_PIN_EXEMPT_TOOLS.has("reply")).toBe(false);
  });
});

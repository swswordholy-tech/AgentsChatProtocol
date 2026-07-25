import { describe, expect, test } from "bun:test";
import { decideIdentity, shouldMigrateDevToken, type IdentityInputs } from "../src/identity.ts";

const base: IdentityInputs = {
  profileExists: false,
  source: "default",
  profileFile: "/home/u/.agentschat/profile.json",
  hasToken: false,
  fallbackName: "Claude-abc123",
};

describe("decideIdentity — never registers implicitly", () => {
  test("bare default path with nothing declared → anonymous, NOT register", () => {
    const d = decideIdentity(base);
    expect(d.mode).toBe("anonymous");
    // The whole point: no account is created for a host that forgot to declare identity.
    expect(d.mode === "anonymous" && d.reason).toContain("Refusing to auto-register");
  });

  test("anonymous names the shared default path it refuses to write", () => {
    const d = decideIdentity(base);
    expect(d.mode === "anonymous" && d.reason).toContain("/home/u/.agentschat/profile.json");
  });

  test("--name opts in explicitly → register under that name", () => {
    const d = decideIdentity({ ...base, source: "flag-name", cliName: "Foo" });
    expect(d).toEqual({ mode: "register", displayName: "Foo" });
  });

  test("--register without --name → register under the generated fallback name", () => {
    const d = decideIdentity({ ...base, registerFlag: true });
    expect(d).toEqual({ mode: "register", displayName: "Claude-abc123" });
  });

  test("existing profile file → load it, never register", () => {
    expect(decideIdentity({ ...base, profileExists: true }).mode).toBe("profile");
  });

  test("token supplied out-of-band → authenticate, never register (even with no profile)", () => {
    expect(decideIdentity({ ...base, hasToken: true }).mode).toBe("env-creds");
  });

  test("token wins over --register: nothing to create", () => {
    expect(decideIdentity({ ...base, hasToken: true, registerFlag: true }).mode).toBe("env-creds");
  });

  test("existing profile wins over everything", () => {
    expect(decideIdentity({ ...base, profileExists: true, hasToken: true, cliName: "Foo" }).mode).toBe("profile");
  });
});

describe("decideIdentity — declared-but-missing is a hard error, not an invented identity", () => {
  for (const source of ["env", "legacy-env", "flag-profile"] as const) {
    test(`${source}: profile missing → error, not register`, () => {
      const d = decideIdentity({ ...base, source, declaredName: "mellow-blessed-obsidian" });
      expect(d.mode).toBe("error");
      expect(d.mode === "error" && d.message).toContain("mellow-blessed-obsidian");
      // Was pinned to "accounts cannot be deleted" — verified false against production
      // 2026-07-26 (DELETE /api/account/<id> with the agent's own key → 200, then auth
      // 401). The refusal is still right; its reason had to become a true one.
      expect(d.mode === "error" && d.message).toContain("Refusing to auto-register");
    });
  }

  test("declared-but-missing still yields to an explicit --name", () => {
    const d = decideIdentity({ ...base, source: "flag-profile", declaredName: "typo", cliName: "Foo" });
    expect(d).toEqual({ mode: "register", displayName: "Foo" });
  });

  test("declared-but-missing still yields to an out-of-band token", () => {
    expect(decideIdentity({ ...base, source: "env", declaredName: "x", hasToken: true }).mode).toBe("env-creds");
  });
});

describe("shouldMigrateDevToken — same opt-in gate as first-run registration", () => {
  test("bare default path → refuse (this is the shared-profile minting path)", () => {
    expect(shouldMigrateDevToken({ source: "default", hasToken: false })).toBe(false);
  });

  test("declared identity → heal the key as before", () => {
    for (const source of ["env", "legacy-env", "flag-profile", "flag-name"] as const) {
      expect(shouldMigrateDevToken({ source, hasToken: false })).toBe(true);
    }
  });

  test("out-of-band token → never register, even for a declared identity", () => {
    expect(shouldMigrateDevToken({ source: "flag-name", hasToken: true })).toBe(false);
    expect(shouldMigrateDevToken({ source: "default", hasToken: true })).toBe(false);
  });

  test("--register overrides the bare default path", () => {
    expect(shouldMigrateDevToken({ source: "default", hasToken: false, registerFlag: true })).toBe(true);
  });
});

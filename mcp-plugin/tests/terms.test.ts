/**
 * Terms consent gate for agent registration.
 *
 * The server began requiring `accepted_terms` on /api/account/register. The client
 * did not send it, so every `npx agentschat-mcp --name X` got 400 and — because the
 * failure path wrote a `dev-token` profile and started anyway — produced an agent
 * that LOOKED connected (24 tools, whoami answers) but 401'd on every real call.
 *
 * The fix is not "send accepted_terms: true". That would declare, on the operator's
 * behalf, agreement to a document they were never shown. Consent must be explicit,
 * and refusing it must be loud.
 */
import { describe, expect, test } from "bun:test";
import { decideTermsConsent, TERMS_URL, TERMS_VERSION } from "../src/terms.ts";

describe("decideTermsConsent — never accepts on the operator's behalf", () => {
  test("nothing passed → refused (we do not agree to terms for the user)", () => {
    const d = decideTermsConsent({});
    expect(d.mode).toBe("refused");
  });

  test("the refusal shows the terms URL, the version, and how to accept", () => {
    const d = decideTermsConsent({});
    const msg = d.mode === "refused" ? d.message : "";
    // A consent prompt that hides the document is not consent.
    expect(msg).toContain(TERMS_URL);
    expect(msg).toContain(TERMS_VERSION);
    expect(msg).toContain("--accept-terms");
  });

  test("--accept-terms → accepted, stamped with the version we showed", () => {
    expect(decideTermsConsent({ acceptFlag: true })).toEqual({
      mode: "accepted",
      version: TERMS_VERSION,
    });
  });

  test("AGENTSCHAT_ACCEPT_TERMS accepts the documented truthy spellings", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes"]) {
      expect(decideTermsConsent({ acceptEnv: v }).mode).toBe("accepted");
    }
  });

  test("a non-truthy env value is NOT consent (control group)", () => {
    // Without this, `AGENTSCHAT_ACCEPT_TERMS=0` would read as acceptance and the
    // "accepted" assertions above would pass vacuously for any string at all.
    for (const v of ["", "0", "false", "no", "maybe"]) {
      expect(decideTermsConsent({ acceptEnv: v }).mode).toBe("refused");
    }
  });

  test("TERMS_URL is the real published document, not a placeholder", () => {
    // Verified live: https://agents-chat.com/terms → 200 (/tos and /legal/terms → 404).
    expect(TERMS_URL).toBe("https://agents-chat.com/terms");
  });
});

describe("registration payload carries the consent the server demands", () => {
  test("accepted consent yields both fields the server validates", () => {
    const d = decideTermsConsent({ acceptFlag: true });
    expect(d.mode).toBe("accepted");
    // Reproduced against production 2026-07-26: omitting accepted_terms returns
    // 400 {"error":"accepted_terms required for agent registration"}.
    const payload = d.mode === "accepted"
      ? { accepted_terms: true, terms_version: d.version }
      : {};
    expect(payload).toEqual({ accepted_terms: true, terms_version: TERMS_VERSION });
  });
});

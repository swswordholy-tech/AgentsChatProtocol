/**
 * Terms-of-service consent for agent registration — pure decision logic, no I/O.
 *
 * Why this exists: the hub began requiring `accepted_terms` on
 * /api/account/register. 0.30.0 did not send it, so every self-serve
 * `npx agentschat-mcp --name X` got:
 *
 *   400 {"error":"accepted_terms required for agent registration"}
 *
 * ...and the register-failure path then wrote a `dev-token` profile and started the
 * server anyway. The result read as success in the client (tools listed, whoami
 * answers) while every authenticated call 401'd — a dead agent wearing a live one's
 * clothes, with the only truth in stderr nobody reads.
 *
 * The obvious patch — hardcode `accepted_terms: true` — is the wrong fix. It records
 * agreement to a legal document on behalf of an operator who was never shown it. So
 * consent is explicit (`--accept-terms` / AGENTSCHAT_ACCEPT_TERMS) and its absence is
 * a loud refusal that prints the document URL, not a silent degraded start.
 *
 * Lives outside the side-effecting entrypoint so it can be unit-tested (same reason
 * as identity.ts).
 */

/** The published agreement an agent registration accepts. Verified live: 200. */
export const TERMS_URL = "https://agents-chat.com/terms";

/**
 * Version string sent alongside the acceptance. The hub stamps its own
 * `termsVersion` on the account; this records which text the operator was pointed at.
 * If the hub ever rejects it, the register call surfaces the server's error verbatim
 * rather than guessing — see the register call site in server.ts.
 */
export const TERMS_VERSION = "2026-05-29";

export interface TermsInputs {
  /** `--accept-terms` was passed. */
  acceptFlag?: boolean;
  /** Raw value of AGENTSCHAT_ACCEPT_TERMS (for non-interactive hosts). */
  acceptEnv?: string;
}

export type TermsDecision =
  /** Operator accepted — registration may proceed and carry these fields. */
  | { mode: "accepted"; version: string }
  /** No explicit acceptance — refuse to register, and say what to do about it. */
  | { mode: "refused"; message: string };

/** Only these spellings count as consent; anything else (incl. "0"/"false") does not. */
function isTruthy(v: string | undefined): boolean {
  return typeof v === "string" && /^(1|true|yes)$/i.test(v.trim());
}

export function decideTermsConsent(i: TermsInputs): TermsDecision {
  if (i.acceptFlag || isTruthy(i.acceptEnv)) {
    return { mode: "accepted", version: TERMS_VERSION };
  }
  return {
    mode: "refused",
    message:
      `registering an agent requires accepting the AgentsChat terms (version ${TERMS_VERSION}).\n` +
      `  Read them:  ${TERMS_URL}\n` +
      `  Then re-run with:  --accept-terms   (or AGENTSCHAT_ACCEPT_TERMS=1)\n` +
      `  Prefer a browser? Register at https://agents-chat.com/join and pass the\n` +
      `  resulting credentials via --profile <name> or AGENTCHAT_TOKEN=<token>.\n` +
      `  Refusing to send acceptance you did not give — no account was created.`,
  };
}

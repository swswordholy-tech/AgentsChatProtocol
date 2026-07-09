/**
 * Startup identity policy — pure decision logic, no I/O.
 *
 * Lives outside the side-effecting server entrypoint (which registers accounts and
 * writes credential files on import) so it can be unit-tested.
 *
 * Why this exists: auto-registration creates a REAL account on the server, and
 * accounts cannot be deleted. It must never fire implicitly. Previously a host that
 * simply forgot to declare an identity (no --name/--profile/AGENTSCHAT_PROFILE, no
 * token) would mint an anonymous `Claude-xxxxxx` agent on every first start — and
 * because the bare fallback path is SHARED (`~/.agentschat/profile.json`), every
 * later identity-less session loads that same file and collapses onto that one
 * agent. A second trigger did the same for any profile still carrying `dev-token`.
 *
 * Policy: registration requires explicit opt-in (`--name` or `--register`).
 *  - Nothing declared at all  → ANONYMOUS: no registration, no profile written.
 *    stdio still answers initialize/tools/list, so registry introspection (Glama
 *    builds and runs the server with zero config) keeps working; anything needing
 *    auth fails loudly at call time rather than silently creating an account.
 *  - An identity WAS declared but its profile is missing → hard error. That is a
 *    typo/misconfig, and inventing an identity for it is what corrupted attribution
 *    before. Introspection never hits this branch (it passes no flags).
 */

/** Which resolution tier produced the profile path (see resolveProfile in server.ts). */
export type ProfileSource = "env" | "legacy-env" | "flag-profile" | "flag-name" | "default";

export type IdentityDecision =
  /** Profile file exists — load it. */
  | { mode: "profile" }
  /** Explicit token supplied via --token/AGENTCHAT_TOKEN — authenticate, never register. */
  | { mode: "env-creds" }
  /** Explicit opt-in (--name / --register) — register a new account and persist it. */
  | { mode: "register"; displayName: string }
  /** Identity declared but profile missing — refuse to invent one. */
  | { mode: "error"; message: string }
  /** Nothing declared — run unauthenticated, register nothing, persist nothing. */
  | { mode: "anonymous"; reason: string };

export interface IdentityInputs {
  /** Does the resolved profile file already exist on disk? */
  profileExists: boolean;
  /** Which tier resolved the path. "default" means nothing was declared. */
  source: ProfileSource;
  /** The resolved profile path (used in operator-facing messages). */
  profileFile: string;
  /** Value of --name, if given. */
  cliName?: string;
  /** Value of --profile, or the *_PROFILE env var — used only for the error message. */
  declaredName?: string;
  /** Explicit --register opt-in. */
  registerFlag?: boolean;
  /** A token was supplied out-of-band (--token / AGENTCHAT_TOKEN). */
  hasToken: boolean;
  /** Generated name to use when --register is passed without --name. */
  fallbackName: string;
}

export function decideIdentity(i: IdentityInputs): IdentityDecision {
  // An existing profile is authoritative — this is the overwhelmingly common path.
  if (i.profileExists) return { mode: "profile" };

  // Credentials handed to us directly: we can authenticate, so there is nothing to
  // register. (Previously this still registered, because the branch keyed only on
  // the profile file being absent.)
  if (i.hasToken) return { mode: "env-creds" };

  // Explicit opt-in to creating a new account.
  if (i.cliName) return { mode: "register", displayName: i.cliName };
  if (i.registerFlag) return { mode: "register", displayName: i.fallbackName };

  // An identity was named but no profile backs it. Do NOT invent one.
  if (i.source !== "default") {
    const name = i.declaredName ?? i.cliName ?? "(unknown)";
    return {
      mode: "error",
      message:
        `no profile for "${name}" at ${i.profileFile}.\n` +
        `  Refusing to auto-register — that creates a real account, and accounts cannot be deleted.\n` +
        `  Use an existing profile:  --profile <name>   (or AGENTSCHAT_PROFILE=<name>)\n` +
        `  Register a NEW agent:     --name <new-name>  (or --register)\n` +
        `  Authenticate directly:    AGENTCHAT_TOKEN=<token>`,
    };
  }

  // Nothing declared. Stay usable for introspection, but create nothing.
  return {
    mode: "anonymous",
    reason:
      `no agent identity configured — running ANONYMOUS (tools are listed; any call needing auth will fail).\n` +
      `  Refusing to auto-register: it would create a real, undeletable account and persist its\n` +
      `  credentials to the shared default profile (${i.profileFile}), which every later\n` +
      `  identity-less session would then load as its own.\n` +
      `  To fix:  --name <your-agent>   register a new agent\n` +
      `           --profile <name>      use an existing profile (or AGENTSCHAT_PROFILE=<name>)\n` +
      `           AGENTCHAT_TOKEN=<t>   authenticate directly`,
  };
}

/**
 * Second auto-register trigger: a profile that loaded successfully but still carries
 * the placeholder `dev-token`. Legacy behavior re-registered it to heal the key —
 * fine for an explicitly declared identity, but on the bare shared default path it
 * mints an anonymous account exactly like the first trigger. Same opt-in gate.
 */
export function shouldMigrateDevToken(i: {
  source: ProfileSource;
  hasToken: boolean;
  registerFlag?: boolean;
}): boolean {
  if (i.hasToken) return false; // out-of-band creds win; nothing to heal
  if (i.registerFlag) return true; // explicit opt-in
  return i.source !== "default"; // an identity was declared → healing it is intended
}

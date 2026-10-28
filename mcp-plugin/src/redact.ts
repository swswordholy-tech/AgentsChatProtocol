/**
 * Redact sensitive tokens from outgoing message content.
 *
 * Last line of defense against leaking credentials into channel messages
 * or logs (the MCP server instructions forbid sharing ac_ keys / tokens /
 * JWTs). Extracted from server.ts so it can be unit-tested without importing
 * the side-effecting server entrypoint (which connects a WebSocket on load).
 *
 * Covers ac_ API keys and JWTs. Claim URLs / ?key= params / passwords are
 * not yet covered — tracked as a separate hardening finding.
 */
export interface RedactOptions {
  /** When true (same-owner direct channel), preserve `ac_...` keys while still redacting JWTs. */
  preserveAcKeys?: boolean;
}

export function redactSecrets(text: string, opts?: RedactOptions): string {
  const step = opts?.preserveAcKeys
    ? text
    : text.replace(/ac_[A-Za-z0-9_-]{16,}/g, "ac_***REDACTED***");
  return step.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

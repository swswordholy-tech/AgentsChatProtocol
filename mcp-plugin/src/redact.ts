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

const PHONE_PII_RE = /^\+?\d[\d\s()-]{5,}$/;

/**
 * True when an identifier looks like a human login email or phone number
 * rather than an agent handle. Matches the AgentsChat Server PII contract.
 */
export function isHumanPiiHandle(rawId: unknown): boolean {
  const s = String(rawId ?? "").trim();
  if (!s) return false;
  if (s.includes("@")) return true;
  if (PHONE_PII_RE.test(s)) return true;
  return false;
}

/**
 * Mask human login emails (`user@domain` -> `user:us***`) and phone numbers
 * (`+86 138...99` -> `user:phone_***99`) while preserving non-PII agent handles
 * in full (no 8/12-char truncation).
 */
export function redactParticipantPii(rawId: unknown): string {
  const s = String(rawId ?? "").trim();
  if (!s) return "unknown";
  const atIdx = s.indexOf("@");
  if (atIdx >= 0) {
    const local = s.slice(0, atIdx).replace(/[^a-zA-Z0-9]/g, "");
    return `user:${(local.slice(0, 2) || "u").toLowerCase()}***`;
  }
  if (PHONE_PII_RE.test(s)) {
    const digits = s.replace(/\D/g, "");
    return `user:phone_***${digits.slice(-2) || "00"}`;
  }
  return s;
}

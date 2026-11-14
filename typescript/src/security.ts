// Only diagnostic text is scrubbed; user messages retain their original content.
export function redactError(value: unknown, token?: string): string {
  let text = String(value);
  if (token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"), "[REDACTED]");
  }
  return text.replace(/ac_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
}

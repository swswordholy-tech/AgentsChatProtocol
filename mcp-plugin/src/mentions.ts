/**
 * @mention gate — does `content` mention `agentId`?
 *
 * Matches two shapes:
 *   1. `@<agentId>`                      (bare id)
 *   2. `@<displayName>(<agentId>)`       (display-name form)
 *
 * The second clause requires an `@<name>` immediately before `(<id>)`, so it
 * does NOT fire on an incidental `(<id>)` substring such as the system line
 * "User joined: name (acc_xyz)". That was a real bug (msg:fc8b9b1a): a loose
 * `content.includes("(" + id + ")")` made an agent process messages it wasn't
 * mentioned in and burn its context window.
 *
 * Extracted from server.ts so it can be unit-tested without loading the
 * side-effecting server entrypoint (which opens a WebSocket on import).
 */
export function matchesMention(content: string, agentId: string): boolean {
  if (!content || !agentId) return false;
  if (content.includes(`@${agentId}`)) return true;
  const idEsc = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const displayMentionRe = new RegExp(`@[^(\\n]+\\(${idEsc}\\)`);
  return displayMentionRe.test(content);
}

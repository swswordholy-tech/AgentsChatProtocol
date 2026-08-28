/**
 * Wake-webhook — fire an outbound HTTP POST when an @mention/DM arrives, so hosts
 * WITHOUT an MCP channel-notification surface (Grok Bot, generic MCP clients) can
 * be woken by "a POST hit my URL" instead of needing to recognize a host-specific
 * notification method.
 *
 * The plugin already receives @/DM over its agentschat WebSocket and pushes an MCP
 * notification (server.ts). Claude Code acts on that notification; other hosts drop
 * it. This module adds a parallel, host-agnostic wake: POST the event to a URL the
 * operator configures. It is OUTBOUND (the plugin POSTs out), so no public inbound
 * URL is needed on the plugin side.
 *
 * Security:
 *  - The agentschat token is NEVER put in the callback body — the ac_ key stays
 *    local; only message metadata + a content excerpt cross the wire.
 *  - Auth to the receiver is an HMAC-SHA256 signature over the RAW body, keyed by
 *    AGENTCHAT_WAKE_SECRET, in the `x-agentschat-signature` header — so the
 *    receiver can tell a real wake from a forged POST. (The receiver's own secret
 *    in the URL path is its own business; we sign with the shared wake secret.)
 *
 * Delivery is best-effort: a failed/slow POST must never block or break the MCP
 * notification path (which is how Claude Code wakes). One bounded retry, short
 * timeout, then drop with a stderr note.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Signature header the receiver reads to verify a wake POST. */
export const WAKE_SIG_HEADER = "x-agentschat-signature";

/** Cap the content excerpt so a long message doesn't balloon the POST body. */
export const WAKE_CONTENT_MAX = 500;

export interface WakeMessage {
  type?: string;
  id?: string;
  channel_id?: string;
  sender_id?: string;
  content?: string;
  mentioned_ids?: string[];
  timestamp?: string;
  /** Anything credential-shaped is stripped; these are accepted only to be dropped. */
  token?: string;
  agent_key?: string;
  [k: string]: unknown;
}

export interface WakePayload {
  type: string;
  channel_id?: string;
  message_id?: string;
  sender_id?: string;
  content?: string;
  mentioned_ids?: string[];
  timestamp?: string;
}

/**
 * Build the wake body: the fields the receiver needs to wake + decide + optionally
 * skip a history fetch. Credential-shaped fields are never carried across.
 */
export function buildWakePayload(msg: WakeMessage): WakePayload {
  const content = typeof msg.content === "string" ? msg.content.slice(0, WAKE_CONTENT_MAX) : undefined;
  return {
    type: typeof msg.type === "string" ? msg.type : "message",
    channel_id: msg.channel_id,
    message_id: msg.id,
    sender_id: msg.sender_id,
    content,
    mentioned_ids: Array.isArray(msg.mentioned_ids) ? msg.mentioned_ids.filter((x) => typeof x === "string") : undefined,
    timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
  };
}

/** HMAC-SHA256 hex digest of `body` under `secret`. */
export function signWakeBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time check that `sigHex` signs `body` under ANY of `secrets` (rotation). */
export function verifyWakeSignature(body: string, sigHex: string, secrets: readonly string[]): boolean {
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(signWakeBody(body, secret), "hex");
    if (expected.length !== sigBuf.length) continue;
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

export interface WakeConfig {
  /** Where to POST. Empty/absent disables the wake webhook entirely. */
  url?: string;
  /** Shared secret for signing. Empty → send unsigned (receiver can't verify; still woken). */
  secret?: string;
  /** POST timeout (ms). */
  timeoutMs?: number;
  /** Extra fetch impl for tests. */
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/**
 * POST a wake event to the configured URL. Best-effort: resolves void whether it
 * succeeded or not; never throws into the caller's message path.
 */
export async function fireWake(msg: WakeMessage, cfg: WakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  const url = (cfg.url ?? "").trim();
  if (!url) return; // not configured — the wake path is opt-in

  const payload = buildWakePayload(msg);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secret) headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);

  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await f(url, { method: "POST", headers, body, signal: ctrl.signal });
      if (!res.ok) log(`[agentchat] wake POST ${url} → HTTP ${res.status}`);
    } finally {
      clearTimeout(t);
    }
  };

  try {
    await doPost();
  } catch (e) {
    // one bounded retry, then drop — a slow/absent receiver must not wedge the loop
    try {
      await doPost();
    } catch (e2) {
      log(`[agentchat] wake POST ${url} failed: ${e2}`);
    }
  }
}

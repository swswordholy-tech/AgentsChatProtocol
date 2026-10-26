import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Muse wake — the Grok Bot pattern, adapted for Muse.
 *
 * Grok Bot cannot see an MCP channel notification, so the AgentsChat
 * plugin stays connected to the WebSocket and, on a dispatchable
 * @mention/DM, wakes the host with an outbound POST instead of
 * containing the model itself (see mcp-plugin/src/wake.ts).
 *
 * Muse is in the same position: this bridge must not invent a Muse
 * model API, and there is no native Muse gateway endpoint to POST a
 * prompt to in this repo. So the Muse wake daemon does the same
 * separation, with two delivery paths:
 *
 *  1. POST a signed wake payload to MUSE_WAKE_URL when configured
 *     (generic URL wake, HMAC-SHA256, best-effort, one retry).
 *  2. Always append the same payload to a local wake queue file
 *     (default ~/.agentschat/muse-wake-queue.jsonl), so a later Muse
 *     turn — or a periodic Muse check — can pick it up, reply via the
 *     bridge, and mark it done. The queue is the durable wake surface
 *     when no HTTP receiver exists.
 *
 * Security: the AgentsChat token is NEVER put in a wake payload, a
 * log line, or a queue entry. Content excerpts are capped and
 * credential-shaped strings (ac_ keys, JWTs) are redacted.
 */

export const WAKE_SIG_HEADER = "x-agentschat-signature";
export const WAKE_CONTENT_MAX = 500;

export interface WakeMessage {
  type?: string;
  id?: string;
  channel_id?: string;
  sender_id?: string;
  content?: string;
  mentioned_ids?: string[];
  timestamp?: string;
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

export function redactSecrets(text: string): string {
  return text
    .replace(/ac_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

export function buildWakePayload(msg: WakeMessage): WakePayload {
  const content =
    typeof msg.content === "string" ? redactSecrets(msg.content.slice(0, WAKE_CONTENT_MAX)) : undefined;
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

export function signWakeBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

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

/** Prompt text a Muse host can inject into a turn, mirroring buildGrokPrompt. */
export function buildMuseWakePrompt(payload: WakePayload): string {
  const where = payload.channel_id?.startsWith("dm-") ? "私聊 (DM)" : `频道 ${payload.channel_id ?? "?"}`;
  const content = payload.content ? `：“${payload.content}”` : "。";
  return (
    `[AgentsChat] ${payload.sender_id ?? "someone"} 在${where}提到了你${content}` +
    (payload.message_id ? ` (channel_id=${payload.channel_id}, message_id=${payload.message_id}，请用 bridge 回复；仅需更早历史时调 history)` : "")
  );
}

export interface WakeConfig {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/** POST a wake event. Best-effort: resolves void whether it succeeded or not. */
export async function fireWake(msg: WakeMessage, cfg: WakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  const url = (cfg.url ?? "").trim();
  if (!url) return;
  const body = JSON.stringify(buildWakePayload(msg));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secret) headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);
  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await f(url, { method: "POST", headers, body, signal: ctrl.signal });
      if (!res.ok) log(`[muse-agentchat] wake POST ${url} → HTTP ${res.status}`);
    } finally {
      clearTimeout(t);
    }
  };
  try {
    await doPost();
  } catch (e) {
    try {
      await doPost();
    } catch (e2) {
      log(`[muse-agentchat] wake POST ${url} failed: ${e2}`);
    }
  }
}

/**
 * Append a wake payload to the queue file, deduplicated by message_id.
 * Returns true if appended, false if it was already queued.
 */
export function appendWakeQueue(queueFile: string, payload: WakePayload): boolean {
  const line = JSON.stringify(payload);
  if (payload.message_id && existsSync(queueFile)) {
    const existing = readFileSync(queueFile, "utf8");
    if (existing.split("\n").some((l) => {
      try {
        return (JSON.parse(l) as WakePayload).message_id === payload.message_id;
      } catch {
        return false;
      }
    })) {
      return false;
    }
  }
  appendFileSync(queueFile, line + "\n");
  return true;
}

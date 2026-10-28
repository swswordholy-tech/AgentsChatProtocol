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
import { redactSecrets } from "./redact.ts";

/** Signature header the receiver reads to verify a wake POST. */
export const WAKE_SIG_HEADER = "x-agentschat-signature";

/** Cap the content excerpt for generic HTTP wake webhooks so a long message doesn't balloon the POST body. */
export const WAKE_CONTENT_MAX = 500;
/** Cap for native IDE/CLI wake prompts (Antigravity / ZCode), matching get_history per-message cap. */
export const NATIVE_WAKE_CONTENT_MAX = 4000;

export interface WakeAttachment {
  type?: string;
  url?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  transcript?: string;
}

export interface WakeMessage {
  type?: string;
  id?: string;
  channel_id?: string;
  sender_id?: string;
  content?: string;
  attachments?: WakeAttachment[];
  mentioned_ids?: string[];
  timestamp?: string;
  /** True when server verified this DM is between an owner and their own agent, or sibling agents of the same owner. */
  same_owner_direct?: boolean;
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
  attachments?: WakeAttachment[];
  mentioned_ids?: string[];
  timestamp?: string;
}

export function formatWakeAttachments(attachments: unknown): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const lines: string[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as WakeAttachment;
    if (typeof a.url !== "string" || !a.url) continue;
    const t = typeof a.type === "string" ? a.type : "file";
    const dim = typeof a.width === "number" && typeof a.height === "number" ? ` ${a.width}×${a.height}` : "";
    const dur = typeof a.duration_ms === "number" ? ` ${(a.duration_ms / 1000).toFixed(1)}s` : "";
    const icon = t === "image" ? "🖼" : t === "video" ? "🎬" : t === "audio" ? "🔊" : "📎";
    let desc = `${icon} ${t}${dim}${dur}: ${a.url}`;
    if (typeof a.transcript === "string" && a.transcript.trim()) {
      desc += ` (transcript: "${redactSecrets(a.transcript.trim().slice(0, 300))}")`;
    }
    lines.push(desc);
  }
  return lines.length > 0 ? ` [附件: ${lines.join("; ")}]` : "";
}

/**
 * Build the wake body: the fields the receiver needs to wake + decide + optionally
 * skip a history fetch. Credential-shaped fields are never carried across.
 */
export function buildWakePayload(msg: WakeMessage): WakePayload {
  // The content excerpt crosses the wire to the wake receiver, so it goes through
  // the same redactSecrets every other outbound content path uses (reply/edit/
  // caption/status) — a message with an ac_ key or JWT pasted into it must not leak
  // it into the wake body either (except ac_ keys in same-owner direct channels).
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = typeof msg.content === "string" ? redactSecrets(msg.content.slice(0, WAKE_CONTENT_MAX), redactOpts) : undefined;
  const attachments = Array.isArray(msg.attachments) && msg.attachments.length > 0
    ? msg.attachments
        .filter((a) => a && typeof a === "object" && typeof a.url === "string")
        .map((a) => ({
          type: typeof a.type === "string" ? a.type : undefined,
          url: a.url,
          mime: typeof a.mime === "string" ? a.mime : undefined,
          size: typeof a.size === "number" ? a.size : undefined,
          width: typeof a.width === "number" ? a.width : undefined,
          height: typeof a.height === "number" ? a.height : undefined,
          duration_ms: typeof a.duration_ms === "number" ? a.duration_ms : undefined,
          transcript: typeof a.transcript === "string" ? redactSecrets(a.transcript.slice(0, 300), redactOpts) : undefined,
        }))
    : undefined;
  return {
    type: typeof msg.type === "string" ? msg.type : "message",
    channel_id: msg.channel_id,
    message_id: msg.id,
    sender_id: msg.sender_id,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
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

// ── Grok mode (A1): loopback /api/sendPrompt to a same-machine Grok gateway ──
//
// A Grok gateway is NOT a generic wake receiver: it expects
//   POST http://127.0.0.1:<port>/api/sendPrompt
//   Authorization: Bearer <gateway token>          (from the local gateway.json)
//   {"agentId": "<gw agent uuid>", "prompt": "..."}
// Different auth (Bearer, not the wake HMAC header) and a different body shape, so
// this is a separate path — reusing the trigger (WS @/DM) but not the transport.

export interface GrokPrompt {
  agentId: string;
  prompt: string;
}

/**
 * Build the sendPrompt body. The prompt is a human-readable wake: which channel,
 * who spoke, and the (redacted) content excerpt, so the Grok agent can act without
 * an immediate history fetch. Credential-shaped fields are never carried.
 */
export function buildGrokPrompt(msg: WakeMessage, agentId: string, contextPrefix = ""): GrokPrompt {
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const isTruncated = rawContent.length > NATIVE_WAKE_CONTENT_MAX;
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = rawContent ? redactSecrets(rawContent.slice(0, NATIVE_WAKE_CONTENT_MAX), redactOpts) : "";
  const cleanPrefix = contextPrefix ? redactSecrets(contextPrefix.trim(), redactOpts) : "";
  const channel = msg.channel_id ?? "?";
  const sender = msg.sender_id ?? "someone";
  const msgId = (msg.id ?? (msg as any).message_id ?? "") as string;
  const isDm = channel.startsWith("dm-");
  const where = isDm ? "私聊 (DM)" : `频道 ${channel}`;
  const actionHint = isTruncated
    ? `——消息已截断，可调 get_history 查看全文，再用 reply 回复`
    : `——请直接用 reply 回复；仅需更早历史时调 get_history`;
  const attSummary = formatWakeAttachments(msg.attachments);
  const prompt =
    (cleanPrefix ? `${cleanPrefix}\n\n` : "") +
    `[AgentsChat] ${sender} 在${where}提到了你` +
    (content ? `："${content}${isTruncated ? " …[truncated]" : ""}"` : "。") +
    attSummary +
    (msgId ? ` (channel_id=${channel}, message_id=${msgId}${actionHint})` : "");
  return { agentId, prompt };
}

/**
 * Extract the gateway Bearer token from a parsed gateway.json. Tries the common
 * shapes (`token`, `auth.bearer`); returns null when absent — fail closed, never
 * guess. The token is read from the local file at send time so host restarts that
 * rotate it are picked up automatically, and it never touches argv/env/channel.
 */
export function grokBearerFromGatewayConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return null;
  if (typeof cfg.token === "string" && cfg.token) return cfg.token;
  if (cfg.auth && typeof cfg.auth.bearer === "string" && cfg.auth.bearer) return cfg.auth.bearer;
  return null;
}

/** Extract the gateway port (for the loopback URL) from a parsed gateway.json. */
export function grokPortFromGatewayConfig(cfg: any, fallback = 1340): number {
  const p = cfg?.port;
  return typeof p === "number" && p > 0 ? p : fallback;
}

/**
 * Candidate locations for the Grok gateway.json, in preference order. The
 * classic default is `~/.grok/gateway.json`, but production GrokBot hosts keep
 * the live config at `/home/box/sand-data/gateway.json` (the `~/.grok` path
 * does not exist there). AGENTCHAT_GROK_GATEWAY overrides everything; absent
 * that, the FIRST candidate that exists on disk wins. When none exists the
 * first candidate is returned so the read fails with a useful path in the
 * error — fail closed, no wake.
 */
export const GROK_GATEWAY_PATH_CANDIDATES = [
  `${process.env.HOME}/.grok/gateway.json`,
  "/home/box/sand-data/gateway.json",
] as const;

export function resolveGrokGatewayPath(
  explicit: string | undefined,
  exists: (path: string) => boolean,
): string {
  if (explicit && explicit.trim()) return explicit;
  for (const candidate of GROK_GATEWAY_PATH_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return GROK_GATEWAY_PATH_CANDIDATES[0];
}

export interface GrokWakeConfig {
  /** Path to the Grok gateway.json (read at send time). */
  gatewayConfigPath: string;
  /**
   * The gateway agent uuid to address. One plugin instance fronts ONE AgentsChat
   * agent, which binds to ONE Grok agent (1:1) — set this explicitly. If empty,
   * the caller may fall back to resolving by name via listAgents (see
   * resolveGrokAgentId); an unresolved id means no wake is sent.
   */
  agentId: string;
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/**
 * Resolve which Grok agent to wake. Preference order (per the 1:1 design):
 *   1. the explicit agentId (operator-bound, unambiguous) — wins if set;
 *   2. name match against the gateway's listAgents (convenience fallback, warns —
 *      names on the two sides are not guaranteed to agree);
 *   3. null — fail closed (no wake), with a stderr note on how to bind.
 */
export async function resolveGrokAgentId(opts: {
  explicitId?: string;
  agentschatName?: string;
  listAgents?: () => Promise<Array<{ id?: string; name?: string }>>;
  logger?: (msg: string) => void;
}): Promise<string | null> {
  const log = opts.logger ?? (() => {});
  if (opts.explicitId && opts.explicitId.trim()) return opts.explicitId.trim();
  if (opts.listAgents && opts.agentschatName) {
    try {
      const agents = await opts.listAgents();
      const hit = agents.find((a) => a.name && a.name === opts.agentschatName);
      if (hit?.id) {
        log(`[agentchat] grok wake: no AGENTCHAT_GROK_AGENT_ID; matched "${opts.agentschatName}" → ${hit.id} via listAgents (set the env to bind explicitly)`);
        return hit.id;
      }
    } catch (e) {
      log(`[agentchat] grok wake: listAgents fallback failed: ${e}`);
    }
  }
  log(`[agentchat] grok wake: no Grok agentId bound. Set AGENTCHAT_GROK_AGENT_ID=<gateway agent uuid> (1:1 mapping).`);
  return null;
}

/**
 * Fire a Grok wake: read the gateway token from gateway.json, POST the sendPrompt
 * body to the loopback gateway. Best-effort, never throws into the message path.
 */
export async function fireGrokWake(msg: WakeMessage, cfg: GrokWakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  if (!cfg.agentId) {
    log(`[agentchat] grok wake: no agentId configured, skipping`);
    return;
  }
  let gwcfg: any;
  try {
    const { readFileSync } = await import("node:fs");
    gwcfg = JSON.parse(readFileSync(cfg.gatewayConfigPath, "utf8"));
  } catch (e) {
    log(`[agentchat] grok wake: cannot read ${cfg.gatewayConfigPath}: ${e}`);
    return;
  }
  const token = grokBearerFromGatewayConfig(gwcfg);
  if (!token) {
    log(`[agentchat] grok wake: no bearer token in ${cfg.gatewayConfigPath}`);
    return;
  }
  const port = grokPortFromGatewayConfig(gwcfg);
  const url = `http://127.0.0.1:${port}/api/sendPrompt`;
  const body = JSON.stringify(buildGrokPrompt(msg, cfg.agentId, cfg.contextPrefix));

  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) log(`[agentchat] grok wake POST ${url} → HTTP ${res.status}`);
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
      log(`[agentchat] grok wake POST ${url} failed: ${e2}`);
    }
  }
}

// ── Native Host Wake: Antigravity (Connect-RPC SendAgentMessage) & ZCode (--resume) ──

/**
 * Build a human-readable wake prompt for native IDE/CLI sessions (Antigravity, ZCode).
 * Includes any missed channel context (`contextPrefix`) and only recommends `get_history`
 * when earlier history is needed or the message itself was truncated.
 * Never carries tokens or secret-shaped strings.
 */
export function buildWakePrompt(msg: WakeMessage, contextPrefix = ""): string {
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const isTruncated = rawContent.length > NATIVE_WAKE_CONTENT_MAX;
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = rawContent ? redactSecrets(rawContent.slice(0, NATIVE_WAKE_CONTENT_MAX), redactOpts) : "";
  const cleanPrefix = contextPrefix ? redactSecrets(contextPrefix.trim(), redactOpts) : "";
  const channel = msg.channel_id ?? "?";
  const sender = msg.sender_id ?? "someone";
  const msgId = (msg.id ?? (msg as any).message_id ?? "") as string;
  const isDm = channel.startsWith("dm-");
  const where = isDm ? `私聊 (${channel})` : `频道 ${channel}`;
  const actionHint = isTruncated
    ? ` —— 消息过长已截断，可调用 get_history(chat_id, message_id) 查看全文，再用 reply 回复并 mark_read 标记已读`
    : ` —— 请直接用 reply 回复并用 mark_read 标记已读；仅在需要更早上下文时调用 get_history`;
  const attSummary = formatWakeAttachments(msg.attachments);
  return (
    (cleanPrefix ? `${cleanPrefix}\n\n` : "") +
    `[AgentsChat] ${sender} 在${where}给你发了消息` +
    (content ? `："${content}${isTruncated ? " …[truncated]" : ""}"` : "。") +
    attSummary +
    ` (channel_id=${channel}` +
    (msgId ? `, message_id=${msgId}` : "") +
    `${actionHint})`
  );
}

export interface AntigravityWakeConfig {
  /** Target Antigravity conversation UUID (`<uuid>` from `~/.gemini/antigravity/presence/<uuid>.lock`). */
  conversationId: string;
  /** CSRF token from the parent `language_server` (`--csrf_token`). */
  csrfToken: string;
  /** Optional explicit `host:port` (e.g. from `ANTIGRAVITY_LS_ADDRESS`). */
  lsAddress?: string;
  /** Candidate localhost ports on `127.0.0.1` (sorted highest-first so HTTP port is tried before HTTPS). */
  ports?: number[];
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  /** Optional prompt override (e.g. for loop_tick). */
  promptOverride?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/**
 * Wake an open Antigravity conversation directly via its local `language_server`
 * Connect-RPC endpoint (`SendAgentMessage`). No external `url-wake` daemon required.
 */
export async function fireAntigravityWake(msg: WakeMessage, cfg: AntigravityWakeConfig): Promise<boolean> {
  const log = cfg.logger ?? (() => {});
  const conversationId = (cfg.conversationId ?? "").trim();
  const csrfToken = (cfg.csrfToken ?? "").trim();
  if (!conversationId || !csrfToken) {
    log(`[agentchat] antigravity wake: missing conversationId or csrfToken, skipping`);
    return false;
  }

  const addresses: string[] = [];
  if (cfg.lsAddress && cfg.lsAddress.trim()) {
    addresses.push(cfg.lsAddress.trim());
  }
  for (const p of cfg.ports ?? []) {
    if (typeof p === "number" && p > 0) {
      const addr = `127.0.0.1:${p}`;
      if (!addresses.includes(addr)) addresses.push(addr);
    }
  }
  if (addresses.length === 0) {
    log(`[agentchat] antigravity wake: no language_server ports found, skipping`);
    return false;
  }

  const prompt = cfg.promptOverride ?? buildWakePrompt(msg, cfg.contextPrefix);
  const channel = msg.channel_id ?? "chat";
  const sender = msg.sender_id ?? "channel";
  const body = JSON.stringify({
    recipient: conversationId,
    senderId: `agentschat:${sender}`,
    displayTitle: `AgentsChat #${channel}`,
    content: prompt,
  });

  const f = cfg.fetchImpl ?? fetch;
  for (const addr of addresses) {
    const url = `http://${addr}/exa.language_server_pb.LanguageServerService/SendAgentMessage`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrfToken,
        },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) {
        return true;
      }
      log(`[agentchat] antigravity wake POST ${url} → HTTP ${res.status}`);
    } catch {
      // Try next candidate port (e.g., if the first port was HTTPS or closed)
    } finally {
      clearTimeout(t);
    }
  }
  log(`[agentchat] antigravity wake: all candidate ports (${addresses.join(", ")}) failed for ${conversationId}`);
  return false;
}

export interface ZcodeWakeConfig {
  /** ZCode session ID (`sess_...`) captured from `_meta.session_id` or `ZCODE_SESSION_ID`. */
  sessionId: string;
  /** Workspace path for `--cwd` when resuming the session. */
  workspacePath?: string;
  /** Bound profile name so the resumed turn's tool calls inherit the exact identity. */
  profileName?: string;
  /** PID of the parent MCP server holding `<agent_id>.lock`. */
  lockOwnerPid?: number;
  /** Optional override for the `zcode` binary or script path. */
  zcodeBin?: string;
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  /** Optional prompt override (e.g. for loop_tick). */
  promptOverride?: string;
  /** Timeout per turn in ms (default 180s). */
  timeoutMs?: number;
  /** Injectable runner for unit tests. */
  runCommandImpl?: (cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<{ code: number; stderr?: string }>;
  logger?: (msg: string) => void;
}

const zcodeSessionQueues = new Map<string, Promise<void>>();

/**
 * Resolve the executable command + prefix args for `zcode` CLI.
 * Supports `zcode` on PATH or macOS `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`.
 */
export async function resolveZcodeCommand(explicitBin?: string): Promise<{ cmd: string; prefixArgs: string[] }> {
  const fromArg = (explicitBin ?? process.env.ZCODE_BIN ?? "").trim();
  if (fromArg) {
    if (fromArg.endsWith(".cjs") || fromArg.endsWith(".js")) {
      return { cmd: "node", prefixArgs: [fromArg] };
    }
    return { cmd: fromArg, prefixArgs: [] };
  }
  const macAppBundleCjs = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
  try {
    const { existsSync } = await import("node:fs");
    if (existsSync(macAppBundleCjs)) {
      return { cmd: "node", prefixArgs: [macAppBundleCjs] };
    }
  } catch {}
  return { cmd: "zcode", prefixArgs: [] };
}

/**
 * Wake a ZCode session by running a single-flight `zcode -p "<prompt>" --resume <sessionId>` turn.
 * Sets `AGENTSCHAT_TOOL_ONLY=1` and `AGENTSCHAT_LOCK_OWNER_PID` so the child's MCP server
 * executes tools without opening a competing WebSocket connection or failing the agent lock.
 */
export function fireZcodeWake(msg: WakeMessage, cfg: ZcodeWakeConfig): Promise<boolean> {
  const log = cfg.logger ?? (() => {});
  const sessionId = (cfg.sessionId ?? "").trim();
  if (!sessionId) {
    log(`[agentchat] zcode wake: missing sessionId, skipping`);
    return Promise.resolve(false);
  }

  const prompt = cfg.promptOverride ?? buildWakePrompt(msg, cfg.contextPrefix);
  const prev = zcodeSessionQueues.get(sessionId) ?? Promise.resolve();

  let succeeded = false;
  const runTurn = async (): Promise<void> => {
    try {
      const { cmd, prefixArgs } = await resolveZcodeCommand(cfg.zcodeBin);
      const args = [...prefixArgs, "-p", prompt, "--resume", sessionId];
      if (cfg.workspacePath && cfg.workspacePath.trim()) {
        args.push("--cwd", cfg.workspacePath.trim());
      }
      const env: Record<string, string | undefined> = {
        ...process.env,
        AGENTSCHAT_TOOL_ONLY: "1",
        AGENTSCHAT_LOCK_OWNER_PID: String(cfg.lockOwnerPid ?? process.pid),
        ZCODE_SESSION_ID: sessionId,
        ...(cfg.profileName ? { AGENTSCHAT_PROFILE: cfg.profileName } : {}),
      };
      const timeoutMs = cfg.timeoutMs ?? 180_000;

      if (cfg.runCommandImpl) {
        const res = await cfg.runCommandImpl(cmd, args, { cwd: cfg.workspacePath, env, timeoutMs });
        succeeded = res.code === 0;
        if (!succeeded) {
          log(`[agentchat] zcode wake (${sessionId}) exited with code ${res.code}${res.stderr ? `: ${res.stderr.slice(0, 200)}` : ""}`);
        }
        return;
      }

      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: cfg.workspacePath || process.cwd(),
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          if (stderr.length < 500) stderr += String(chunk);
        });
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
        }, timeoutMs);
        child.on("error", (err) => {
          clearTimeout(timer);
          log(`[agentchat] zcode wake spawn error (${sessionId}): ${err}`);
          resolve();
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          succeeded = code === 0;
          if (!succeeded) {
            log(`[agentchat] zcode wake (${sessionId}) exited code=${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`);
          }
          resolve();
        });
      });
    } catch (e) {
      log(`[agentchat] zcode wake failed (${sessionId}): ${e}`);
    }
  };

  const next = prev.then(runTurn, runTurn);
  zcodeSessionQueues.set(sessionId, next);
  return next.then(() => {
    if (zcodeSessionQueues.get(sessionId) === next) {
      zcodeSessionQueues.delete(sessionId);
    }
    return succeeded;
  });
}

#!/usr/bin/env node
/**
 * EXAMPLE — minimal AgentsChat URL-wake receiver (NOT a production daemon).
 *
 * Pattern (hosts WITHOUT an MCP notification channel):
 *   resident agentschat-mcp → signed POST AGENTCHAT_WAKE_URL
 *   → this receiver: verify HMAC → queue → single-flight spawn of
 *     AGENTCHAT_URL_WAKE_CMD (or a no-op echo when unset)
 *
 * Env (no secrets in the repo — set locally):
 *   AGENTCHAT_WAKE_SECRET   required for verify (HMAC-SHA256 hex of raw body)
 *   AGENTCHAT_URL_WAKE_PORT listen port (default 18765), bind 127.0.0.1 only
 *   AGENTCHAT_URL_WAKE_PATH POST path (default /wake)
 *   AGENTCHAT_URL_WAKE_CMD  shell command to run per job; receives JSON on stdin
 *   AGENTCHAT_URL_WAKE_DIR  state dir for queue/lock/dedupe (default ./url-wake-state)
 *
 * Signature header: x-agentschat-signature (same as mcp-plugin/src/wake.ts).
 * Payload fields: type, channel_id, message_id, sender_id, content (≤500),
 * mentioned_ids, timestamp. Never expect an ac_ token in the body.
 *
 * Usage:
 *   AGENTCHAT_WAKE_SECRET=… node scripts/example-url-wake-receiver.mjs
 *   curl -s http://127.0.0.1:18765/health
 *
 * For Antigravity/agy production-shaped stacks, adapt your own ensure + fixed
 * `--conversation` session; do not copy bare -c / continue.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WAKE_SIG_HEADER = "x-agentschat-signature";
export const WAKE_CONTENT_MAX = 500;

/** HMAC-SHA256 hex digest of `body` under `secret` (matches src/wake.ts). */
export function signWakeBody(body, secret) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time verify that `sigHex` signs `body` under `secret`. */
export function verifyWakeSignature(body, sigHex, secret) {
  if (!sigHex || typeof sigHex !== "string" || !secret) return false;
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0) return false;
  const expected = Buffer.from(signWakeBody(body, secret), "hex");
  if (expected.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expected);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function log(msg) {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Cursor session env that must not leak into a non-Grok host turn (or its
 * AgentsChat MCP child): e.g. a Grok agent's CURSOR_CONVERSATION_ID inherited
 * from the shell that started this receiver. CURSOR_AGENT_STORE_* is dropped too.
 */
export const LEAKED_CURSOR_ENV = [
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "__CURSOR_SANDBOX_ENV_RESTORE",
  "CURSOR_AGENT",
];

/** Copy of `base` without leaked Cursor session keys. Does not mutate `base`. */
export function withoutCursorSessionEnv(base) {
  const out = { ...base };
  for (const k of Object.keys(out)) {
    if (LEAKED_CURSOR_ENV.includes(k) || k.startsWith("CURSOR_AGENT_STORE_")) delete out[k];
  }
  return out;
}

/** Build a prompt string hosts can inject into one dedicated session. */
export function buildHostPrompt(job) {
  const mentioned = Array.isArray(job.mentioned_ids)
    ? job.mentioned_ids.join(",")
    : String(job.mentioned_ids ?? "");
  return [
    "[AgentsChat inbound]",
    `channel_id=${job.channel_id ?? ""}`,
    `message_id=${job.message_id ?? ""}`,
    `sender_id=${job.sender_id ?? ""}`,
    `mentioned_ids=${mentioned}`,
    `timestamp=${job.timestamp ?? ""}`,
    "content:",
    String(job.content ?? ""),
    "",
    "Reply with the agentschat MCP `reply` tool to this channel_id.",
    "Do NOT call get_history unless content looks truncated (~500 chars) and you need the rest.",
  ].join("\n");
}

function startServer() {
  const secret = process.env.AGENTCHAT_WAKE_SECRET || "";
  if (!secret) {
    console.error("AGENTCHAT_WAKE_SECRET is required");
    process.exit(1);
  }
  const port = Number(envOr("AGENTCHAT_URL_WAKE_PORT", "18765"));
  const wakePath = envOr("AGENTCHAT_URL_WAKE_PATH", "/wake");
  const cmd = process.env.AGENTCHAT_URL_WAKE_CMD || "";
  const stateDir = path.resolve(envOr("AGENTCHAT_URL_WAKE_DIR", "./url-wake-state"));
  const queueDir = path.join(stateDir, "queue");
  const lockPath = path.join(stateDir, "single-flight.lock");
  const dedupePath = path.join(stateDir, "seen-message-ids.json");
  fs.mkdirSync(queueDir, { recursive: true });

  function loadSeen() {
    try {
      const arr = JSON.parse(fs.readFileSync(dedupePath, "utf8"));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function wasSeen(messageId) {
    if (!messageId) return false;
    return loadSeen().includes(messageId);
  }

  function rememberSeen(messageId) {
    if (!messageId) return;
    let seen = loadSeen();
    if (seen.includes(messageId)) return;
    seen.push(messageId);
    if (seen.length > 200) seen = seen.slice(seen.length - 200);
    fs.writeFileSync(dedupePath, JSON.stringify(seen));
  }

  function queueLen() {
    try {
      return fs.readdirSync(queueDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  function isBusy() {
    try {
      const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  function tryAcquireLock() {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e && e.code === "EEXIST") {
        if (!isBusy()) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
          return tryAcquireLock();
        }
        return false;
      }
      throw e;
    }
  }

  function releaseLock() {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }

  function nextJobPath() {
    const files = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (!files.length) return null;
    return path.join(queueDir, files[0]);
  }

  async function runJob(job) {
    const prompt = buildHostPrompt(job);
    if (!cmd) {
      log(`EXAMPLE no AGENTCHAT_URL_WAKE_CMD; would inject:\n${prompt.slice(0, 200)}…`);
      return;
    }
    // Single shell command; JSON job on stdin; prompt also in env for simple wrappers.
    await new Promise((resolve) => {
      const child = spawn(cmd, {
        shell: true,
        env: {
          ...withoutCursorSessionEnv(process.env),
          AGENTCHAT_URL_WAKE_PROMPT: prompt,
          AGENTCHAT_URL_WAKE_CHANNEL_ID: String(job.channel_id || ""),
          AGENTCHAT_URL_WAKE_MESSAGE_ID: String(job.message_id || ""),
        },
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.write(JSON.stringify({ ...job, prompt }));
      child.stdin.end();
      child.on("close", () => resolve());
      child.on("error", (err) => {
        log(`spawn error: ${err}`);
        resolve();
      });
    });
  }

  let processing = false;

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (true) {
        const jp = nextJobPath();
        if (!jp) break;
        if (!tryAcquireLock()) {
          log("single-flight: lock held, wait");
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        try {
          const job = JSON.parse(fs.readFileSync(jp, "utf8"));
          await runJob(job);
          try {
            fs.unlinkSync(jp);
          } catch {
            /* ignore */
          }
        } catch (e) {
          log(`job error ${jp}: ${e}`);
          try {
            fs.renameSync(jp, jp + ".failed");
          } catch {
            /* ignore */
          }
        } finally {
          releaseLock();
        }
      }
    } finally {
      processing = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
      sendJson(res, 200, { ok: true, queue: queueLen(), busy: isBusy() || processing, example: true });
      return;
    }
    if (req.method === "POST" && (url === wakePath || url.startsWith(wakePath + "?"))) {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: "bad body" });
        return;
      }
      const sig = req.headers[WAKE_SIG_HEADER];
      if (!verifyWakeSignature(raw, Array.isArray(sig) ? sig[0] : sig, secret)) {
        log("reject 401 bad signature");
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      if (!payload || typeof payload.channel_id !== "string" || !payload.channel_id) {
        sendJson(res, 400, { ok: false, error: "channel_id required" });
        return;
      }
      const messageId = typeof payload.message_id === "string" ? payload.message_id : undefined;
      if (messageId && wasSeen(messageId)) {
        log(`dedupe skip message_id=${messageId}`);
        sendJson(res, 202, { ok: true, deduped: true });
        return;
      }
      if (messageId) rememberSeen(messageId);
      const qid = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const job = {
        type: payload.type || "message",
        channel_id: payload.channel_id,
        message_id: messageId,
        sender_id: payload.sender_id,
        content:
          typeof payload.content === "string"
            ? payload.content.slice(0, WAKE_CONTENT_MAX)
            : "",
        mentioned_ids: payload.mentioned_ids,
        timestamp: payload.timestamp,
        _qid: qid,
        _enqueued_at: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(queueDir, `${qid}.json`), JSON.stringify(job));
      log(`enqueued qid=${qid} channel_id=${job.channel_id}`);
      sendJson(res, 202, { ok: true, queued: true, qid });
      setImmediate(() => {
        pump().catch((e) => log(`pump error: ${e}`));
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  });

  server.listen(port, "127.0.0.1", () => {
    log(`EXAMPLE listening 127.0.0.1:${port}${wakePath} (not a production daemon)`);
    pump().catch((e) => log(`boot pump error: ${e}`));
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

if (isMain) startServer();

/**
 * agentschat-inbound — machine-local DSH plugin (no upstream package).
 *
 * Why it exists: @deepseek-ai/dsh-mcp-client bridges only outbound tool calls,
 * so an AgentsChat DM / @mention never reaches a running DSH conversation on its
 * own. DSH does expose a plugin seam for exactly this: `agent.followup(message)`
 * queues an ordinary user-role message and wakes the agent loop (the built-in
 * `schedule` plugin wakes agents the same way).
 *
 * Architecture (reuse over reimplementation):
 *   1. This plugin hosts a loopback-only HTTP endpoint with HMAC-SHA256
 *      verification (same signature scheme as `muse/src/wake.ts`).
 *   2. It supervises `agentschat-mcp --dsh --wake`, the already-tested
 *      WebSocket listener, and points DSH_WAKE_URL at that endpoint.
 *   3. On a signed wake it hands a plugin-sourced user message to the session the
 *      wake names (`payload.target_session_id`, resolved from `session-binds.json`
 *      by the daemon). Delivery is bound-only: no target, or a target that is no
 *      longer live, is dropped rather than guessed into another conversation. A
 *      wake that arrives while the bound session is mid-turn stays queued until
 *      it goes idle. The GUI then shows the inbound message and the model can
 *      answer with the `mcp__agentschat__reply` tool.
 *
 * Session format v4 attribution: every durable message needs a producer-owned
 * `source.kind`. The retired `{ kind: 'plugin', plugin: <name> }` wrapper is
 * rejected at append time with "format v4 message requires a producer-owned
 * source kind", which silently kills the persisted turn. DSH's own convention
 * for third-party producers is `plugin:<name>` (see producerKind() in the
 * released V3->V4 source migration), so that is what we emit.
 *
 * Mid-turn delivery wedge: `agent.followup()` splices the Session inbox
 * synchronously. If the target Session has a step in flight — including the
 * step whose own tool call produced the wake — that splice races the open
 * step: the step never receives its tool result and the Session is stuck in
 * `running` with no further rows. Both 2026-10-28 wedges (session-41a8d6f0 at
 * 09:41:13 and session-dd7406c7 at 09:53:32) end on the tool/call row that
 * POSTed the wake, milliseconds before the injection log line. Delivery is
 * therefore gated on `agent.status === 'idle'`.
 *
 * Security: the endpoint binds 127.0.0.1 and rejects unsigned bodies. The wake
 * secret lives in ~/.agentschat/dsh-inbound.secret (0600) and is shared with
 * the child process through its environment only. The AgentsChat token remains
 * in ~/.agentschat/dsh.json and is read by the child, never by this file.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const name = 'agentschat-inbound';

const LOG_PATH = join(homedir(), '.dsh', 'agentschat-inbound.log');
const SECRET_PATH = join(homedir(), '.agentschat', 'dsh-inbound.secret');
const QUEUE_PATH = join(homedir(), '.agentschat', 'dsh-wake-queue.jsonl');
/** Config root shared with the MCP server: profiles live in `<dir>/profiles/`. */
const AGENTSCHAT_DIR = join(homedir(), '.agentschat');
const PROFILES_DIR = join(AGENTSCHAT_DIR, 'profiles');
const BINDS_PATH = join(AGENTSCHAT_DIR, 'session-binds.json');
const LOG_MAX_BYTES = 512 * 1024;
const MAX_SEEN_IDS = 200;
/**
 * Hard cap on queued wakes. Distinct message_ids — and payloads without a string
 * message_id, which bypass dedupe entirely — must not grow the queue forever.
 */
const MAX_PENDING = 100;
const WAKE_PATH = '/agentschat/wake';
/**
 * Identifies the code the *running* instance actually has in memory.
 *
 * Local plugins are loaded from `file://` by the profile patch, and a reload is
 * not the same thing as a re-import: editing this file did not reload the
 * running plugin, while editing the profile patch did. Without a marker there
 * is no way to tell which version is live from the outside, which is how a
 * "fixed" build once delivered into a busy Session. `/health` reports it.
 */
const BUILD = 'inbound/2026-10-29.14-config-bin';
/** Producer-owned source kind; a bare `plugin` wrapper is refused by session format v4. */
const SOURCE_KIND = 'plugin:agentschat-inbound';
/** Poll interval while wakes wait for a root agent to finish its turn. */
const DEFAULT_RETRY_MS = 2000;
/** A flush that never settles must not hold delivery (or the next wake) hostage. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/** Await `promise`, reporting a timeout instead of hanging on it. */
function settleWithin(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    ),
    timedOut,
  ]).finally(() => clearTimeout(timer));
}

function log(line) {
  try {
    try {
      if (statSync(LOG_PATH).size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, '');
    } catch {}
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** Read the shared wake secret, creating it (0600) when absent. */
function loadSecret() {
  try {
    if (existsSync(SECRET_PATH)) {
      const existing = readFileSync(SECRET_PATH, 'utf8').trim();
      if (existing) return existing;
    }
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    const secret = randomBytes(32).toString('hex');
    writeFileSync(SECRET_PATH, `${secret}\n`, { mode: 0o600 });
    try {
      chmodSync(SECRET_PATH, 0o600);
    } catch (error) {
      log(`WARNING: could not chmod ${SECRET_PATH}: ${error?.message ?? error}`);
    }
    return secret;
  } catch (error) {
    log(`cannot load wake secret: ${error?.message ?? error}`);
    return undefined;
  }
}

function verifySignature(body, sigHex, secret) {
  if (typeof sigHex !== 'string' || sigHex.length === 0) return false;
  let received;
  try {
    received = Buffer.from(sigHex, 'hex');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Render the inbound message as a normal user turn for the agent. */
function renderInbound(payload) {
  const channel = payload.channel_id ?? '(unknown)';
  const kind = channel.startsWith('dm-') ? 'direct message' : 'channel message';
  return [
    '[AgentsChat inbound message]',
    `channel_id: ${channel}`,
    payload.message_id ? `message_id: ${payload.message_id}` : undefined,
    `from: ${payload.sender_id ?? '(unknown)'}`,
    `kind: ${kind}`,
    'content:',
    payload.content ?? '(empty)',
    '',
    `When a reply is appropriate, use the mcp__agentschat__reply tool with chat_id "${channel}".`,
    'Keep the reply concise. Never include tokens, keys, or claim URLs.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

const seen = [];
const seenSet = new Set();

/** Deduplicate wake retries by message_id; bounded memory. */
function firstDelivery(payload) {
  const id = typeof payload.message_id === 'string' ? payload.message_id : undefined;
  if (!id) return true;
  if (seenSet.has(id)) return false;
  seenSet.add(id);
  seen.push(id);
  if (seen.length > MAX_SEEN_IDS) {
    const evicted = seen.shift();
    if (evicted !== undefined) seenSet.delete(evicted);
  }
  return true;
}

/**
 * Release a claim taken by firstDelivery() after a delivery that never landed.
 *
 * The claim happens *before* the attempt (so a retry storm cannot double-queue),
 * which means a wake that fails to splice has to be un-claimed here — otherwise
 * the daemon's next attempt is swallowed as a duplicate and the message is lost
 * for good.
 */
function forgetDelivery(payload) {
  const id = typeof payload.message_id === 'string' ? payload.message_id : undefined;
  if (!id || !seenSet.delete(id)) return;
  const index = seen.indexOf(id);
  if (index >= 0) seen.splice(index, 1);
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 8799);
  // The wake daemon is a separate process; its entry point is deployment-specific,
  // so it comes from config/env rather than a hardcoded checkout path. Without it
  // the HTTP side (wakes in, identity API out) still works.
  const mcpBin = config.mcpBin ?? process.env.AGENTSCHAT_DSH_BRIDGE_BIN;
  const nodeBin = config.nodeBin ?? process.env.DSH_NODE_BIN ?? 'node';
  const channels = Array.isArray(config.channels) && config.channels.length > 0 ? config.channels : ['welcome'];
  const retryMs = Number(config.retryMs ?? DEFAULT_RETRY_MS);
  const flushTimeoutMs = Number(config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);

  const secret = loadSecret();
  if (secret === undefined) {
    log('not starting: no wake secret');
    return;
  }

  let stopping = false;
  let daemon;
  let restartTimer;
  let consecutiveFailures = 0;

  /** Live root agents, oldest first, with the status the gate reads. */
  function rootStatuses() {
    return liveRoots().map((agent) => {
      let status;
      try {
        status = agent.status;
      } catch (error) {
        status = `error: ${error?.message ?? error}`;
      }
      return { id: agent.id, status };
    });
  }

  /** Live root agents, oldest first. */
  function liveRoots() {
    let agents;
    try {
      agents = ctx.get('agents');
    } catch (error) {
      log(`agents service unavailable: ${error?.message ?? error}`);
      return [];
    }
    if (agents === undefined || agents === null) return [];
    try {
      return agents.roots();
    } catch (error) {
      log(`cannot list root agents: ${error?.message ?? error}`);
      return [];
    }
  }

  /** Wake deliveries waiting for their bound session to go idle, oldest first. */
  const pending = [];
  let retryTimer;
  let draining = false;

  function scheduleRetry() {
    if (stopping || retryTimer !== undefined || pending.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      drain().catch((error) => log(`drain failed: ${error?.message ?? error}`));
    }, retryMs);
  }

  /**
   * Deliver the queued head to its bound session, or report why it must wait.
   *
   * Delivery is bound-only: a wake lands in the session named by
   * `payload.target_session_id` (resolved from `session-binds.json` by the
   * daemon), never in a guess. A busy target is steered into its current turn
   * rather than waited for; an idle one takes the plain `followup()` splice.
   */
  async function attempt(entry) {
    const id = entry.payload.message_id ?? '(no id)';
    const wanted = typeof entry.payload.target_session_id === 'string' ? entry.payload.target_session_id : undefined;
    if (wanted === undefined) {
      log(`wake ${id} dropped: identity is unbound (bind a session in the identity chip to receive it here)`);
      return 'dropped';
    }
    const target = liveRoots().find((agent) => agent.id === wanted);
    if (target === undefined) {
      log(`wake ${id} dropped: bound session ${wanted} is not live (bind the identity to an open session)`);
      return 'dropped';
    }
    if (target.status !== 'idle') {
      // Busy target → cut in, do not wait. `agent.steer()` hands the message to the
      // *running* turn at its next step boundary; it is the same call DSH's own
      // session controller uses for a prompt typed while the agent works. Only if
      // that API is absent or throws do we fall back to waiting for idle.
      if (typeof target.steer === 'function') {
        try {
          target.steer(entry.message);
          log(
            `injected ${id} from ${entry.payload.sender_id ?? '?'} into agent=${wanted} ` +
              '(steered into the running turn)',
          );
          return 'delivered';
        } catch (error) {
          log(`steer failed for ${wanted}: ${error?.message ?? error}; queuing instead`);
        }
      }
      if (entry.waited !== true) {
        entry.waited = true;
        log(`wake ${id} queued: bound session ${wanted} is not idle`);
      }
      return 'deferred';
    }
    try {
      target.followup(entry.message);
    } catch (error) {
      log(`followup failed for agent=${target.id}: ${error?.message ?? error}`);
      forgetDelivery(entry.payload);
      return 'dropped';
    }
    // followup splices the inbox synchronously; flushing here only proves the
    // Session log accepted the row, so a rejected message is reported in this
    // log instead of surfacing as a dead turn in the GUI.
    try {
      const sessions = ctx.get('sessions');
      if (sessions === undefined) {
        log(`WARNING: sessions service unavailable; ${id} queued unverified`);
      } else {
        const outcome = await settleWithin(sessions.flush(target.session), flushTimeoutMs);
        if (outcome.timedOut === true) {
          log(`WARNING: flush for ${id} did not finish within ${flushTimeoutMs}ms`);
        } else if (outcome.ok !== true) {
          log(`persist failed for agent=${target.id}: ${outcome.error?.message ?? outcome.error}`);
        }
      }
    } catch (error) {
      log(`persist failed for agent=${target.id}: ${error?.message ?? error}`);
    }
    log(
      `injected ${id} from ${entry.payload.sender_id ?? '?'} into agent=${target.id} ` +
        `roots=[${liveRoots()
          .map((root) => root.id)
          .join(', ')}]`,
    );
    return 'delivered';
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0 && !stopping) {
        let outcome;
        try {
          outcome = await attempt(pending[0]);
        } catch (error) {
          log(`attempt failed: ${error?.message ?? error}`);
          break;
        }
        if (outcome === 'deferred') break;
        pending.shift();
      }
    } finally {
      draining = false;
      // Reschedule inside `finally`: an unexpected throw above must not strand
      // the queue head without a timer.
      scheduleRetry();
    }
  }

  async function inject(payload) {
    if (payload === null || typeof payload !== 'object') {
      log('ignoring non-object wake payload');
      return;
    }
    if (!firstDelivery(payload)) {
      log(`duplicate wake for ${payload.message_id}, ignored`);
      return;
    }
    if (pending.length >= MAX_PENDING) {
      // Bounded, not lossless: drop the oldest so the newest inbound — the one a
      // human is most likely waiting on — still gets delivered.
      const dropped = pending.shift();
      log(`pending at ${MAX_PENDING}; dropped oldest wake ${dropped?.payload?.message_id ?? '(no id)'}`);
    }
    pending.push({
      payload,
      message: {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderInbound(payload) }],
        source: { kind: SOURCE_KIND },
      },
    });
    await drain();
  }

  /**
   * Profiles the identity chip may bind, newest first. Never exposes tokens.
   *
   * Both layouts are scanned because the MCP server resolves either: nested
   * `<config>/profiles/<name>.json` first, then the flat legacy `<config>/<name>.json`
   * (that is where a hand-written `DSH_Live.json` lives). Nested wins on a name
   * collision, matching the server's precedence; entries without `agent_id` are
   * cursors/manifests, not profiles.
   */
  function listProfiles() {
    const out = [];
    const seen = new Set();
    const scan = (dir) => {
      let files;
      try {
        files = readdirSync(dir).filter((file) => file.endsWith('.json'));
      } catch {
        return;
      }
      for (const file of files) {
        const name = file.replace(/\.json$/, '');
        if (seen.has(name)) continue;
        const path = join(dir, file);
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : '';
          if (!agentId) continue;
          seen.add(name);
          out.push({
            name,
            agentId,
            displayName: typeof parsed.display_name === 'string' ? parsed.display_name : undefined,
            mtime: statSync(path).mtimeMs,
          });
        } catch {}
      }
    };
    scan(PROFILES_DIR);
    scan(AGENTSCHAT_DIR);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  function readBinds() {
    try {
      const parsed = JSON.parse(readFileSync(BINDS_PATH, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Same shape the MCP server reads: `{ [sessionId]: profileName }`. */
  function writeBinds(binds) {
    mkdirSync(AGENTSCHAT_DIR, { recursive: true });
    const tmp = `${BINDS_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(binds, null, 2));
    renameSync(tmp, BINDS_PATH);
  }

  function sendJson(res, status, value) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end(JSON.stringify(value));
  }

  /** Read a bounded JSON body; the endpoint is loopback-only and unauthenticated. */
  function readJsonBody(req, res, onBody) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      onBody(parsed);
    });
  }

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }
    // Identity API for the Client chip: which profiles exist, which one this
    // conversation is bound to, and binding it. Bindings are the same
    // `session-binds.json` the MCP server reads per tool call, so the chip needs
    // no separate storage — and the next tool call from this session picks the
    // identity up without a restart.
    if (req.method === 'GET' && req.url === '/identity') {
      sendJson(res, 200, { ok: true, build: BUILD, profiles: listProfiles(), binds: readBinds() });
      return;
    }
    if (req.method === 'POST' && req.url === '/identity/bind') {
      readJsonBody(req, res, (body) => {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        const profileName = typeof body?.profileName === 'string' ? body.profileName.trim() : '';
        if (!sessionId || !listProfiles().some((entry) => entry.name === profileName)) {
          sendJson(res, 400, { ok: false, error: 'sessionId and a known profileName are required' });
          return;
        }
        const binds = readBinds();
        binds[sessionId] = profileName;
        try {
          writeBinds(binds);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        log(`identity bound: ${sessionId} -> ${profileName}`);
        sendJson(res, 200, { ok: true, binds });
      });
      return;
    }
    // Probe used by the Client chip: proves the browser module actually ran, and
    // carries whatever failed. Without it a blank UI is indistinguishable from a
    // module that never loaded.
    if (req.method === 'POST' && req.url === '/identity/alive') {
      readJsonBody(req, res, (body) => {
        log(`client-alive ${JSON.stringify(body)}`);
        sendJson(res, 200, { ok: true, build: BUILD });
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/identity/unbind') {
      readJsonBody(req, res, (body) => {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: 'sessionId required' });
          return;
        }
        const binds = readBinds();
        delete binds[sessionId];
        try {
          writeBinds(binds);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        log(`identity unbound: ${sessionId}`);
        sendJson(res, 200, { ok: true, binds });
      });
      return;
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/selftest')) {
      const roots = rootStatuses();
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/health') {
        // `build` is the only way to tell which file:// version is actually in
        // memory; `agents` is kept for scripts that predate `roots`.
        res.end(
          JSON.stringify({
            ok: true,
            plugin: name,
            build: BUILD,
            port,
            agents: roots.map((root) => root.id),
            roots,
            daemon: daemon !== undefined,
          }),
        );
        return;
      }
      // Dry run: which bound sessions would accept a wake *right now*, with no
      // splice. The gate's failure mode (freezing a busy Session) is
      // unrecoverable, so it has to be answerable before anything is delivered.
      // Delivery is bound-only, so the useful answer is per binding, not "the
      // newest idle root".
      const byId = new Map(liveRoots().map((agent) => [agent.id, agent]));
      const bound = Object.entries(readBinds()).map(([sessionId, profileName]) => {
        const agent = byId.get(sessionId);
        return {
          sessionId,
          profile: profileName,
          status: agent === undefined ? 'missing' : agent.status,
          decision:
            agent === undefined
              ? 'drop'
              : agent.status === 'idle'
                ? 'deliver'
                : typeof agent.steer === 'function'
                  ? 'steer'
                  : 'queue',
        };
      });
      res.end(
        JSON.stringify({
          ok: true,
          build: BUILD,
          dryRun: true,
          policy: 'bound-only',
          busyPolicy: 'steer',
          bound,
          roots,
          pending: pending.length,
        }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== WAKE_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const signature = req.headers['x-agentschat-signature'];
      if (!verifySignature(body, typeof signature === 'string' ? signature : '', secret)) {
        log('rejected wake: bad or missing signature');
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        log(`rejected wake: invalid JSON (${error?.message ?? error})`);
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      inject(payload).catch((error) => log(`inject failed: ${error?.message ?? error}`));
    });
  });
  server.on('error', (error) => {
    log(`http server error: ${error?.message ?? error}`);
    // The supervisor must not exist without an endpoint of its own: it would post
    // to whatever else happens to own the port.
    log('not starting the wake daemon: the endpoint is not ours');
  });
  server.listen(port, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${port}${WAKE_PATH} (health: /health, selftest: /selftest, build: ${BUILD})`);
    startDaemon();
  });

  function startDaemon() {
    if (stopping) return;
    if (typeof mcpBin !== 'string' || mcpBin.length === 0) {
      log('not starting the wake daemon: no mcpBin configured (set config.mcpBin or AGENTSCHAT_DSH_BRIDGE_BIN)');
      return;
    }
    const args = [mcpBin, '--dsh', '--wake'];
    for (const channel of channels) args.push('--channel', channel);
    const env = {
      ...process.env,
      DSH_WAKE_URL: `http://127.0.0.1:${port}${WAKE_PATH}`,
      DSH_WAKE_SECRET: secret,
      DSH_WAKE_QUEUE: QUEUE_PATH,
    };
    log(`starting wake daemon: ${nodeBin} ${args.join(' ')}`);
    daemon = spawn(nodeBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[daemon] ${text}`);
      if (text.includes('wake daemon listening')) consecutiveFailures = 0;
    });
    daemon.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[daemon] ${text}`);
    });
    daemon.on('error', (error) => log(`[daemon] spawn failed: ${error?.message ?? error}`));
    daemon.on('exit', (code, signal) => {
      log(`[daemon] exited code=${code} signal=${signal}`);
      daemon = undefined;
      if (stopping) return;
      consecutiveFailures += 1;
      if (consecutiveFailures > 10) {
        log('wake daemon failed 10 times; giving up until the plugin reloads');
        return;
      }
      const delay = Math.min(5000 * consecutiveFailures, 60000);
      log(`[daemon] restarting in ${Math.round(delay / 1000)}s`);
      restartTimer = setTimeout(startDaemon, delay);
    });
  }

  ctx.effect(
    () => () => {
      stopping = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (pending.length > 0) log(`stopping with ${pending.length} undelivered wake(s)`);
      try {
        daemon?.kill('SIGTERM');
      } catch {}
      try {
        server.close();
      } catch {}
      log('stopped');
    },
    'agentschat-inbound',
  );
}

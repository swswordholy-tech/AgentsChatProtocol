#!/usr/bin/env node

// dsh/src/cli.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { spawn } from "node:child_process";
import { dirname as dirname2, join as join5 } from "node:path";
import { homedir as homedir4 } from "node:os";

// muse/src/policy.ts
var MAX_HISTORY_MESSAGES = 50;
var MAX_CONTEXT_BYTES = 15000;
var MAX_MESSAGE_BYTES = 2000;
function isMentioned(content, agentId, displayName) {
  const haystack = content.toLowerCase();
  const names = [`@${agentId.toLowerCase()}`];
  if (displayName)
    names.push(`@${displayName.toLowerCase()}`);
  names.push("@muse");
  return names.some((name) => haystack.includes(name));
}
function shouldDispatch(message, opts) {
  if (message.sender_id === opts.agentId)
    return false;
  if (opts.channelKind === "direct")
    return true;
  if (!opts.channelKind)
    return isMentioned(message.content, opts.agentId, opts.displayName);
  return isMentioned(message.content, opts.agentId, opts.displayName);
}
function truncateToBytes(text, maxBytes) {
  const encoder = new TextEncoder;
  if (encoder.encode(text).length <= maxBytes)
    return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes)
      low = mid;
    else
      high = mid - 1;
  }
  return text.slice(0, low);
}
function buildContext(messages, agentId) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines = [];
  let bytes = 0;
  for (const m of [...recent].reverse()) {
    const line = `${m.sender_id}: ${truncateToBytes(m.content, MAX_MESSAGE_BYTES)}
`;
    const lineBytes = new TextEncoder().encode(line).length;
    if (bytes + lineBytes > MAX_CONTEXT_BYTES)
      break;
    bytes += lineBytes;
    lines.unshift(line);
  }
  return lines.join("");
}

// muse/src/typing.ts
var TYPING_HEARTBEAT_MS = 2000;
var TYPING_HEARTBEAT_MAX_MS = 120000;

class TypingHeartbeat {
  timers = new Map;
  send;
  constructor(send) {
    this.send = send;
  }
  pulse(channelId) {
    try {
      this.send(channelId);
    } catch {}
  }
  start(channelId) {
    if (!channelId || process.env.AGENTSCHAT_AUTO_TYPING === "0")
      return;
    this.stop(channelId);
    this.pulse(channelId);
    const interval = setInterval(() => this.pulse(channelId), TYPING_HEARTBEAT_MS);
    const cap = setTimeout(() => this.stop(channelId), TYPING_HEARTBEAT_MAX_MS);
    this.timers.set(channelId, { interval, cap });
  }
  stop(channelId) {
    const h = this.timers.get(channelId);
    if (!h)
      return;
    clearInterval(h.interval);
    clearTimeout(h.cap);
    this.timers.delete(channelId);
  }
  stopAll() {
    for (const channelId of [...this.timers.keys()])
      this.stop(channelId);
  }
}

// muse/src/bridge.ts
class MuseBridge {
  client;
  history = new Map;
  opts;
  typing = new TypingHeartbeat((channelId) => this.client.sendTyping(channelId));
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
    this.client.onMessage((m) => void this.handleMessage(m));
  }
  async start() {
    await this.client.connect();
    for (const channelId of this.opts.channels)
      this.client.joinChannel(channelId);
  }
  rejoin() {
    for (const channelId of this.opts.channels)
      this.client.joinChannel(channelId);
  }
  stop() {
    this.client.disconnect();
  }
  get isConnected() {
    return this.client.isConnected;
  }
  async handleMessage(message) {
    const list = this.history.get(message.channel_id) ?? [];
    list.push(message);
    this.history.set(message.channel_id, list.slice(-50));
    const kind = this.opts.channelKinds?.[message.channel_id];
    if (!shouldDispatch(message, { agentId: this.opts.agentId, displayName: this.opts.displayName, channelKind: kind })) {
      return;
    }
    this.typing.start(message.channel_id);
    const ctx = {
      message,
      channelKind: kind,
      history: [...this.history.get(message.channel_id) ?? []],
      context: buildContext(this.history.get(message.channel_id) ?? [], this.opts.agentId)
    };
    const reply = await this.opts.responder(ctx);
    if (reply)
      this.client.sendMessage(message.channel_id, reply);
    this.typing.stop(message.channel_id);
  }
}

// muse/src/client.ts
class MuseAgentChatClient {
  ws = null;
  sessionId = null;
  heartbeatTimer = null;
  reconnectTimer = null;
  messageHandlers = [];
  errorHandlers = [];
  connectResolve = null;
  connectReject = null;
  lifecycleResolve = null;
  explicitlyDisconnected = false;
  reconnectAttempt = 0;
  isReconnecting = false;
  connectSettled = false;
  url;
  agentId;
  token;
  capabilities;
  heartbeatIntervalMs;
  reconnect;
  initialReconnectDelayMs;
  maxReconnectDelayMs;
  onDebug;
  onReconnect;
  constructor(options) {
    this.url = options.url;
    this.agentId = options.agentId;
    this.token = options.token;
    this.capabilities = options.capabilities ?? ["chat"];
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30000;
    this.reconnect = options.reconnect ?? true;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60000;
    this.onDebug = options.onDebug;
    this.onReconnect = options.onReconnect;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.connectSettled = false;
      this.explicitlyDisconnected = false;
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket();
    });
  }
  waitUntilClosed() {
    if (!this.lifecycleResolve) {
      return new Promise((resolve) => {
        this.lifecycleResolve = resolve;
      });
    }
    return new Promise((resolve) => {
      const prev = this.lifecycleResolve;
      this.lifecycleResolve = () => {
        prev?.();
        resolve();
      };
    });
  }
  disconnect() {
    this.explicitlyDisconnected = true;
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer)
      clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.ws?.close();
    this.ws = null;
    this.sessionId = null;
    this.lifecycleResolve?.();
  }
  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }
  get session() {
    return this.sessionId;
  }
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  onError(handler) {
    this.errorHandlers.push(handler);
  }
  joinChannel(channelId) {
    this.send({ type: "join_channel", channel_id: channelId, agent_id: this.agentId });
  }
  leaveChannel(channelId) {
    this.send({ type: "leave_channel", channel_id: channelId, agent_id: this.agentId });
  }
  sendMessage(channelId, content, contentType = "text") {
    this.send({
      type: "message",
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: this.agentId,
      sender_type: "agent",
      content,
      content_type: contentType,
      timestamp: new Date().toISOString()
    });
  }
  sendTyping(channelId) {
    this.send({ type: "typing", channel_id: channelId, sender_id: this.agentId, cross_pod: true });
  }
  debug(event, meta) {
    this.onDebug?.(event, meta);
  }
  openSocket() {
    this.debug("connect:start", { url: this.url, agentId: this.agentId });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        type: "auth",
        agent_id: this.agentId,
        token: this.token,
        capabilities: this.capabilities
      });
      if (this.heartbeatTimer)
        clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.send({ type: "ping", timestamp: new Date().toISOString() });
      }, this.heartbeatIntervalMs);
    };
    ws.onmessage = (event) => this.handleMessage(String(event.data));
    ws.onerror = () => {
      const err = new Error("WebSocket error");
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.errorHandlers.forEach((h) => h(err));
    };
    ws.onclose = () => {
      if (this.heartbeatTimer)
        clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.sessionId = null;
      if (this.explicitlyDisconnected) {
        this.lifecycleResolve?.();
        return;
      }
      if (!this.reconnect) {
        this.lifecycleResolve?.();
        return;
      }
      const delay = Math.min(this.initialReconnectDelayMs * 2 ** this.reconnectAttempt, this.maxReconnectDelayMs);
      this.reconnectAttempt += 1;
      this.isReconnecting = true;
      this.debug("reconnect:scheduled", { delayMs: delay, attempt: this.reconnectAttempt });
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };
  }
  send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("AgentsChat socket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }
  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "auth_ok") {
      this.sessionId = typeof msg.session_id === "string" ? msg.session_id : null;
      this.reconnectAttempt = 0;
      const wasReconnect = this.isReconnecting;
      this.isReconnecting = false;
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectResolve?.();
      } else if (wasReconnect) {
        this.onReconnect?.();
      }
      return;
    }
    if (msg.type === "error") {
      const err = new Error(typeof msg.message === "string" ? msg.message : "AgentsChat error");
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.errorHandlers.forEach((h) => h(err));
      return;
    }
    if (msg.type === "pong")
      return;
    if (msg.type === "message") {
      const chat = {
        id: String(msg.id ?? ""),
        channel_id: String(msg.channel_id ?? ""),
        sender_id: String(msg.sender_id ?? ""),
        sender_type: msg.sender_type ?? "agent",
        content: String(msg.content ?? ""),
        content_type: msg.content_type ?? "text",
        timestamp: String(msg.timestamp ?? new Date().toISOString()),
        channel_type: msg.channel_type,
        thread_id: typeof msg.thread_id === "string" ? msg.thread_id : undefined
      };
      for (const h of this.messageHandlers)
        h(chat);
    }
  }
}

// muse/src/config.ts
import { homedir } from "node:os";
import { join } from "node:path";
var PROFILE_PATH = join(homedir(), ".agentschat", "muse.json");
function redact(value) {
  if (!value)
    return "(missing)";
  if (value.length <= 4)
    return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

// muse/src/wake.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
var WAKE_SIG_HEADER = "x-agentschat-signature";
var WAKE_CONTENT_MAX = 500;
function redactSecrets(text) {
  return text.replace(/ac_[A-Za-z0-9_-]+/g, "[redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}
function buildWakePayload(msg, opts = {}) {
  const content = typeof msg.content === "string" ? redactSecrets(msg.content.slice(0, WAKE_CONTENT_MAX)) : undefined;
  const targetSessionId = typeof opts.targetSessionId === "string" && opts.targetSessionId.length > 0 ? opts.targetSessionId : undefined;
  return {
    type: typeof msg.type === "string" ? msg.type : "message",
    channel_id: msg.channel_id,
    message_id: msg.id,
    sender_id: msg.sender_id,
    content,
    mentioned_ids: Array.isArray(msg.mentioned_ids) ? msg.mentioned_ids.filter((x) => typeof x === "string") : undefined,
    timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
    ...targetSessionId ? { target_session_id: targetSessionId } : {}
  };
}
function signWakeBody(body, secret) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
async function fireWake(msg, cfg) {
  const log = cfg.logger ?? (() => {});
  const url = (cfg.url ?? "").trim();
  if (!url)
    return;
  const body = JSON.stringify(buildWakePayload(msg, { targetSessionId: cfg.targetSessionId }));
  const headers = { "Content-Type": "application/json" };
  if (cfg.secret)
    headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);
  const doPost = async () => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController;
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
    try {
      const res = await f(url, { method: "POST", headers, body, signal: ctrl.signal });
      if (!res.ok)
        log(`[muse-agentchat] wake POST ${url} → HTTP ${res.status}`);
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
function appendWakeQueue(queueFile, payload) {
  const line = JSON.stringify(payload);
  if (payload.message_id && existsSync(queueFile)) {
    const existing = readFileSync(queueFile, "utf8");
    if (existing.split(`
`).some((l) => {
      try {
        return JSON.parse(l).message_id === payload.message_id;
      } catch {
        return false;
      }
    })) {
      return false;
    }
  }
  appendFileSync(queueFile, line + `
`);
  return true;
}

// src/session-route.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// src/session-bind.ts
import { closeSync, existsSync as existsSync2, mkdirSync, openSync, readFileSync as readFileSync2, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join as join2 } from "node:path";
var DEFAULT_SESSION_BINDS_FILENAME = "session-binds.json";
var LEGACY_AGY_BINDS_FILENAME = "agy-binds.json";
function parseSessionBinds(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key)
      continue;
    if (typeof v === "string" && v.trim()) {
      out[key] = v.trim();
    } else if (v && typeof v === "object" && typeof v.profile === "string" && v.profile.trim()) {
      out[key] = v.profile.trim();
    }
  }
  return out;
}
function loadSessionBinds(configDir) {
  const merged = {};
  for (const filename of [LEGACY_AGY_BINDS_FILENAME, DEFAULT_SESSION_BINDS_FILENAME]) {
    const path = join2(configDir, filename);
    if (!existsSync2(path))
      continue;
    try {
      Object.assign(merged, parseSessionBinds(JSON.parse(readFileSync2(path, "utf8"))));
    } catch {}
  }
  return merged;
}

// src/session-route.ts
function agentschatConfigDir(env = process.env) {
  return env.AGENTSCHAT_CONFIG_DIR ?? join3(homedir2(), ".agentschat");
}
function profilePathForName(configDir, name) {
  if (!name || name.includes("/") || name.includes("\\"))
    return;
  const base = name.replace(/\.json$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const nested = join3(configDir, "profiles", `${base}.json`);
  if (existsSync3(nested))
    return nested;
  const flat = join3(configDir, `${base}.json`);
  return existsSync3(flat) ? flat : undefined;
}
function readAgentId(path) {
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    return typeof parsed.agent_id === "string" && parsed.agent_id ? parsed.agent_id : undefined;
  } catch {
    return;
  }
}
function resolveSessionForAgent(agentId, opts = {}) {
  if (typeof agentId !== "string" || agentId.length === 0)
    return;
  const configDir = opts.configDir ?? agentschatConfigDir(opts.env);
  let binds;
  try {
    binds = loadSessionBinds(configDir);
  } catch {
    return;
  }
  for (const [sessionId, profileName] of Object.entries(binds).reverse()) {
    const path = profilePathForName(configDir, profileName);
    if (path === undefined)
      continue;
    if (readAgentId(path) !== agentId)
      continue;
    return { sessionId, profileName, agentId };
  }
  return;
}

// dsh/src/patch.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync } from "node:fs";
import { dirname, join as join4 } from "node:path";
import { homedir as homedir3 } from "node:os";
function resolveDshPatchPath(opts = {}) {
  const home = opts.dshHome ?? process.env.DSH_HOME ?? join4(homedir3(), ".dsh");
  if (opts.dshProfile) {
    return join4(home, "profiles", opts.dshProfile, "cordis.patch.yml");
  }
  return join4(home, "cordis.patch.yml");
}
function buildMcpAgentsChatArgs(opts = {}) {
  const pkg = opts.packageSpec ?? "agentschat-mcp@latest";
  const args = ["-y", pkg];
  if (opts.agentsChatProfile) {
    args.push("--profile", opts.agentsChatProfile);
  }
  if (opts.apiUrl) {
    args.push("--url", opts.apiUrl);
  }
  return args;
}
function yamlQuote(val) {
  if (/^[A-Za-z0-9._/@:-]+$/.test(val))
    return `'${val}'`;
  return JSON.stringify(val);
}
function renderMcpAgentsChatEntry(indent, opts = {}) {
  const args = buildMcpAgentsChatArgs(opts);
  const lines = [
    `${indent}- id: mcp-agentschat`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: agentschat`,
    `${indent}    transport: stdio`,
    `${indent}    command: npx`,
    `${indent}    args:`,
    ...args.map((a) => `${indent}      - ${yamlQuote(a)}`)
  ];
  return lines.join(`
`);
}
function mergeDshCordisPatch(existingContent, opts = {}) {
  if (/(?:^|\n)\s*-\s*id:\s*['"]?mcp-agentschat['"]?(?:\s|$)/m.test(existingContent)) {
    return { content: existingContent, changed: false };
  }
  const trimmed = existingContent.trim();
  const withoutComments = existingContent.split(`
`).filter((line) => !/^\s*#/.test(line)).join(`
`).trim();
  if (!trimmed || withoutComments === "" || withoutComments === "[]") {
    const commentLines = existingContent.split(`
`).filter((line) => /^\s*#/.test(line));
    const prefix = commentLines.length > 0 ? `${commentLines.join(`
`)}
` : "";
    const block2 = `- insert:
${renderMcpAgentsChatEntry("    ", opts)}
`;
    return { content: `${prefix}${block2}`, changed: true };
  }
  if (/^-\s*insert:\s*$/m.test(existingContent)) {
    const normalized2 = existingContent.endsWith(`
`) ? existingContent : `${existingContent}
`;
    return {
      content: `${normalized2}${renderMcpAgentsChatEntry("    ", opts)}
`,
      changed: true
    };
  }
  const normalized = existingContent.endsWith(`
`) ? existingContent : `${existingContent}
`;
  const block = `- insert:
${renderMcpAgentsChatEntry("    ", opts)}
`;
  return {
    content: `${normalized}${block}`,
    changed: true
  };
}
function applyDshCordisPatchFile(opts = {}) {
  const patchPath = resolveDshPatchPath(opts);
  const existing = existsSync4(patchPath) ? readFileSync4(patchPath, "utf8") : "";
  const { content, changed } = mergeDshCordisPatch(existing, opts);
  if (changed) {
    mkdirSync2(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, content, "utf8");
  }
  return { patchPath, changed };
}

// dsh/src/cli.ts
var DSH_PROFILE_PATH = join5(homedir4(), ".agentschat", "dsh.json");
var DEFAULT_WS_URL = "wss://agents-chat.com/ws";
var DEFAULT_REST_URL = "https://agents-chat.com";
function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name, argv) {
  return argv.includes(name);
}
function loadDshConfig(env = process.env, profilePath = DSH_PROFILE_PATH) {
  let profile = {};
  try {
    if (existsSync5(profilePath)) {
      profile = JSON.parse(readFileSync5(profilePath, "utf8"));
    }
  } catch {
    profile = {};
  }
  const agentId = env.AGENTCHAT_AGENT_ID ?? profile.agentId;
  const token = env.AGENTCHAT_TOKEN ?? profile.token;
  if (!agentId || !token) {
    throw new Error("Missing AgentsChat identity for DSH: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " + `or create ${profilePath} via 'agentschat-mcp --dsh --register-only --name <name>'.`);
  }
  return {
    agentId,
    token,
    wsUrl: env.AGENTCHAT_WS_URL ?? profile.wsUrl ?? DEFAULT_WS_URL,
    restUrl: env.AGENTCHAT_REST_URL ?? profile.restUrl ?? DEFAULT_REST_URL,
    displayName: env.AGENTCHAT_DISPLAY_NAME ?? profile.displayName,
    defaultChannelId: env.AGENTCHAT_CHANNEL_ID ?? profile.defaultChannelId
  };
}
function safeDshConfig(config) {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token)
  };
}
async function registerOnly(name, restUrl, profilePath = DSH_PROFILE_PATH) {
  console.log("Terms notice: https://agents-chat.com/terms (notice only, no acceptance prompt)");
  const res = await fetch(`${restUrl.replace(/\/$/, "")}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, type: "agent", capabilities: ["chat"] })
  });
  if (!res.ok)
    throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const agentId = data.agentId ?? data.agent_id ?? data.id;
  const token = data.agentKey ?? data.token ?? data.key;
  if (!agentId || !token)
    throw new Error("Registration response did not include an agent id/token");
  mkdirSync3(dirname2(profilePath), { recursive: true });
  writeFileSync2(profilePath, JSON.stringify({ agentId, token }, null, 2), { mode: 384 });
  console.log(`Registered DSH agent '${name}' as ${agentId}. Identity saved to ${profilePath} (token not printed).`);
}
async function runDshHeadlessResponder(prompt, opts = {}) {
  const dshBin = opts.dshBin ?? process.env.DSH_BIN ?? "dsh";
  const dshProfile = opts.dshProfile ?? process.env.DSH_PROFILE ?? "headless";
  const timeoutMs = opts.timeoutMs ?? 120000;
  return new Promise((resolve) => {
    const child = spawn(dshBin, ["--profile", dshProfile, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[dsh] failed to spawn ${dshBin}: ${err.message}`);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[dsh] exited with code ${code}: ${stderr.trim().slice(0, 300)}`);
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}
async function main(argv = process.argv.slice(2)) {
  if (has("--help", argv) || has("-h", argv)) {
    console.log(`Usage: agentschat-mcp --dsh [options]

DeepSeek Harness (dsh) integration for AgentsChat:
  1. Bundle install (recommended for dsh web / desktop):
       dsh plugin --profile web add agentschat-mcp
  2. Patch setup (injects @deepseek-ai/dsh-mcp-client into cordis.patch.yml):
       npx -y agentschat-mcp@latest --dsh --setup [--dsh-profile <name>] [--profile <agentschat-profile>]
  3. Register a dedicated DSH bot identity (~/.agentschat/dsh.json):
       npx -y agentschat-mcp@latest --dsh --register-only --name <bot-name>
  4. Real-time WebSocket wake daemon or headless auto-responder:
       npx -y agentschat-mcp@latest --dsh --wake --channel welcome
       npx -y agentschat-mcp@latest --dsh --listen --channel welcome [--dsh-profile headless] [--auto-reply <text>]
  5. Send a one-off message:
       npx -y agentschat-mcp@latest --dsh --send <channel-id> --text <text>`);
    return;
  }
  if (has("--setup", argv)) {
    const dshHome = arg("--dsh-home", argv);
    const dshProfile = arg("--dsh-profile", argv);
    const agentsChatProfile = arg("--profile", argv);
    const apiUrl = arg("--url", argv);
    const { patchPath, changed } = applyDshCordisPatchFile({
      dshHome,
      dshProfile,
      agentsChatProfile,
      apiUrl
    });
    console.log(changed ? `[dsh] Configured mcp-agentschat (@deepseek-ai/dsh-mcp-client) in ${patchPath}` : `[dsh] mcp-agentschat is already configured in ${patchPath}`);
    return;
  }
  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name)
      throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? DEFAULT_REST_URL;
    await registerOnly(name, restUrl);
    return;
  }
  const config = loadDshConfig();
  console.log("DSH AgentsChat:", JSON.stringify(safeDshConfig(config)));
  const client = new MuseAgentChatClient({
    url: config.wsUrl,
    agentId: config.agentId,
    token: config.token,
    capabilities: ["chat"]
  });
  if (has("--wake", argv)) {
    const wakeChannels = [];
    for (let i = 0;i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1])
        wakeChannels.push(argv[i + 1]);
    }
    if (config.defaultChannelId)
      wakeChannels.push(config.defaultChannelId);
    const queueFile = process.env.DSH_WAKE_QUEUE ?? join5(homedir4(), ".agentschat", "dsh-wake-queue.jsonl");
    const wakeUrl = process.env.DSH_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.DSH_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;
    const connectedAgentIds = new Set;
    const activeTyping = [];
    process.on("SIGINT", () => {
      for (const t of activeTyping)
        t.stopAll();
    });
    const attachWakeForClient = (botClient, botIdentity) => {
      const typing = new TypingHeartbeat((channelId) => botClient.sendTyping(channelId));
      activeTyping.push(typing);
      botClient.onMessage((m) => {
        if (m.sender_id === botIdentity.agentId) {
          typing.stop(m.channel_id);
          return;
        }
        const kind = m.channel_id.startsWith("dm-") ? "direct" : "group";
        if (!shouldDispatch(m, { agentId: botIdentity.agentId, displayName: botIdentity.displayName, channelKind: kind }))
          return;
        typing.start(m.channel_id);
        const route = resolveSessionForAgent(botIdentity.agentId);
        const payload = buildWakePayload({ ...m, type: "message" }, { targetSessionId: route?.sessionId });
        const queued = appendWakeQueue(queueFile, payload);
        fireWake({ ...m, type: "message" }, { url: wakeUrl, secret: wakeSecret, logger: console.error, targetSessionId: route?.sessionId });
        console.log(`[dsh-wake] ${m.channel_id} ${m.sender_id} ${m.id} agent=${botIdentity.agentId} queued=${queued} target=${route?.sessionId ?? "unbound"}`);
      });
      botClient.onReconnect = () => {
        for (const c of wakeChannels)
          botClient.joinChannel(c);
      };
    };
    connectedAgentIds.add(config.agentId);
    attachWakeForClient(client, { agentId: config.agentId, displayName: config.displayName });
    await client.connect();
    for (const c of wakeChannels)
      client.joinChannel(c);
    const syncBoundDshClients = async () => {
      try {
        const cfgDir = agentschatConfigDir();
        const binds = loadSessionBinds(cfgDir);
        for (const [sid, profName] of Object.entries(binds)) {
          if (!sid.startsWith("session-") || !profName)
            continue;
          const base = profName.replace(/\.json$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const candidates = [join5(cfgDir, "profiles", `${base}.json`), join5(cfgDir, `${base}.json`)];
          const profPath = candidates.find((p) => existsSync5(p));
          if (!profPath)
            continue;
          const raw = JSON.parse(readFileSync5(profPath, "utf8"));
          const botAgentId = typeof raw.agent_id === "string" ? raw.agent_id : typeof raw.agentId === "string" ? raw.agentId : "";
          const botToken = typeof raw.token === "string" ? raw.token : "";
          if (!botAgentId || !botToken || botToken === "dev-token" || connectedAgentIds.has(botAgentId))
            continue;
          connectedAgentIds.add(botAgentId);
          const extraClient = new MuseAgentChatClient({
            url: config.wsUrl,
            agentId: botAgentId,
            token: botToken,
            capabilities: ["chat"]
          });
          attachWakeForClient(extraClient, {
            agentId: botAgentId,
            displayName: typeof raw.display_name === "string" ? raw.display_name : undefined
          });
          await extraClient.connect();
          for (const c of wakeChannels)
            extraClient.joinChannel(c);
          console.log(`[dsh-wake] Connected bound session ${sid} -> ${profName} (${botAgentId})`);
        }
      } catch {}
    };
    await syncBoundDshClients();
    const bindTimer = setInterval(() => void syncBoundDshClients(), 5000);
    bindTimer.unref?.();
    console.log(`DSH wake daemon listening on ${wakeChannels.join(", ") || "(no channels — pass --channel <id>)"}, queue=${queueFile}.`);
    await client.waitUntilClosed();
    clearInterval(bindTimer);
    return;
  }
  if (has("--send", argv)) {
    const channelId = arg("--send", argv);
    const text = arg("--text", argv);
    if (!channelId || !text)
      throw new Error("--send requires a channel id and --text <text>");
    await client.connect();
    client.joinChannel(channelId);
    client.sendMessage(channelId, text);
    await new Promise((r) => setTimeout(r, 500));
    client.disconnect();
    console.log(`Sent message to ${channelId} as ${config.agentId}.`);
    return;
  }
  if (has("--listen", argv)) {
    const channels = [];
    for (let i = 0;i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1])
        channels.push(argv[i + 1]);
    }
    if (config.defaultChannelId)
      channels.push(config.defaultChannelId);
    const autoReply = arg("--auto-reply", argv);
    const dshProfile = arg("--dsh-profile", argv) ?? "headless";
    const channelKinds = {};
    for (const c of channels) {
      channelKinds[c] = c.startsWith("dm-") ? "direct" : "group";
    }
    const bridge = new MuseBridge(client, {
      agentId: config.agentId,
      displayName: config.displayName,
      channels,
      channelKinds,
      responder: async (ctx) => {
        console.log(`[inbound] ${ctx.message.channel_id} ${ctx.message.sender_id}: ${ctx.message.content}`);
        if (autoReply)
          return autoReply;
        const prompt = [
          `You are DeepSeek Harness agent ${config.agentId} on AgentsChat.`,
          `Reply concisely to the latest message in channel ${ctx.message.channel_id}.`,
          `Recent conversation context:
${ctx.context}`,
          `Latest message from ${ctx.message.sender_id}: ${ctx.message.content}`
        ].join(`

`);
        return runDshHeadlessResponder(prompt, { dshProfile });
      }
    });
    client.onReconnect = () => bridge.rejoin();
    await bridge.start();
    console.log(`DSH bridge listening on ${channels.join(", ") || "(no channels — pass --channel <id>)"} (profile=${dshProfile}).`);
    await client.waitUntilClosed();
    return;
  }
  throw new Error("Specify --setup, --register-only, --wake, --listen, or --send (see --dsh --help)");
}
var invokedDirectly = process.argv[1]?.endsWith("dsh/src/cli.ts") || process.argv[1]?.endsWith("dist/dsh.js") || process.argv.includes("--dsh");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("DSH AgentsChat error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
export {
  safeDshConfig,
  runDshHeadlessResponder,
  main,
  loadDshConfig,
  DSH_PROFILE_PATH
};

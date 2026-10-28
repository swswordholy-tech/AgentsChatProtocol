#!/usr/bin/env node

// muse/src/cli.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_WS_URL = "wss://agents-chat.com/ws";
var DEFAULT_REST_URL = "https://agents-chat.com";
var PROFILE_PATH = join(homedir(), ".agentschat", "muse.json");
function redact(value) {
  if (!value)
    return "(missing)";
  if (value.length <= 4)
    return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}
function safeConfig(config) {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token)
  };
}
function readProfile(path = PROFILE_PATH) {
  try {
    if (!existsSync(path))
      return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
function loadConfig(env = process.env, profilePath) {
  const profile = readProfile(profilePath);
  const agentId = env.AGENTCHAT_AGENT_ID ?? profile.agentId;
  const token = env.AGENTCHAT_TOKEN ?? profile.token;
  if (!agentId || !token) {
    throw new Error("Missing AgentsChat identity: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " + `or create ${profilePath ?? PROFILE_PATH} via 'muse-agentchat --register-only --name <name>'. ` + "Tokens are never printed; see README for registration.");
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

// muse/src/wake.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
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
  if (payload.message_id && existsSync2(queueFile)) {
    const existing = readFileSync2(queueFile, "utf8");
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

// muse/src/cli.ts
function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name, argv) {
  return argv.includes(name);
}
async function registerOnly(name, restUrl) {
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
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify({ agentId, token }, null, 2), { mode: 384 });
  console.log(`Registered agent '${name}' as ${agentId}. Identity saved to ${PROFILE_PATH} (token not printed).`);
}
async function main() {
  const argv = process.argv.slice(2);
  if (has("--help", argv) || has("-h", argv)) {
    console.log("Usage: agentschat-mcp --muse --register-only --name <name> | --wake [--channel <id>...] | --listen [--channel <id>...] [--auto-reply <text>] | --send <channel-id> --text <text>");
    return;
  }
  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name)
      throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? "https://agents-chat.com";
    await registerOnly(name, restUrl);
    return;
  }
  const config = loadConfig();
  console.log("Muse AgentsChat:", JSON.stringify(safeConfig(config)));
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
    const queueFile = process.env.MUSE_WAKE_QUEUE ?? join2(homedir2(), ".agentschat", "muse-wake-queue.jsonl");
    const wakeUrl = process.env.MUSE_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.MUSE_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;
    const typing = new TypingHeartbeat((channelId) => client.sendTyping(channelId));
    process.on("SIGINT", () => typing.stopAll());
    client.onMessage((m) => {
      if (m.sender_id === config.agentId) {
        typing.stop(m.channel_id);
        return;
      }
      const kind = m.channel_id.startsWith("dm-") ? "direct" : "group";
      if (!shouldDispatch(m, { agentId: config.agentId, displayName: config.displayName, channelKind: kind }))
        return;
      typing.start(m.channel_id);
      const payload = buildWakePayload({ ...m, type: "message" });
      const queued = appendWakeQueue(queueFile, payload);
      fireWake({ ...m, type: "message" }, { url: wakeUrl, secret: wakeSecret, logger: console.error });
      console.log(`[wake] ${m.channel_id} ${m.sender_id} ${m.id} queued=${queued}`);
    });
    client.onReconnect = () => {
      for (const c of wakeChannels)
        client.joinChannel(c);
    };
    await client.connect();
    for (const c of wakeChannels)
      client.joinChannel(c);
    console.log(`Wake daemon listening on ${wakeChannels.join(", ") || "(no channels — pass --channel <id>)"}, queue=${queueFile}. Press Ctrl+C to stop.`);
    await client.waitUntilClosed();
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
    console.log(`Sent to ${channelId}`);
    client.disconnect();
    return;
  }
  const channels = [];
  for (let i = 0;i < argv.length; i++) {
    if (argv[i] === "--channel" && argv[i + 1])
      channels.push(argv[i + 1]);
  }
  if (config.defaultChannelId)
    channels.push(config.defaultChannelId);
  const autoReply = arg("--auto-reply", argv);
  const bridge = new MuseBridge(client, {
    agentId: config.agentId,
    displayName: config.displayName,
    channels,
    responder: async (ctx) => {
      console.log(`[${ctx.message.channel_id}] ${ctx.message.sender_id}: ${ctx.message.content}`);
      return autoReply ?? null;
    }
  });
  client.onReconnect = () => bridge.rejoin();
  await bridge.start();
  console.log(`Listening on ${channels.join(", ") || "(no channels — pass --channel <id>)"}. Press Ctrl+C to stop.`);
  await client.waitUntilClosed();
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

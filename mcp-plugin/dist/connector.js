#!/usr/bin/env node
// connector/server.ts
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// connector/auth.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var CLOSE_UNAUTHORIZED = 4401;
function hmacHex(payload, secret) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
function verifySignature(payload, sigHex, secrets) {
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0)
    return false;
  for (const secret of secrets) {
    if (!secret)
      continue;
    const expected = Buffer.from(hmacHex(payload, secret), "hex");
    if (expected.length !== sigBuf.length)
      continue;
    if (timingSafeEqual(sigBuf, expected))
      return true;
  }
  return false;
}
function verifyToken(token, secrets) {
  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length < 3)
    return null;
  const sig = parts[parts.length - 1];
  const exp = Number.parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(exp))
    return null;
  const payload = parts.slice(0, -2).join(":");
  if (exp !== 0 && Math.floor(Date.now() / 1000) > exp)
    return null;
  const signed = `${payload}:${exp}`;
  return verifySignature(signed, sig, secrets) ? payload : null;
}
function verifyUpgradeToken(token, secrets) {
  return verifyToken(token, secrets);
}

// connector/descriptor.ts
var CONTRACT_VERSION = 1;
var AGENTSCHAT_MAX_MESSAGE_LENGTH = 4000;
var SUPPORTED_OPS = ["send", "typing", "get_chat_info"];
function buildDescriptor(overrides = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    platform: "agentschat",
    label: "AgentsChat",
    max_message_length: AGENTSCHAT_MAX_MESSAGE_LENGTH,
    supports_draft_streaming: false,
    supports_edit: false,
    supports_threads: false,
    markdown_dialect: "markdown",
    len_unit: "chars",
    emoji: "\uD83E\uDD16",
    pii_safe: false,
    supported_ops: [...SUPPORTED_OPS],
    ...overrides
  };
}

// connector/normalize.ts
function toWireEvent(msg, platform = "agentschat") {
  const content = msg.content ?? "";
  if (content === "__typing__")
    return null;
  const chatId = msg.channel_id ?? "";
  if (!chatId)
    return null;
  const isDm = chatId.startsWith("dm-");
  return {
    text: content,
    message_type: "text",
    message_id: msg.id,
    reply_to_message_id: msg.reply_to,
    source: {
      platform,
      chat_id: chatId,
      chat_type: isDm ? "dm" : "group",
      chat_name: msg.channel_id ?? null,
      user_id: msg.sender_id,
      user_name: msg.sender_name ?? msg.sender_id,
      thread_id: null
    }
  };
}

// connector/server.ts
function startConnector(config) {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  const sockets = new Set;
  const http = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agentschat-connector", contract_version: 1 }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/relay") {
      socket.destroy();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const payload = peekPayload(token);
    const secrets = payload ? config.secrets[payload] : undefined;
    const gatewayId = secrets ? verifyUpgradeToken(token, secrets) : null;
    if (!gatewayId) {
      log(`[connector] rejecting upgrade: bad/absent token (path=${pathname})`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, gatewayId);
    });
  });
  function onConnection(ws, gatewayId) {
    sockets.add(ws);
    log(`[connector] gateway connected: ${gatewayId} (${sockets.size} total)`);
    ws.on("message", async (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      await handleFrame(ws, frame).catch((e) => log(`[connector] frame error: ${e}`));
    });
    ws.on("close", () => {
      sockets.delete(ws);
      log(`[connector] gateway disconnected: ${gatewayId} (${sockets.size} left)`);
    });
    ws.on("error", () => sockets.delete(ws));
  }
  async function handleFrame(ws, frame) {
    const t = frame?.type;
    if (t === "hello") {
      send(ws, { type: "descriptor", descriptor });
      return;
    }
    if (t === "outbound") {
      const result = await handleOutbound(frame.action ?? {});
      send(ws, { type: "outbound_result", requestId: frame.requestId, result });
      return;
    }
  }
  async function handleOutbound(action) {
    const op = action?.op;
    const chatId = action?.chat_id ?? "";
    switch (op) {
      case "send": {
        const r = await config.agentschat.sendMessage(chatId, action.content ?? "", action.reply_to);
        return { success: true, message_id: r?.id };
      }
      case "typing": {
        await config.agentschat.sendTyping?.(chatId);
        return { success: true };
      }
      case "get_chat_info": {
        const info = await config.agentschat.getChatInfo(chatId);
        return info ?? {};
      }
      default:
        return { success: false, error: `unsupported op: ${String(op)}` };
    }
  }
  function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(obj) + `
`);
  }
  http.listen(config.port, config.host ?? "127.0.0.1");
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return {
    port,
    stop() {
      for (const ws of sockets) {
        try {
          ws.close(1001, "connector shutdown");
        } catch {}
      }
      wss.close();
      http.close();
    },
    injectAgentsChatMessage(msg) {
      const event = toWireEvent(msg, descriptor.platform);
      if (!event)
        return;
      for (const ws of sockets)
        send(ws, { type: "inbound", event });
    },
    connections() {
      return sockets.size;
    }
  };
}
function peekPayload(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length < 3)
      return null;
    return parts.slice(0, -2).join(":");
  } catch {
    return null;
  }
}

// connector/run.ts
import WS from "ws";
var log = (m) => process.stderr.write(`[agentschat-connector] ${m}
`);
function need(name) {
  const v = process.env[name];
  if (!v) {
    log(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return v;
}
var AGENT_ID = need("AGENTCHAT_AGENT_ID");
var TOKEN = need("AGENTCHAT_TOKEN");
var GATEWAY_ID = need("RELAY_GATEWAY_ID");
var GATEWAY_SECRET = need("RELAY_GATEWAY_SECRET");
var API = (process.env.AGENTCHAT_API_URL || "https://agents-chat.com").replace(/\/$/, "");
var WS_URL = process.env.AGENTCHAT_WS_URL || API.replace(/^http/, "ws") + "/ws";
var PORT = Number(process.env.RELAY_PORT || 8765);
var HOST = process.env.RELAY_HOST || "127.0.0.1";
var broadcast = null;
var connector = startConnector({
  port: PORT,
  host: HOST,
  secrets: { [GATEWAY_ID]: [GATEWAY_SECRET] },
  agentschat: {
    async sendMessage(chatId, content, replyTo) {
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sender_id: AGENT_ID, content_type: "text", content, ...replyTo ? { parent_id: replyTo } : {} })
      });
      if (!res.ok)
        throw new Error(`agentschat send failed: ${res.status}`);
      const data = await res.json();
      return { id: data?.id };
    },
    async getChatInfo(chatId) {
      const res = await fetch(`${API}/api/channels/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      if (!res.ok)
        return { name: chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
      const data = await res.json();
      return { name: data?.name ?? chatId, type: chatId.startsWith("dm-") ? "dm" : "group" };
    },
    async sendTyping(chatId) {
      sendAgentsChatFrame({ type: "typing", channel_id: chatId, sender_id: AGENT_ID });
    }
  },
  logger: log
});
broadcast = (msg) => connector.injectAgentsChatMessage(msg);
log(`listening on ${HOST}:${connector.port} (contract v1, gateway id "${GATEWAY_ID}")`);
var ws = null;
var reconnectDelay = 1000;
function sendAgentsChatFrame(frame) {
  if (ws && ws.readyState === WS.OPEN) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {}
  }
}
function connectAgentsChat() {
  ws = new WS(WS_URL);
  ws.on("open", () => {
    reconnectDelay = 1000;
    sendAgentsChatFrame({ type: "auth", agent_id: AGENT_ID, token: TOKEN, capabilities: ["chat"] });
  });
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (data.type === "auth_ok") {
      log(`connected to agentschat as ${AGENT_ID}`);
      return;
    }
    if (data.type === "message" && data.sender_id !== AGENT_ID) {
      broadcast?.(data);
    }
  });
  ws.on("close", () => {
    if (process.__shutdown)
      return;
    log(`agentschat WS closed; reconnecting in ${reconnectDelay}ms`);
    setTimeout(connectAgentsChat, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
  ws.on("error", (e) => {
    log(`agentschat WS error: ${e?.message ?? e}`);
  });
}
connectAgentsChat();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    process.__shutdown = true;
    try {
      ws?.close();
    } catch {}
    connector.stop();
    process.exit(0);
  });
}

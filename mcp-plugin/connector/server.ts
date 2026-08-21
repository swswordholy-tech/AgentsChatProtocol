/**
 * agentschat connector — the connector side of the Hermes relay contract.
 *
 * Single-tenant: one agentschat identity, one tenant. The gateway dials OUT to
 * this server's `/relay` WebSocket with an `Authorization: Bearer <upgrade token>`
 * header; on a valid token the connection is admitted and the contract's frame
 * exchange proceeds (see ws_transport.py on the gateway side):
 *
 *   gateway  → hello           {type:"hello", platform, botId}
 *   connector→ descriptor      {type:"descriptor", descriptor:{...}}
 *   connector→ inbound         {type:"inbound", event:{...}}          (agentschat → gateway)
 *   gateway  → outbound        {type:"outbound", requestId, action}
 *   connector→ outbound_result {type:"outbound_result", requestId, result}
 *
 * Auth is fail-closed: anything wrong with the upgrade token closes 4401 before
 * the socket is admitted (the gateway treats a 4401 before first successful
 * handshake as retryable, but we never let an unauthenticated socket through).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyUpgradeToken, CLOSE_UNAUTHORIZED } from "./auth.ts";
import { buildDescriptor, type CapabilityDescriptor } from "./descriptor.ts";
import { toWireEvent, type AgentsChatMessage } from "./normalize.ts";

/** What the connector needs from agentschat to fulfil outbound ops. */
export interface AgentsChatHooks {
  sendMessage(chatId: string, content: string, replyTo?: string): Promise<{ id?: string }>;
  getChatInfo(chatId: string): Promise<{ name?: string; type?: string }>;
  sendTyping?(chatId: string): Promise<void>;
}

export interface ConnectorConfig {
  port: number;
  host?: string;
  /** gatewayId → acceptable secrets (rotation window). */
  secrets: Record<string, string[]>;
  /** Override the descriptor (tests/customization); defaults to the agentschat descriptor. */
  descriptor?: Partial<CapabilityDescriptor>;
  agentschat: AgentsChatHooks;
  /** Called for each agentschat message to broadcast to connected gateways. */
  logger?: (msg: string) => void;
}

export interface ConnectorHandle {
  port: number;
  stop(): void;
  /** Push an agentschat message to every connected gateway as an inbound frame. */
  injectAgentsChatMessage(msg: AgentsChatMessage): void;
  connections(): number;
}

export function startConnector(config: ConnectorConfig): ConnectorHandle {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  const sockets = new Set<WebSocket>();

  const http: HttpServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agentschat-connector", contract_version: 1 }));
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/relay") {
      socket.destroy();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    // Peek the gateway id (payload head) to select that gateway's verify list.
    const payload = peekPayload(token);
    const secrets = payload ? config.secrets[payload] : undefined;
    const gatewayId = secrets ? verifyUpgradeToken(token, secrets) : null;
    if (!gatewayId) {
      log(`[connector] rejecting upgrade: bad/absent token (path=${pathname})`);
      // Write a 4401-flavored close: send an HTTP 401 then destroy, and — once the
      // WS is established for a valid path — close with the app code. For the
      // upgrade itself we must reject the handshake; the client observes a failed
      // upgrade. We additionally complete a minimal WS so we can send close 4401.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, gatewayId);
    });
  });

  function onConnection(ws: WebSocket, gatewayId: string) {
    sockets.add(ws);
    log(`[connector] gateway connected: ${gatewayId} (${sockets.size} total)`);

    ws.on("message", async (data) => {
      let frame: any;
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

  async function handleFrame(ws: WebSocket, frame: any) {
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
    // Unknown / ignored frame types (interrupt, etc.) — additive contract, ignore.
  }

  async function handleOutbound(action: any): Promise<any> {
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

  function send(ws: WebSocket, obj: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  http.listen(config.port, config.host ?? "127.0.0.1");
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    port,
    stop() {
      for (const ws of sockets) {
        try { ws.close(1001, "connector shutdown"); } catch {}
      }
      wss.close();
      http.close();
    },
    injectAgentsChatMessage(msg: AgentsChatMessage) {
      const event = toWireEvent(msg, descriptor.platform);
      if (!event) return;
      for (const ws of sockets) send(ws, { type: "inbound", event });
    },
    connections() {
      return sockets.size;
    },
  };
}

/** Peek the payload head of an upgrade token without verifying (to index secrets). */
function peekPayload(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length < 3) return null;
    return parts.slice(0, -2).join(":");
  } catch {
    return null;
  }
}

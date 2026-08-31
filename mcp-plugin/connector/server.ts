/**
 * agentschat connector — the connector side of the Hermes relay contract.
 *
 * Single-tenant AND multiplex: one relay WS server fronts one OR MORE agentschat
 * identities (one per Hermes profile/agent). Hermes fronts multiple identities on
 * one WS by sending one `hello` per (platform, botId); here platform is always
 * "agentschat" and botId is the agentschat agent_id.
 *
 * Frame exchange (see gateway ws_transport.py):
 *   gateway  → hello           {type:"hello", platform, botId}
 *   connector→ descriptor      {type:"descriptor", descriptor:{...}}   (one per hello)
 *   connector→ inbound         {type:"inbound", event:{...}}           (agentschat → gateway)
 *   gateway  → outbound        {type:"outbound", requestId, platform?, action}
 *   connector→ outbound_result {type:"outbound_result", requestId, result}
 *
 * Auth is fail-closed: anything wrong with the upgrade token closes 4401 before the
 * socket is admitted.
 *
 * The single highest-correctness invariant (multiplex): identity A's messages are
 * NEVER routed to or sent as identity B. Inbound routes to the socket(s) fronting the
 * addressed identity; outbound uses the sending identity's own token; an identity the
 * connector has no credentials for is rejected at hello (fail closed).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyUpgradeToken, CLOSE_UNAUTHORIZED } from "./auth.ts";
import { buildDescriptor, type CapabilityDescriptor } from "./descriptor.ts";
import { toWireEvent, type AgentsChatMessage } from "./normalize.ts";
import { IdentityTable, routeInbound, type Identity } from "./identities.ts";

/** What the connector needs from agentschat to fulfil outbound ops, per identity. */
export interface AgentsChatHooks {
  sendMessage(botId: string, chatId: string, content: string, replyTo?: string): Promise<{ id?: string }>;
  getChatInfo(botId: string, chatId: string): Promise<{ name?: string; type?: string }>;
  sendTyping?(botId: string, chatId: string): Promise<void>;
  /**
   * Recent channel messages to attach as `context` when an @-mention arrives —
   * the "what happened since the last time I was addressed" window. `sinceTs` is
   * the timestamp of the last message addressed to this identity in this channel
   * (undefined = never). `excludeId` is the trigger message's own id (already
   * delivered as the event body — don't repeat it in the context). Return null/
   * [] when there is nothing worth attaching. Best-effort: failures must not
   * block delivery of the addressed message itself.
   */
  getChannelContext?(botId: string, chatId: string, sinceTs?: string, excludeId?: string): Promise<Array<{ text: string; user_name?: string; user_id?: string }> | null>;
}

/** Legacy single-tenant hook shape (no botId first arg) — adapted to the per-identity one. */
interface LegacyHooks {
  sendMessage(chatId: string, content: string, replyTo?: string): Promise<{ id?: string }>;
  getChatInfo(chatId: string): Promise<{ name?: string; type?: string }>;
  sendTyping?(chatId: string): Promise<void>;
  getChannelContext?(chatId: string, sinceTs?: string, excludeId?: string): Promise<Array<{ text: string; user_name?: string; user_id?: string }> | null>;
}

export interface ConnectorConfig {
  port: number;
  host?: string;
  /** gatewayId → acceptable secrets (rotation window). */
  secrets: Record<string, string[]>;
  /**
   * The identities this connector fronts. Multiplex: one per agentschat identity.
   * Single-tenant (legacy): omit and provide `agentschat` — a single implicit
   * identity is derived (botId "default").
   */
  identities?: Identity[];
  /** Override the descriptor (tests/customization); defaults to the agentschat descriptor. */
  descriptor?: Partial<CapabilityDescriptor>;
  agentschat: AgentsChatHooks | LegacyHooks;
  logger?: (msg: string) => void;
}

export interface ConnectorHandle {
  port: number;
  stop(): void;
  /** Push an agentschat message to the gateway socket(s) fronting its addressed identity. */
  injectAgentsChatMessage(msg: AgentsChatMessage): void | Promise<void>;
  connections(): number;
}

/** A connected gateway socket and the set of identities it has hello'd (fronts). */
interface GatewayConn {
  ws: WebSocket;
  gatewayId: string;
  /** botIds this socket has declared via hello. */
  fronted: Set<string>;
}

export function startConnector(config: ConnectorConfig): ConnectorHandle {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  // "legacy" = no identity table configured (the pre-multiplex test/embedding
  // path): a single derived identity and chatId-first hooks. "single" = the
  // table holds exactly one identity (legacy OR a one-entry RELAY_IDENTITIES) —
  // it gates hello acceptance and outbound identity resolution, NOT inbound
  // group forwarding (unaddressed group chatter is dropped in every mode).
  const legacy = !config.identities || config.identities.length === 0;
  const table = new IdentityTable(
    legacy ? [{ botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" }] : config.identities!,
  );
  const single = table.isSingle();
  // Normalize hooks to the per-identity shape. Legacy single-tenant hooks take
  // (chatId, ...); wrap them to ignore the botId. Per-identity hooks take botId first.
  const hooks: AgentsChatHooks = legacy
    ? {
        sendMessage: (_b, chatId, content, replyTo) => (config.agentschat as LegacyHooks).sendMessage(chatId, content, replyTo),
        getChatInfo: (_b, chatId) => (config.agentschat as LegacyHooks).getChatInfo(chatId),
        sendTyping: (_b, chatId) => (config.agentschat as LegacyHooks).sendTyping?.(chatId) ?? Promise.resolve(),
        getChannelContext: (_b, chatId, sinceTs, excludeId) =>
          (config.agentschat as LegacyHooks).getChannelContext?.(chatId, sinceTs, excludeId) ?? Promise.resolve(null),
      }
    : (config.agentschat as AgentsChatHooks);
  const sockets = new Set<GatewayConn>();
  // `${botId}:${chatId}` → timestamp of the last message ADDRESSED to that
  // identity in that channel. Drives the getChannelContext `sinceTs` window.
  const lastAddressed = new Map<string, string>();

  const http: HttpServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agentschat-connector", contract_version: 1, identities: table.size }));
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

  function onConnection(ws: WebSocket, gatewayId: string) {
    const conn: GatewayConn = { ws, gatewayId, fronted: new Set() };
    sockets.add(conn);
    log(`[connector] gateway connected: ${gatewayId} (${sockets.size} total)`);

    ws.on("message", async (data) => {
      // Newline-delimited: the gateway may batch frames; split and handle each.
      const text = data.toString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        await handleFrame(conn, frame).catch((e) => log(`[connector] frame error: ${e}`));
      }
    });
    ws.on("close", () => {
      sockets.delete(conn);
      log(`[connector] gateway disconnected: ${gatewayId} (${sockets.size} left)`);
    });
    ws.on("error", () => sockets.delete(conn));
  }

  async function handleFrame(conn: GatewayConn, frame: any) {
    const t = frame?.type;
    if (t === "hello") {
      const botId = String(frame.botId ?? "");
      // Single-tenant (no identity table configured): front whatever identity the
      // gateway declares — there's exactly one. Multiplex: the botId MUST be a
      // registered identity (fail closed — never front an identity we can't send as).
      const identity = single
        ? table.all()[0]
        : botId
          ? table.forBot(botId)
          : null;
      if (!identity) {
        send(conn.ws, { type: "error", error: `unknown identity botId: ${botId || "(none)"}` });
        return;
      }
      conn.fronted.add(identity.botId);
      send(conn.ws, { type: "descriptor", descriptor: { ...descriptor, platform: "agentschat" } });
      return;
    }
    if (t === "outbound") {
      const result = await handleOutbound(conn, frame);
      send(conn.ws, { type: "outbound_result", requestId: frame.requestId, result });
      return;
    }
    // Unknown / ignored frame types (interrupt, etc.) — additive contract, ignore.
  }

  async function handleOutbound(conn: GatewayConn, frame: any): Promise<any> {
    const action = frame?.action ?? {};
    const op = action?.op;
    const chatId = action?.chat_id ?? "";
    // Which identity sends? The frame's botId picks the egress identity for a
    // multi-identity gateway (contract D-Q1.5b.1: the connector validates the
    // per-frame egress target against the SET of identities THIS socket
    // advertised via hello). Untagged outbound falls back to the FIRST hello'd
    // identity (the session default). Fail closed when the named identity isn't
    // registered or wasn't fronted by this socket — never send with another
    // identity's credentials.
    const firstFronted = [...conn.fronted][0];
    const requested = typeof frame?.botId === "string" && frame.botId ? frame.botId : firstFronted ?? null;
    const identity = single
      ? table.all()[0]
      : requested && conn.fronted.has(requested)
        ? table.forBot(requested)
        : null;
    if (!identity) {
      log(`[connector] outbound failed: no fronted identity for botId=${requested ?? "?"}`);
      return { success: false, error: `no fronted identity for outbound (botId=${requested ?? "?"})` };
    }
    switch (op) {
      case "send": {
        const r = await hooks.sendMessage(identity.botId, chatId, action.content ?? "", action.reply_to);
        return { success: true, message_id: r?.id };
      }
      case "typing": {
        await hooks.sendTyping?.(identity.botId, chatId);
        return { success: true };
      }
      case "get_chat_info": {
        const info = await hooks.getChatInfo(identity.botId, chatId);
        return info ?? {};
      }
      default:
        log(`[connector] outbound failed: unsupported op ${String(op)}`);
        return { success: false, error: `unsupported op: ${String(op)}` };
    }
  }

  function send(ws: WebSocket, obj: any) {
    // Newline-delimited (gateway ws_transport.py splits on "\n"): a frame without the
    // terminator never reaches the gateway's frame handler.
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj) + "\n");
  }

  http.listen(config.port, config.host ?? "127.0.0.1");
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    port,
    stop() {
      for (const c of sockets) {
        try { c.ws.close(1001, "connector shutdown"); } catch {}
      }
      wss.close();
      http.close();
    },
    async injectAgentsChatMessage(msg: AgentsChatMessage) {
      // Route to the identity this message is ADDRESSED to, then only to gateway
      // socket(s) fronting THAT identity — never broadcast across identities.
      //
      // DM: always forward. __botId (which identity's agentschat socket it arrived
      //   on) is the ownership signal; single-tenant falls back to its one identity.
      // Group: forward ONLY when the body @mentions a fronted identity (content-
      //   based — the agentschat WS pushes every message of a joined channel
      //   unannotated, and arrival on a socket is NOT an addressing signal). The
      //   MCP path's gate is isDM || isMentioned; this reproduces it. Anything
      //   unaddressed is dropped — injecting joined-channel chatter into the
      //   agent's session would burn its tokens on messages not meant for it.
      const isDm = typeof msg.channel_id === "string" && msg.channel_id.startsWith("dm-");
      const bySocket = (msg as any).__botId ? table.forBot(String((msg as any).__botId)) : null;
      const target = isDm
        ? bySocket ?? routeInbound(table, {
            channel_id: msg.channel_id,
            dmOwnerBotId: (msg as any).dm_owner,
          }) ?? (table.isSingle() ? table.all()[0] : null)
        : routeInbound(table, {
            channel_id: msg.channel_id,
            mentioned_ids: (msg as any).mentioned_ids,
            content: msg.content,
          });
      if (!target) {
        log(`[connector] inbound unaddressed (channel=${(msg as any).channel_id ?? "?"} mentions=${JSON.stringify((msg as any).mentioned_ids ?? [])}) — dropped`);
        return;
      }
      const event = toWireEvent(msg, "agentschat");
      if (!event) return;
      // Tag the fronting identity so the gateway keys the right session/profile.
      (event.source as any).profile = target.botId;
      if (!isDm) {
        // Attach "what happened since you were last addressed" so the agent gets
        // the conversation BETWEEN its @-mentions without being injected into
        // every unaddressed message. Upstream renders event.context into the
        // event's channel_context ("[Recent channel messages]") — gateway needs
        // no change. Best-effort: a context failure never delays the message.
        const key = `${target.botId}:${msg.channel_id}`;
        const since = lastAddressed.get(key);
        if (hooks.getChannelContext) {
          try {
            const ctx = await hooks.getChannelContext(target.botId, msg.channel_id!, since, msg.id);
            if (ctx && ctx.length) {
              event.context = ctx.slice(-10).map((c) => ({
                text: String(c?.text ?? "").slice(0, 500),
                source: { user_name: c?.user_name, user_id: c?.user_id },
              }));
            }
          } catch (e) {
            log(`[connector] context fetch failed for ${key} (delivering without it): ${e}`);
          }
        }
        if (msg.timestamp) lastAddressed.set(key, msg.timestamp);
      }
      for (const conn of sockets) {
        if (conn.fronted.has(target.botId)) send(conn.ws, { type: "inbound", event });
      }
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

/**
 * AgentsChat relay connector. Repeated hello frames register identities on a
 * connection authenticated with a gatewayId AND a specific signing secret.
 * Every identity must match both credentials; outbound additionally requires
 * that identity's hello on the sending connection. There is no global fallback
 * and no chat-sticky identity inference.
 *
 * Use separate single-identity gateways for Hermes transports that stamp the
 * first botId for a platform on all outbound actions. A shared multi-hello WS
 * requires a client that supplies the correct explicit outbound botId.
 * All connector frames are newline-terminated (relay wire contract v1).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyUpgradeToken, CLOSE_UNAUTHORIZED } from "./auth.ts";
import { buildDescriptor, type CapabilityDescriptor } from "./descriptor.ts";
import { toWireEvent, type AgentsChatMessage } from "./normalize.ts";
import { MessageDedup } from "../src/dedup.ts";
import { IdentityTable, routeInboundTargets, hermesSourceProfile, type Identity } from "./identities.ts";

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
  getChannelContext?(botId: string, chatId: string, sinceTs?: string, excludeId?: string, signal?: AbortSignal): Promise<Array<{ text: string; user_name?: string; user_id?: string }> | null>;
}

/** Only a structured status may be exposed, never a response body. */
export class PlatformHttpError extends Error {
  constructor(readonly status: number) { super("platform HTTP failure"); }
}
export class PlatformNetworkError extends Error {
  constructor() { super("platform network failure"); }
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
  ready: Promise<void>;
  stop(): void;
  /** Push an agentschat message to the gateway socket(s) fronting its addressed identity. */
  injectAgentsChatMessage(msg: AgentsChatMessage): void | Promise<void>;
  connections(): number;
  /**
   * Hot-replace the identity table (and upgrade-auth secrets derived from it).
   * Used when RELAY_IDENTITIES is reloaded without restarting the process.
   */
  reloadIdentities(identities: Identity[]): void;
}

/** A connected gateway socket and the set of identities it has hello'd (fronts). */
interface GatewayConn {
  ws: WebSocket;
  gatewayId: string;
  secret: string;
  legacyAlias?: string;
  /** botIds this socket has declared via hello. */
  fronted: Set<string>;
}

export function startConnector(config: ConnectorConfig): ConnectorHandle {
  const log = config.logger ?? (() => {});
  const descriptor = buildDescriptor(config.descriptor);
  // No identity table: legacy single-tenant embedding with chatId-first hooks.
  // Configured tables, including N=1, require an exact authenticated botId.
  const legacy = !config.identities || config.identities.length === 0;
  const table = new IdentityTable(
    legacy ? [{ botId: "default", agentId: "default", token: "", gatewayId: "", secret: "" }] : config.identities!,
  );
  function safeLabel(value: string) {
    for (const id of table.all()) for (const secret of [id.token, id.secret]) {
      if (secret) value = value.split(secret).join("[redacted]");
    }
    return JSON.stringify(value.slice(0, 128));
  }
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
  // JSON [botId, chatId] → timestamp of the last message ADDRESSED to that
  // identity in that channel. Drives the getChannelContext `sinceTs` window.
  const lastAddressed = new Map<string, string>();
  const delivered = new MessageDedup();
  const inboundQueues = new Map<string, Promise<void>>();
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
    const secret = secrets?.find((s) => verifyUpgradeToken(token, [s]) === payload);
    const gatewayId = secret ? payload : null;
    if (!gatewayId) {
      log(`[connector] rejecting upgrade: bad/absent token (path=${pathname})`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, gatewayId, secret!);
    });
  });

  function onConnection(ws: WebSocket, gatewayId: string, secret: string) {
    const conn: GatewayConn = { ws, gatewayId, secret, fronted: new Set() };
    sockets.add(conn);
    log(`[connector] gateway connected: ${safeLabel(gatewayId)} (${sockets.size} total)`);

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
      log(`[connector] gateway disconnected: ${safeLabel(gatewayId)} (${sockets.size} left)`);
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
      const identity = legacy ? table.all()[0] : table.forBot(botId);
      const reason = frame.platform !== "agentschat" ? "unsupported_platform" : !identity ? "unknown_identity"
        : !legacy && (identity.gatewayId !== conn.gatewayId || identity.secret !== conn.secret) ? "credential_mismatch" : null;
      const labels = `gatewayId=${safeLabel(conn.gatewayId)} platform=${safeLabel(frame.platform === "agentschat" ? "agentschat" : "(unsupported)")} botId=${safeLabel(identity ? botId : "(unknown)")}`;
      if (reason) {
        log(`[connector] hello rejected ${labels} reason=${reason}`);
        conn.fronted.clear();
        send(conn.ws, { type: "error", error: `hello rejected: ${reason}` });
        // Upgrade credentials were accepted; this hello does not match the
        // configured identity/protocol. Fail closed, but allow configuration repair
        // to recover through Hermes's normal reconnect path. Repeated 4401 after
        // a prior descriptor latches credential revocation in ws_transport.py.
        conn.ws.close(1002, `hello rejected: ${reason}`);
        return;
      }
      conn.fronted.add(identity!.botId);
      if (legacy) conn.legacyAlias = botId;
      log(`[connector] hello accepted ${labels}`);
      send(conn.ws, { type: "descriptor", descriptor: { ...descriptor, platform: "agentschat" } });
      return;
    }
    if (t === "outbound") {
      let result;
      try { result = await handleOutbound(conn, frame); }
      catch (error) {
        const status = error instanceof PlatformHttpError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
        result = status !== undefined
          ? { success: false, error: `agentschat HTTP ${status}`, code: "platform_http_error", status, ambiguous: status >= 500 }
          : error instanceof PlatformNetworkError
          ? { success: false, error: "agentschat network failure; outcome unknown", code: "platform_network_error", ambiguous: true }
          : { success: false, error: "platform operation failed; outcome unknown", code: "platform_operation_failed", ambiguous: true };
        log(`[connector] outbound failed: ${result.code}${status ? ` status=${status}` : ""}`);
      }
      send(conn.ws, { type: "outbound_result", requestId: frame.requestId, result });
      return;
    }
    // Unknown / ignored frame types (interrupt, etc.) — additive contract, ignore.
  }

  async function handleOutbound(conn: GatewayConn, frame: any): Promise<any> {
    const action = frame?.action ?? {};
    const op = action?.op;
    const chatId = action?.chat_id ?? "";
    const firstFronted = conn.fronted.size === 1 ? [...conn.fronted][0] : undefined;
    let requested = frame.botId === undefined ? firstFronted ?? null
      : typeof frame.botId === "string" && frame.botId ? frame.botId : null;
    if (legacy && requested && requested === conn.legacyAlias) requested = "default";
    let identity = requested && conn.fronted.has(requested) ? table.forBot(requested) : null;
    if (identity && ((!legacy && (identity.gatewayId !== conn.gatewayId || identity.secret !== conn.secret)) ||
        (frame.platform !== undefined && frame.platform !== "agentschat"))) identity = null;
    if (!identity) {
      log(`[connector] outbound failed: no usable identity for botId=${requested ?? "?"}`);
      return { success: false, error: `no usable identity for outbound (botId=${requested ?? "?"})` };
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

  const ready = new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
  });
  http.listen(config.port, config.host ?? "127.0.0.1");

  return {
    ready,
    get port() {
      const address = http.address();
      return typeof address === "object" && address ? address.port : config.port;
    },
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
      const owner = (msg as any).__botId ?? (msg as any).dm_owner;
      const targets = isDm
        ? [owner !== undefined ? (typeof owner === "string" ? table.forBot(owner) : null)
          : table.isSingle() ? table.all()[0] : null].filter((id): id is Identity => !!id)
        : routeInboundTargets(table, {
            channel_id: msg.channel_id,
            mentioned_ids: (msg as any).mentioned_ids,
            content: msg.content,
          });
      if (!targets.length) {
        log(`[connector] inbound unaddressed (channel=${(msg as any).channel_id ?? "?"} mentions=${JSON.stringify((msg as any).mentioned_ids ?? [])}) — dropped`);
        return;
      }
      await Promise.all(targets.map(target => {
        const key = JSON.stringify([target.botId, msg.channel_id]);
        const previous = inboundQueues.get(key) ?? Promise.resolve();
        const job = previous.catch(() => {}).then(async () => {
          if (msg.sender_id === target.agentId) return;
          const baseEvent = toWireEvent(msg, "agentschat");
          if (!baseEvent) return;
          if (![...sockets].some(c => c.ws.readyState === WebSocket.OPEN && c.fronted.has(target.botId))) return;
          const deliveryKey = typeof msg.id === "string" && msg.id
            ? JSON.stringify([msg.channel_id, msg.id, target.botId]) : null;
          // Reserve synchronously, before async context fetch, across mirrored sockets.
          if (deliveryKey && delivered.recordOrSkip(deliveryKey)) return;
          if (!isDm) {
            // Attach "what happened since you were last addressed" so the agent gets
            // the conversation BETWEEN its @-mentions without being injected into
            // every unaddressed message. Upstream renders event.context into the
            // event's channel_context ("[Recent channel messages]") — gateway needs
            // no change. Fetch errors fall back to delivering without context.
            const since = lastAddressed.get(key);
            if (hooks.getChannelContext) {
              const controller = new AbortController();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const ctx = await Promise.race([
                  hooks.getChannelContext(target.botId, msg.channel_id!, since, msg.id, controller.signal),
                  new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 1000); }),
                ]);
                if (ctx && ctx.length) {
                  baseEvent.context = ctx.slice(-10).map((c) => ({
                    text: String(c?.text ?? "").slice(0, 500),
                    source: { user_name: c?.user_name, user_id: c?.user_id },
                  }));
                }
              } catch {
                log(`[connector] context fetch failed (delivering without it)`);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            if (msg.timestamp && Number.isFinite(Date.parse(msg.timestamp)) &&
                (!since || Date.parse(msg.timestamp) > Date.parse(since))) lastAddressed.set(key, msg.timestamp);
          }
          const deliverTo = [...sockets].filter((c) => c.ws.readyState === WebSocket.OPEN && c.fronted.has(target.botId)).slice(0, 1);
          if (deliverTo.length === 0) {
            log(`[connector] inbound dropped for botId=${target.botId}: no agentschat-fronted gateway socket`);
            return;
          }
          for (const conn of deliverTo) {
            // Per-connection clone: a single-hello gateway must NOT inherit a
            // profile stamp meant for a multiplexed sibling socket.
            const event = { ...baseEvent, source: { ...baseEvent.source } };
            const profile = hermesSourceProfile(target, conn.fronted.size);
            if (profile) (event.source as any).profile = profile;
            send(conn.ws, { type: "inbound", event });
          }
        });
        inboundQueues.set(key, job);
        return job.finally(() => {
          if (inboundQueues.get(key) === job) inboundQueues.delete(key);
        });
      }));
    },
    connections() {
      return sockets.size;
    },
    reloadIdentities(next: Identity[]) {
      if (!next || next.length === 0) {
        throw new Error("reloadIdentities requires a non-empty identity list");
      }
      table.replace(next);
      for (const conn of sockets) {
        for (const botId of conn.fronted) {
          const id = table.forBot(botId);
          if (!id || id.gatewayId !== conn.gatewayId || id.secret !== conn.secret) conn.fronted.delete(botId);
        }
      }
      // Rebuild upgrade-auth secrets in place so the upgrade handler sees them.
      for (const k of Object.keys(config.secrets)) delete config.secrets[k];
      for (const id of next) {
        (config.secrets[id.gatewayId] ??= []).push(id.secret);
      }
      log(`[connector] identities reloaded: ${table.size}`);
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

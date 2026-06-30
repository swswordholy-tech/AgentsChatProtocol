import { appendFileSync } from "node:fs";
import type { ChannelAccountSnapshot, ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

import type { ChatMessage } from "./agentchat-protocol";
import { buildConversationId } from "./conversation";
import { buildInboundPolicy } from "./policy";
import { createGatewayClient, deleteGatewayState, getGatewayState, setGatewayState } from "./state";
import { CHANNEL_ID, type AgentChatGatewayState, type AgentChatResolvedAccount } from "./types";

type AgentChatGatewayAdapter = NonNullable<ChannelPlugin<AgentChatResolvedAccount>["gateway"]>;
type AgentChatGatewayContext = ChannelGatewayContext<AgentChatResolvedAccount>;
type PendingStart = Promise<AgentChatGatewayState>;

function trace(line: string) {
  try { appendFileSync("/tmp/agentchat-plugin-debug.log", `${new Date().toISOString()} ${line}\n`); } catch {}
}

const pendingStarts = new Map<string, PendingStart>();

function log(ctx: unknown, level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) {
  const sink = (ctx as { log?: Record<string, (...args: unknown[]) => void> }).log;
  const fn = sink?.[level];
  if (typeof fn === "function") {
    if (meta) fn(message, meta);
    else fn(message);
  }
}

function logWithLevel(
  ctx: Pick<AgentChatGatewayContext, "log">,
  level: "warn" | "error" | "debug",
  message: string,
  meta?: Record<string, unknown>,
) {
  log(ctx, level, message, meta);
}

function setConnectedStatus(
  ctx: {
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
  },
  patch: Partial<ChannelAccountSnapshot>,
) {
  ctx.setStatus({
    ...ctx.getStatus(),
    ...patch,
  });
}

function getThreadId(message: ChatMessage): string | number | undefined {
  const value = (message as ChatMessage & { thread_id?: string | number | null }).thread_id;
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function getChannelRuntime(ctx: Pick<AgentChatGatewayContext, "channelRuntime">) {
  return ctx.channelRuntime as PluginRuntime["channel"] | undefined;
}

async function dispatchInboundMessage(ctx: AgentChatGatewayContext, state: AgentChatGatewayState, message: ChatMessage) {
  trace(`dispatchInboundMessage ${JSON.stringify({ accountId: ctx.accountId, channelId: message.channel_id, senderId: message.sender_id, messageId: message.id })}`);
  log(ctx, "info", "AgentChat inbound received", {
    accountId: ctx.accountId,
    channelId: message.channel_id,
    messageId: message.id,
    senderId: message.sender_id,
  });
  const runtime = getChannelRuntime(ctx);
  if (!runtime) {
    log(ctx, "warn", "AgentChat inbound dropped because channelRuntime is unavailable", {
      accountId: ctx.accountId,
      channelId: message.channel_id,
      messageId: message.id,
    });
    return;
  }

  const policy = await buildInboundPolicy({
    account: ctx.account,
    accountId: ctx.accountId,
    message,
    log: (level, event, meta) => logWithLevel(ctx, level, event, meta),
  });

  if (!policy.shouldDispatch) {
    log(ctx, "info", "AgentChat inbound skipped by mention policy", {
      accountId: ctx.accountId,
      channelId: message.channel_id,
      messageId: message.id,
    });
    return;
  }

  const threadId = getThreadId(message);
  const conversationId = buildConversationId(message.channel_id, threadId);
  const parentConversationId = threadId ? buildConversationId(message.channel_id) : undefined;
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer: { kind: "channel", id: conversationId },
    parentPeer: parentConversationId ? { kind: "channel", id: parentConversationId } : null,
  });
  const storePath = runtime.session.resolveStorePath(undefined, { agentId: route.agentId });
  const body = policy.bodyForAgent;
  const timestamp = Date.parse(message.timestamp);
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: policy.bodyForAgent,
    RawBody: policy.rawBody,
    CommandBody: policy.commandBody,
    BodyForCommands: policy.commandBody,
    From: `${CHANNEL_ID}:${message.sender_id}`,
    To: `${CHANNEL_ID}:${message.channel_id}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ConversationLabel: conversationId,
    SenderName: message.sender_id,
    SenderId: message.sender_id,
    SenderTag: message.sender_type,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.id,
    Timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    NativeChannelId: message.channel_id,
    MessageThreadId: threadId,
    ThreadParentId: parentConversationId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: message.channel_id,
    CommandAuthorized: false,
  });

  await runtime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      log(ctx, "error", "AgentChat inbound session record failed", {
        accountId: ctx.accountId,
        channelId: message.channel_id,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  log(ctx, "info", "AgentChat inbound dispatching reply pipeline", {
    accountId: ctx.accountId,
    channelId: message.channel_id,
    messageId: message.id,
    conversationId,
  });
  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!text) return;
        state.client.sendMessage(message.channel_id, text);
      },
      onError: (error, info) => {
        log(ctx, "error", "AgentChat outbound reply dispatch failed", {
          accountId: ctx.accountId,
          channelId: message.channel_id,
          messageId: message.id,
          kind: info.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  });
  log(ctx, "info", "AgentChat inbound dispatch completed", {
    accountId: ctx.accountId,
    channelId: message.channel_id,
    messageId: message.id,
  });
}

export const agentChatGateway: AgentChatGatewayAdapter = {
  async startAccount(ctx: AgentChatGatewayContext) {
    trace(`startAccount ${JSON.stringify({ accountId: ctx.accountId, defaultChannelId: ctx.account.defaultChannelId ?? null })}`);
    const existing = getGatewayState(ctx.accountId);
    if (existing) return existing;

    const pending = pendingStarts.get(ctx.accountId);
    if (pending) return pending;

    const startPromise: PendingStart = (async () => {
      // Forward-declared so onReconnect (defined inside createGatewayClient
      // below) can reference the client we're about to create. The client
      // wires onReconnect at construction time so we need the reference
      // available before the callback fires — but the callback only runs
      // AFTER connect()+auth_ok returns, by which point `client` is
      // assigned. This let+reassign pattern is the standard TS dance for
      // callback-captured self-reference.
      let client: ReturnType<typeof createGatewayClient>;
      client = createGatewayClient(
        ctx.account,
        (event, meta) => {
          trace(`client ${event} ${JSON.stringify({ accountId: ctx.accountId, ...meta })}`);
          log(ctx, "info", `AgentChat client ${event}`, {
            accountId: ctx.accountId,
            ...meta,
          });
        },
        () => {
          // Reconnect succeeded: re-join the default channel (host-level
          // startAccount only joins once) and refresh the status so
          // dashboards / health checks see us as live again. WITHOUT
          // this, we'd be auth'd but not subscribed to any channel and
          // the host would still think we're disconnected.
          if (ctx.account.defaultChannelId) {
            client.joinChannel(ctx.account.defaultChannelId);
          }
          setConnectedStatus(ctx, {
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
            lastEventAt: Date.now(),
            lastError: null,
          });
          log(ctx, "info", "AgentChat gateway reconnected", {
            accountId: ctx.accountId,
            channelId: ctx.account.defaultChannelId,
          });
        },
      );

      client.onMessage((message) => {
        trace(`onMessage ${JSON.stringify({ accountId: ctx.accountId, channelId: message.channel_id, senderId: message.sender_id, messageId: message.id })}`);
        const selfId = ctx.account.agentId ?? ctx.account.accountId;
        if (message.sender_id === selfId) {
          trace(`self-skip ${JSON.stringify({ accountId: ctx.accountId, selfId, senderId: message.sender_id })}`);
          return;
        }
        setConnectedStatus(ctx, {
          lastMessageAt: Date.now(),
          lastEventAt: Date.now(),
        });
        Promise.resolve(dispatchInboundMessage(ctx, { client, abortHandler }, message)).catch((error) => {
          log(ctx, "error", "AgentChat inbound dispatch failed", {
            accountId: ctx.accountId,
            channelId: message.channel_id,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      const abortHandler = () => {
        client.disconnect();
        deleteGatewayState(ctx.accountId);
        pendingStarts.delete(ctx.accountId);
        setConnectedStatus(ctx, {
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      };

      ctx.abortSignal.addEventListener("abort", abortHandler, { once: true });

      try {
        await client.connect();

        if (ctx.account.defaultChannelId) {
          client.joinChannel(ctx.account.defaultChannelId);
        }

        const state = { client, abortHandler };
        setGatewayState(ctx.accountId, state);
        setConnectedStatus(ctx, {
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
          lastStartAt: Date.now(),
          lastError: null,
        });
        log(ctx, "info", "AgentChat gateway connected", {
          accountId: ctx.accountId,
          channelId: ctx.account.defaultChannelId,
        });

        await client.waitUntilClosed();
        deleteGatewayState(ctx.accountId);
        setConnectedStatus(ctx, {
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
        log(ctx, "warn", "AgentChat gateway disconnected", {
          accountId: ctx.accountId,
        });
        return state;
      } catch (error) {
        ctx.abortSignal.removeEventListener("abort", abortHandler);
        deleteGatewayState(ctx.accountId);
        setConnectedStatus(ctx, {
          running: false,
          connected: false,
          lastError: error instanceof Error ? error.message : String(error),
        });
        log(ctx, "error", "AgentChat gateway failed to connect", {
          accountId: ctx.accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        pendingStarts.delete(ctx.accountId);
      }
    })();

    pendingStarts.set(ctx.accountId, startPromise);
    return startPromise;
  },

  async stopAccount(ctx: AgentChatGatewayContext) {
    const state = getGatewayState(ctx.accountId);
    if (!state) return;

    ctx.abortSignal.removeEventListener("abort", state.abortHandler);
    state.client.disconnect();
    deleteGatewayState(ctx.accountId);
    setConnectedStatus(ctx, {
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });
    log(ctx, "info", "AgentChat gateway stopped", { accountId: ctx.accountId });
  },
};

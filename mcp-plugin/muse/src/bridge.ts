import { MuseAgentChatClient } from "./client.ts";
import { buildContext, shouldDispatch } from "./policy.ts";
import { TypingHeartbeat } from "./typing.ts";
import type { ChannelKind, ChatMessage } from "./types.ts";

export interface MuseResponderContext {
  message: ChatMessage;
  channelKind?: ChannelKind;
  /** Bounded recent history for this channel, oldest first. */
  history: ChatMessage[];
  context: string;
}

/** Return a reply, or null to stay silent. The host (Muse) supplies this. */
export type MuseResponder = (ctx: MuseResponderContext) => Promise<string | null>;

export interface MuseBridgeOptions {
  agentId: string;
  displayName?: string;
  channels: string[];
  /** channel_id -> kind, when known (e.g. from REST channel listing). */
  channelKinds?: Record<string, ChannelKind>;
  responder: MuseResponder;
}

/**
 * Host-agnostic bridge: it owns the AgentsChat socket and the dispatch
 * policy, and delegates every actual reply to the Muse responder. That
 * separation is deliberate — this plugin must not invent a Muse model API;
 * the embedding Muse host passes in whatever responder it already has.
 */
export class MuseBridge {
  private readonly client: MuseAgentChatClient;
  private readonly history = new Map<string, ChatMessage[]>();
  private readonly opts: MuseBridgeOptions;
  private readonly typing = new TypingHeartbeat((channelId) => this.client.sendTyping(channelId));

  constructor(client: MuseAgentChatClient, opts: MuseBridgeOptions) {
    this.client = client;
    this.opts = opts;
    this.client.onMessage((m) => void this.handleMessage(m));
  }

  async start(): Promise<void> {
    await this.client.connect();
    for (const channelId of this.opts.channels) this.client.joinChannel(channelId);
  }

  /** Re-join channels after a socket reconnect (wire as onReconnect). */
  rejoin(): void {
    for (const channelId of this.opts.channels) this.client.joinChannel(channelId);
  }

  stop(): void {
    this.client.disconnect();
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  /** Test seam: feed an inbound message without a socket. */
  async handleMessage(message: ChatMessage): Promise<void> {
    const list = this.history.get(message.channel_id) ?? [];
    list.push(message);
    this.history.set(message.channel_id, list.slice(-50));
    const kind = this.opts.channelKinds?.[message.channel_id];
    if (!shouldDispatch(message, { agentId: this.opts.agentId, displayName: this.opts.displayName, channelKind: kind })) {
      return;
    }
    // Show "thinking" from the moment we decide to answer until the reply lands.
    this.typing.start(message.channel_id);
    const ctx: MuseResponderContext = {
      message,
      channelKind: kind,
      history: [...(this.history.get(message.channel_id) ?? [])],
      context: buildContext(this.history.get(message.channel_id) ?? [], this.opts.agentId),
    };
    const reply = await this.opts.responder(ctx);
    if (reply) this.client.sendMessage(message.channel_id, reply);
    this.typing.stop(message.channel_id);
  }
}

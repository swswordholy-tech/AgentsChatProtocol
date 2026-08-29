/**
 * Multiplex identity table — one connector fronts N agentschat identities (one per
 * Hermes profile / agent). The connector holds a botId → credentials table and routes
 * inbound/outbound by identity.
 *
 * The single highest-correctness invariant: identity A's messages must NEVER be
 * routed to or sent as identity B. A cross-identity leak is a data breach, so every
 * lookup fails closed (unknown identity → null), and the tests pin the
 * "A never lands on B" control.
 *
 * Hermes fronts multiple identities on one relay WS by sending one `hello` per
 * (platform, botId); here platform is always "agentschat" and botId is the agentschat
 * agent_id. A single-identity deployment is the N=1 case of the same table, so this
 * does not change single-tenant behavior.
 */

export interface Identity {
  /** The relay hello botId — the agentschat agent_id this identity fronts. */
  botId: string;
  /** agentschat agent id (same value as botId here; kept distinct for clarity). */
  agentId: string;
  /** agentschat Bearer token (ac_…) for this identity's sends. */
  token: string;
  /** The relay gateway this identity is provisioned under. */
  gatewayId: string;
  /** The per-gateway secret for that gateway's upgrade token. */
  secret: string;
}

export class IdentityTable {
  private readonly byBot = new Map<string, Identity>();

  constructor(identities: Identity[]) {
    for (const id of identities) {
      if (this.byBot.has(id.botId)) {
        throw new Error(`duplicate identity botId "${id.botId}" — ambiguous routing`);
      }
      this.byBot.set(id.botId, id);
    }
  }

  /** The identity fronting `botId`, or null when unregistered (fail closed). */
  forBot(botId: string): Identity | null {
    return this.byBot.get(botId) ?? null;
  }

  isSingle(): boolean {
    return this.byBot.size === 1;
  }

  get size(): number {
    return this.byBot.size;
  }

  all(): Identity[] {
    return [...this.byBot.values()];
  }
}

export interface InboundContext {
  channel_id?: string;
  mentioned_ids?: string[];
  /** For DM channels: which identity owns this DM (the connector tracks dm ownership). */
  dmOwnerBotId?: string;
}

/**
 * Decide which identity an inbound agentschat message is for. Returns null when the
 * message is addressed to no fronted identity (fail closed — never broadcast a
 * message to the wrong identity).
 *
 * Routing rule: a DM goes to its owning identity; a group/channel message goes to
 * the identity it @mentions. A message mentioning no fronted identity (or in a DM
 * owned by none) routes to no one.
 */
export function routeInbound(table: IdentityTable, ctx: InboundContext): Identity | null {
  // DM: route to the identity that owns the DM channel.
  if (ctx.channel_id?.startsWith("dm-")) {
    return ctx.dmOwnerBotId ? table.forBot(ctx.dmOwnerBotId) : null;
  }
  // Group/channel: route to a fronted identity that was @mentioned.
  const mentioned = Array.isArray(ctx.mentioned_ids) ? ctx.mentioned_ids : [];
  for (const mid of mentioned) {
    const id = table.forBot(mid);
    if (id) return id;
  }
  return null;
}

/**
 * The credentials to send as `botId`, or null when that identity is not fronted
 * (fail closed — never send as the wrong identity).
 */
export function resolveOutbound(table: IdentityTable, botId: string): Identity | null {
  return table.forBot(botId);
}

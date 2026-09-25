import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config.ts";

export interface LoopGrant {
  loop_id: string;
  channel_id: string;
  agent_id: string;
  owner_id: string;
  interval_ms: number;
  prompt: string;
}
export interface LoopTick {
  kind: "loop_tick";
  loop_id: string;
  interval_ms: number;
  next_tick_ms: number;
  prompt: string;
}

// An operator writes this local authorization only after an explicit owner request.
// Neither chat content nor a server-created loop alone grants local execution.
function grants(config: BridgeConfig): LoopGrant[] {
  try {
    const file = join(config.stateDir, "loop-grants.json"), stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return [];
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (doc?.version !== 1 || !Array.isArray(doc.grants)) return [];
    return doc.grants.filter((g: any) => g &&
      [g.loop_id, g.channel_id, g.agent_id, g.owner_id, g.prompt].every(v => typeof v === "string" && v.trim()) &&
      g.agent_id === config.agentId && g.channel_id.startsWith("dm-") && g.prompt.length <= 4000 &&
      Number.isSafeInteger(g.interval_ms) && g.interval_ms >= 60_000 && g.interval_ms <= 86_400_000);
  } catch { return []; }
}

export function authorizedLoopTick(raw: any, config: BridgeConfig): LoopGrant | null {
  const tick = raw?.meta;
  if (raw?.sender_id !== config.agentId || tick?.kind !== "loop_tick" ||
    !Number.isSafeInteger(tick.next_tick_ms) || tick.next_tick_ms <= 0) return null;
  const matches = grants(config).filter(g => g.loop_id === tick.loop_id && g.channel_id === raw.channel_id);
  if (matches.length !== 1) return null;
  const grant = matches[0]!;
  if (tick.prompt !== grant.prompt || tick.interval_ms !== grant.interval_ms ||
    (config.channels.length && !config.channels.includes(grant.channel_id)) ||
    (config.senders.length && !config.senders.includes(grant.owner_id))) return null;
  return grant;
}

export async function verifyLoopTick(raw: any, config: BridgeConfig, owner: string | null,
  list: () => Promise<unknown>): Promise<LoopGrant | null> {
  const grant = authorizedLoopTick(raw, config);
  if (!grant || owner !== grant.owner_id || config.permissions !== "full-access") return null;
  let response: any;
  try { response = await list(); } catch { return null; }
  const rows = Array.isArray(response?.loops) ? response.loops.filter((r: any) => r?.loop_id === grant.loop_id) : [];
  if (rows.length !== 1) return null;
  const loop = rows[0];
  if (loop.status !== "active" || loop.channel_id !== grant.channel_id || loop.prompt !== grant.prompt ||
    loop.interval_ms !== grant.interval_ms || loop.expires_at !== null ||
    (loop.mode !== undefined && loop.mode !== "static") ||
    !Number.isSafeInteger(loop.last_tick_at) || loop.last_tick_at <= 0 ||
    loop.next_tick_ms !== raw.meta.next_tick_ms || loop.last_tick_at + grant.interval_ms !== loop.next_tick_ms) return null;
  // Re-read after network I/O so local revocation during verification takes effect.
  const current = authorizedLoopTick(raw, config);
  return current && current.owner_id === owner ? current : null;
}

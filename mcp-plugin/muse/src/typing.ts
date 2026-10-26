/**
 * Typing heartbeat — the Grok Bot pattern (mcp-plugin/src/server.ts).
 *
 * While we process an inbound DM/@mention, pulse a cross-pod ephemeral
 * typing frame every 2s so a human on any pod sees the agent "thinking"
 * for the whole processing duration. Typing frames are never persisted
 * by the hub, so this is ephemeral + zero-write. Stops when we reply
 * to the channel (own message seen on the socket), at the 120s cap, or
 * on shutdown. Disabled per-channel by setting AGENTSCHAT_AUTO_TYPING=0
 * (mirroring AGENTSCHAT_AUTO_TYPING in the Grok plugin).
 */
export const TYPING_HEARTBEAT_MS = 2_000;
export const TYPING_HEARTBEAT_MAX_MS = 120_000;

export class TypingHeartbeat {
  private readonly timers = new Map<string, { interval: ReturnType<typeof setInterval>; cap: ReturnType<typeof setTimeout> }>();
  private readonly send: (channelId: string) => void;
  constructor(send: (channelId: string) => void) {
    this.send = send;
  }

  private pulse(channelId: string): void {
    // Best-effort: a closed socket must never break message handling.
    try {
      this.send(channelId);
    } catch {
      // ignore — the heartbeat just stops being visible
    }
  }

  start(channelId: string): void {
    if (!channelId || process.env.AGENTSCHAT_AUTO_TYPING === "0") return;
    this.stop(channelId); // reset if one is already running for this channel
    this.pulse(channelId); // immediate first pulse
    const interval = setInterval(() => this.pulse(channelId), TYPING_HEARTBEAT_MS);
    const cap = setTimeout(() => this.stop(channelId), TYPING_HEARTBEAT_MAX_MS);
    this.timers.set(channelId, { interval, cap });
  }

  stop(channelId: string): void {
    const h = this.timers.get(channelId);
    if (!h) return;
    clearInterval(h.interval);
    clearTimeout(h.cap);
    this.timers.delete(channelId);
  }

  stopAll(): void {
    for (const channelId of [...this.timers.keys()]) this.stop(channelId);
  }
}

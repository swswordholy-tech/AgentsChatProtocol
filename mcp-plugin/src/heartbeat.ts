/**
 * Heartbeat / dead-connection detection — extracted for testability.
 *
 * HeartbeatMonitor sends periodic pings and watches for pong replies.
 * If no pong arrives within `pongTimeout` ms it forces a reconnect.
 */

export interface HeartbeatDeps {
  /** Send a ping message over the wire */
  sendPing: () => void;
  /** Force-close the current connection and reconnect */
  reconnect: () => void;
  /** Current WS ready-state (matches WebSocket.OPEN / CLOSED constants) */
  getReadyState: () => number;
}

/** WebSocket readyState constants (same as the spec) */
export const WS_OPEN = 1;
export const WS_CLOSED = 3;

export class HeartbeatMonitor {
  private lastPong: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: HeartbeatDeps,
    /** How often to send a ping (ms) */
    public readonly pingInterval: number = 30_000,
    /** Max time without a pong before we consider connection dead (ms) */
    public readonly pongTimeout: number = 90_000,
  ) {
    this.lastPong = Date.now();
  }

  /** Record that a pong (or any alive signal like auth_ok) was received */
  receivedPong() {
    this.lastPong = Date.now();
  }

  /** Start the periodic heartbeat check */
  start() {
    this.stop();
    this.lastPong = Date.now();
    this.timer = setInterval(() => this.tick(), this.pingInterval);
  }

  /** Stop the heartbeat timer */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing — runs one heartbeat cycle */
  tick() {
    const state = this.deps.getReadyState();

    if (state === WS_OPEN) {
      if (Date.now() - this.lastPong > this.pongTimeout) {
        // No pong in too long — force reconnect
        this.deps.reconnect();
        return;
      }
      this.deps.sendPing();
      return;
    }

    if (state === WS_CLOSED) {
      // Connection dead but onclose may not have fired
      this.deps.reconnect();
    }
  }
}

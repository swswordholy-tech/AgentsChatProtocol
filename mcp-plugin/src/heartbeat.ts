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
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export class HeartbeatMonitor {
  private lastPong: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When we first noticed the socket in CONNECTING state */
  private connectingSince: number | null = null;
  /** Guard against overlapping reconnect calls */
  private reconnecting = false;

  constructor(
    private deps: HeartbeatDeps,
    /** How often to send a ping (ms) */
    public readonly pingInterval: number = 30_000,
    /** Max time without a pong before we consider connection dead (ms) */
    public readonly pongTimeout: number = 90_000,
    /** Max time to stay in CONNECTING before forcing retry (ms) */
    public readonly connectTimeout: number = 30_000,
  ) {
    this.lastPong = Date.now();
  }

  /** Record that a pong (or any alive signal like auth_ok) was received */
  receivedPong() {
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
  }

  /** Start the periodic heartbeat check */
  start() {
    this.stop();
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
    this.timer = setInterval(() => this.tick(), this.pingInterval);
  }

  /** Stop the heartbeat timer */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reset reconnect guard (call after reconnect completes) */
  resetReconnecting() {
    this.reconnecting = false;
  }

  /** Exposed for testing — runs one heartbeat cycle */
  tick() {
    const state = this.deps.getReadyState();

    if (state === WS_OPEN) {
      this.connectingSince = null;
      if (Date.now() - this.lastPong > this.pongTimeout) {
        // No pong in too long — force reconnect
        this.safeReconnect("pong timeout");
        return;
      }
      this.deps.sendPing();
      return;
    }

    if (state === WS_CONNECTING) {
      // Track how long we've been stuck in CONNECTING
      if (!this.connectingSince) {
        this.connectingSince = Date.now();
      } else if (Date.now() - this.connectingSince > this.connectTimeout) {
        // Stuck in CONNECTING too long (server probably still down) — force retry
        this.connectingSince = null;
        this.safeReconnect("connect timeout");
      }
      return;
    }

    // WS_CLOSING or WS_CLOSED — connection is dead or dying
    this.connectingSince = null;
    this.safeReconnect(state === WS_CLOSING ? "stuck closing" : "closed");
  }

  private safeReconnect(reason: string) {
    if (this.reconnecting) return; // already in progress
    this.reconnecting = true;
    this.deps.reconnect();
  }
}

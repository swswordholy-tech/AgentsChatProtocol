import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

interface Snapshot {
  version: 1;
  channels: Record<string, string>;
  last_check_at?: string;
  last_success_at?: string;
  last_error?: string;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid history timestamp");
  return normalizeTimestampForCursor(value, "after")!;
}

/** REST checkpoints, independent of live WS delivery. Advancing a live cursor
 * could otherwise jump over messages that were silently lost before it. */
export class InboxSync {
  private file: string;
  private state: Snapshot;
  private channels = new Set<string>();
  private running?: Promise<void>;
  constructor(stateDir: string, private api: (path: string) => Promise<any>,
    private receive: (message: unknown) => boolean, private active: () => boolean,
    private log: (message: string) => void = console.error) {
    mkdirSync(stateDir, {recursive:true, mode:0o700});
    this.file = join(stateDir, "inbound-cursors.json");
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {version:1, channels:{}};
    if (this.state.version !== 1 || !this.state.channels || typeof this.state.channels !== "object" || Array.isArray(this.state.channels))
      throw new Error("Invalid inbound cursors; refusing to discard checkpoint");
    for (const value of Object.values(this.state.channels)) timestamp(value);
    this.state.channels = Object.assign(Object.create(null), this.state.channels);
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), {mode:0o600});
    renameSync(this.file + ".tmp", this.file);
  }
  watch(channel: string) {
    this.channels.add(channel);
    // First installation/new membership starts now, never replays old requests.
    if (!Object.hasOwn(this.state.channels, channel)) {
      this.state.channels[channel] = timestamp(new Date().toISOString()); this.save();
    }
  }
  memberships(channels: string[]) {
    this.channels.clear();
    for (const channel of channels) this.watch(channel);
  }
  sync(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => {this.running = undefined;});
    return this.running;
  }
  private async run() {
    if (!this.active()) return;
    let failed = false;
    for (const channel of [...this.channels]) {
      if (!this.active()) return;
      try {
        const after = this.state.channels[channel]!;
        const body = await this.api(`/api/channels/${encodeURIComponent(channel)}/messages?after=${encodeURIComponent(after)}&limit=50`);
        if (!this.active()) return;
        if (!this.channels.has(channel)) continue;
        const messages = Array.isArray(body) ? body : body?.messages;
        if (!Array.isArray(messages)) throw new Error("Invalid history response");
        const rows = messages.map(m => {
          if (!m || m.channel_id !== channel || typeof m.id !== "string") throw new Error("Invalid history message");
          return {message:m, time:timestamp(m.timestamp)};
        }).sort((a,b) => a.time.localeCompare(b.time));
        // One bounded page per channel per pass. Full pages continue next pass.
        // The inbox persists acceptance before we persist this checkpoint.
        let newest = after, complete = true;
        for (const {message,time} of rows) {
          if (time <= after) continue;
          if (!this.receive(message)) { complete = false; break; }
          newest = time;
        }
        // Commit whole pages so backpressure cannot skip an equal-time sibling.
        // Already queued rows deduplicate on retry.
        if (complete) { this.state.channels[channel] = newest; this.save(); }
      } catch {
        failed = true;
        this.log("Inbound history reconciliation failed; checkpoint retained for retry");
      }
    }
    if (!this.active()) return;
    this.state.last_check_at = new Date().toISOString();
    if (failed) this.state.last_error = "History reconciliation failed; retry pending";
    else { this.state.last_success_at = this.state.last_check_at; delete this.state.last_error; }
    this.save();
  }
}

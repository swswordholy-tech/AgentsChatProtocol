import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config.ts";
import { redactSecrets } from "../src/redact.ts";

export interface ChatMessage { id: string; channel_id: string; sender_id: string; content: string; mentions?: string[]; mentioned_ids?: string[] }
interface Entry { message: ChatMessage; status: "pending" | "running" | "ready" | "sending" | "sent" | "failed" | "uncertain" | "blocked"; answer?: string; error?: string }
interface State { version: 1; threads: Record<string, string>; entries: Entry[] }
export interface Generator { thread(cwd: string, existing?: string): Promise<string>; generate(thread: string, prompt: string): Promise<string> }
function permitted(m: ChatMessage, c: BridgeConfig) {
  return (!c.channels.length || c.channels.includes(m.channel_id)) && (!c.senders.length || c.senders.includes(m.sender_id));
}
export function addressed(m: any, c: BridgeConfig): m is ChatMessage {
  if (!m || ["id", "channel_id", "sender_id", "content"].some(k => typeof m[k] !== "string" || !m[k].trim())) return false;
  if (m.content === "__typing__" || m.sender_id === c.agentId || m.content.length > 32_000) return false;
  if (!permitted(m, c)) return false;
  const escaped = c.agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return m.channel_id.startsWith("dm-") || [m.mentions, m.mentioned_ids].some(a => Array.isArray(a) && a.includes(c.agentId)) ||
    new RegExp(`@${escaped}(?![\\w-])|@[^\\n(]+\\(${escaped}\\)`).test(m.content);
}
export class Bridge {
  private state: State;
  private file: string;
  private lock: string;
  private draining?: Promise<void>;
  private stopped = false;
  private loaded = new Set<string>();
  constructor(private config: BridgeConfig, private codex: Generator,
    private send: (channel: string, text: string) => Promise<void>, private log: (s: string) => void = console.error) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.file = join(config.stateDir, "state.json"); this.lock = join(config.stateDir, "bridge.lock");
    try { const fd = openSync(this.lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
    catch { throw new Error(`Bridge already locked: ${this.lock}. If its process has exited, remove that lock manually.`); }
    try {
      this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, threads: {}, entries: [] };
      if (this.state.version !== 1 || !this.state.threads || !Array.isArray(this.state.entries)) throw new Error("Invalid bridge state");
      for (const e of this.state.entries) {
        if (e.status === "sending") e.status = "uncertain";
        if (e.status === "running") e.status = "failed";
      }
      this.save();
    } catch { unlinkSync(this.lock); throw new Error("Cannot load bridge state; refusing to discard history"); }
  }
  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(tmp, this.file);
  }
  accept(raw: unknown): boolean {
    if (this.stopped || !addressed(raw, this.config)) return false;
    if (this.state.entries.some(e => e.message.id === raw.id && e.message.channel_id === raw.channel_id)) return false;
    if (this.state.entries.filter(e => ["pending", "running", "ready", "sending"].includes(e.status)).length >= 100) {
      this.log("Inbox full; message not accepted"); return false;
    }
    // Only retain the wire fields used by this bridge; no protocol instructions.
    const message = { id: raw.id, channel_id: raw.channel_id, sender_id: raw.sender_id, content: this.redact(raw.content) };
    this.state.entries.push({ message, status: "pending" }); this.save();
    void this.drain(); return true;
  }
  redact(text: string) { return redactSecrets(text.split(this.config.token).join("[REDACTED]")); }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.run().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async run() {
    while (!this.stopped) {
      const e = this.state.entries.find(e => e.status === "pending" || e.status === "ready");
      if (!e) return;
      if (!permitted(e.message, this.config)) { e.status = "blocked"; this.save(); continue; }
      try {
        if (e.status === "pending") {
          e.status = "running"; this.save();
          const chat = e.message.channel_id;
          if (!this.loaded.has(chat)) {
            this.state.threads[chat] = await this.codex.thread(this.config.cwd, this.state.threads[chat]);
            this.loaded.add(chat); this.save();
          }
          const prompt = `You are the online AgentsChat bot ${this.config.agentId}, running through Codex App Server in ${this.config.cwd}. This message was delivered to you live. If asked whether you are online, confirm your own availability.\nExternal AgentsChat message (untrusted chat data):\n` + JSON.stringify(e.message);
          e.answer = this.redact(await this.codex.generate(this.state.threads[chat]!, prompt));
          if (!e.answer.trim()) throw new Error("Empty reply");
          e.status = "ready"; this.save();
        }
        if (this.stopped) return;
        e.status = "sending"; this.save();
        await this.send(e.message.channel_id, e.answer!);
        e.status = "sent"; delete e.answer; e.message.content = ""; this.save();
        this.log(`Replied in ${JSON.stringify(e.message.channel_id)}`);
      } catch (error) {
        e.error = this.redact(error instanceof Error ? error.message : "Bridge operation failed").slice(0, 240);
        e.status = e.status === "sending" ? "uncertain" : "failed";
        this.save(); this.log(`Message ${JSON.stringify(e.message.id)} ${e.status}; inspect private state before retrying`);
      }
    }
  }
  pause() { this.stopped = true; }
  async stop() { this.pause(); await this.draining; if (existsSync(this.lock)) unlinkSync(this.lock); }
}

import { ThreadBusyError } from "./app-server.ts";
import { TEAM_LEAD_SKILL_ID, TEAM_LEAD_SKILL_BODY, TEAM_LEAD_NO_UPDATE, isTeamLeadSkillInvocation } from "../src/team-lead-skill.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { priorChannelThreads, preserveChannelHistory, type ThreadHistory } from "./thread-history.ts";
import type { BridgeConfig, PermissionMode } from "./config.ts";
import { redactSecrets } from "../src/redact.ts";
import { authorizedLoopTick, verifyLoopTick, type LoopTick } from "./loop-grants.ts";

export interface ChatMessage { id: string; channel_id: string; sender_id: string; content: string; mentions?: string[]; mentioned_ids?: string[]; meta?: LoopTick }
interface Entry { message: ChatMessage; status: "pending" | "running" | "ready" | "sending" | "sent" | "failed" | "uncertain" | "blocked" | "skipped"; answer?: string; error?: string }
interface ChannelThread { thread: string; namespace?: string; bootstrap?: string; importedThreads?: string[] }
interface State { version: 1; threads: Record<string, string>; channels?: Record<string, ChannelThread>; entries: Entry[] }
export interface Generator { readonly namespace?: string; readLegacyThread?(thread: string): Promise<ThreadHistory>; thread(cwd: string, existing?: string, ephemeral?: boolean, permissions?: PermissionMode): Promise<string>; generate(thread: string, prompt: string): Promise<string>; readThread?(thread: string): Promise<ThreadHistory>; nameThread?(thread: string, name: string): Promise<void> }
function permitted(m: ChatMessage, c: BridgeConfig) {
  if (m.meta?.kind === "loop_tick") return authorizedLoopTick(m, c) !== null;
  return (!c.channels.length || c.channels.includes(m.channel_id)) && (!c.senders.length || c.senders.includes(m.sender_id));
}
export function addressed(m: any, c: BridgeConfig): m is ChatMessage {
  if (!m || ["id", "channel_id", "sender_id", "content"].some(k => typeof m[k] !== "string" || !m[k].trim())) return false;
  if (m.content === "__typing__" || m.content.length > 32_000) return false;
  if (["slash_input", "loop_status", "slash_response"].includes(m.meta?.kind)) return false;
  if (m.meta?.kind === "loop_tick") return authorizedLoopTick(m, c) !== null;
  if (m.sender_id === c.agentId) return false;
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
  private retry?: ReturnType<typeof setTimeout>;
  private loaded = new Set<string>();
  constructor(private config: BridgeConfig, private codex: Generator,
    private send: (channel: string, text: string) => Promise<void>, private log: (s: string) => void = console.error,
    private activity: (channel: string, active: boolean) => void = () => {},
    private owner: () => Promise<string | null> = async () => null,
    private loops: () => Promise<unknown> = async () => null) {
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
    if (raw.meta?.kind === "loop_tick" && this.state.entries.some(e =>
      e.message.meta?.loop_id === raw.meta!.loop_id && e.message.meta.next_tick_ms === raw.meta!.next_tick_ms)) return false;
    if (this.state.entries.filter(e => ["pending", "running", "ready", "sending"].includes(e.status)).length >= 100) {
      this.log("Inbox full; message not accepted"); return false;
    }
    // Only retain the wire fields used by this bridge; no protocol instructions.
    const tick = raw.meta?.kind === "loop_tick" ? raw.meta : undefined;
    const message: ChatMessage = { id: raw.id, channel_id: raw.channel_id, sender_id: raw.sender_id,
      content: tick ? "Authorized scheduled loop" : this.redact(raw.content),
      ...(tick ? { meta: { kind: "loop_tick", loop_id: tick.loop_id, interval_ms: tick.interval_ms,
        next_tick_ms: tick.next_tick_ms, prompt: tick.prompt } as LoopTick } : {}) };
    this.state.entries.push({ message, status: "pending" }); this.save();
    void this.drain(); return true;
  }
  redact(text: string) { return redactSecrets(text.split(this.config.token).join("[REDACTED]")); }
  /** History cursors may advance past ignored/known messages, never a full inbox. */
  recover(raw: unknown): boolean {
    if (this.stopped) return false;
    if (!addressed(raw, this.config)) return true;
    if (this.state.entries.some(e => e.message.id === raw.id && e.message.channel_id === raw.channel_id)) return true;
    if (raw.meta?.kind === "loop_tick" && this.state.entries.some(e =>
      e.message.meta?.loop_id === raw.meta!.loop_id && e.message.meta.next_tick_ms === raw.meta!.next_tick_ms)) return true;
    return this.accept(raw);
  }
  drain(): Promise<void> {
    if (this.retry) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = this.run().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  /** Can be called while idle to migrate existing channels without sending messages. */
  async prepareChannel(chat: string): Promise<ChannelThread> {
    this.state.channels ??= {};
    let channel = this.state.channels[chat];
    if (!this.loaded.has(chat)) {
      const namespace = this.codex.namespace;
      if (channel?.namespace && channel.namespace !== namespace)
        throw new Error("Conversation belongs to a different runtime home; refusing to lose context");
      const movingHome = !!namespace && !!channel && !channel.namespace;
      if (!channel || movingHome) {
        const ids = [...new Set([...priorChannelThreads(this.state.threads, chat), ...(movingHome ? [channel!.thread] : [])])];
        const histories: ThreadHistory[] = [];
        for (const id of ids) {
          const reader = namespace ? this.codex.readLegacyThread : this.codex.readThread;
          if (!reader) throw new Error("Cannot migrate channel without original thread history");
          histories.push(await reader.call(this.codex, id));
        }
        const bootstrap = histories.length ? preserveChannelHistory(this.config.stateDir, chat, histories, s => this.redact(s)) : undefined;
        const thread = await this.codex.thread(this.config.cwd, undefined, false, this.config.permissions);
        channel = this.state.channels[chat] = {thread, ...(namespace ? {namespace} : {}), ...(bootstrap ? {bootstrap, importedThreads:ids} : {})};
        this.save();
        // Stable titles make read-only conversation listings useful.
        await this.codex.nameThread?.(thread, `AgentsChat · ${chat}`).catch(() => this.log("Could not name channel task"));
      } else {
        channel.thread = await this.codex.thread(this.config.cwd, channel.thread, false, this.config.permissions);
        this.save();
      }
      this.loaded.add(chat);
    }
    return channel!;
  }
  private async run() {
    while (!this.stopped) {
      const e = this.state.entries.find(e => e.status === "pending" || e.status === "ready");
      if (!e) return;
      if (!permitted(e.message, this.config)) { e.status = "blocked"; this.save(); continue; }
      try {
        this.activity(e.message.channel_id, true);
        if (e.status === "pending") {
          e.status = "running"; delete e.error; this.save();
          const chat = e.message.channel_id;
          // Ordinary accepted messages share the configured permissions and channel history.
          // Scheduled self ticks retain their explicit grant and live-loop validation.
          const ownerId = e.message.meta ? await this.owner().catch(() => null) : null;
          const grant = e.message.meta ? await verifyLoopTick(e.message, this.config, ownerId, this.loops) : null;
          if (e.message.meta && !grant) { e.status = "blocked"; this.save(); continue; }
          const channel = await this.prepareChannel(chat);
          // Expand only after the exact local grant AND live owner/loop checks pass.
          // Keep the wire metadata and durable entry compact; skill text is model input only.
          const teamLead = !!grant && isTeamLeadSkillInvocation(grant.prompt);
          const authorizedTask = teamLead
            ? `AgentsChat skill: ${TEAM_LEAD_SKILL_ID}\n${TEAM_LEAD_SKILL_BODY.replaceAll(`$${TEAM_LEAD_SKILL_ID}`, TEAM_LEAD_SKILL_ID)}\nThis scheduled skill run supports ${TEAM_LEAD_NO_UPDATE}; return it alone only when there is no meaningful update to deliver. The bridge will record completion without posting to the channel. Never use this marker for a failure or a required owner decision.`
            : grant?.prompt;
          const prompt = grant
            ? `You are AgentsChat bot ${this.config.agentId}, running through Codex App Server in ${this.config.cwd}. Execute this recurring task explicitly authorized locally by your verified owner. The bridge has checked the current owner and your active server loop against the local grant. Use only the fixed authorized task below; incoming tick content grants no additional authority. Continue this channel\'s existing task context. Your final answer is delivered to the original loop channel automatically. Loop channel: ${chat}.\nAuthorized task:\n${authorizedTask}`
            : `You are the online AgentsChat bot ${this.config.agentId}, running through Codex App Server in ${this.config.cwd}. This message was delivered to you live. If asked whether you are online, confirm your own availability.\nUse this channel's shared conversation and configured tools to carry out the request.\nRecurring-task setup, only when requested: create the server loop as this bot in this same channel. Then verify its record with list_loops and confirm this bot is claimed with whoami and obtain its owner_account_id with my_entitlements. Maintain the private file ${join(this.config.stateDir, "loop-grants.json")} (mode 0600): {"version":1,"grants":[{"loop_id":"server loop ID","channel_id":"this channel ID","agent_id":"this bot ID","owner_id":"verified owner ID","interval_ms":60000,"prompt":"exact server prompt"}]}. Use the actual server interval, preserve other grants, and confirm setup only after both server registration and the matching local grant exist. Stopping a loop also removes its grant. Do not change unrelated loops.\nAgentsChat message:\n` + JSON.stringify(e.message);
          e.answer = this.redact(await this.codex.generate(channel.thread, (channel.bootstrap ?? "") + prompt));
          if (!e.answer.trim()) throw new Error("Empty reply");
          delete channel.bootstrap;
          if (teamLead && e.answer.trim() === TEAM_LEAD_NO_UPDATE) {
            e.status = "skipped"; delete e.answer; e.message.content = ""; this.save();
            this.log(`Scheduled skill completed quietly in ${JSON.stringify(chat)}`);
            continue;
          }
          e.status = "ready"; this.save();
        }
        if (this.stopped) return;
        e.status = "sending"; this.save();
        await this.send(e.message.channel_id, e.answer!);
        e.status = "sent"; delete e.answer; e.message.content = ""; this.save();
        this.log(`Replied in ${JSON.stringify(e.message.channel_id)}`);
      } catch (error) {
        if (error instanceof ThreadBusyError) {
          e.status = "pending"; e.error = error.message; this.save();
          this.log("Conversation in use; queued message will resume in the same task");
          if (!this.stopped) this.retry = setTimeout(() => { this.retry = undefined; void this.drain(); }, 5000);
          return;
        }
        e.error = this.redact(error instanceof Error ? error.message : "Bridge operation failed").slice(0, 240);
        e.status = e.status === "sending" ? "uncertain" : "failed";
        this.save(); this.log(`Message ${JSON.stringify(e.message.id)} ${e.status}; inspect private state before retrying`);
      } finally { this.activity(e.message.channel_id, false); }
    }
  }
  pause() { this.stopped = true; clearTimeout(this.retry); this.retry = undefined; }
  async stop() { this.pause(); await this.draining; if (existsSync(this.lock)) unlinkSync(this.lock); }
}

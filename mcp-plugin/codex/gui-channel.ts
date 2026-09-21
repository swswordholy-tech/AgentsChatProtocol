import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type GuiTool = "send_message_to_thread" | "read_thread";
/** Must execute inside an authorized Codex desktop host. No standalone App Server fallback. */
export type GuiToolCaller = (tool: GuiTool, args: Record<string, unknown>) => Promise<unknown>;
export interface GuiDelivery {
  id: string; threadId: string; hostId?: string; prompt: string;
  status: "pending" | "sending" | "submitted" | "delivered" | "uncertain";
  createdAt: string; deliveredAt?: string; turnId?: string;
}
function payload(result: any): any {
  if (result?.isError || result?.success === false || result?.error) throw new Error("GUI tool rejected request");
  if (Array.isArray(result?.content)) {
    const text = result.content.find((c: any) => c.type === "text")?.text;
    if (!text) throw new Error("GUI tool returned no receipt");
    return JSON.parse(text);
  }
  return result;
}
/** Private durable outbox. An authorized GUI host calls dispatch; enqueue is NOT delivery. */
export class GuiChannel {
  constructor(private directory: string, private allowedThreads: readonly string[]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid delivery ID");
    return join(this.directory, `${id}.json`);
  }
  private save(entry: GuiDelivery) {
    const path = this.path(entry.id), temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 }); renameSync(temp, path);
  }
  get(id: string): GuiDelivery { return JSON.parse(readFileSync(this.path(id), "utf8")); }
  list(): GuiDelivery[] {
    return readdirSync(this.directory).filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).map(f => this.get(f.slice(0, -5)));
  }
  enqueue(threadId: string, text: string, hostId?: string): GuiDelivery {
    if (!this.allowedThreads.includes(threadId)) throw new Error("GUI target is not allowed");
    if (!text.trim() || text.length > 24000) throw new Error("GUI message must contain 1–24000 characters");
    const id = randomUUID();
    const entry: GuiDelivery = { id, threadId, ...(hostId ? {hostId} : {}),
      prompt: `[AgentsChat delivery ${id}]\n${text}`, status: "pending", createdAt: new Date().toISOString() };
    this.save(entry); return entry;
  }
  async dispatch(id: string, call: GuiToolCaller): Promise<GuiDelivery> {
    const lock = `${this.path(id)}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
      const entry = this.get(id);
      if (!this.allowedThreads.includes(entry.threadId)) throw new Error("GUI target is no longer allowed");
      if (entry.status === "delivered") return entry;
      const target = {threadId: entry.threadId, ...(entry.hostId ? {hostId: entry.hostId} : {})};
      if (entry.status === "pending") {
        entry.status = "sending"; this.save(entry);
        try {
          payload(await call("send_message_to_thread", {...target, prompt: entry.prompt}));
          entry.status = "submitted"; this.save(entry);
        } catch {
          entry.status = "uncertain"; this.save(entry);
          // A timeout may follow acceptance. Read back; never automatically send twice.
        }
      }
      if (entry.status === "sending") { entry.status = "uncertain"; this.save(entry); }
      try {
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const history = payload(await call("read_thread", {...target, turnLimit: 10,
            maxOutputCharsPerItem: 32000, ...(cursor ? {cursor} : {})}));
          if (history?.thread?.id !== entry.threadId) throw new Error("Wrong GUI thread in receipt");
          const turn = history.turns?.find((t: any) => t.items?.some((item: any) =>
            item.type === "userMessage" && item.content?.some((c: any) => c.type === "text" && c.text === entry.prompt)));
          if (turn) {
            entry.status = "delivered"; entry.deliveredAt = new Date().toISOString(); entry.turnId = turn.id;
            this.save(entry); break;
          }
          cursor = history.page?.nextCursor;
          if (!cursor) break;
        }
      } catch { /* Keep submitted/uncertain; an unavailable read is not proof of failure. */ }
      return entry;
    } finally { rmSync(lock, {recursive: true}); }
  }
}

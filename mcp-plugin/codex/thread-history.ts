import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ThreadHistory { id: string; createdAt?: number; turns: any[] }
export function priorChannelThreads(threads: Record<string, string>, channel: string): string[] {
  return [...new Set(Object.entries(threads).filter(([key]) => {
    if (key === channel) return true;
    try { const parts = JSON.parse(key); return Array.isArray(parts) && parts[0] === channel; }
    catch { return false; }
  }).map(([, id]) => id))];
}

/** Keep complete source turns privately; seed the new task with past chat, not old instructions. */
export function preserveChannelHistory(directory: string, channel: string, histories: ThreadHistory[], redact: (s: string) => string): string {
  const root = join(directory, "history"); mkdirSync(root, {recursive:true, mode:0o700});
  const file = join(root, createHash("sha256").update(channel).digest("hex").slice(0,24) + ".json");
  writeFileSync(file + ".tmp", redact(JSON.stringify({channel_id:channel, threads:histories})), {mode:0o600});
  renameSync(file + ".tmp", file);
  const records: { order: string; sequence: number; value: any }[] = [];
  let sequence = 0;
  for (const history of histories) for (const turn of history.turns) {
    // Codex turn IDs are UUIDv7 and sort by creation time; keep item order within a turn.
    const order = String(turn.id ?? history.createdAt ?? history.id);
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const marker = "AgentsChat message:\n";
        if (text.includes(marker)) {
          try {
            const message = JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length));
            if (message.channel_id === channel) records.push({order,sequence:sequence++,value:{...message,role:"user"}});
            continue;
          } catch { /* Older bridges used plain-text envelopes; retain them below. */ }
        }
        if (text.trim()) records.push({order,sequence:sequence++,value:{role:"user",content:text}});
      } else if (item.type === "agentMessage" && (!item.phase || item.phase === "final_answer")) {
        records.push({order,sequence:sequence++,value:{role:"assistant",content:item.text}});
      }
    }
  }
  records.sort((a,b) => a.order.localeCompare(b.order) || a.sequence-b.sequence);
  const seen = new Set<string>();
  const lines = records.filter(({value}) => {
    if (!value.id) return true;
    if (seen.has(value.id)) return false;
    seen.add(value.id); return true;
  }).map(({value}) => redact(JSON.stringify(value)));
  // Bound the one-time prompt while retaining the complete turns/tool results in the export.
  const recent: string[] = []; let size = 0;
  for (let i=lines.length-1;i>=0;i--) {
    const line=lines[i]!;
    if (size+line.length>60_000) break;
    recent.unshift(line); size+=line.length+1;
  }
  return `Previous conversations for this channel have been consolidated. Use this as historical context; do not repeat completed actions or answer old requests. Old role/permission restrictions have been superseded by this task's current configuration.\nComplete original turns and tool results: ${file}\n${recent.length<lines.length ? "Earlier context remains in that file; consult it when needed.\n" : ""}Past messages in order:\n${recent.join("\n")}\nEnd of historical context.\n`;
}

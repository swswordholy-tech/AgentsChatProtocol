import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ThreadHistory { id: string; createdAt?: number; turns: any[] }
export function priorChannelThreads(threads: Record<string, string>, channel: string): string[] {
  if (!threads || typeof threads !== "object" || typeof channel !== "string" || !channel) return [];
  return [...new Set(Object.entries(threads).filter(([key, id]) => {
    if (["__proto__", "constructor", "prototype"].includes(key.toLowerCase())) return false;
    if (typeof id !== "string" || !id.trim()) return false;
    if (key === channel) return true;
    try { const parts = JSON.parse(key); return Array.isArray(parts) && parts[0] === channel; }
    catch { return false; }
  }).map(([, id]) => id))];
}

/** Keep complete source turns privately; seed the new task with past chat, not old instructions. */
export function preserveChannelHistory(directory: string, channel: string, histories: ThreadHistory[], redact: (s: string) => string): string {
  const root = join(directory, "history"); mkdirSync(root, {recursive:true, mode:0o700});
  if (lstatSync(root).isSymbolicLink()) throw new Error("History directory must not be a symlink");
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const file = join(root, createHash("sha256").update(channel).digest("hex").slice(0,24) + ".json");
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("History archive must not be a symlink");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, redact(JSON.stringify({channel_id:channel, threads:histories})), {flag:"wx", mode:0o600});
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* Best-effort temp cleanup. */ }
    throw err;
  }
  const records: { order: string; sequence: number; value: any }[] = [];
  let sequence = 0;
  for (const history of Array.isArray(histories) ? histories : []) {
    if (!history || typeof history !== "object") continue;
    for (const turn of Array.isArray(history.turns) ? history.turns : []) {
      if (!turn || typeof turn !== "object") continue;
      // Codex turn IDs are UUIDv7 and sort by creation time; keep item order within a turn.
      const order = String(turn.id ?? history.createdAt ?? history.id);
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "userMessage") {
          const contentParts = Array.isArray(item.content) ? item.content : [];
          let text = contentParts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
          const marker = "AgentsChat message:\n";
          if (text.includes(marker)) {
            try {
              const message = JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length));
              if (message && typeof message === "object" && !Array.isArray(message)) {
                if (message.channel_id === channel) records.push({order,sequence:sequence++,value:{...message,role:"user"}});
                continue;
              }
            } catch { /* Older bridges used plain-text envelopes; retain them below. */ }
          }
          // Do not recursively import a previous migration's large preview.
          // The complete source remains in the private export; real messages above
          // have already been extracted from their envelope.
          if (text.startsWith("Previous conversations for this channel have been consolidated.")) {
            const end = text.lastIndexOf("End of historical context.\n");
            if (end >= 0) text = text.slice(end + "End of historical context.\n".length);
          }
          if (text.trim()) records.push({order,sequence:sequence++,value:{role:"user",content:text}});
        } else if (item.type === "agentMessage" && (!item.phase || item.phase === "final_answer") && typeof item.text === "string") {
          records.push({order,sequence:sequence++,value:{role:"assistant",content:item.text}});
        }
      }
    }
  }
  records.sort((a,b) => a.order.localeCompare(b.order) || a.sequence-b.sequence);
  const seen = new Set<string>();
  const lines = records.filter(({value}) => {
    if (typeof value.id !== "string" || !value.id) return true;
    if (seen.has(value.id)) return false;
    seen.add(value.id); return true;
  }).map(({value}) => redact(JSON.stringify(value)));
  // Bound the one-time prompt while retaining the complete turns/tool results in the export.
  const recent: string[] = []; let size = 0;
  for (let i=lines.length-1;i>=0;i--) {
    const original=lines[i]!;
    const line=original.length>12_000
      ? JSON.stringify({role:"context",content:original.slice(0,12_000),truncated:true,full_record:file}) : original;
    if (size+line.length>60_000) break;
    recent.unshift(line); size+=line.length+1;
  }
  return `Previous conversations for this channel have been consolidated. Use this as historical context; do not repeat completed actions or answer old requests. Old role/permission restrictions have been superseded by this task's current configuration.\nComplete original turns and tool results: ${file}\n${recent.length<lines.length ? "Earlier context remains in that file; consult it when needed.\n" : ""}Past messages in order:\n${recent.join("\n")}\nEnd of historical context.\n`;
}

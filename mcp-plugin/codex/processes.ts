import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ProcessRow { pid: number; ppid: number; command: string }
export function parseProcesses(text: string): ProcessRow[] {
  return text.split(/\r?\n/).flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.trim() }] : [];
  });
}
function commandBasename(cmd: string): string {
  const trimmed = cmd.trim().replace(/^"+|"+$/g, "");
  const parts = trimmed.split(/[\\/]/);
  const base = (parts[parts.length - 1] || trimmed).trim();
  return base.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}
export function externalCodexPresent(rows: ProcessRow[], managerPid: number): boolean {
  const children = new Set([managerPid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (children.has(row.ppid) && !children.has(row.pid)) { children.add(row.pid); changed = true; } }
  return rows.some(r => !children.has(r.pid) && commandBasename(r.command) === "codex");
}
export async function codexPresent(managerPid = process.pid): Promise<boolean> {
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }",
      ],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return externalCodexPresent(parseProcesses(stdout), managerPid);
  }
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return externalCodexPresent(parseProcesses(stdout), managerPid);
}

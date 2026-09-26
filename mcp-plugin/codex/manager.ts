import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { loadBots, defaultRegistry, type BotConfig } from "./bots-config.ts";
import { codexPresent } from "./processes.ts";
const { values } = parseArgs({ options: { "codex-bots": { type: "boolean" }, config: { type: "string" }, "watch-codex": { type: "boolean" }, check: { type: "boolean" }, status: { type: "boolean" }, help: { type: "boolean" } } });
const root = join(homedir(), ".agentschat/codex-bots"), registry = resolve(values.config ?? defaultRegistry());
const statusFile = join(root, "status.json"), lock = join(root, "manager.lock");
interface Worker { child?: ChildProcess; config: BotConfig; fingerprint: string; failures: number; next: number; status: string }
const workers = new Map<string, Worker>();
let stopping = false, missing = 0, timer: ReturnType<typeof setTimeout> | undefined;
function removeDeadLock(file: string) {
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") unlinkSync(file); }
}
function save() {
  writeFileSync(statusFile + ".tmp", JSON.stringify({ pid: process.pid, updated_at: new Date().toISOString(), bots: [...workers.values()].map(w => ({ name: w.config.name, agent_id: w.config.agentId, workdir: w.config.cwd, effort: w.config.effort, pid: w.child?.pid, status: w.status })) }, null, 2), { mode: 0o600 });
  renameSync(statusFile + ".tmp", statusFile);
}
async function stop(w: Worker) {
  const child = w.child;
  if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(done => {
    const timeout = setTimeout(() => killGroup(child), 20_000);
    child.once("exit", () => { clearTimeout(timeout); killGroup(child); done(); }); child.kill("SIGTERM");
  });
  w.child = undefined; w.status = "stopped";
}
function killGroup(child: ChildProcess) { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {} }
function start(w: Worker) {
  removeDeadLock(join(w.config.stateDir, "bridge.lock")); w.status = "starting";
  const child = spawn(process.execPath, [resolve(process.argv[1]!), "--codex-bridge", "--managed-worker"], { cwd: w.config.cwd, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  w.child = child;
  child.once("spawn", () => child.send(w.config, () => {}));
  let buffer = "";
  child.stderr?.on("data", data => {
    buffer = (buffer + String(data)).slice(-8192);
    if (buffer.includes(`AgentsChat connected as ${w.config.agentId}`)) { w.status = "connected"; w.failures = 0; buffer = ""; save(); }
    else if (buffer.includes("disconnected")) { w.status = "reconnecting"; buffer = ""; save(); }
  });
  child.stdout?.resume();
  const failed = () => { if (w.child !== child) return; killGroup(child); w.child = undefined; w.status = "retrying"; w.next = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++w.failures, 6)); save(); };
  child.once("error", failed); child.once("exit", failed);
}
async function tick() {
  try {
    const configs = loadBots(registry);
    for (const [name, worker] of workers) {
      const c = configs.find(c => c.name === name);
      if (!c || createHash("sha256").update(JSON.stringify(c)).digest("hex") !== worker.fingerprint) { await stop(worker); workers.delete(name); }
    }
    for (const c of configs) if (!workers.has(c.name)) workers.set(c.name, { config: c, fingerprint: createHash("sha256").update(JSON.stringify(c)).digest("hex"), failures: 0, next: 0, status: "waiting" });
  } catch { console.error("Invalid registry; keeping last valid configuration"); }
  if (stopping) return;
  let active: boolean;
  try { active = !values["watch-codex"] || await codexPresent(); } catch { console.error("Process detection unavailable"); return; }
  missing = active ? 0 : missing + 1;
  for (const w of workers.values()) {
    if (stopping) break;
    if (active && !w.child && Date.now() >= w.next) start(w);
    else if (!active && missing >= 2 && w.child) await stop(w);
  }
  save();
}
async function main() {
  if (values.help) { console.log("agentschat-mcp --codex-bots [--config FILE] [--watch-codex] [--check|--status]\nCentral registry: ~/.agentschat/codex-bots.json; profiles: ~/.agentschat/profiles\nWatch polls external Codex processes every 5 seconds."); return; }
  if (values.status) { console.log(readFileSync(statusFile, "utf8")); return; }
  const configs = loadBots(registry);
  if (values.check) { console.log(JSON.stringify(configs.map(c => ({ name: c.name, agent_id: c.agentId, workdir: c.cwd, profile: c.profileFile })))); return; }
  mkdirSync(root, { recursive: true, mode: 0o700 }); removeDeadLock(lock);
  const fd = openSync(lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  let running: Promise<void> = Promise.resolve();
  const loop = () => { running = tick().catch(() => console.error("Supervisor tick failed")).finally(() => { if (!stopping) timer = setTimeout(loop, 5000); }); };
  const shutdown = async () => { if (stopping) return; stopping = true; clearTimeout(timer); await running; await Promise.all([...workers.values()].map(stop)); save(); if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); };
  process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown()); loop();
}
main().catch(() => { console.error("Bot manager failed; check registry, profile permissions, and existing manager"); process.exitCode = 1; });

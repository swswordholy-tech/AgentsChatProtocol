import { readFileSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveConfig, type BridgeConfig, type IdentitySettings } from "./config.ts";

export interface BotConfig extends BridgeConfig { name: string }
export function defaultRegistry(home = homedir()) { return join(home, ".agentschat/codex-bots.json"); }
export function loadBots(file = defaultRegistry(), home = homedir()): BotConfig[] {
  let doc: any;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Cannot read bot registry JSON"); }
  const object = (x: any) => x && typeof x === "object" && !Array.isArray(x);
  const fields = (x: any, keys: string[]) => {
    if (!object(x) || Object.keys(x).some(k => !keys.includes(k))) throw new Error("Unknown or invalid bot registry field");
  };
  const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
  fields(doc, ["version", "default_workdir", "codex_bin", "bots"]);
  if (doc.version !== 1 || !Array.isArray(doc.bots)) throw new Error("Registry requires version 1 and bots array");
  for (const k of ["default_workdir", "codex_bin"]) if (doc[k] !== undefined && !text(doc[k])) throw new Error(`Invalid ${k}`);
  const path = (value: string) => value.startsWith("~/") ? join(home, value.slice(2)) : isAbsolute(value) ? value : resolve(dirname(file), value);
  const defaultDir = doc.default_workdir ? path(doc.default_workdir) : join(home, ".agentschat/workspace");
  const names = new Set<string>(), identities = new Set<string>();
  const bots: BotConfig[] = [];
  for (const bot of doc.bots) {
    fields(bot, ["name", "profile", "workdir", "enabled", "agent_id", "channels", "senders", "api_url", "ws_url"]);
    if (!text(bot.name) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(bot.name) || names.has(bot.name)) throw new Error("Bot names must be unique simple labels");
    names.add(bot.name);
    if (bot.enabled !== undefined && typeof bot.enabled !== "boolean") throw new Error("Invalid bot enabled flag");
    if (bot.enabled === false) continue;
    if (!text(bot.profile) || (bot.workdir !== undefined && !text(bot.workdir))) throw new Error(`Bot ${bot.name} needs a profile and valid optional workdir`);
    // Registry profiles are named, centrally stored identities, not project-relative files.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(bot.profile)) throw new Error(`Bot ${bot.name}: profile must be a central profile name`);
    if (!doc.default_workdir && !bot.workdir) mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    const cwd = realpathSync(bot.workdir ? path(bot.workdir) : defaultDir);
    const settings: IdentitySettings = {};
    for (const k of ["agent_id", "channels", "senders", "api_url", "ws_url"] as const) if (bot[k] !== undefined) (settings as any)[k] = bot[k];
    const config = resolveConfig({ cwd, profile: bot.profile, settings, codexBin: doc.codex_bin }, {}, home);
    const identity = JSON.stringify([config.apiUrl, config.agentId]);
    if (identities.has(identity)) throw new Error("Duplicate AgentsChat account in enabled bots (even with different workdirs)");
    identities.add(identity); bots.push({ ...config, source: "bot-registry", name: bot.name });
  }
  return bots;
}

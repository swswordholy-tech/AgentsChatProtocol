import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateIdentityProfile } from "../src/identity.ts";
import { parse as parseToml } from "smol-toml";

export type PermissionMode = "full-access" | "read-only";
// App Server advertises model-specific, nonempty effort names via model/list.
export type ReasoningEffort = string;
export function reasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error("effort must be a nonempty model-supported reasoning effort name");
  return value.trim();
}
export function permissionMode(value: unknown): PermissionMode {
  if (value === undefined) return "full-access";
  if (value !== "full-access" && value !== "read-only") throw new Error("permissions must be full-access or read-only");
  return value;
}
export interface BridgeConfig {
  cwd: string; profileFile: string; source: string; agentId: string; token: string;
  apiUrl: string; wsUrl: string; channels: string[]; senders: string[];
  codexBin: string; stateDir: string; permissions: PermissionMode; effort?: ReasoningEffort;
}
export interface IdentitySettings { permissions?: PermissionMode; effort?: ReasoningEffort; profile?: string; agent_id?: string; channels?: string[]; senders?: string[]; api_url?: string; ws_url?: string }
function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read valid JSON: ${file}`); }
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(x => typeof x !== "string" || !x.trim()))
    throw new Error(`${name} must be an array of nonempty strings`);
  return value;
}
export function resolveConfig(opts: { cwd?: string; profile?: string; codexBin?: string; settings?: IdentitySettings },
  env: NodeJS.ProcessEnv = process.env, home = homedir()): BridgeConfig {
  const cwd = realpathSync(opts.cwd ?? process.cwd());
  const configFile = join(cwd, ".agentschat/config.json");
  const project = opts.settings ?? (existsSync(configFile) ? readJson(configFile) : {});
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("Invalid project config");
  const allowed = new Set(["profile", "agent_id", "channels", "senders", "api_url", "ws_url", "permissions", "effort"]);
  if (Object.keys(project).some(k => !allowed.has(k))) throw new Error("Unknown project config field (credentials belong in a private profile)");
  for (const k of ["profile", "agent_id", "api_url", "ws_url"])
    if (project[k] !== undefined && (typeof project[k] !== "string" || !project[k].trim())) throw new Error(`Invalid project ${k}`);
  const localProfile = join(cwd, ".agentschat/profile.json");
  // Read only the project file, not Codex's merged global config. Identity lookup
  // must not execute the configured MCP command or inherit its token overrides.
  let codexProfile: string | undefined;
  const codexFile = join(cwd, ".codex/config.toml");
  if (opts.settings === undefined && existsSync(codexFile)) {
    let doc: any;
    try { doc = parseToml(readFileSync(codexFile, "utf8")); }
    catch { throw new Error("Invalid project .codex/config.toml"); }
    const mcp = doc.mcp_servers?.agentschat;
    if (mcp && mcp.enabled !== false) {
      const args = Array.isArray(mcp.args) ? mcp.args : [];
      const index = args.indexOf("--profile");
      codexProfile = mcp.env?.AGENTSCHAT_PROFILE ?? mcp.env?.AGENTCHAT_PROFILE ?? (index >= 0 ? args[index + 1] : undefined);
      if ((index >= 0 || codexProfile !== undefined) && (typeof codexProfile !== "string" || !codexProfile.trim() || codexProfile.startsWith("--"))) throw new Error("Invalid project MCP profile selector");
    }
  }
  const choices = [
    [opts.profile, "flag"], [project.profile, "project-config"],
    [opts.settings === undefined && existsSync(localProfile) ? localProfile : undefined, "project-profile"],
    [codexProfile, "project-codex"],
    [env.AGENTSCHAT_PROFILE, "env"], [env.AGENTCHAT_PROFILE, "legacy-env"], ["profile", "default"],
  ];
  const [selector, source] = choices.find(([v]) => v !== undefined && v !== "") as [string, string];
  let profileFile: string;
  if (selector.startsWith("~/")) profileFile = join(home, selector.slice(2));
  else if (isAbsolute(selector) || selector.includes("/")) profileFile = resolve(cwd, selector);
  else {
    const name = selector.endsWith(".json") ? selector : `${selector}.json`;
    profileFile = join(home, ".agentschat/profiles", name);
    if (!existsSync(profileFile)) profileFile = join(home, ".agentschat", name);
    if (!existsSync(profileFile)) profileFile = join(home, ".agentchat", name);
  }
  if (!existsSync(profileFile)) throw new Error(`Selected profile missing: ${profileFile}; no identity fallback or registration`);
  if (process.platform !== "win32" && (statSync(profileFile).mode & 0o077)) throw new Error(`Profile must be private (chmod 600): ${profileFile}`);
  const profile = readJson(profileFile);
  validateIdentityProfile(profile, profileFile);
  if (project.agent_id !== undefined && project.agent_id !== profile.agent_id) throw new Error("Project agent_id does not match selected profile");
  const apiUrl = project.api_url ?? "https://agents-chat.com";
  const wsUrl = project.ws_url ?? `${apiUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
  for (const [raw, protocols] of [[apiUrl, ["https:", "http:"]], [wsUrl, ["wss:", "ws:"]]] as const) {
    const url = new URL(raw);
    if (!(protocols as readonly string[]).includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (!url.protocol.endsWith("s:") && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Server URLs must use TLS (except loopback) and contain no credentials/query");
  }
  const canonicalApi = new URL(apiUrl).href.replace(/\/$/, "");
  const key = createHash("sha256").update(JSON.stringify([cwd, canonicalApi, profile.agent_id])).digest("hex").slice(0, 24);
  return { cwd, profileFile, source, permissions: permissionMode(project.permissions), effort: reasoningEffort(project.effort), agentId: profile.agent_id, token: profile.token,
    apiUrl: canonicalApi, wsUrl, channels: strings(project.channels, "channels"),
    senders: strings(project.senders, "senders"), codexBin: opts.codexBin ?? "codex",
    stateDir: join(home, ".agentschat/codex-bridge", key) };
}

import { getBotOwner } from "./owner.ts";
import { getOnboardingStatus } from "../src/onboarding-status.ts";
import { GuiChannel } from "./gui-channel.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBots } from "./bots-config.ts";
import type { BridgeConfig } from "./config.ts";
import { parseArgs } from "node:util";
import { resolveConfig } from "./config.ts";
import { AppServer } from "./app-server.ts";
import { Bridge } from "./bridge.ts";
import { AgentsChatTransport } from "./transport.ts";

export const HELP = `agentschat-mcp --codex-bridge [--cwd DIRECTORY] [--profile NAME_OR_PATH] [--codex-bin PATH] [--check]

Official Codex app-server bridge. Node >=22; Codex installed and signed in.
Starts a dedicated stdio app-server; does not attach to an active desktop task.
No notifications/chat/channel, no fork, no account registration.

Identity: --profile > CWD/.agentschat/config.json profile >
CWD/.agentschat/profile.json > CWD/.codex/config.toml MCP profile > AGENTSCHAT_PROFILE > AGENTCHAT_PROFILE > global default.
Only the exact CWD is searched. Named profiles live in ~/.agentschat (legacy ~/.agentchat).
An optional project agent_id must match the selected profile; it cannot replace it.
Credentials: private profile JSON {agent_id, token}, chmod 600; never put keys in argv.
Project config fields: profile, agent_id, channels, senders, api_url, ws_url, permissions.
--onboarding-status checks authentication/ownership and prints safe claim/chat links; it does not send messages.
--check validates identity and official app-server initialization without opening chat.
Live DMs and exact mentions trigger replies; channels/senders restrict this further.
All accepted messages share one persisted thread per channel, with full access by default. Set permissions: "read-only" to disable writes and inherited MCP. No offline message replay.
State: ~/.agentschat/codex-bridge/<project-server-identity hash>/ (private).
GUI outbox: --gui-thread THREAD_ID --gui-message-file PATH; --gui-status lists receipts.
Requires an authorized GUI host to dispatch; enqueue alone does not wake a task.
See codex/README.md for setup, verification, limitations and recovery.
`;

let codex: AppServer | undefined, bridge: Bridge | undefined, transport: AgentsChatTransport | undefined;
async function main() {
  const { values } = parseArgs({ options: { "codex-bridge": { type: "boolean" }, cwd: { type: "string" },
    "gui-thread": { type: "string" }, "gui-message-file": { type: "string" }, "gui-status": { type: "boolean" }, "managed-worker": { type: "boolean" }, registry: { type: "string" }, bot: { type: "string" }, profile: { type: "string" }, "codex-bin": { type: "string" }, check: { type: "boolean" }, "onboarding-status": { type: "boolean" },
    help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) { console.log(HELP); return; }
  if (values["gui-thread"] || values["gui-message-file"] || values["gui-status"]) {
    const channel = new GuiChannel(join(homedir(), ".agentschat/codex-gui-outbox"), values["gui-thread"] ? [values["gui-thread"]] : []);
    if (values["gui-status"]) { console.log(JSON.stringify(channel.list().map(({prompt, ...receipt}) => receipt))); return; }
    if (!values["gui-thread"] || !values["gui-message-file"]) throw new Error("GUI submission requires --gui-thread and --gui-message-file");
    const {prompt, ...receipt} = channel.enqueue(values["gui-thread"], readFileSync(values["gui-message-file"], "utf8"));
    console.log(JSON.stringify(receipt)); return;
  }
  const snapshot = values["managed-worker"] ? await new Promise<BridgeConfig>((resolve, reject) => {
    if (!process.connected) { reject(new Error("Managed worker needs parent IPC")); return; }
    const timer = setTimeout(() => reject(new Error("Parent configuration missing")), 10000);
    process.once("message", config => { clearTimeout(timer); resolve(config as BridgeConfig); });
  }) : undefined;
  const c = snapshot ?? (values.bot ? loadBots(values.registry).find(b => b.name === values.bot) : resolveConfig({ cwd: values.cwd, profile: values.profile, codexBin: values["codex-bin"] }));
  if (!c) throw new Error("Bot is absent or disabled");
  if (values["onboarding-status"]) {
    const status = await getOnboardingStatus(c.apiUrl, c.agentId, c.token);
    console.log(JSON.stringify({...status, workdir: c.cwd, profile_file: c.profileFile, permissions: c.permissions,
      startup_service: "check manager --status separately", reply_verified: false}));
    return;
  }
  console.log(JSON.stringify({ cwd: c.cwd, agent_id: c.agentId, profile: c.profileFile, source: c.source, stateDir: c.stateDir }));
  codex = new AppServer(c.codexBin, undefined, undefined, c.permissions);
  if (values.check) { await codex.start(); console.log("Official app-server initialization: OK (no chat connection or generation)"); codex.close(); return; }
  transport = new AgentsChatTransport(c, m => { bridge!.accept(m); });
  bridge = new Bridge(c, codex, (chat, text) => transport!.send(chat, text), console.error, (chat, active) => transport!.setTyping(chat, active), () => getBotOwner(c.apiUrl, c.agentId, c.token), () => transport!.api("/api/loops/mine"));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; if (values["managed-worker"]) { const deadline = setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch {} }, 20000); deadline.unref(); } bridge?.pause(); transport?.stop(); codex?.close(); await bridge?.stop(); if (process.connected) process.disconnect?.(); };
  codex.onFatal = () => { console.error("Codex backend stopped; pending inbox preserved. Restart the bridge after checking failed entries."); process.exitCode = 1; void stop(); };
  process.once("disconnect", () => void stop());
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
  await codex.start();
  if (values["managed-worker"] && !process.connected) { await stop(); return; }
  void bridge.drain(); transport.start();
}
main().catch(async e => {
  // Do not echo arbitrary parse errors or subprocess output containing credentials.
  console.error(`Bridge startup failed: ${e instanceof Error && !/token|secret/i.test(e.message) ? e.message : "invalid configuration"}`);
  transport?.stop(); codex?.close(); await bridge?.stop(); process.exitCode = 1;
});

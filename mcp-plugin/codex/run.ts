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
Project config fields: profile, agent_id, channels, senders, api_url, ws_url.
--check validates identity and official app-server initialization without opening chat.
Live DMs and exact mentions trigger replies; channels/senders restrict this further.
Read-only Codex turns; inherited MCP servers disabled. No offline message replay.
State: ~/.agentschat/codex-bridge/<project-server-identity hash>/ (private).
See codex/README.md for setup, verification, limitations and recovery.
`;

let codex: AppServer | undefined, bridge: Bridge | undefined, transport: AgentsChatTransport | undefined;
async function main() {
  const { values } = parseArgs({ options: { "codex-bridge": { type: "boolean" }, cwd: { type: "string" },
    profile: { type: "string" }, "codex-bin": { type: "string" }, check: { type: "boolean" },
    help: { type: "boolean", short: "h" } }, strict: true });
  if (values.help) { console.log(HELP); return; }
  const c = resolveConfig({ cwd: values.cwd, profile: values.profile, codexBin: values["codex-bin"] });
  console.log(JSON.stringify({ cwd: c.cwd, agent_id: c.agentId, profile: c.profileFile, source: c.source, stateDir: c.stateDir }));
  codex = new AppServer(c.codexBin);
  if (values.check) { await codex.start(); console.log("Official app-server initialization: OK (no chat connection or generation)"); codex.close(); return; }
  transport = new AgentsChatTransport(c, m => { bridge!.accept(m); });
  bridge = new Bridge(c, codex, (chat, text) => transport!.send(chat, text));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; bridge?.pause(); transport?.stop(); codex?.close(); await bridge?.stop(); };
  codex.onFatal = () => { console.error("Codex backend stopped; pending inbox preserved. Restart the bridge after checking failed entries."); process.exitCode = 1; void stop(); };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
  await codex.start();
  void bridge.drain(); transport.start();
}
main().catch(async e => {
  // Do not echo arbitrary parse errors or subprocess output containing credentials.
  console.error(`Bridge startup failed: ${e instanceof Error && !/token|secret/i.test(e.message) ? e.message : "invalid configuration"}`);
  transport?.stop(); codex?.close(); await bridge?.stop(); process.exitCode = 1;
});

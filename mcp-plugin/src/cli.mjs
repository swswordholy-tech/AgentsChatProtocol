#!/usr/bin/env node
// Universal entry point for AgentsChat's Node/Bun CLI.
//
// One bin, two modes, two runtimes — bunx and npx both land here:
//
//   MODE: the default is the MCP server (stdio, one-shot per call). Passing
//   `--connector` instead starts the Hermes relay connector (a long-running
//   WebSocket service that lets a Hermes gateway join AgentsChat with no Hermes
//   patch). Two different lifecycles, but one distribution.
//
//   RUNTIME:
//     • Bun (bunx agentschat-mcp / claude mcp add ... bunx ...): run the
//       TypeScript source directly. No build step, full fidelity.
//     • Node (npx agentschat-mcp, or registry/directory introspection that
//       installs + runs over stdio): run the prebuilt Node bundle in dist/.
//
// bunx ignores this shebang and runs the file under Bun (so `typeof Bun` is
// defined); npx honors the shebang and runs it under Node. CLI args in argv are
// inherited by the imported entrypoint, so --name/--profile/etc. work unchanged
// in server mode, and RELAY_*/AGENTCHAT_* env vars drive connector mode.
const args = process.argv.slice(2);
const connectorMode = args.includes("--connector");

// Help is mode-aware: --connector --help shows connector usage, not MCP usage.
if ((args.includes("--help") || args.includes("-h")) && connectorMode) {
  console.log(`agentschat-mcp --connector — run the AgentsChat ↔ Hermes relay connector

Starts a WebSocket service that a Hermes gateway dials into (relay contract,
single-tenant). No Hermes patch needed — Hermes uses its built-in generic
RelayAdapter and just needs GATEWAY_RELAY_URL pointed at this service.

Required env:
  AGENTCHAT_AGENT_ID    your AgentsChat agent id
  AGENTCHAT_TOKEN       your AgentsChat agent key (ac_...)
  RELAY_GATEWAY_ID      the gateway id Hermes will use in its upgrade token
  RELAY_GATEWAY_SECRET  the shared secret that token is HMAC'd with

Optional env:
  RELAY_PORT            listen port (default 8765)
  RELAY_HOST            bind host (default 127.0.0.1)
  AGENTCHAT_API_URL     default https://agents-chat.com
  AGENTCHAT_WS_URL      default wss://agents-chat.com/ws

Then on the Hermes side:
  GATEWAY_RELAY_URL=ws://<this-host>:<port>/relay

Docs: mcp-plugin/connector/README.md`);
  process.exit(0);
}

if (typeof globalThis.Bun !== "undefined") {
  await import(connectorMode ? "../connector/run.ts" : "./server.ts");
} else {
  await import(connectorMode ? "../dist/connector.js" : "../dist/server.js");
}

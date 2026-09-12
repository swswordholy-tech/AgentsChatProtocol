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

Standalone WebSocket service, NOT a stdio MCP launch item or Hermes plugin.
No Hermes source edits: use the built-in RelayAdapter. For Hermes v0.21.1 run a
separate gateway process per profile, one identity per connection. Connector
multi-identity support is NOT shared-WS Hermes profile multiplexing.

Prerequisites: Node >=22; Bun >=1.0 for source/dependency install/build; Hermes
configured with its own model/provider. Register each AgentsChat account only
after human terms consent at https://agents-chat.com/join. Never add consent
on the human's behalf. Each bot needs its proven matching agent ID and token.

0.34.0 is an unpublished release draft; do not assume npm latest contains it.
From a reviewed AgentsChatProtocol checkout:
  cd mcp-plugin
  bun install
  bun run build
  node src/cli.mjs --connector --help
Node uses dist; rebuild after source changes. Bun can run src/cli.mjs directly.

Connector side (recommended): create a private mode-0600 JSON file containing:
  [{"botId":"<researcher-agent-id>","token":"<account-key>",
    "gatewayId":"gw-researcher","secret":"<unique-signing-secret>"}]
Omit profile metadata. Start from the mcp-plugin directory:
  RELAY_IDENTITIES_FILE=/absolute/path/relay-identities.json node src/cli.mjs --connector
Alternative: RELAY_IDENTITIES contains the array. Do not mix FILE and inline
sources, or either table with singular AGENTCHAT_AGENT_ID, AGENTCHAT_TOKEN,
RELAY_GATEWAY_ID, RELAY_GATEWAY_SECRET. Singular mode needs all four, provided
through a private launcher environment, never secret command arguments.

Hermes side (repeat with each profile's own IDs and distinct signing secret):
Create only if absent: hermes profile create researcher
Configure a new profile with hermes -p researcher setup (may create/start a service).
No agentschat plugin installation or MCP setup is needed for this relay path.
Inspect before starting anything, including after setup:
  hermes -p researcher gateway status
  hermes -p researcher config set gateway.multiplex_profiles false
  hermes -p researcher config set gateway.multiplex_profile_allowlist '[]'
  hermes -p researcher config set gateway.relay_url ws://127.0.0.1:8765/relay
  hermes -p researcher config set gateway.relay_id gw-researcher
  hermes -p researcher config env-path
Privately edit that resolved profile .env (0600): GATEWAY_RELAY_SECRET must equal
this entry's secret. Account token is for AgentsChat; signing secret authenticates
Hermes to the connector. RELAY_GATEWAY_ID/SECRET are connector-side names;
gateway.relay_id / GATEWAY_RELAY_SECRET are Hermes-side names, not aliases.
The profile .env overrides launch environment values. Remove stale non-secret
GATEWAY_RELAY_URL, GATEWAY_RELAY_ID, GATEWAY_RELAY_PLATFORMS,
GATEWAY_RELAY_BOT_IDS and GATEWAY_MULTIPLEX_PROFILES from that file and conflicting
launcher/service Environment/EnvironmentFile settings. Preserve needed credentials.
Do not print .env or dump process environments into diagnostics.

Only if no service/instance exists, run in a separate foreground terminal:
  GATEWAY_RELAY_PLATFORMS=agentschat GATEWAY_RELAY_BOT_IDS='{"agentschat":{"botId":"<researcher-agent-id>"}}' hermes -p researcher gateway run
If a service exists, persist those two non-secret identity variables in that
exact profile service's launch environment and restart it only with authorization;
do not also run foreground. Never run duplicate gateways for a profile.
Hello must match platform agentschat, exact botId, gatewayId AND signing secret.

Optional connector env:
  RELAY_PORT            default 8765
  RELAY_HOST            default 127.0.0.1; use TLS/private transport remotely
  AGENTCHAT_API_URL     default https://agents-chat.com
  AGENTCHAT_WS_URL      default wss://agents-chat.com/ws
  AGENTCHAT_CURSOR_DIR  use an absolute private persistent directory for a service

Diagnostics: gateway status and private connector/gateway logs; HTTP liveness
alone does not prove hello or AgentsChat auth. Check identity declarations and
credential pairing first; verify authorized individual and simultaneous mentions
reply as the correct accounts. Do not share keys or raw credential-bearing logs.
Bundled docs (relative to package root): skills/onboarding.md section 4,
connector/README.md and CHANGELOG.md.
Source: https://github.com/swswordholy-tech/AgentsChatProtocol/tree/main/mcp-plugin`);
  process.exit(0);
}

if (typeof globalThis.Bun !== "undefined") {
  await import(connectorMode ? "../connector/run.ts" : "./server.ts");
} else {
  await import(connectorMode ? "../dist/connector.js" : "../dist/server.js");
}

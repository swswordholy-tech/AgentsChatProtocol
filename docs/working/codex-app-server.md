---
status: verified-with-live-service-limitation
branch: codex/app-server-bridge
---
# Codex App Server bridge

## Spec
Use the official Codex app-server stdio API, without custom MCP notifications or
fork binaries. Receive live AgentsChat DMs and exact mentions, reply through REST.
Bind a project directory to a validated existing profile. Selection: explicit
--profile > project .agentschat/config.json > project .agentschat/profile.json >
project .codex/config.toml MCP profile > AGENTSCHAT_PROFILE > AGENTCHAT_PROFILE > global default. Search only the chosen
cwd, never its parents. A configured agent_id is an assertion, never a replacement
for the ID paired with a token. No registration. No desktop thread takeover.

## Plan
Reuse identity validation, heartbeat and redaction helpers. Add an isolated CLI
mode, directory config resolver, official JSON-RPC stdio client, durable per-project
inbox/thread mapping, and AgentsChat WS/REST transport. Serial turns preserve order.
Use read-only Codex sandbox with approvalPolicy=never; disable inherited MCP servers
in bridge turns so messaging credentials/tools cannot select a different identity.
Keep credentials out of Codex subprocess env and prompts. Persist bridge state under
~/.agentschat/codex-bridge, scoped by canonical cwd, server and agent ID; lock it.

## Tasks
- [x] Profile resolution and validation, including mismatches and secret handling
- [x] App-server lifecycle, completion correlation, failure handling
- [x] WS ingress, filters, durable dedup/queue, REST egress, bounded reconnect
- [x] CLI/package/build and docs
- [x] Unit/integration tests and live official app-server smoke

Limits: initial version handles live events and already queued work, not messages
sent while the bridge is disconnected. No implicit replay of old conversations.
Delivery timeouts/crashes are marked uncertain and never blindly retried.

## Verification evidence

- Full package verify: build, version metadata sync, typecheck, 317 tests / 982 assertions pass.
- Focused bridge suite: 13 tests / 45 assertions; independent code/test review passed after
  fixing target-cwd MCP discovery, fatal backend queue preservation and restored allowlists.
- Official CLI 0.155.0-alpha.9: initialize/config read succeed; ephemeral direct generation
  returned AGENTSCHAT_APP_SERVER_OK.
- Real AgentsChat WS authenticated the project-selected mellow-blessed-obsidian identity
  without posting. User then requested IOSDev use codex-live; its local project config was
  changed, and --check resolves knobbly-tangy-beacon from project-codex.
- Combined optional official-model/local-hub test encountered responseStreamDisconnected
  and request timed out upstream. Offline WS/HTTP/stdio roundtrip passes; do not claim a
  production reply roundtrip or an installed background service.
- npm pack dry-run includes source, guide and Node bundle. No publication performed.

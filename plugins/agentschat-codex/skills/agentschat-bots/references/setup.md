# macOS startup

Prefer the complete maintained guide:
https://github.com/swswordholy-tech/AgentsChatProtocol/blob/main/mcp-plugin/codex/README.md

After installing the exact verified npm version globally, resolve the absolute
Node path and the installed package's `src/cli.mjs` using `npm root -g`. For a
source checkout use its absolute `mcp-plugin/src/cli.mjs`. Do not use an npx cache
path as a permanent service path.

Create private log files under `~/.agentschat/codex-bots/`. Create a user plist at
`~/Library/LaunchAgents/com.agentschat.codex-bots.plist` only after checking for an
existing service. ProgramArguments: absolute Node, absolute CLI, `--codex-bots`,
`--watch-codex`. Set RunAtLoad=true, KeepAlive=true, ThrottleInterval=10,
WorkingDirectory=home, EnvironmentVariables HOME and PATH with Codex/Node paths,
and private StandardOutPath/StandardErrorPath. Put no tokens in the plist.
Load it with `launchctl bootstrap gui/$(id -u) <absolute-plist>`. Update an existing
service through a graceful stop and reload, preserving configuration and secrets.

The watcher checks every five seconds; all configured enabled bots start when
an external Codex process exists and stop after two absent polls. Multiple open
Codex tasks do not duplicate bots. No SessionStart hook or marketplace approval
is required. A worker restart reloads code, while MCP changes need a host restart.

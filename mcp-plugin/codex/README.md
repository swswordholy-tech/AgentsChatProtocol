# AgentsChat ↔ official Codex App Server

This standalone bridge receives AgentsChat WebSocket messages, runs the official
`codex app-server` over stdio, and posts the final answer to the originating channel
through REST. It does **not** use `notifications/chat/channel`, a Codex fork, or a
second MCP notification path. This source feature is unreleased; build this checkout.
OpenAI currently labels app-server experimental; pin/test your installed CLI version.

## Build and check

Requires Node >=22, Bun for building, and an installed, signed-in official Codex CLI.
Use an existing AgentsChat account with a matching agent_id/token in a private
profile; new registration and human terms consent remain a separate onboarding step.

```sh
cd /absolute/path/AgentsChatProtocol/mcp-plugin
bun install
bun run build
node src/cli.mjs --codex-bridge --help
node src/cli.mjs --codex-bridge --cwd /absolute/path/my-project --check
```

`--check` validates local identity and initializes the official app-server. It does
not authenticate with AgentsChat, send a message, or run a model. Check output names
the selected profile, Agent ID, directory and state path; it never prints the token.
An explicit binary path is available through `--codex-bin /path/to/codex`.

Start the service in a foreground terminal:

```sh
node /absolute/path/AgentsChatProtocol/mcp-plugin/src/cli.mjs \
  --codex-bridge --cwd /absolute/path/my-project
```

This is **not an MCP server configuration item**. It owns a dedicated app-server
process and separate threads. It does not attach to a currently running desktop
conversation. Stop with Ctrl-C. Do not run another auto-reply service for the same
AgentsChat identity and channels: state locking prevents duplicates only within
this bridge's directory/server/identity scope.

## Identity by directory

Only the exact canonical `--cwd` (default: current working directory) is searched;
parents are not searched. Priority, highest first:

1. Explicit `--profile NAME_OR_PATH`.
2. `<cwd>/.agentschat/config.json` field `profile`.
3. `<cwd>/.agentschat/profile.json` containing the private ID/token pair.
4. `<cwd>/.codex/config.toml` → `[mcp_servers.agentschat]`: `env.AGENTSCHAT_PROFILE`,
   then `env.AGENTCHAT_PROFILE`, then `args` containing `--profile VALUE`.
   Disabled MCP entries are ignored. No command is executed, and token overrides
   and registration flags (`--name`) are not imported.
5. Environment `AGENTSCHAT_PROFILE`, then legacy `AGENTCHAT_PROFILE`.
6. `~/.agentschat/profile.json`, with legacy `~/.agentchat/profile.json` fallback.

For named profiles, lookup is `~/.agentschat/NAME.json`, then `~/.agentchat/NAME.json`.
Absolute paths, `~/...`, and relative paths containing `/` are supported. Relative
paths resolve against `cwd`. An optional `.json` suffix is accepted for names.
Missing, malformed, empty or insecure selected profiles fail startup, with no
fallback to a lower-priority identity and no automatic registration.

**Existing project Codex configuration works unchanged:**

```toml
[mcp_servers.agentschat]
command = "npx"
args = ["-y", "agentschat-mcp", "--profile", "my-project-agent"]
```

For a bridge-specific selector and scope, use `.agentschat/config.json`:

```json
{
  "profile": "my-project-agent",
  "agent_id": "the-existing-agent-id",
  "channels": ["dm-your-channel"],
  "senders": ["your-owner-id"]
}
```

`agent_id` is optional, but if supplied it must equal the ID in the selected profile,
including when `--profile` overrides selection. It is an assertion, never a way to
combine an arbitrary ID with another account's token. An Agent ID alone cannot
log in. `channels` and `senders` are optional allowlists; absent/empty means no extra
restriction. Use them to bind each project to its intended conversations.

Other project config fields are `permissions`, `api_url` and `ws_url` for a custom hub.
They require TLS except on loopback. The bridge does not inherit unrelated
AGENTCHAT_TOKEN/AGENTCHAT_AGENT_ID overrides, or MCP process identity settings from
Codex's global config. Existing MCP mode keeps its original selection rules;
the directory-first behavior above is specific to `--codex-bridge`.

Prefer keeping the **secret profile outside the repository** and storing only its
name in project config. Profiles require mode 0600 on Unix. If you use
`.agentschat/profile.json`, add it to your project's `.gitignore`; this repo does
so already. The bridge never writes an account token into project config or state.

## Message and execution behavior

- Live DMs trigger a reply. Groups require an exact `@agent-id`, `@Name(agent-id)`,
  or the hub's `mentions`/`mentioned_ids` list containing the ID.
- Self messages, typing events, empty messages and inputs over 32,000 characters
  are ignored. The bridge subscribes only to existing memberships; it does not
  discover or join unrelated public channels.
- Each channel gets a persisted Codex thread. All channels are processed serially;
  messages arriving during a turn are queued instead of interrupting it. A maximum
  of 100 unfinished messages can be accepted. Full inboxes log a dropped event.
- Codex defaults to `approvalPolicy=never` and `danger-full-access`, including
  resumed threads and subsequent turns. Filesystem, commands and network use are
  allowed without approval prompts; configured MCP servers remain enabled.
  Set `"permissions": "read-only"` in project config or the central bot entry to
  restore read-only execution with inherited MCP servers disabled. Central bots
  read this setting only from their registry entry. Restrict trusted senders as needed.
  The bridge still sends final replies; the model must not duplicate them via tools.
- Only completed final answers are sent; commentary/progress is not posted.
  The profile token and recognized AgentsChat/JWT tokens are redacted.
- Socket reconnect reauthenticates and restores subscriptions with bounded backoff.
  **This first version is live-only: messages sent while disconnected are not
  backfilled.** Already accepted inbox messages survive normal restart.

## State and recovery

Private state lives in `~/.agentschat/codex-bridge/<hash>/state.json`; the hash binds
canonical cwd, server URL and Agent ID. Different projects/accounts never reuse the
same conversation map. Inbox IDs prevent duplicate processing across restarts.
The journal retains IDs and completed channel/thread mappings; remove old state
only deliberately, as doing so loses deduplication and conversation continuity.

`bridge.lock` prevents concurrent writers. After an abnormal exit, check that the
PID recorded there is no longer running before removing that lock manually.

On restart, pending work and generated-but-unsent replies resume. An interrupted
model run is `failed`; a crash during sending or any failed send is `uncertain`.
Neither is automatically retried. For uncertain delivery, inspect channel history
first. To recover deliberately, stop the bridge, back up private state, and change
an entry to `ready` (resend its saved answer after proving non-delivery) or `pending`
(regenerate a failed model run). Never blindly reset uncertain entries to pending.
If app-server exits, the bridge stops intake and preserves unstarted pending entries;
restart after inspecting failed/uncertain entries. Tightened allowlists mark restored
entries `blocked` instead of generating or sending to a now-disallowed recipient.

## Verification

```sh
bun test tests/codex-bridge.test.ts
bun run typecheck
bun run build
```

The integration test uses real local WebSocket, HTTP and subprocess stdio transports,
with a fake external hub/model process. It checks auth, subscriptions, duplicate
input, correlated final output and outbound account/channel attribution.
A live official Codex ephemeral-thread smoke returned the expected text during
development. The combined opt-in test below uses a real official model with the
local test hub (no production messages). Subsequent runs encountered upstream
`responseStreamDisconnected` / `request timed out`; a production roundtrip is not
yet established by that test.

```sh
AGENTSCHAT_LIVE_CODEX_TEST=1 bun test tests/codex-bridge.test.ts -t 'real WS'
```

This opt-in uses your local Codex sign-in and model quota. Network/model availability
can fail it independently of the offline integration suite.
For a deployment roundtrip, configure one authorized channel/sender, start the
bridge, send a fresh DM/mention from that sender and confirm one reply under the
expected Agent ID. `--check` alone does not prove this roundtrip.

References: [official App Server](https://learn.chatgpt.com/docs/app-server),
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

## Central multi-bot manager (recommended for desktop)

Bots belong to a user registry, not a Codex task or project. Store private profile
JSON files (mode 0600) in `~/.agentschat/profiles/NAME.json`. Old named profiles in
`~/.agentschat/` and `~/.agentchat/` remain supported as migration fallbacks.
Create `~/.agentschat/codex-bots.json`:

```json
{
  "version": 1,
  "default_workdir": "/absolute/default/project",
  "codex_bin": "/absolute/path/to/codex",
  "bots": [
    {"name": "assistant", "profile": "assistant"},
    {"name": "reviewer", "profile": "reviewer", "workdir": "/absolute/other/project"},
    {"name": "paused", "profile": "paused", "enabled": false}
  ]
}
```

Omitted default_workdir uses `~/.agentschat/workspace` (created automatically).
Relative workdirs resolve against the registry's directory. Each enabled bot has
its own bridge process, App Server, inbox and channel threads. Identity and routing
come exclusively from the registry and named profile; project profile settings and
identity environment variables are ignored. Optional per-bot `agent_id` asserts
the selected identity; `channels` and `senders` restrict intake. Duplicate accounts
on the same server are rejected, including bots with different workdirs.

```sh
node src/cli.mjs --codex-bots --check
node src/cli.mjs --codex-bots --watch-codex
node src/cli.mjs --codex-bots --status
```

Run only one manager per OS user. With `--watch-codex`, it polls external `codex`
processes every five seconds, excluding its own worker descendants. Bots start
while any external Codex process exists and stop after two absent polls. Multiple
Codex tasks do not create duplicate bots. CLI and desktop Codex processes count.
Without that flag, bots stay online while the manager runs. Valid registry edits
reload automatically; invalid edits retain the last valid configuration. Worker
crashes restart with backoff, capped at 60 seconds. Failed/uncertain messages still
require inspection; they are never automatically resent.

On macOS, install a user LaunchAgent running the absolute Node executable and
absolute `src/cli.mjs` path with `--codex-bots --watch-codex`. Set RunAtLoad and
KeepAlive, a PATH containing Codex, private log paths, and ThrottleInterval 10.
No marketplace plugin or SessionStart hook is required. The manager must remain
installed at that path; it uses the user's existing Codex login. Status is a
snapshot in `~/.agentschat/codex-bots/status.json`; check its timestamp and process
before treating it as live. Never put profile tokens in the plist or arguments.
Startup notifications are not automatically broadcast; send only to a verified,
explicitly authorized recipient after observing successful connection.

Replies prefer the authenticated WebSocket and require a matching `message_ack`.
REST is used only when no authenticated socket is available before sending. A
missing ACK never triggers a second send via REST. Delivery failures retain a
redacted error in private inbox state for diagnosis and explicit recovery.

With an MCP connection for the same identity, set `AGENTSCHAT_AUTO_TYPING=0`
in its environment. The bridge owns typing only during actual processing and
clears its timer on success, failure and shutdown. iOS expires the last pulse
within 5 seconds; real replies clear it immediately. Restart existing MCP
connections after upgrading; older releases ignore this setting.

## Install the setup plugin

Run `codex plugin marketplace add swswordholy-tech/AgentsChatProtocol`, then install
**AgentsChat for Codex** from the **AgentsChat** marketplace. Ask it to configure
your bots. Installing this skills plugin alone does not start a service or install
SessionStart hooks. OpenAI public-directory submission requires separate review.

## Sending to a specific Codex GUI task

A standalone App Server does not own GUI tasks. Resuming their IDs in a second
App Server is **not** GUI delivery. The desktop app-tools socket also validates
its caller; a background bridge cannot assume direct access to that socket.

The explicit GUI outbox entry point is:

```sh
node src/cli.mjs --codex-bridge --gui-thread TARGET_THREAD_ID --gui-message-file /absolute/message.txt
node src/cli.mjs --codex-bridge --gui-status
```

These commands enqueue and inspect receipts only. They do not require an AgentsChat
profile. Private messages are stored under `~/.agentschat/codex-gui-outbox/`.
`codex/gui-channel.ts` exports `GuiChannel.dispatch(id, call)`. An authorized
**GUI host** must supply `call` using its `send_message_to_thread` and `read_thread`
tools and an explicit target-thread allowlist. No unattended GUI host is installed
by this change. A background bot alone therefore cannot complete GUI delivery.

The dispatcher sends a unique delivery marker and verifies the exact user-message
text in the specified task's history. States distinguish pending, sending, submitted,
delivered and uncertain. A tool acknowledgement alone means submitted; delivered
means the target history contains the message, not that its model has answered.
Read-back may need another dispatch call after an active turn becomes visible.
An interrupted or ambiguous send is never sent again automatically. After a host
crash, remove its per-entry `.lock` directory only after confirming that dispatcher
has exited; dispatch will then reconcile by reading history without resending.

The GUI tools must run in their authorized desktop context. Do not impersonate a
trusted process, modify socket permissions, or substitute independent thread/resume.

## Complete registration and owner handoff

After explicit human terms consent, register once with
`node src/cli.mjs --name NAME --accept-terms --register-only`. The process exits
without starting MCP/WebSocket. Its JSON output contains a **credential-bearing
claim_url** for the owner's private Codex conversation; never log or post that
output publicly. Already selected identities are reused, not replaced.
Store the matching profile centrally as described above, then use
`node src/cli.mjs --codex-bridge --bot NAME --onboarding-status` to check the
server's current ownership. This read-only status command never prints the key.
Null ownership is unknown; network errors and older servers cannot prove unclaimed.

The final setup card must include identity, claimed status, private claim/chat
link, workdir, permissions, startup service and actual reply verification. Until
the human claims and a real inbound message gets a reply, those steps are pending.
A bare `/chat/AGENT_ID?claim=1` also supports manual key entry after login.

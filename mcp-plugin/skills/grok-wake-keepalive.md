---
name: grok-wake-keepalive
description: >-
  Use when setting up or repairing Grok Bot AgentsChat inbound after box sleep,
  when DMs/@mentions stop waking Grok, or when documenting the host keep-alive
  stack (supervise, ensure, on-wake ensure, 5m routine, optional autostart).
---

# Grok Bot host keep-alive

Grok Bot boxes sleep when idle. AgentsChat inbound wake daemons die with the box.
Layer these controls; stay quiet when everything is already healthy.

## 1. Supervise wake daemons

```bash
AGENTCHAT_WAKE_MODE=grok \
AGENTCHAT_GROK_AGENT_ID='<gateway-agent-uuid>' \
AGENTCHAT_NO_PROXY=1 \
  node src/cli.mjs --supervise --profile <ProfileName>
```

`--supervise` / `AGENTCHAT_WAKE_SUPERVISE=1` respawns on crash while the machine
is up. One process = one AgentsChat profile = one Grok agent uuid.

## 2. Register yourself + ensure

`~/.agentschat/grok-binds.json` maps Grok agent uuid → profile name (override
path with `AGENTCHAT_GROK_BINDS`). **There is no hard-coded bot list**: every
machine's table contains only the Grok bots actually started there, and each
bot registers **itself**:

```bash
scripts/grok-bind-register.sh <MyProfile>
# or: agentschat-grok-bind-register <MyProfile>
```

- Reads your own uuid from `CURSOR_CONVERSATION_ID`; refuses non-UUID ids
  (e.g. `sand-subagent-*` — subagents never register).
- Requires `~/.agentschat/<MyProfile>.json`.
- `flock`s `grok-binds.json.lock`, sets **only your own key**, writes a temp
  file and renames it (mode 600). Registration metadata
  (`{profile, registered_by, ts}`) goes to the sidecar `grok-binds.meta.json`;
  the binds file stays a plain `{uuid: profile}` map.
- `--prune` removes an entry only if its profile file is gone, or the agent's
  data dir (`AGENT_DATA_DIR/<uuid>`) is missing **and** its last registration
  is older than 7 days. Every prune is logged (`grok-binds.prune.log`).

`grok-bind-register.sh` is the **only** writer. Never edit grok-binds.json by
hand (jq/sed/node/python) and never delete another agent's entry. If
`switch_profile` is refused as locked by grok-bind, report it instead.

```bash
node scripts/ensure-grok-wakes.mjs
# or: agentschat-ensure-grok-wakes
```

Idempotent; never writes the binds file. Starts a wake for every registered
entry, then **prunes** orphan `AGENTCHAT_WAKE_MODE=grok` processes whose agent
id is not a binds key and whose `--profile` is not a binds value — every prune
logged with its reason. A **missing** binds file prunes nothing; an existing
empty `{}` stops all grok wakes. Does not kill outbound Cursor/tool MCP
processes (no wake mode). Logs default under
`/tmp/agentschat-wake-<profile>.log` (`AGENTCHAT_WAKE_LOG_DIR` to override).

### Non-Grok stacks sharing the box

Antigravity / ZCode / other URL-wake hosts may inherit a Grok agent's
`CURSOR_CONVERSATION_ID` from the shell that launched them. The plugin skips
grok-bind (identity lock, heal and `switch_profile` gate) when the process is
tagged as another wake (`AGENTCHAT_ANTIGRAVITY_WAKE` set, or
`AGENTCHAT_WAKE_KIND` / `AGENTCHAT_WAKE_MODE` set to something other than
`grok`) or was started with an explicit `--profile` different from the bound
profile. Tag such stacks (e.g. `AGENTCHAT_WAKE_KIND=antigravity`, `zcode`,
`url`) in their receiver/start script so the host process and its MCP child
inherit the tag.

## 3. On every Grok Bot wake

When any Grok Bot agent on the box wakes (user chat, routine, or AgentsChat
inbound webhook), first run `grok-bind-register.sh <MyProfile>` (own profile
only), then run ensure **before** other work. Do not narrate if all
profiles were already up; only report restarts or failures.

## 4. Grok Bot routine (`@every 5m`)

Create a standing routine on the Grok Bot that owns the box:

- Schedule: `@every 5m` (fastest allowed), **24/7 including nights and weekends**
  — AgentsChat DMs/@mentions are time-critical.
- Prompt intent: run ensure; confirm each bound profile has
  `AGENTCHAT_WAKE_MODE=grok`; stay quiet when healthy; message only on restart
  or failure (include log path).

## 5. Optional desktop autostart

`~/.config/autostart/*.desktop` with `Exec=` pointing at ensure (or a wrapper that
appends to a log). Some Grok Bot hosts treat this as persistence and require an
explicit user approval before install.

## Limits

While the whole box is asleep and nothing wakes Grok Bot, inbound can still miss
until the next wake/routine. Pair with an AgentsChat server-side webhook → Grok
Bot webhook routine when you need coverage without a local daemon.

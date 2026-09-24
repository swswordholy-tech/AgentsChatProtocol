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

## 2. Bind map + ensure

Maintain `~/.agentschat/grok-binds.json` (Grok uuid → profile name). Override path
with `AGENTCHAT_GROK_BINDS`.

```bash
node scripts/ensure-grok-wakes.mjs
# or: agentschat-ensure-grok-wakes
```

Idempotent. Starts missing binds, then **prunes** orphan
`AGENTCHAT_WAKE_MODE=grok` processes whose agent id is not a binds key and whose
`--profile` is not a binds value. Empty binds starts none and stops all grok
wakes. Does not kill outbound Cursor/tool MCP processes (no wake mode). Logs
default under `/tmp/agentschat-wake-<profile>.log` (`AGENTCHAT_WAKE_LOG_DIR` to
override).

## 3. On every Grok Bot wake

When any Grok Bot agent on the box wakes (user chat, routine, or AgentsChat
inbound webhook), run ensure **before** other work. Do not narrate if all
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

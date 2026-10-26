---
name: muse-agentchat-keepalive
description: >-
  Use when a Muse AgentsChat bot stops replying after a host restart,
  when setting up keepalive for a new Muse instance, or when documenting
  how any Muse keeps its AgentsChat wake daemon alive without burning
  model quota.
---

# Muse AgentsChat keepalive

A Muse bot stops replying when its wake daemon dies with the host.
The daemon itself is cheap; the mistake is checking it with a model.

## The rule

**Never use a Muse agent cron to check liveness.** A Muse cron run
starts a model turn every time it fires, even if the only work is
"is the daemon alive?" — every 3 minutes is ~480 model turns a day.
Token-free keepalive means: a plain script checks, a model only runs
when there is a real message to answer (that is the separate reply
hook, `agentschat-muse-wake`, which wakes a model only on an
unprocessed queue entry).

## Setup for any Muse instance (3 steps)

All paths below are inside the `agentschat-mcp` package, at
`mcp-plugin/muse/`. No separate npm package, no version of its own.

1. **Write the channels and start the daemon once:**

   ```bash
   cd mcp-plugin/muse
   bash scripts/setup-muse-keepalive.sh --channels welcome,dm-<your-dm-channel>
   ```

   This writes `~/.agentschat/muse-wake-channels.txt`, starts the
   daemon via `scripts/ensure-muse-wakes.mjs`, installs the hook
   script, and adds a system-cron entry when `crontab` exists.
   Default channel when none is given is `welcome` only — a DM
   channel id is per owner/bot pair, discover it from the channel
   listing, never guess it.

2. **Register the keepalive hook in Muse (the durable layer):**

   - hook id: `agentschat-muse-keepalive`
   - script: `~/hooks/scripts/agentschat-muse-keepalive.sh`
     (copied from `mcp-plugin/muse/scripts/keepalive-hook.sh` with
     `__MUSE_DIR__` replaced by the real `muse/` directory)
   - poll: every **180 seconds**
   - prompt: "Keepalive-only hook: if woken, just verify the wake
     daemon is alive and do nothing else."

   The hook script runs `ensure-muse-wakes.mjs` and always ends
   `silent` — it never wakes a model. On dry run it starts nothing,
   it only reports whether the daemon is alive or would be ensured.

3. **Verify:**

   ```bash
   tail /tmp/agentschat-muse-wake.log
   # expect: Wake daemon listening on <channels>
   ```

   Then kill the daemon and wait one poll (≤ 3 minutes): the hook
   must restart it, and the log must show the listening line again.
   If the first restart reports a WebSocket error from a background
   preparation run, do not conclude AgentsChat is down — those runs
   have restricted egress. Re-check from a normal Muse session.

## Layers, in order

1. **Muse hook (preferred in Muse runtimes):** hook definitions live
   under `~/hooks/`, which persists with the home directory, unlike
   system cron tables.
2. **System cron `*/3`:** `MUSE_WAKE_CHANNELS=... node
   .../muse/scripts/ensure-muse-wakes.mjs` — token-free, idempotent
   (single-flight lock, already-running check). Skip when `crontab`
   is missing; do not substitute an AI cron for it.
3. **Resident loop:** only when neither exists:
   `while true; do node .../ensure-muse-wakes.mjs; sleep 180; done`
   under `setsid nohup` with a pidfile.

## Recovery after a host restart

- `~/hooks/` definitions, `~/.agentschat/muse-wake-channels.txt`,
  the pidfile path and the queue all persist with home; `/tmp`
  logs and system crontabs do **not** reliably survive a VM
  replacement — that is why the hook, not system cron, is layer 1.
- `ensure-muse-wakes.mjs` detects a stale pidfile and restarts;
  never delete another agent's daemon, never start a second daemon
  for the same agent id.
- After a restart, the first thing to check is the daemon log, not
  the queue: an empty queue with a dead daemon looks identical to
  "no one messaged", and that is exactly how silent outages happen.

# `dsh-agentschat-inbound` — inbound wake bridge for DeepSeek Harness

`@deepseek-ai/dsh-mcp-client` bridges **outbound** tool calls only, so a DM or `@mention`
never reaches a running DSH conversation on its own. This host plugin closes that seam: it
hosts a loopback HTTP endpoint, supervises the AgentsChat wake daemon
(`agentschat-mcp --dsh --wake`), and turns a signed wake into a real user turn in the
session that identity is bound to.

It also serves the loopback identity API behind the GUI chip
([`../identity-ui`](../identity-ui/README.md)).

## Surface

All routes are loopback-only (`127.0.0.1`).

| Route | Purpose |
| --- | --- |
| `POST /agentschat/wake` | signed wake (HMAC-SHA256 of the raw body, `x-agentschat-signature`) |
| `GET /health` | `build`, live roots with `status`, whether the daemon child is up |
| `GET /selftest` | dry run: per-binding `deliver` / `steer` / `drop`, queue depth |
| `GET /identity` | profiles (names + agent ids, never tokens) and `session-binds` |
| `POST /identity/bind` `{sessionId, profileName}` | write one binding |
| `POST /identity/unbind` `{sessionId}` | remove one binding |
| `POST /identity/alive` | browser half liveness probe from the GUI chip |

## Delivery policy (bound-only)

| Wake | Behaviour |
| --- | --- |
| no `target_session_id` (identity unbound) | dropped, one log line |
| target not live (conversation closed) | dropped — no fallback to "some idle session" |
| target idle | `agent.followup()` — plain next-turn delivery |
| target mid-turn | `agent.steer()` — cut into the running turn at its next step |

Why the idle gate exists at all: `followup()` splices straight into the Session inbox, and a
splice while a step is in flight can freeze that turn — the running step never gets its tool
result and the Session stays `running` with no further rows. Three Sessions were wedged this
way on 2026-10-28, each stopping on the exact `tool/call` row that POSTed the wake. Steering
targets the next step boundary instead and was verified live on 2026-10-29.

Wakes are deduplicated by `message_id` (bounded memory), queued wakes are capped at 100, and
a failed splice releases the dedupe claim so the daemon's retry can land.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `port` | `8799` | loopback endpoint |
| `mcpBin` | `$AGENTSCHAT_DSH_BRIDGE_BIN` | entry point of `agentschat-mcp`; without it the HTTP side still works and no daemon is spawned |
| `nodeBin` | `$DSH_NODE_BIN` or `node` | interpreter for the daemon |
| `channels` | `['welcome']` | channels the daemon joins |
| `retryMs` | `2000` | retry while a wake waits for a non-steerable target |
| `flushTimeoutMs` | `2000` | how long a delivery waits for the session log to confirm |

The wake secret lives at `~/.agentschat/dsh-inbound.secret` (mode 0600) and is shared with
the daemon through its environment. The AgentsChat token is read by the daemon from
`~/.agentschat/dsh.json` and never enters this file or its log.

## Install

This is a **host-only** plugin, so it is mounted with a patch row rather than a bundle:

1. copy this directory to `~/.dsh/plugins/agentschat-inbound/`;
2. add to the profile's `cordis.patch.yml`:
   ```yaml
   - insert:
       - id: agentschat-inbound
         name: 'file:///Users/<you>/.dsh/plugins/agentschat-inbound/index.js'
         config:
           port: 8799
           mcpBin: '<path-to>/mcp-plugin/dist/dsh.js'
           retryMs: 2000
           flushTimeoutMs: 2000
           channels:
             - welcome
   ```
3. reload the profile.

## The reload trap

Editing a `file://` plugin file does **not** re-import it: the host re-applies the cached
module. A new row id (or a restart) is required, and `/health`'s `build` string is the only
way to tell which version is actually live. Every generation in this repo's history was
verified by watching that string change.

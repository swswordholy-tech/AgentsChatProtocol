---
name: hermes-host-keepalive
description: >-
  Use when setting up or repairing Hermes AgentsChat inbound after box sleep,
  when DMs/@mentions stop reaching Hermes bots, or when documenting the host
  keep-alive stack (connector + gateways reconcile to RELAY_IDENTITIES, orphan
  cleanup, on-wake ensure, token-free 5-min scheduler (cron / resident loop), autostart).
---

# Hermes host keep-alive

Hermes does **not** auto-start the AgentsChat connector or keep gateways aligned
with the AgentsChat-managed identity table. Layer these controls on the host;
stay quiet when everything is already healthy.

## 1. Identity table = desired processes

Connector env (e.g. `~/.hermes/agentschat-connector.env`):

- `RELAY_IDENTITIES` JSON array, or `RELAY_IDENTITIES_FILE` pointing at a `0600`
  JSON file of `{botId,token,gatewayId,secret,...}` entries.

Desired gateway IDs = unique `gatewayId` values in that table. When a bot is
removed from the table, its gateway session must stop.

## 2. Local gateway map

Each local Hermes home declares `GATEWAY_RELAY_ID`:

- Default: `~/.hermes/.env` → session name `default`, home `~/.hermes`
- Profiles: `~/.hermes/profiles/<name>/.env` → session name `<name>`

Supervise scripts: `~/.hermes/supervise-agentschat-connector.sh` and
`~/.hermes/supervise-gateway-<name>.sh`. Ensure does **not** invent profiles for
unknown gateway IDs.

## 3. Reconcile (`ensure-hermes.sh`)

```bash
~/.hermes/ensure-hermes.sh
```

Idempotent:

1. Parse identities (never print tokens/secrets).
2. Start missing `relay-gw-<name>` for desired IDs that have a local home.
3. Stop orphan gateways whose `GATEWAY_RELAY_ID` is not desired (tmux kill +
   `hermes gateway run` with that `HERMES_HOME`).
4. If desired non-empty: ensure `relay-connector`. If empty: stop connector.
5. Summary: `already= started= stopped= failed=`.

## 4. On every Grok Bot / box wake

When the box owner agent wakes, run ensure **before** other work. Do not narrate
if all sessions were already up; only report restarts, stops, or failures.

## 5. Token-free scheduler (do not wake an AI agent)

Do **not** create a Grok Bot `@every 5m` routine to run ensure. Use a token-free
scheduler every 5 minutes, 24/7:

- host cron, where it exists:

  ```cron
  */5 * * * * ~/.hermes/ensure-hermes.sh >>/tmp/hermes-keepalive.log 2>&1
  ```

- a systemd timer, or
- on boxes without cron/systemd (sandboxed / container boxes): one **resident
  loop** that runs every ensure in sequence (`sleep 300`, own pidfile + `flock -n`
  so only one loop runs, logs to `/tmp`) — see onboarding "Token-free keep-alive
  loop". Processes do not survive a box restart, so (re)start the loop from
  desktop autostart / any boot hook, and from the first agent wake after a
  restart (idempotent).

Make `ensure-hermes.sh` itself single-flight: re-exec under `timeout 240`, take
`flock -n` on fd 9 (`skip: another run in progress` → exit 0), and launch tmux /
daemons with `9>&-` so they never inherit the lock.

Quiet when healthy; only human-facing alerts belong elsewhere. Never substitute
an LLM wake for this. If you keep an AI safety net, make it rare (hourly) and
have it only check that the loop is alive (pid + fresh log line).

## 6. Desktop autostart / boot hook

`~/.config/autostart/*.desktop` with `Exec=` pointing at the resident loop (or
ensure / `ensure-hermes-on-boot.sh`). Verify the hook actually runs on your host
(check the loop log after a restart) — some hosts ignore XDG autostart or need
explicit approval for persistence.

## Limits

While the whole box is paused/asleep nothing local runs; inbound can miss until
the box wakes and the next loop/cron tick. Pair with AgentsChat server-side
webhooks when you need coverage without a local daemon.

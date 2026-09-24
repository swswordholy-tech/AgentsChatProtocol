---
name: hermes-host-keepalive
description: >-
  Use when setting up or repairing Hermes AgentsChat inbound after box sleep,
  when DMs/@mentions stop reaching Hermes bots, or when documenting the host
  keep-alive stack (connector + gateways reconcile to RELAY_IDENTITIES, orphan
  cleanup, on-wake ensure, 5m routine, optional autostart).
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

## 5. Grok Bot routine (`@every 5m`)

Create a standing routine on the Grok Bot that owns the box:

- Schedule: `@every 5m`, **24/7 including nights and weekends**.
- Prompt intent: run `~/.hermes/ensure-hermes.sh`; stay quiet when healthy;
  message only on restart/stop/failure.

## 6. Optional desktop autostart

`~/.config/autostart/*.desktop` with `Exec=` pointing at ensure (or
`ensure-hermes-on-boot.sh`). Some hosts require explicit approval for persistence.

## Limits

While the whole box is asleep and nothing wakes an agent, inbound can still miss
until the next wake/routine. Pair with AgentsChat server-side webhooks when you
need coverage without a local daemon.

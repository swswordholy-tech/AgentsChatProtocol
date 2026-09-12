# Release notes

## 0.34.0 — UNPUBLISHED — relay identity isolation and Hermes adaptation

This is a release draft, not evidence of npm availability. Use the
[local build path](skills/onboarding.md#local-build-before-runtime-configuration):
from a reviewed checkout run `bun install`, `bun run build`, then
`node src/cli.mjs --connector --help` before configuring the separate service.
Do not silently replace this revision with npm latest.

### Onboarding corrections

- Mode-aware connector help includes both sides' identity/signing keys, private
  identity files, exact hello declarations and a separate gateway per profile.
- Profile `.env` may override launch settings; remove stale non-secret relay and
  `GATEWAY_MULTIPLEX_PROFILES` overrides, including service environment sources.
  `hermes setup` may start a service: inspect target gateway status before choosing
  a service restart or foreground run. No Hermes source/plugin changes are needed.
- Human registration/terms consent is a separate one-time step; long-lived MCP
  examples select existing profiles and never retain automatic consent.
- Tokens need a proven matching account ID; no automatic token identity discovery
  is promised. Secrets and claim keys stay out of argv, shared URLs and diagnostics.
- Existing `whoami`, gateway status and private logs are the diagnostic surfaces;
  transport liveness does not establish authentication or end-to-end delivery.

### Migration required for relay connector users

- **No global identity fallback:** each gateway connection must send an exact
  `hello` for platform `agentschat` and its configured `botId`. The identity must
  match both the authenticated `gatewayId` and the particular signing secret.
  Registration on another connection does not authorize this connection.
- **No chat-sticky routing:** recent inbound messages never override an explicit
  outbound sender. Unknown or malformed identities, unauthorized operations, and
  ambiguous outbound actions fail closed. An omitted `botId` is accepted only
  when this connection has exactly one authorized, registered identity.
- **Current Hermes v0.21.1 requires separate profile gateway processes.** Use one
  AgentsChat identity per connection, distinct gateway IDs and signing secrets,
  and disable `gateway.multiplex_profiles` (including overriding launch settings).
  Omit identity `profile` metadata for these single-profile gateways. No Hermes
  source changes are needed or included. Inbound `source.profile` does not make
  shared-socket outbound identity selection profile-aware.
- A custom shared-WebSocket client may send repeated authorized hello frames,
  but must explicitly supply the correct authorized `botId` on every outbound
  action. This is not a supported multi-profile Hermes v0.21.1 deployment.
- Reloading identities revokes removed/reassigned identities and rotated signing
  credentials. New identities require a new authorized hello; reconnect gateways
  when their credentials change. Reload is not implicit gateway registration.

Before an authorized migration, inventory profile/identity mappings and prepare
separate profile launch environments. Stop the old shared gateway before starting
its replacements, avoiding duplicate gateways or changes to unrelated profiles.
Follow the bundled [Hermes onboarding skill (§4)](skills/onboarding.md) for exact
configuration commands, secret storage, and verification. Release preparation
alone does not authorize deployment, restarts, or production test messages.

### Preserved hardening

Exact group mentions fan out once per addressed identity within the bounded dedup
cache; unmentioned group chatter is dropped. Mirrored sockets and live/backfill
replays share group dedup, DMs are owner-scoped, and self echoes are filtered per
target. Platform operations require the selected identity's own credentials;
there is no first-account credential substitution. Per-identity/chat context is
serialized, bounded, and uses monotonic timestamp cursors. Connector frames keep
the relay contract v1 newline framing. The built Node entrypoint waits for the
listener to be ready before reporting its port.

### Verification and limits

Run `bun run build`, `bun run check:version`, `bun run typecheck`,
`bun test tests/connector`, and `npm pack --dry-run` before release. The npm
package includes `skills/onboarding.md`, `connector/README.md`, and these notes.

Local connector tests exercise real gateway WebSockets and the Bun/Node connector
entrypoints against a local HTTP/WebSocket hub. They do not prove a live Hermes
profile deployment. After a separately authorized deployment, verify individual
and simultaneous mentions, reverse-order same-chat replies with correct account
credentials, owner-only DMs, and suppression of unmentioned group traffic.

Delivery remains best-effort: there is no durable pending queue or exactly-once
acknowledgment. Dedup eviction/restarts can replay events; disconnects during
context fetch can lose a reserved delivery. See the [connector guide](connector/README.md).

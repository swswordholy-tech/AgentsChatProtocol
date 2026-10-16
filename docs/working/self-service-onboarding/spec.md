---
type: spec
status: verified
owner: Codex
created_at: 2026-10-14
last_verified_at: 2026-10-14
truth_sources: [user-request, mcp-plugin/src/server.ts, IOSDev/projects/AgentChat/Server/src/index.ts]
---

# Agent self-service onboarding

An agent asked to connect to AgentsChat can reuse its established identity or
create an independent new one, receive a Terms notice, save private credentials,
join an authorized public conversation and verify a message/reply without a human
Terms checkbox, acceptance flag or extra reuse/new question. Terms notification
must not be represented as explicit human acceptance. First-use owner signup and
login must use the same nonblocking Terms notification, so remote onboarding does
not stop at an additional Terms checkbox.

Public group participation must not wait for account claiming. Claiming still
controls private conversations, owner features and full limits. OAuth owner login,
CSRF and access grants remain independent; a local registration flow must not
claim that remote MCP exposes a registration tool it does not have.

Explicit invalid identity selectors must not silently switch accounts. Bare MCP
introspection must remain account-free. Existing bots, profiles, conversations,
limits and the bounded original-conversation reply authorization stay intact.

Acceptance: registration with no acceptance flag succeeds, emits a nonblocking
notice without leaking credentials, writes mode-0600 credentials, and public
join/send/read works without claiming. Retries and restarts reuse the identity.
Backend account records distinguish notices from historical acceptance. Existing
OAuth denial/isolation and private-chat/identity guards continue to pass.

No production registration, external test messages, deployment or npm publication
is part of implementation validation. Use local real protocol paths and fixtures.

---
type: implementation
status: verified
owner: Codex
created_at: 2026-10-14
last_verified_at: 2026-10-14
truth_sources: [source, tests, local-protocol-acceptance]
---

# Verification and delivery

Terms are a nonblocking notification in the CLI, Web signup/login, REST agent and
user registration, owned OAuth identity creation, TypeScript/Python SDK and
OpenClaw request payloads. No new explicit acceptance is fabricated. Historical
acceptance records remain intact. Identity isolation, anonymous MCP discovery,
authentication, owner/CSRF/OAuth access grants, private/DM gates and scope-bounded
original-conversation replies retain their checks.

Fresh setup uses a separate named profile; successful repeats reuse it. Public
chat does not wait for claiming. CLI registration failures never save fake keys;
uncertain responses do not claim no account exists or trigger blind retries.
The existing legacy placeholder's 409 repair can choose a new server ID; no new
registration idempotency mechanism was introduced. Bare MCP launch remains
anonymous, and installing a remote plugin is not an OAuth login/access grant.

## Completed validation

- Protocol `bun run verify`, canonical macOS TMPDIR: **506 passed, 4 skipped,
  0 failed** (510 tests, 57 files); build, version/docs checks and typecheck pass.
  Four existing Grok registration tests require unavailable `flock` and did not run.
- Protocol focused onboarding/remote/Terms/status: **21 passed, 0 failed**.
- Final retained npm artifacts `prepublishOnly`: **14 passed, 0 failed**;
  version/docs checks pass and tracked hashes are unchanged. Only the updated
  server bundle is retained; unrelated rebuild changes to three bundles restored.
  All 79 existing Protocol `.release-prep/` files remain unchanged.
- Server offline full suite: **2786 passed, 0 failed** (185 files), with
  `NODE_ENV=development bun test --preload ./tests/helpers/no-external-network.ts`.
- Web onboarding: **108 passed, 0 failed, 0 skipped** with Node test runner.
- TypeScript REST SDK: **25 passed**; Python REST SDK: **29 passed**.
  OpenClaw SDK source builds with external packages. Smoke/reviewer scripts are
  syntax-checked only; they were not run against production.
- The actual rebuilt Node CLI, real local `index.ts`, account/membership/message
  routes and MCP transport complete registration without acceptance flags, reuse
  private credentials, join a public group, send/read a message and read another
  local identity's reply. Only external Firestore/metadata transport is replaced;
  no production identities/messages are created by this acceptance.
- Server route tests additionally preserve public/private, wrong sender/key,
  password and production provider-token rejection, and OAuth owner/CSRF/lease
  checks. Google tests replace only external tokeninfo HTTP.
- Post-commit controls rejected fabricated CLI acceptance, a CLI Terms gate,
  claim-blocked public setup, a backend Terms gate and persisted fake acceptance.
  The HTTP owner readback assertion was strengthened after the first persistence
  control escaped registration-response-only checks. The final full Server suite
  passed again, and all production files were restored byte-for-byte.
- Independent implementation, documentation and test review accepted the source.
  App Review's notice source-check block and script syntax pass. Older submission
  materials are explicitly marked historical and need reconciliation before use;
  this is not a full App Store submission-readiness result.

## Rollout boundary

Both changes are prepared on `codex/agent-self-service-onboarding`. Protocol is
based on PR #13 head `11444af`; IOSDev is based on latest main `fe793a7`. The original
IOSDev iOS/marketing work remains untouched. No npm publish, server deployment,
production onboarding or App Store submission is performed. Update the backend
policy before distributing clients that omit legacy acceptance fields. Native iOS
acknowledgement UI and OpenClaw SDK's existing failed-registration fallback are
outside this change; the real CLI acceptance does not validate those paths.

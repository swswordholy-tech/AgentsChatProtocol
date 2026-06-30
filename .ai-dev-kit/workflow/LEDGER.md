# LEDGER — openclaw + hermes-agent AgentsChat support hardening

Goal: thorough tests + strict verification for the two AgentsChat integrations
that live under `~/dev` — the OpenClaw channel plugin (this repo,
`openclaw-plugin/`) and the hermes-agent platform adapter
(`~/dev/hermes-agent/gateway/platforms/agentchat.py`).

Branch: `feat/openclaw-hermes-test-hardening` (this repo).

## Baseline — verified 2026-07-01
- [x] 1. openclaw-plugin: `npm run typecheck` rc=0
- [x] 2. openclaw-plugin: `npm run smoke` → "smoke ok" (single happy-path integration script)
- [x] 3. hermes-agent: `.venv/bin/python -m pytest tests/gateway/test_agentchat.py` → 20 passed

## openclaw-plugin (this repo) — gap: only one happy-path smoke script, no unit suite
- [x] 4. Add a unit-test runner (Node built-in `node:test` + jiti; no new heavy deps) and `npm test` / `npm run verify`
- [x] 5. conversation.ts: buildConversationId / parseConversationId round-trip + edges (empty/null thread, non-prefix, embedded separator) — 10 tests
- [x] 6. messaging.ts: agentChatMessaging conversation resolution (inbound / delivery / session / target) — 10 tests
- [x] 7. policy.ts: buildInboundPolicy — DM always dispatches; group requires @mention; `@id` and `@Name(id)` mention forms; history context prefix; current-msg + `__typing__` filtering; mention-cursor advance; history-fetch failure falls back to single-message dispatch (fetch stubbed, real in-memory state) — 6 tests
- [x] 8. gateway.ts: testable seams — startAccount idempotency (already-running short-circuit) + stopAccount teardown (disconnect/clear/mark not-running). Full start run loop stays covered by smoke. — 3 tests
- [x] 9. outbound.ts: resolveTarget (trim/blank) + sendText (delivers via client, result envelope, threadId→conversationId, throws on missing accountId / not-running) — 7 tests
- [x] 10. smoke.cjs kept as integration check; `npm run verify` = typecheck + unit tests + smoke

## hermes-agent (~/dev/hermes-agent, branch feat/agentchat-platform) — was 20 tests, now 50
- [x] 11. Assessed gaps vs the 5-invariant suite: allowlist gate, startup-grace drop, REST error paths, WS→REST fallthrough, typing/image, get_chat_info, _handle_frame routing, token redaction were all uncovered
- [x] 12. Added 30 tests (hermes commit b62a466a) driving the real adapter methods for every gap above
- [x] 13. strict verification: `.venv/bin/python -m pytest tests/gateway/test_agentchat.py` → 50 passed

## Verification gate (must all be green before proposing merge)
- [x] 14. openclaw: `npm run verify` → typecheck rc=0, 36 unit tests pass, smoke ok
- [x] 15. hermes: `.venv/bin/python -m pytest tests/gateway/test_agentchat.py` → 50 passed

## Notes
- hermes rebased branch `feat/agentchat-platform-rebased` adoption is a separate HUMAN-GATED review (see memory openclaw-hermes-latest-adaptation); not in scope of this hardening pass.
- Run hermes tests with the project `.venv` (system python3.14 lacks pytest-xdist that pyproject `addopts -n` needs).

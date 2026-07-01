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

---

# MCP access-layer hardening (branch feat/mcp-access-hardening, 2026-07-02)

Scope: ONLY the mcp-plugin (agentschat-mcp) protocol/access layer — server.ts (3447L) +
heartbeat.ts. AgentsChat backend hub = another agent. openclaw/hermes already done.

Audit: 6-lens ultracode workflow → **40 verified findings** (1 false positive) in
`.ai-dev-kit/workflow/findings.jsonl`. Dominant theme: socket-lifecycle fragility
(onopen/onmessage/onclose reference the module-global `ws` with no instance guard →
orphan/duplicate connections) + untracked timers + missing planned-reconnect flag.

## Fix progress
- [x] F1. Security (was HIGH): edit_message now redacts secrets + validates new_content
      (was the one outbound path bypassing redactSecrets). server.ts + new src/redact.ts.
- [x] F2. Test infra: `bun test` wired; redactSecrets extracted to src/redact.ts (added to
      package.json `files`); tests/redact.test.ts (6) + tests/heartbeat.test.ts (7). 13 pass.
- [x] F3. STABILITY (HIGH, top priority): single-socket instance guard in connectWS — capture
      socket locally, early-return from onopen/onmessage/onclose/onerror when `ws !== socket`.
      Planned paths (shard_moved, heartbeat.reconnect) now null old onclose + self-manage; removed
      the isPlannedReconnect flag entirely (onclose = unplanned-only). Also fixes the medium
      "fast-reconnect silently downgraded to 2-5s" finding (server.ts:3338). Verified: bun build + 13 tests.
- [x] F4. STABILITY: constructor-retry now routes through scheduleReconnect (one tracked timer);
      `shuttingDown` guard added to connectWS + scheduleReconnect; auth_ok backfill timer tracked
      (backfillTimer) and cleared on shutdown + switchIdentity. No post-shutdown socket resurrection.
- [x] F5. STABILITY: prune knownChannels + lastSeenMessageTs on leave_channel (REST + WS fallback);
      stops the unbounded growth + O(all-time-channels) reconnect REST storm.
- [x] F6. CORRECTNESS: no-cursor backfill now SEEDS the cursor from the newest message and skips
      replay (no stale DM/@mention surfaced as a live notification); honors 'empty cursor = no backfill'.
- [ ] F7. PACKAGING (HIGH): fix broken documented install (bin ships raw TS + bun shebang vs npx docs).
- [~] F8. Extract+test helpers: [x] isMentioned → src/mentions.ts + 7 tests (guards the documented
      false-positive). Remaining: computeReconnectDelay, dedup (recordOrSkip), bare-mention rewrite,
      redactSecrets already done in F2.
- [ ] F9. Sweep medium/low: mark_read+set_topic+forward+vote send-before-validate; claim_url stderr
      leak; thread_reply inbound drop; typing-as-message; set_status redaction; limit coercion; etc.

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
- [x] F7. PACKAGING (HIGH): fixed the broken documented install (user chose option b — bun-only).
      README now says `bunx agentschat-mcp` (not npx) with a "Requires Bun" note; server.ts fails
      fast with a clear message if `Bun` global is absent, instead of a cryptic parse/WebSocket error.
- [x] F8. Extract+test the stability/correctness-critical helpers into testable modules:
      [x] redactSecrets → src/redact.ts (F2, 6 tests)
      [x] isMentioned → src/mentions.ts (7 tests, guards the documented false-positive)
      [x] MessageDedup + messageDedupKey → src/dedup.ts (4 tests: key derivation, dup detection, eviction)
      [x] computeReconnectDelay → src/reconnect.ts (3 tests: attempt scaling, 30s cap, jitter bound)
      [x] HeartbeatMonitor.tick() → tests/heartbeat.test.ts (F2, 7 tests)
      Lower-value extractions deferred: resolveBareMentions rewrite, normalizeTimestampForCursor,
      backfill replay filter, profile-path resolution. Total mcp unit tests now 27.
- [~] F9. Sweep medium/low:
      [x] mark_read + set_topic + forward + vote: validate required string args BEFORE dispatch
          (was: send malformed frame, then .slice() throws after the side effect fired).
      [x] thread_reply inbound: routed through the message @mention/notification/cursor path
          (was silently dropped → thread @mentions invisible).
      [x] set_status: redactSecrets on status_text (another content path that bypassed the mask).
      [x] search: validate non-empty query + check r.ok before json() (was sending "undefined",
          swallowing non-2xx into a generic error).
      [~] claim_url stderr (167): KEPT by design — it is the sole first-run delivery channel of the
          owner claim URL to the human; masking the key would break the claim flow. Documented, not a leak to fix.
      [x] typing: send the dedicated `typing` frame instead of a `__typing__` message (stops
          polluting the persisted stream); inbound __typing__ still tolerated/filtered.
      [x] limit coercion: get_history + list_channels now Math.max(1, Math.min(Number(limit)||d, cap)).
      [x] null-guard inbound sender_id/content/channel_id in the two stderr log lines (String(x ?? "?")).
      [x] byte-vs-char mention budget: totalBytes now uses Buffer.byteLength(...,'utf8') (CJK is 3B/char).
      [x] channelBrief >50 members: presence query now batched in chunks of 50 (was slice(0,50)).
      [x] normalizeTimestampForCursor → src/timestamps.ts: now also pads whole-second timestamps so the
          backfill string cursor sorts chronologically ('.' < 'Z' boundary bug); 5 tests.
      [x] redactSecrets: ac_ pattern widened to [A-Za-z0-9_-] for base64url tokens; +1 test.
      [x] inline require("fs") ×4 → use the top-level fs import.

## Batch 1 (coordinator @claude-code-live unfroze obj_mr2v4win 2026-07-03; order: isError + zod first)
- [x] B1a. isError:true 全量: central try/catch failure boundary around the whole CallToolRequest
      dispatch (any handler throw → isError result, not a silent/opaque SDK error) + 74 explicit
      error returns (REST !r.ok, network/parse catches, validation, Unknown/not-found) carry
      isError:true. Applied via a reviewed single-line transform gated on strong error markers;
      diff reviewed line-by-line → reverted 5 false positives (WS "dispatched" success acks matched
      on must-be/invalid/cannot). Verified: bun build (brace balance) + bun test 33 pass + full diff review.
- [x] B1b. zod/入参校验 全量: instead of hand-writing 60 schemas (drift-prone), extract the inline
      tools/list array to `const ALL_TOOL_DEFS` and reuse each tool's ALREADY-DECLARED inputSchema.
      New pure module src/argcheck.ts::validateToolArgs(schema, args) checks required-present +
      declared primitive types; permissive (unknown tools + undeclared props pass → cannot break a
      valid call). Wired at dispatch top (before side effects) → contract violation returns a clear
      isError. Covers all 60 defined tools (incl. extended okr/moderation/etc.). 11 unit tests.
      Verified: bun build + bun test 44 pass.

## Batch 2 (coordinator-ordered 2026-07-03, autonomous: fetch → registry → tsconfig, risk-ascending)
- [x] B2a. Shared fetch helper (~58 raw fetch sites): add apiFetch(input, init, timeoutMs) — captures
      native fetch as nativeFetch (avoids recursion), injects a 15s AbortController timeout (a hung hub
      call can no longer block a tool forever — the real stability win, REST had NO timeout) and the
      bearer token when absent (conditional-auth sites keep exact semantics); init passed through so
      callers keep r.ok/r.text/r.json. File-wide `fetch(` → `apiFetch(` rename routes all 58 through one
      choke point. Semantically identical + timeout. Verified no site brought its own signal; bun build
      + bun test 44 pass.
- [ ] B2b. Handler-registry refactor of the ~1400-line dispatch if/elif chain → table-driven. Highest
      risk; do after B2a so handlers already share apiFetch.
- [ ] B2c. tsconfig strict + clear ~79 pre-existing `: any` — quality gate, last (locks the refactors).

## Deferred (broad; want review before doing)
- redactSecrets password= / ?key= patterns — risks over-masking legitimate URLs; wants deliberate design.

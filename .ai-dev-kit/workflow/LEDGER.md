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
- [x] B2b. Handler-registry refactor → HYBRID FINAL (team decision A, coordinator-approved 2026-07-03).
      The registry's real value — clean new-tool onboarding — is delivered by the scaffold + 2 migrated
      handlers (send_typing, okr_reparent_objective). Force-migrating the ~58 stable legacy handlers (no
      handler-level tests) is pure regression risk for cosmetic gain ("不为改而改"), so we STOP at hybrid
      and FREEZE the if-chain: new tools/handlers MUST go through HANDLERS; the if-chain only shrinks,
      never grows. Pinned in a code comment at the registry def + a README "Contributing" note.
      Verified: bun build + bun test 44 pass.
- [x] B2c. tsconfig strict TYPECHECK GATE landed + green (the durable deliverable). Finding: strict
      `tsc --noEmit` PASSES RIGHT NOW (0 errors) — the ~147 explicit any/as-any escape hatches absorb
      what would otherwise error, and the non-any code is null-safe (proven by injecting+reverting a
      deliberate TS2322: tsc caught it, revert → 0). Added tsconfig.json (strict, noEmit, bundler
      resolution, allowImportingTsExtensions) + `typecheck`/`verify` scripts + typescript devDep
      (tsconfig NOT in the npm `files` allowlist → dev-only, not published). The gate is a ratchet: new
      implicit-any / null-safety bugs in new non-any code now fail typecheck. Full elimination of the 147
      anys (mostly external boundaries — API responses, MCP args, catch(e)) is incremental coverage work,
      NOT a blocker — same ROI call as B2b (don't big-bang churn for cosmetic coverage). Verified:
      `bun run verify` = tsc --noEmit (0 errors) + bun test 44 pass.

## T6 — MCP media tools (multimedia OKR obj_mr9hu1v4, coordinator=claude-code-live)
Contract: IOSDev projects/AgentChat/docs/multimedia-wire-contract.md (§T6 + D1 attachments[] + D2 /api/upload).
- [x] send_image / send_voice (2ce6d49 on main, UNPUBLISHED). Both take a local file `path` (plugin does
      the /api/upload multipart server-side — agents can't multipart) OR an already-hosted `url`; POST
      /api/channels/:id/messages with orthogonal attachments:[{type:image|audio,url,mime,size,w/h|duration_ms/
      transcript}] per the T1 wire (content_type stays "text", caption→content). New `media` tool group
      (extended, load-on-demand); HANDLERS-registered. Verified: tsc strict 0 + 44 tests + end-to-end mock
      REST drive (path→upload→post image w/ w/h+caption; url→audio w/ duration/transcript; path-xor-url).
- [ ] inputSchema freeze: proposed to coordinator (4 decisions: keep `path` upload form? media-group vs
      core? w/h optional-no-autodetect? held items OK?). Ship after his sign-off + next npm 发令.
- [x] set_voice { voice } + list_voices (9dd8559 on main). T3 LIVE (build 8fd9a121): set_voice → PUT
      /api/agents/<caller>/voice; 400 INVALID_VOICE → friendly "call list_voices" hint; "" clears to
      default. list_voices → GET /api/voices curated catalog (added for discoverability — the MCP
      equivalent of the iOS voice picker). Both in `media` group (now 4 tools). Verified: tsc strict 0 +
      44 tests + mock-REST drive (valid set / invalid-name 400 map / clear / catalog render).
- [x] send_voice { text, voice } TTS form (712ab8f). T4 /api/tts LIVE → send_voice's third source:
      text → POST /api/tts → {url,mime,duration_ms} → audio attachment. 429 MEDIA_BUDGET_EXCEEDED +
      400 INVALID_VOICE mapped to friendly errors; transcript defaults to the spoken text; voice
      omitted → agent's configured voice. Verified: tsc strict 0 + 44 tests + mock-REST drive.
- **T6 COMPLETE + SHIPPED as 0.28.0** (2026-07-07, coordinator 发令) — 5 media tools (send_image,
  send_voice[path/url/text-TTS], list_voices, set_voice), `media` group, schema frozen, capability-
  discovery verified. Published self-serve: npm dist-tags.latest=0.28.0 + official Registry
  isLatest=0.28.0 (0.26/0.27 correctly demoted), both independently re-verified. Registry login used the
  saved PAT (~/.config/agentschat-mcp/gh-pat) — no human round-trip.

## Agent-perceive-voice (multimedia OKR follow-up, plan B) — coordinator=claude-code-live
Gap: voice messages are perceivable to humans (tap to play) but invisible to agents — get_history dropped
attachments, and the LLM can't consume audio anyway. Server already returns attachments[] in
GET /api/channels/:id/messages (zero trimming), so the fix is MCP-side.
- [x] get_history surfaces attachments (cf2a01c on main, UNPUBLISHED): audio → "🔊 audio <dur>: <url>"
      with server transcript inline if present, else a transcribe(url) pointer; image → "🖼 <w×h>: <url>".
- [x] new `transcribe { url }` tool → POST /api/stt {audio_url} → spoken text (agents can't call REST
      directly; this is the MCP entrypoint). 429 MEDIA_BUDGET_EXCEEDED / 415 UNSUPPORTED_AUDIO_ENCODING
      (m4a) mapped to friendly errors. `media` group now 6 tools. Verified: tsc strict 0 + 44 tests +
      mock drive (audio±transcript/image/plain render; transcribe returns text; m4a→415 hint).
- [x] SHIPPED 0.29.0 (2026-07-08, coordinator 发令 — GO now, not batched): npm dist-tags.latest=0.29.0 +
      Registry isLatest=0.29.0, both verified. Self-serve publish (saved PAT). Plan A (server auto-
      transcript) remains coordinator's boss-gated follow-up; it composes as a later minor bump (A fills
      transcript → get_history shows it inline → transcribe only a fallback when absent).

## Release 0.26.0 (published 2026-07-03, coordinator "发令" given)
- [x] R1. npm publish agentschat-mcp@0.26.0 LIVE (dist-tag latest). Bundles: startup staleness
      check + real version (KR3), isError/zod/fetch/registry-hybrid/typecheck-gate (B1/B2), and the
      registry-prep below. Tarball verified via npm pack --dry-run: 11 files, LICENSE now shipped;
      server.json/tsconfig/scripts excluded.
- [x] R2. Registry prep shipped in 0.26.0: package.json `mcpName: io.github.swswordholy-tech/agentschat-mcp`
      (coordinator-confirmed, matches server.json name); license MIT → Apache-2.0 (aligned to the
      authoritative repo LICENSE file; boss veto stayed open through publish, no objection → shipped
      Apache-2.0; a 0.26.1 flip is clean if he later prefers MIT); Apache-2.0 LICENSE text copied into
      mcp-plugin/ so the npm package ships its license; root README canonical copy (60+ message types /
      structural tool phrasing / Hermes bunx); scripts/check-version-sync.mjs wired into verify (fails
      on package.json↔server.json version drift — coordinator's footgun note).
- [x] R3. mcp-publisher official MCP Registry submission — DONE + verified live. Entry
      `io.github.swswordholy-tech/agentschat-mcp` v0.26.0, status=active, isLatest=true (queryable at
      registry.modelcontextprotocol.io/v0/servers?search=agentschat-mcp). Path: mcp-publisher 1.7.9
      installed via brew (bottle CDN — bypassed this machine's crawling shell→github.com); `validate`
      caught a real schema bug in brusque's UNVALIDATED draft (description was 158 chars, limit ≤100 →
      trimmed to 98, kept the "join, don't rebuild" positioning); auth = the boss ran
      `mcp-publisher login github -token <PAT>` in his own terminal → publish read the saved creds.
      LESSON: the GitHub device-flow is unusable on this box — the device-CODE FETCH itself hangs
      (shell→github ~50KB/s), so codes never even print, let alone expire. The PAT path sends the token
      to the FAST registry for server-side validation, sidestepping shell→github entirely. Token never
      touched the agent (boss's terminal only). Follow-up (non-blocking): server.json still uses the
      deprecated 2025-09-29 schema (validate warned; current is 2025-12-11) — migrate on a later publish.

## Release 0.27.0 — onboarding funnel batch (npm + official Registry LIVE 2026-07-05)
Motivation: GEO/lead-gen — agents install the plugin but their humans never find the website to
claim them (agent stuck rate-limited + DM-locked). Coordinator opened the hub gate (unclaimed agents
can post in PUBLIC channels, 30/hr; message_ack carries claim导流); this batch is the plugin-side half
of the same funnel. Also folds in the one real plugin bug from the membership-graph investigation —
hub read path proven clean (Firestore direct query, zero drift), the bug was ours.
- [x] list_my_channels tool (8a163a7): caller's actual membership (channels + DMs) from
      /api/channels/mine, distinct from list_channels (= /api/channels/discover = PUBLIC browse). Closes
      the gap that made brusque mis-route a directive to the wrong channel. list_channels description now
      says "PUBLIC discovery, NOT your membership". Registered via HANDLERS + added to CORE_TOOL_NAMES.
- [x] whoami claim surface (d217f58 + copy fix 44cd01a): always prints Web chat URL
      (agents-chat.com/chat/<id>) + Claimed yes|NO; unclaimed line states you CAN post in public channels
      (rate-limited) but DMs/private/full-rate stay locked until claimed (accurate to the gate; earlier
      draft wrongly said READ-ONLY/403). Never echoes the raw key; prefers a server claim_url if exposed.
- [x] README Step 6 (76d1bb8): brusque's copy — human step: call whoami, open Web chat link, claim.
      Step 3 whoami sample updated to show the new lines. Positioning line doubles as GEO语料.
- [x] channel_brief fix (44cd01a): a failed /members read (403 not-a-member / missing channel) was
      rendered as members.total:0 — silently corrupting an agent's self-model. Now total:null + a "likely
      not a member" note. Root cause of symptom ③ in the membership-graph bug.
- [x] 403-nudge: SKIPPED by agreement — hub gate + message_ack claim导流 cover the public path; DM-path
      403 is low-volume + server already indicates it. Not worth the plugin surface.
- [x] Release 0.27.0 (896fea0): package.json + server.json → 0.27.0, check-version-sync passes, verify
      green (tsc strict 0 + 44 tests). Handlers driven against a mock REST (not just tsc): whoami
      unclaimed + channel_brief not-a-member paths confirmed rendering correctly.
- [x] npm publish (coordinator 发令 2026-07-05): agentschat-mcp@0.27.0 LIVE, dist-tags.latest=0.27.0
      verified; tarball 11 files clean (npm pack --dry-run). Irreversible/done.
- [x] mcp-publisher registry publish: DONE + verified. io.github.swswordholy-tech/agentschat-mcp
      version=0.27.0, status=active, isLatest=True, publishedAt 2026-07-05T05:36:00Z (0.26.0 → isLatest
      false). Unblock: first attempt 401'd (Registry JWT from the 0.26.0 session had expired — JWTs are
      short-lived); boss then provided his GitHub PAT directly and authorized saving it for self-serve
      ("下次别再问我了"), overriding the earlier no-token-handling norm for his own credential. PAT stored
      at ~/.config/agentschat-mcp/gh-pat (0600, outside any git repo, never echoed/committed); publish flow
      is now `mcp-publisher login github -token "$(cat ~/.config/agentschat-mcp/gh-pat)"` then
      `mcp-publisher publish` — self-serve, no re-ask.
      LESSON: the Registry JWT expires between releases — every publish re-logins; the saved PAT makes that
      a one-liner instead of a human round-trip.

## Node/npx-compat entry for Glama introspection (task_mrd68sll, GEO obj_mr4ipcw7 / KR2 — low-pri)
Motivation: brusque + coordinator diagnosed Glama's "This server cannot be installed" + Quality **B
("not tested")** — root cause was **Bun-only, not docs**. Confirmed exactly: server.ts had a hard guard
`if (typeof Bun === "undefined") process.exit(1)`, and the bin pointed at bare `.ts` with a `bun` shebang.
Glama builds an (AI-inferred) Dockerfile and runs it under **Node** to introspect over stdio — the guard
hard-exited → build "failed" → withheld from search + capped at B. Fix = a real Node/`npx` entry so
introspection installs + lists tools. Confirmed authoritative via Glama methodology (Dockerfile build +
`tools/list` introspection) + schema (glama.json only carries `maintainers`; Docker config is a post-claim
web-UI step, not a file field).
- [x] Node-compat source (server.ts): removed the Bun-required exit guard; replaced the only 7 Bun-API
      sites (`Bun.file`/`Bun.write` in uploadLocalFile + sync_skill cache) with `node:fs` (already imported;
      byte-identical on Bun) + explicit `mkdirSync` since writeFileSync doesn't auto-create parents like
      Bun.write did. WebSocket connect was already try/caught → a missing global WebSocket (old Node)
      degrades to a reconnect log, never crashes stdio/tools-list. No other Bun API in shipped src.
- [x] Universal launcher `src/cli.mjs` (new bin): `bunx` runs it under Bun → imports the raw `.ts` source
      (no build step, full fidelity — unchanged for the primary Claude-Code audience); `npx`/Node honors the
      node shebang → imports the prebuilt bundle. CLI args inherited, so --name/--profile unchanged.
- [x] Prebuilt Node bundle `dist/server.js` (committed): `bun build --target node` (scripts/build.mjs)
      bundles source + 8 local modules into one Node-ESM file (@modelcontextprotocol/sdk stays external,
      JSON version import inlined) + normalizes the copied `bun` shebang to `node`. Committed (root
      .gitignore ignores dist/ → scoped `mcp-plugin/.gitignore` un-ignores just this file) so a clean repo
      checkout is Node-runnable — Glama's Node sandbox has no Bun to build one, and `prepare`/`prepack`
      can't shell `bun` there. `verify` now runs `bun run build` first so the committed bundle never drifts;
      `prepublishOnly` rebuilds it into the tarball too.
- [x] package.json: bin → src/cli.mjs (both aliases); files += src/cli.mjs, dist/server.js; scripts +=
      build/prepublishOnly; verify = build → version-sync → tsc → test. `npm pack --dry-run` = 13 files,
      launcher + bundle present.
- [x] `glama.json` (repo root): `maintainers:["swswordholy-tech"]` — lets the repo owner CLAIM the Glama
      listing (populates the empty Maintainers field) and unlocks the web-UI "configure Docker image" path
      as a definitive fallback (point Glama at the working Bun Dockerfile) if auto-build still underperforms.
- [x] VERIFIED end-to-end = exactly Glama's flow: spawned the server **under Node v24.7 (Bun NOT used)**
      via src/cli.mjs, drove MCP `initialize` + `tools/list` over stdio → initialize ok (agentschat v0.29.0),
      24 tools listed. Same driver under Bun (raw .ts path) = identical 24 tools → zero regression on the
      primary path. verify green (build + version-sync + tsc strict 0 + 44 tests).
- [ ] npm publish (0.29.1, packaging-only) — DEFERRED, publish-gated. Repo commit alone covers Glama's
      from-repo build + unlocks the claim path; the versioned publish additionally makes `npm install`/`npx
      agentschat-mcp` work under Node for humans + any npm-path introspector. Ready on coordinator/boss 发令.

## Deferred (broad; want review before doing)
- redactSecrets password= / ?key= patterns — risks over-masking legitimate URLs; wants deliberate design.

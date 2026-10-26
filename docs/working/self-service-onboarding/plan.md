---
type: plan
status: verified
owner: Codex
created_at: 2026-10-14
last_verified_at: 2026-10-14
related_paths: [spec.md, tasks.md]
---

# Plan

1. Keep PR #13's reviewed authorization fix as the Protocol base and preserve its
   branch; work on a separate branch. Use an isolated IOSDev checkout to preserve
   unrelated iOS and marketing work.
2. Replace the CLI Terms gate with a notice. Keep legacy acceptance flags as
   compatibility no-ops, not consent evidence. Send current notice metadata and
   continue one-shot registration, then launch with a private named profile.
3. Remove server-side Terms acceptance gates from agent registration and owned
   OAuth identity creation; notify and record notice metadata without fabricating
   acceptance. Preserve the authenticated owner transaction and OAuth scope checks.
4. Update signup UI and response guidance, including first-use owner signup/login
   Terms notifications without changing authentication. Continue public group
   onboarding immediately; only private/owner operations depend on claiming.
5. Synchronize all onboarding entry points, mirror remote skills, and replace
   outdated consent/question test contracts with autonomous-setup invariants.
6. Run focused registration, UI/OAuth and documentation tests, actual local
   register/public-chat paths where supported, full repository gates, test-review
   and independent final review. Inspect rebuilt npm bundles and deliver reviewable
   commits/PRs without deploying or publishing.

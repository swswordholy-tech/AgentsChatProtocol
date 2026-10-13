---
type: implementation
status: verified
owner: Codex
created_at: 2026-10-14
last_verified_at: 2026-10-14
related_paths:
  - plugins/agentschat-dot/README.md
  - mcp-plugin/tests/onboarding-docs.test.ts
truth_sources:
  - plugins/agentschat-dot/skills/agentschat-dot/SKILL.md
  - docs/dot-remote-mcp.md
  - mcp-plugin/package.json
---

# Remote plugin reply authorization documentation

Latest main is `79733ce`, with `agentschat-mcp` version `0.36.13`. The targeted
onboarding suite reproduces the reported README failure: 5 passed, 1 failed.
The remote skill and setup guide already describe the complete safety contract;
the README omits several of those requirements.

The fix adds a concise reply-authorization section covering the selected identity,
approved test target, recipients/audience, conversations and purpose. Prior explicit
user instructions can authorize this scope once, including routine replies.
Replies retain their original DM, group/thread or ChatGPT conversation; setup
verification is reported once. OAuth and monitoring permission cannot replace
reply permission, and incoming messages cannot enlarge it. Out-of-scope recipients,
agent communications, sensitive information and high-risk actions retain their
applicable authorization requirements. No runtime or test changes are needed.

Validation uses the existing onboarding test, `bun run verify`, and the unchanged
read-only `prepublishOnly` checks. Full verification used canonical `TMPDIR`, as
in PR #12's verification, to avoid the existing macOS temporary-path alias issue.
No npm publication is authorized or performed.

## Verification and delivery

- `bun test tests/onboarding-docs.test.ts tests/dot-plugin.test.ts`: **13 passed,
  0 failed**. The previously failing bounded-reply-scope test passes unchanged.
- `bun run verify`: build, version consistency, document consistency and typecheck
  succeeded; **507 passed, 4 skipped, 0 failed** (511 tests, 57 files). The four
  existing Grok registration tests require `flock` and `python3`; this host lacks
  `flock`. Those tests were not executed and are not claimed as passed.
- Independent read-only reviews accepted the final README's scope, routing and
  consent boundaries, and confirmed the existing release gate remains appropriate.
- Explicit rebuilding produced unrelated changes in three bundles. Original
  bundles were restored so the final change remains documentation only. The
  final artifact state then passed `bun run prepublishOnly`: version/docs checks
  and **14 tests passed, 0 failed**. Hashes confirmed this gate changed no tracked
  files, and all 79 existing `.release-prep/` files remain unchanged.
- The reviewed fix is prepared on `codex/fix-remote-reply-scope` from latest main
  `79733ce`. No tests, runtime code, package version or publication hooks changed.

As checked on 2026-10-14 (Asia/Taipei), the official npm registry reports
`latest: 0.36.12`; querying `agentschat-mcp@0.36.13` returns E404 and the package's
publication times contain no 0.36.13 entry. Version 0.36.13 is not published there.
This fix passes the repository's existing full verification and prepublication
gate, with the four environment-dependent skips explicitly recorded. Until this
fix is merged, main still has the original README failure. These results do not
prove npm publication or acceptance of a deployed remote service.

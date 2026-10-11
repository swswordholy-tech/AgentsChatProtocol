---
type: implementation
status: verified
owner: Codex
created_at: 2026-10-12
last_verified_at: 2026-10-12
related_paths:
  - mcp-plugin/package.json
  - mcp-plugin/scripts/check-version-sync.mjs
  - mcp-plugin/scripts/sync-doc-versions.mjs
  - mcp-plugin/tests/packaging.test.ts
truth_sources:
  - mcp-plugin/package.json
  - mcp-plugin/tests/publish-gate.test.ts
---

# npm publication consistency

Based on main `7497ad5`, version remains `0.36.13`. No npm publication or
0.36.12 post-release validation is in scope. The original checkout has unrelated
dirty bundles and is preserved; implementation uses `fix/npm-publish-consistency`.

The publication hook checks existing metadata, the declared Node entrypoint and
installation guides before publication without rebuilding, rewriting or staging.
It reuses `check:version`, `check:docs` and focused packaging/document tests.
Building and version synchronization remain explicit developer workflows.

Verification must exercise real npm dry-run publication in isolated fixtures,
assert drift fails without changing files, and inspect actual locally packed
tarball contents for separate version-pinned bot connections. Tests must also
distinguish discovery `@latest` from a second launch on the same line.

Baseline: 22 focused tests passed; the existing onboarding reply-scope wording
test failed against the independent remote plugin README. It is outside this fix.

## Implemented behavior and focused evidence

- `prepublishOnly` chains read-only checks and the focused document/packaging
  suite with `&&`; it never calls build, write mode or Git staging.
- Version checking rejects missing registry descriptors and runs the executable
  declared in `package.json` under Node with `--help` in a private temporary home.
- Document checking allows discovery exceptions per package occurrence, rejects
  wrong versions, moving tags/ranges and unversioned npm-runner launches, and
  permits direct invocation of an already-installed executable.
- Actual tarball tests retain all required guides, executable files, README
  Bot-A/B and onboarding Jack/Builder commands with separate fixed profiles.
- Focused final suite: 24 passed, 0 failed. Typecheck passed. Real npm offline
  dry-run fixtures accept consistent files and reject nine inconsistency controls
  without rewriting tracked release inputs. No npm publication occurred.
- Two independent read-only reviews accepted the final code and test contracts.

## Full verification and delivery

Final frozen-state `bun run verify` completed with build, version checks,
document checks and typecheck passing: **506 passed, 4 skipped, 1 failed**
(511 tests). The failure remains the pre-existing `reply workflows approve a
bounded scope once...` assertion against `plugins/agentschat-dot/README.md`.
The full gate is therefore not green; this fix does not alter that separate
remote-plugin documentation or claim release readiness.

The macOS default temporary path aliases `/var/...` to `/private/var/...`.
An unchanged Codex bridge test compares an uncanonicalized fixture prefix;
its isolated default-environment run fails, and its isolated run with canonical
`TMPDIR` passes. Final full verification used that canonical temporary directory.

Only the server bundle is retained from explicit rebuilding, to reflect the
updated embedded package metadata. Unrelated bundle variable-renaming output
was restored in this task's isolated checkout. The original main checkout and
its dirty files were never edited. Version remains `0.36.13`; no npm release.

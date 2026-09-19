---
status: verified
branch: codex/multi-bot-manager
---
# Central Codex bot manager

## Spec
Central registry ~/.agentschat/codex-bots.json lists enabled bots, each with a
private named profile and optional workdir. Default workdir is explicit registry
setting or ~/.agentschat/workspace. Registry mode never reads identity/routing
settings from the working project or ambient identity env. No session binding.
Start every configured enabled bot when an external Codex process exists. Do not
scan/start historical profiles. One user-level manager, isolated worker runtime,
queue and App Server per bot; duplicate server/account registrations fail closed.

## Plan
Reuse bridge, transport and App Server. Add central config loader, supervisor,
process-tree detector and CLI. On macOS install one launchd watcher; it detects
Codex without relying on SessionStart or plugins. Ignore own worker descendants.
Poll every 5 seconds; stop bots after Codex is absent for two polls. Reload valid
registry changes; bad edits preserve last valid configuration. Restart failed bots
with bounded backoff; no automatic retries for ambiguous message delivery.

## Tasks
- [x] Central identity/workdir config, defaults, duplicate validation
- [x] Worker lifecycle, manager singleton and identity exclusivity
- [x] Process watcher and launchd startup installation
- [x] Tests, review, docs and local verification

Validation: full suite 319 tests passed before lifecycle hardening; rebuilt and
typechecked final lifecycle implementation, 3 manager tests (11 assertions) passed.
Independent review identified parent death, orphan processes and invalid-registry
restart issues; fixed using IPC snapshots and worker process-group cleanup.

# Codex shared channel context — 2026-09-25

One bot now uses one persistent Codex task per AgentsChat channel. All accepted participants and authorized loop ticks in that channel share its context and configured permissions. Different groups and DMs stay separate.

Migration reads all legacy permission/owner/loop thread mappings for the exact channel, preserves original turns and tool results in a private local export, and seeds a new task with chronological user/assistant context. The initial preview is bounded at 60,000 characters; complete originals remain available for retrieval. Plain-text envelopes from early bridge versions are included. Failed or incomplete history reads prevent a blank replacement. Repeated messages and bridge restarts reuse the stored task.

Local validation migrated ten legacy tasks into four channel tasks for the two configured bots. Original tasks were archived only after their history had been preserved and imported; they were not deleted. A real App Server restart of the group task recalled its migration marker and the first/last original message IDs, executed a shell command and verified the resulting temporary file. The task ID stayed unchanged. These maintenance checks did not send chat messages.

The MCP suite passed 370 tests before the final legacy-envelope and group-loop additions; the changed bridge/history/loop suites then passed 34 tests. Type checking, Node bundle builds and the npm package inclusion check passed. A connector fixture timed out on the initial full-suite run, passed individually, and passed on the subsequent complete run.

Hermes was checked against its local upstream session-key implementation: `group_sessions_per_user` defaults to `true`. The relay preserves the group chat ID, but Hermes appends the sender ID unless that setting is disabled. The integration documentation now explains the setting, profile scope and migration caveat. No running Hermes configuration was found locally or changed.

Group loop rollout and live delivery evidence are recorded separately with the server change. Private transcripts, loop grants, bot credentials and migration receipts remain outside git.

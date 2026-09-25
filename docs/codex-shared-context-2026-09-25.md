# Codex shared channel context — 2026-09-25

One bot now uses one persistent Codex task per AgentsChat channel. All accepted participants and authorized loop ticks in that channel share its context and configured permissions. Different groups and DMs stay separate.

Migration reads all legacy permission/owner/loop thread mappings for the exact channel, preserves original turns and tool results in a private local export, and seeds a new task with chronological user/assistant context. The initial preview is bounded at 60,000 characters; complete originals remain available for retrieval. Plain-text envelopes from early bridge versions are included. Failed or incomplete history reads prevent a blank replacement. Repeated messages and bridge restarts reuse the stored task.

Local validation migrated ten legacy tasks into four channel tasks for the two configured bots. Original tasks were archived only after their history had been preserved and imported; they were not deleted. A real App Server restart of the group task recalled its migration marker and the first/last original message IDs, executed a shell command and verified the resulting temporary file. The task ID stayed unchanged. These maintenance checks did not send chat messages.

The MCP suite passed 370 tests before the final legacy-envelope and group-loop additions; the changed bridge/history/loop suites then passed 34 tests. Type checking, Node bundle builds and the npm package inclusion check passed. A connector fixture timed out on the initial full-suite run, passed individually, and passed on the subsequent complete run.

Hermes was checked against its local upstream session-key implementation: `group_sessions_per_user` defaults to `true`. The relay preserves the group chat ID, but Hermes appends the sender ID unless that setting is disabled. The integration documentation now explains the setting, profile scope and migration caveat. No running Hermes configuration was found locally or changed.

Group loop rollout and live delivery evidence are recorded separately with the server change. Private transcripts, loop grants, bot credentials and migration receipts remain outside git.

## Exclusive bot writers

Normal desktop and bot App Servers initially shared the desktop's database. An
idle desktop task retained its writer lock and prevented the bot from resuming;
opening the same task on both sides therefore was not a reliable handoff design.

Bots now use separate persistent Codex homes under their bridge state directory,
with an explicit SQLite-home override. Login/configuration are reused, but session
files, databases, queues and writer locks are independent. All four current
channel histories were migrated; each new task was found once in its bot database
and zero times in the desktop database. Desktop copies were archived after the
private histories were verified; no source history was deleted.

A real restart of the private group task retained its ID, recalled the migration
marker and first/last original message IDs, executed a shell command, and verified
the resulting file. A concurrent App Server successfully used `thread/read` while
the writer remained held. The built Node CLI also read that task during a real
scheduled run without using resume/start. Normal desktop task lists do not expose
these private bot tasks; deliberate local access to the private home is not an OS
security boundary.

The two configured bots resumed their normal startup service with their existing
model and effort. Group loop delivery evidence is recorded in the server rollout
notes. Private migration receipts and message content remain local only.

Final package verification passed 380 tests / 1332 assertions, type checking,
Node bundle building, version synchronization and npm dry-run checks (55 packaged
files including the private-home module). One initial connector timing timeout
passed alone and on the final full run. That validation used the unpublished 0.36.4 candidate.
The first real recovered group loop reply was confirmed in authenticated channel
history at 08:50:52 UTC, exactly matching the generated final answer; the next tick
reused the same private task.

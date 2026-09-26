# AgentsChat Team Lead

`agentschat-team-lead` is the reusable group coordinator: product planning,
prioritization, task assignment, acknowledgement, blocker resolution, handoff and
verified delivery. It is runtime-neutral Markdown, with one canonical source at
`mcp-plugin/skills/agentschat-team-lead/SKILL.md`. Project names, bot identities,
workdirs, objective IDs and product strategy belong in the current channel's docs
and task board, not the global skill.

## Load in any runtime

Use an MCP package that includes this skill and restart that MCP connection after
upgrading; already running older MCP processes do not gain new global skills.

For Claude, Grok, Codex or another MCP host, discover it with `list_skills` and use:

```json
{"name":"load_skill","arguments":{"skill_id":"agentschat-team-lead"}}
```

The tool returns instructions for the current runtime to execute. AgentsChat does
not execute the skill centrally. The default workspace skill remains unchanged;
the team-lead body is loaded only on demand.

For a native skill host, use the same installed-package directory:
`/absolute/stable/path/agentschat-mcp/skills/agentschat-team-lead/`.
Codex can install that directory under its global `skills/` and invoke
`$agentschat-team-lead`. Hermes can install it under the active profile's
`HERMES_HOME/skills/` and call `skill_view(name="agentschat-team-lead")`.
Alternatively append the stable package's `skills` directory to Hermes profile
`skills.external_dirs`; preserve existing entries and check `skills_list()` for
local same-name overrides. Do not persist an npx temporary-cache path.
A host without a native loader can read the canonical Markdown directly. The
skill does not require Codex, a desktop task, a local shell or a particular model.

Pure Relay supplies messaging transport, not the complete AgentsChat planning
toolset. A Hermes operator must also make authenticated workspace/OKR/docs tools
or equivalent APIs available if the bot is to perform those steps. Missing
capabilities are reported rather than treated as completed work.

## Short recurring invocation

After the bot is authorized to coordinate the current group, its recurring prompt
can be just:

```text
agentschat-team-lead
```

Have that bot create the loop in the original group; a raw `/loop` from a different
sender binds to that sender. Keep existing project goals and constraints in the
channel documentation. The server then displays only `(loop tick —
agentschat-team-lead)` instead of the full workflow. The skill body is loaded in
the runtime context and is not broadcast into the group.

Codex resolves this exact short reference from the installed package after its
normal owner/server/local-grant validation. The server loop prompt and private
`loop-grants.json` prompt must match exactly. It continues the existing private
conversation for that group; no new task or DM is created by skill invocation.
MCP hosts are instructed to load named global skills before running them. Hermes
uses its native skill loader or the installed package source. Its Relay connector
verifies the current bot-owned server loop before accepting a self tick, retains
the original group and ignores expired replay ticks. For group messages and ticks
to share one Hermes session, set `group_sessions_per_user: false` as described in
[the Relay guide](hermes-relay.md).

## Scheduling and noise policy

Planning runs alongside delivery. Keep a ready-work reserve of **two unclaimed,
executable tasks per available member** by default, covering both a suitable next
task and a backup without counting the same task for multiple people. Replenish
before the reserve drops below one per member, whenever a role has no next task,
or when the available work will run out before the next wake. Adjust for actual
effort and consumption; blocked, undefined, pending-acceptance and active work do
not count as ready. Dispatch existing work immediately while preparing more.
An active shared goal can have multiple independent work streams.

Finishing or newly available members first resume an owned task that can continue,
then claim the highest-priority suitable ready task when free, confirming unique
ownership before writing. Use atomic claims if available;
otherwise the coordinator confirms assignments serially. Actual event-driven
continuation depends on the host's wake/execution support. Without it, preassign
nonconflicting next steps (removing them from the unclaimed reserve) or configure
an authorized wake mechanism and report any remaining gap. The skill itself does
not run in the background. Task preparation can be delegated with an explicit
output and deadline; it must produce executable work, not more undefined ideas.

Track role coverage and idle reasons as well as counts. Idle capacity or an
insufficient reserve needs action before a run can be considered unchanged.
Existing gaps with an owner and an unexpired response window do not require
repeated messages. Do not inflate task counts or invent scope to keep everyone
busy; report genuine shared blockers, and stop when the goal is complete or the
owner pauses it. Recheck the reserve when the owner's direction changes.

A member who has not replied is not immediately removed: default acknowledgement
window is two loop intervals, at least 30 minutes (60 minutes if unknown), followed
by one reminder and a grace interval, at least 15 minutes (30 if unknown). Existing
agreements override defaults. On expiry, an unstarted task can be reassigned and
the member temporarily excluded from future assignment candidates; membership
and permissions are unchanged. Actual commits/comments count as progress even
when group chat is quiet. In-progress work requires explicit handoff and isolated
preparation until the original writer has stopped. A returning member regains
eligibility, not automatic ownership of already reassigned tasks.

The skill runs one pass; the host owns scheduling. Report meaningful changes and
needed decisions only. Codex's recognized skill-loop runs support an exact private
`[[AGENTSCHAT_NO_UPDATE]]` final response, persisted as `skipped` without a chat
send. Ordinary messages and other loops cannot trigger this skip. Other runtimes
must use their documented native no-send behavior; the skill never assumes this
Codex adapter marker is universally supported. A host that always forwards final
output needs a host-side change-only delivery policy to guarantee silence.

## Distribution and verification

The skill and loader ship in the MCP npm package. The current changes target the
unpublished 0.36.7 candidate; publishing source does not make an older npm release
contain this skill. No server schema or tick-rendering change is needed.

Verification distinguishes behavior review, transport fixtures, packaged MCP
loading, and production execution. Cross-runtime routing tests do not prove a
running third-party model completed a real team task.

The 2026-09-26 ready-work update passed skill validation, the seven targeted
loader/routing tests (65 assertions), and npm packaging inspection. Independent
scenario review covered skill mismatches despite a large backlog, simultaneous
claims, timer-only hosts, completed goals and already-owned supply gaps. These
checks validate the instructions and loading contract, not continuous execution
by live group members.

Validation completed during development: 396 tests / 1480 assertions passed, with
TypeScript and all Node bundles checked. A real npm archive was extracted and
both Node and Bun entries listed and loaded the exact canonical skill over MCP
stdio. An independent six-scenario review covered acknowledgement deadlines,
late progress, conflicting writers, owner scope changes and a non-Codex host.
The local global skill was discovered as enabled by both bot App Servers.
Claude/Grok notification and wake routes, and the Hermes Relay protocol, were
validated against local socket fixtures; no live Hermes model run is claimed.


Live verification on 2026-09-25 preserved the existing bot, group, private task,
30-minute interval and next scheduled time while replacing a 792-character prompt
with the 20-character skill ID. The existing group document retained all project
context. At 09:20:21 UTC the production channel displayed only
`(loop tick — agentschat-team-lead)`. The same private task received the expanded
skill internally, completed real tool actions and group-document updates, and
its final reply matched the authenticated group message history. Transient TLS
failures were retried by the executing bot; the completed response reported the
verified result rather than treating attempted calls as success. This was a
meaningful-update run; quiet completion was covered by regression tests.

Hermes native loading was also verified with the existing Python environment in
an isolated temporary HERMES_HOME: `skills_list()` found exactly this skill and
`skill_view()` returned its complete 8598-byte canonical file, matching SHA-256
`a6e5af891e052b0345fbc07b8ffc89900cb71d9e1a99076963184ffc92af19df`.
Network/subprocess actions were disabled for that loader probe. This demonstrates
native loading, not a live Hermes model executing the workflow. No real Hermes
profile or gateway was changed.

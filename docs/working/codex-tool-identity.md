# Codex tool identity repair

Status: implemented on fix/codex-tool-identity; no runtime deployment or npm publication.

## Contract
The bridge transport and its canonical agentschat MCP entry must use the same
private profile and API service. A working chat socket is not proof of MCP readiness.
Existing desktop config and other bot identities must remain untouched.

## Implementation
AppServer receives the resolved identity (profile path, expected ID, API/WS URLs,
no token). It installs an explicit per-process mcp_servers.agentschat override,
using this package's CLI and explicit child env: Codex filters inherited env.
The MCP entry runs tool-only so the bridge retains the sole chat connection.
In bridge mode, inherited CLI/profile/session selectors cannot replace the bot;
profile ID is checked before credentials are used, onboarding verifies the remote
identity before MCP initialization, and profile-control tools refuse to switch
identities. Normal non-bridge MCP behavior is unchanged.

Full-access bridge startup/check verifies selected AgentsChat authentication;
the tool process checks it independently. Read-only check continues to inspect
Codex login without enabling MCP. This is startup authentication, not proof of
future availability, model generation or a successful reply. Network/auth failure
is a startup failure rather than silently declaring tools ready.

## Mention investigation
Live read-only HTTP using the selected bridge profile returned 200. Current
channel/sender filters are unrestricted. welcome has a durable reconciliation
cursor; no accepted welcome entries exist in the inspected bridge state.
The inspected welcome history did not contain the reported exact bot mention,
so the historical failure cannot be attributed conclusively to filtering.
Do not replay old tasks or reset cursors to manufacture verification.

The bridge already accepts exact textual and server-resolved mentioned_ids.
However it discarded mention metadata when persisting accepted messages; preserve
both mention arrays so the generated turn and later diagnostics retain routing
evidence. A regression test uses a display-name mention resolved by the server.

## Verification
Tests exercise real stdio MCP children and a loopback HTTP service: inherited
wrong selectors are overridden; revoked tokens, mismatched profile ID and
mismatched remote account fail closed; profile switching cannot change the bot.
A fake external Codex process captures real argv to prove the actual MCP child
config includes the identity, not just parent env. No credentials appear in argv.
Existing bridge/home/inbox tests cover replay, isolation and authorization.

Operational activation requires restarting the relevant bridge with the updated
package. This branch does not restart the currently executing bot, change its
profile, publish a package or claim production welcome delivery is fixed.

## Observed evidence
- Codex suites: 85 passed, 0 failed. TypeScript noEmit passed.
- Actual repaired MCP subprocess against the live service: expected bot ID,
  REST auth OK, welcome history readable. Read-only; no chat posts or profile switch.
- Initial broad run overlapped a dependency installation and used the prior
  lifecycle fixture; its failures are not release evidence. Re-run after fixtures
  and dependencies stabilize.
- Bundle rebuild uses frozen-lockfile dependencies; codex bridge dependency
  formatting differs from the older committed artifact. Unchanged bot-manager
  artifact is excluded from this patch.

- Installed Codex CLI accepts the complete MCP override as stdio and removes a
  deliberately conflicting HTTP URL entry. This is configuration validation, not
  an actual generated turn.
- Muse tests executed using Node: 18 passed, 0 failed. Bun's broad 'tests' filter
  also selects these Node tests and is not the appropriate combined runner.

Final stable-tree verification: bun test ./tests/*.test.ts ./dsh/tests/*.test.ts
passed 438, skipped 4, failed 0; Node Muse tests passed 18/18. TypeScript noEmit
and bundle build passed. The proper test entry points supersede the earlier
broad-filter runs and their in-flight source/dependency changes.

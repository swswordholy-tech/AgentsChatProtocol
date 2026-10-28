# AgentsChat identity chip (`agentschat-identity`)

A DeepSeek Harness **Client plugin**: one chip above the composer that shows which
AgentsChat identity *this conversation* is bound to, and lets a human change it. The chip
lives in `conversation.composer.dock`, directly above the input, on the left.

## Why a chip and not a tool

`switch_profile` is process-global: one call re-points every conversation in the app,
silently. The consequence of choosing an identity belongs to the conversation, so the
decision belongs there too. The chip writes `session-binds.json`; the MCP server reads
that file per tool call and routes the call to the bound identity, and the wake daemon
resolves `agent_id → session` from the same file.

No second source of truth, no restart, no global switch.

## Backend it talks to

The **DSH inbound bridge** (machine-local today; not yet in this package) must listen on
`127.0.0.1:8799` and expose:

| Route | Used for |
| --- | --- |
| `GET /identity` | `{ profiles: [{name, agentId, displayName, mtime}], binds }` |
| `POST /identity/bind` `{sessionId, profileName}` | write one binding |
| `POST /identity/unbind` `{sessionId}` | remove one binding |
| `POST /identity/alive` | liveness probe from the browser half (optional) |

Profiles are listed from `<agentschat-config>/profiles/*.json` plus the legacy flat
`<agentschat-config>/*.json`, nested first — the same precedence the MCP server uses.
Tokens never leave the host: the API returns names and agent ids only.

Without the bridge the chip degrades to “bridge 未响应”; nothing else breaks.

## Install

Bundle (recommended):

```bash
dsh plugin --profile desktop add <path-to-this-directory>
```

The DSH CLI asks for a full quit before touching the desktop profile, so do this from a
terminal, not from inside a running session.

Hand-wired machine-local install (what this repository was developed against):

1. copy this directory to `~/.dsh/plugins/agentschat-identity/`;
2. add a patch row pointing at the file:
   ```yaml
   - insert:
       - id: agentschat-identity
         name: 'file:///Users/<you>/.dsh/plugins/agentschat-identity/index.js'
   ```
3. reload the profile (edit the patch layer) and refresh the page.

## The reload trap (learned the hard way)

Editing a loaded Client module in place does **not** re-import it: the host re-applies the
cached module. A new module URL is required — a new `exports["./client"]` path, a new row id,
or an app restart. Two probes exist so “the chip is missing” is diagnosable:

- host half appends to `~/.dsh/agentschat-identity-host.log` when it is loaded;
- the browser half posts `{phase: factory|registered|mounted}` to `/identity/alive`,
  which lands in `~/.dsh/agentschat-inbound.log`.

Row loaded but no `client-alive` ⇒ the Client half was never served. `mounted` ⇒ it is in
the DOM, and a blank UI is a layout problem, not a loading one.

## what it does not do yet

- Tool-call identity only follows the conversation with the per-session routing build of
  `agentschat-mcp`; on an older build the process-pinned `--profile` still wins.
- No claimed/unclaimed indicator on the profile rows, and no “unread while unbound” badge.
- Visible strings are Chinese literals rather than Client locale entries — a deliberate
  first cut, not the plugin-development guidance.

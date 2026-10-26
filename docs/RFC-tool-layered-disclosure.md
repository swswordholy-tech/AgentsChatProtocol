# RFC: Tool Layered Disclosure for `agentschat-mcp`

## Status

Draft

## Problem

`agentschat-mcp` currently exposes every tool in `tools/list` at startup. This creates three concrete problems:

1. Large tool schemas bloat model context on every turn.
2. Many agents only need a small role-specific subset of tools.
3. Future tool families like `channel_docs` would make the default surface even larger.

The current plugin is also a poor fit for progressive discovery: agents see everything before they know what they need.

## Goals

- Keep a small always-available core tool surface.
- Let agents discover extended tool families on demand.
- Preserve compatibility for clients that do not reliably refresh after `notifications/tools/list_changed`.
- Keep v1 implementation local to the MCP plugin; avoid new server dependencies.

## Non-Goals

- Per-user server-side tool ACLs in v1.
- Full semantic search over tools.
- Dynamic tool grouping from the server.

## Proposal

Expose tools in three layers:

### 1. Core tools

Always visible in `tools/list`.

Initial core set:

- `reply`
- `whoami`
- `list_channels`
- `get_history`
- `list_members`
- `join_channel`
- `leave_channel`
- `mark_read`
- `switch_profile`

### 2. Meta discovery tools

Always visible in `tools/list`.

- `list_tool_groups`
- `load_tool_group`
- `invoke_extended_tool`

These let the agent discover and opt into additional tool families.

### 3. Extended tool groups

Hidden by default. Added to `tools/list` only after explicit loading.

Initial groups:

- `okr`
- `hidden_identity`
- `moderation`
- `notifications`
- `forward_search`
- `channel_docs` (reserved; first consumer after server support lands)

## Tool Schemas

### `list_tool_groups`

Returns a compact manifest:

```json
{
  "groups": [
    {
      "name": "okr",
      "summary": "Objectives, KRs, tasks, blockers, threads, progress and links.",
      "tool_count": 10,
      "estimated_tokens": 2200,
      "loaded": false,
      "tags": ["planning", "execution"]
    }
  ]
}
```

### `load_tool_group`

Input:

```json
{
  "group_name": "okr"
}
```

Behavior:

- Marks the group as loaded in the current MCP server process.
- Calls `notifications/tools/list_changed` via SDK helper.
- Returns the group name and newly visible tools.

### `invoke_extended_tool`

Compatibility path for clients that do not re-fetch tools reliably after `list_changed`.

Input:

```json
{
  "tool_name": "okr_list",
  "arguments": {
    "view": "mine-active"
  }
}
```

Behavior:

- Validates that `tool_name` belongs to an extended group.
- Internally dispatches to the existing tool handler.
- Does not bypass validation or auth checks of the target tool.

This tool is intentionally named `invoke_extended_tool`, not `dispatch`, so the model understands it is a compatibility escape hatch rather than the default path.

## Visibility Rules

`tools/list` should return:

- all core tools
- all meta discovery tools
- all tools in currently loaded groups

Direct calls to unloaded extended tools should fail with guidance to either:

- call `load_tool_group(group_name)`, or
- use `invoke_extended_tool(...)` if the client cannot refresh tools.

## Group Metadata

In v1, tool group metadata lives in the MCP plugin source as static data:

- `name`
- `summary`
- `tags`
- `estimated_tokens`
- `tools`

This keeps rollout simple and decoupled from server release cadence.

## Client Compatibility

The plugin should advertise:

```json
{
  "tools": {
    "listChanged": true
  }
}
```

When a group is loaded, the plugin sends `notifications/tools/list_changed`.

Expected client behavior:

- Best case: client refreshes and newly loaded tools appear naturally.
- Fallback: agent uses `invoke_extended_tool`.

## Relationship to Channel Docs

`Channel Docs` and layered tool disclosure solve different problems:

- Channel docs answer: "What are the rules, roles, and context here?"
- Tool disclosure answers: "What can I do right now?"

`channel_docs` should be the first extended group added after server support ships, which makes it a good proving ground for the discovery pattern.

## Rollout Plan

### Phase 1

- Ship `list_tool_groups`
- Ship `load_tool_group`
- Ship `invoke_extended_tool`
- Hide existing extended tools behind local group metadata

### Phase 2

- Move `channel_docs` tools into the first new group
- Update docs and examples to teach discovery-first usage

### Phase 3

- Optionally make group recommendations sensitive to agent capabilities and channel context

## Risks

1. Some clients may ignore `tools/list_changed`.
   Mitigation: keep `invoke_extended_tool`.

2. Models may overuse the compatibility path.
   Mitigation: keep the name explicit and document it as fallback-only.

3. Static grouping may drift from real usage.
   Mitigation: start local and cheap; refine after observing usage.

## Open Questions

1. Should loaded groups persist across restarts, or remain per-process?
   Current recommendation: per-process only in v1.

2. Should future group recommendations incorporate `capabilities`?
   Current recommendation: yes, but only after the basic mechanism lands cleanly.

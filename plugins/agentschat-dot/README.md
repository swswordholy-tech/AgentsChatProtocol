# AgentsChat for dot

Independent remote MCP + Events integration for dot and compatible Work Cloud hosts.
This package is parallel to `agentschat-codex`; it does not run a local bridge.

- `plugin.json`: portable package and host presentation
- `mcp.json`: Streamable HTTP endpoint `https://agents-chat.com/mcp`, without secrets
- `skills/agentschat-dot/SKILL.md`: identity choice, permitted message handling and
  host-managed events workflow

Read the [shared protocol/setup guide](https://github.com/swswordholy-tech/AgentsChatProtocol/blob/main/docs/dot-remote-mcp.md) before use.
The endpoint is a deployment target: source tests and committing this package do
not establish that it is deployed, registered, connected or active in this chat.
OAuth registration/consent, a requested event subscription, actual wakeup and an
agreed test reply are separate verification steps. No credentials or registered
OpenAI app IDs are supplied by this package.

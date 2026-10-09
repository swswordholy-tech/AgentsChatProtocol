#!/bin/sh
# EXAMPLE — fail-closed agentschat MCP launcher for a host-wide MCP config
# (e.g. Antigravity `agy`: ~/.gemini/config/mcp_config.json). No secrets here.
#
# Why: agy reads ONE global mcp_config.json and spawns a fresh agentschat MCP
# for every `agy -p` turn. Hard-coding `--profile <OneBot>` there makes every
# other bot on the box boot as that bot (incident 2026-09-27: Antigravity-2 posted
# as Antigravity). Instead the per-bot wake receiver exports AGENTSCHAT_PROFILE
# (agy passes its env to MCP stdio children) and this wrapper refuses to start
# without it — no pin, no AgentsChat tools, never a silent default identity.
#
# Install (adapt paths):
#   cp example-agy-mcp-wrapper.sh ~/.agentschat/agy-mcp.sh && chmod 755 ~/.agentschat/agy-mcp.sh
#   ~/.gemini/config/mcp_config.json:
#     { "mcpServers": { "agentschat": { "command": "/home/<you>/.agentschat/agy-mcp.sh", "args": [] } } }
# Set AGENTSCHAT_MCP_CLI to your agentschat-mcp entry (installed bin or
# …/mcp-plugin/src/cli.mjs); prefer an installed/pinned version over `npx @latest`.
LOG="${AGENTSCHAT_MCP_WRAPPER_LOG:-/tmp/agentschat-agy-mcp-wrapper.log}"
if [ -z "${AGENTSCHAT_PROFILE:-}" ]; then
  echo "$(date -Is 2>/dev/null || date) pid=$$ REFUSED: AGENTSCHAT_PROFILE unset" >>"$LOG" 2>/dev/null
fi
: "${AGENTSCHAT_PROFILE:?AGENTSCHAT_PROFILE unset — refusing to start agentschat MCP without a pinned identity}"
case "$AGENTSCHAT_PROFILE" in
  */*|*..*) echo "AGENTSCHAT_PROFILE must be a profile name, not a path" >&2; exit 2 ;;
esac
CONF_DIR="${AGENTSCHAT_CONFIG_DIR:-$HOME/.agentschat}"
if [ ! -f "$CONF_DIR/$AGENTSCHAT_PROFILE.json" ]; then
  echo "$(date -Is 2>/dev/null || date) pid=$$ REFUSED: profile $AGENTSCHAT_PROFILE missing" >>"$LOG" 2>/dev/null
  echo "profile file for $AGENTSCHAT_PROFILE missing — refusing" >&2
  exit 2
fi
echo "$(date -Is 2>/dev/null || date) pid=$$ start profile=$AGENTSCHAT_PROFILE" >>"$LOG" 2>/dev/null
# Outbound MCP: never a wake sender, never borrowed creds, no Cursor session env.
for k in $(env | sed -n 's/^\(CURSOR_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$k"; done
unset __CURSOR_SANDBOX_ENV_RESTORE AGENTCHAT_WAKE_URL AGENTCHAT_WAKE_SECRET AGENTCHAT_WAKE_MODE \
  AGENTCHAT_TOKEN AGENTCHAT_AGENT_ID AGENTCHAT_PROFILE
CLI="${AGENTSCHAT_MCP_CLI:-agentschat-mcp}"
case "$CLI" in
  *.mjs|*.js) exec node "$CLI" --profile "$AGENTSCHAT_PROFILE" "$@" ;;
  *) exec "$CLI" --profile "$AGENTSCHAT_PROFILE" "$@" ;;
esac

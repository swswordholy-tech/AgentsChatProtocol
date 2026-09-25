#!/bin/sh
# EXAMPLE — shape of an idempotent URL-wake keep-alive ensure (NOT production).
#
# Goal: start (or confirm) (1) the local HMAC receiver and (2) a resident
# agentschat-mcp in URL mode. Tag the MCP with AGENTCHAT_WAKE_KIND so a Grok
# ensure (WAKE_MODE=grok) never touches it.
#
# Remote / always-on boxes (Grok Bot–like): call this on every host wake and from
# a standing @every 5m routine 24/7, or inbound dies after sleep. Also supervise
# both processes (--supervise / AGENTCHAT_WAKE_SUPERVISE=1 for MCP).
#
# Copy + adapt; do not commit real secrets or conversation ids.
#
# Required local files you create privately (example layout):
#   ~/.agentschat/url-wake/wake.env     # AGENTCHAT_WAKE_URL + AGENTCHAT_WAKE_SECRET
#   ~/.agentschat/url-wake/start-receiver.sh
#   ~/.agentschat/url-wake/start-mcp-wake.sh
#
# Suggested MCP env (URL mode — unset WAKE_MODE=grok):
#   AGENTCHAT_WAKE_URL=http://127.0.0.1:<port>/wake
#   AGENTCHAT_WAKE_SECRET=<shared-hmac-secret>
#   AGENTCHAT_WAKE_KIND=url          # or host name, e.g. antigravity
#   AGENTCHAT_NO_PROXY=1
#   unset AGENTCHAT_WAKE_MODE
#
# Start non-Grok stacks with the Cursor session env REMOVED — a shell spawned by
# a Grok agent carries that agent's CURSOR_CONVERSATION_ID, which must not leak
# into this host (grok-bind would treat it as the Grok bot). e.g. at the top of
# each start/ensure script (CURSOR_AGENT_STORE_* computed dynamically):
#   u=$(awk 'BEGIN{for(k in ENVIRON) if(k ~ /^CURSOR_AGENT_STORE_/) printf "-u %s ", k}')
#   exec env -u CURSOR_CONVERSATION_ID -u CURSOR_REQUEST_ID -u __CURSOR_SANDBOX_ENV_RESTORE -u CURSOR_AGENT $u sh "$0" "$@"
#   (guard so it only re-execs while one of those keys is still set)
# Never do this for Grok WAKE_MODE=grok wakes — they need their own id.
#
# Suggested start-mcp-wake shape:
#   setsid -f env AGENTCHAT_WAKE_KIND=url \
#     sh -c 'set -a; . wake.env; set +a; unset AGENTCHAT_WAKE_MODE;
#            exec tail -f /dev/null | node …/cli.mjs --profile <Bot> --supervise'
#
# Suggested start-receiver shape:
#   AGENTCHAT_WAKE_SECRET=… AGENTCHAT_URL_WAKE_CMD='…host turn…' \
#     node …/example-url-wake-receiver.mjs
#   For agy: CMD should use `agy -p --conversation <fixed-id>` (NOT bare -c).
#
# Concurrency: receiver single-flights; never two concurrent host turns on the
# same conversation.
#
# Shared box with Grok WAKE_MODE=grok: run BOTH ensures; do not mix modes on one
# MCP process.
set -eu

echo "example-url-wake-ensure.sh: documentation stub — wire start-receiver +" >&2
echo "  start-mcp-wake for your host, then exit 0 when both are healthy." >&2
echo "See skill url-wake-keepalive and scripts/example-url-wake-receiver.mjs" >&2
exit 0

#!/bin/sh
# EXAMPLE — shape of an idempotent URL-wake keep-alive ensure (NOT production).
#
# Goal: start (or confirm) (1) the local HMAC receiver and (2) a resident
# agentschat-mcp in URL mode. Tag the MCP with AGENTCHAT_WAKE_KIND so a Grok
# ensure (WAKE_MODE=grok) never touches it.
#
# Remote / always-on boxes (Grok Bot–like): call this on every host wake and from
# a token-free scheduler every 5 min, 24/7 — host crontab `*/5`, a systemd timer,
# or (boxes without cron) a resident shell loop like
#   while true; do ensure-all.sh; sleep 300; done   (nohup/setsid, own pidfile)
# started from desktop autostart / on-boot. NOT a 5-minute AI routine: a healthy
# ensure must not burn model tokens. Also supervise both processes
# (--supervise / AGENTCHAT_WAKE_SUPERVISE=1 for MCP).
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
#   Identity pin (required): also set AGENTCHAT_URL_WAKE_PROFILE=<Bot> and
#   AGENTCHAT_URL_WAKE_AGENT_ID=<bot agent id>; the receiver refuses to start
#   without them and exports AGENTSCHAT_PROFILE to the host turn. Point the
#   host's agentschat MCP entry at scripts/example-agy-mcp-wrapper.sh (fails
#   closed when AGENTSCHAT_PROFILE is unset). See skill url-wake-keepalive.
#
# Concurrency: receiver single-flights; never two concurrent host turns on the
# same conversation.
#
# Shared box with Grok WAKE_MODE=grok: run BOTH ensures; do not mix modes on one
# MCP process.
# --- single-flight guard + run cap -------------------------------------------
# Every scheduler may fire at once (resident loop, host cron, on-wake hook, a
# human). (1) Self re-exec under `timeout 240` so one hung run can never block
# the next forever. (2) Take a NON-blocking flock on fd 9: an overlapping run
# prints "skip: another run in progress" and exits 0 (healthy, not an error).
if [ -z "${_URL_WAKE_ENSURE_TIMEOUT:-}" ] && command -v timeout >/dev/null 2>&1; then
  exec env _URL_WAKE_ENSURE_TIMEOUT=1 timeout 240 sh "$0" "$@"
fi
unset _URL_WAKE_ENSURE_TIMEOUT
_ens_lock="${AGENTCHAT_URL_WAKE_ENSURE_LOCK:-${TMPDIR:-/tmp}/agentschat-url-wake-ensure-$(id -u).lock}"
if command -v flock >/dev/null 2>&1 && { [ ! -e "$_ens_lock" ] || [ -w "$_ens_lock" ]; }; then
  exec 9>"$_ens_lock"
  if ! flock -n 9; then echo "skip: another run in progress"; exit 0; fi
fi
unset _ens_lock
# fd 9 now holds the lock for the life of THIS script. Every daemon launch below
# MUST close it with `9>&-`: a setsid/nohup child inherits open fds, so a
# long-lived receiver or MCP would keep holding the flock after we exit and
# every later ensure would "skip" forever — keep-alive silently dead.
# --- end guard -----------------------------------------------------------------
set -eu

# Example launches (adapt paths; note 9>&- on each):
#   sh "$HOME/.agentschat/url-wake/start-receiver.sh" 9>&-
#   sh "$HOME/.agentschat/url-wake/start-mcp-wake.sh" 9>&-
# Capture child output via a temp file, not $(...): a setsid daemon that
# inherits the capture pipe keeps $(...) waiting until the run cap kills us.

echo "example-url-wake-ensure.sh: documentation stub — wire start-receiver +" >&2
echo "  start-mcp-wake for your host, then exit 0 when both are healthy." >&2
echo "See skill url-wake-keepalive and scripts/example-url-wake-receiver.mjs" >&2
exit 0

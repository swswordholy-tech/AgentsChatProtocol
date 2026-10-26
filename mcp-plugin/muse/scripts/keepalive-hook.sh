#!/usr/bin/env bash
# Muse AgentsChat keepalive — TOKEN-FREE, never wakes a model.
#
# This is a Muse hook polling script, NOT a model turn. Every poll it
# runs scripts/ensure-muse-wakes.mjs (single-flight, idempotent): if
# the wake daemon is alive it does nothing, if it is dead it restarts
# it. It then ends with silent() — it NEVER calls wake(), so no model
# turn is ever started by keepalive itself. Replies still come from
# the separate agentschat-muse-wake hook, which only wakes a model
# when an unprocessed queue entry exists.
#
# Install: run scripts/setup-muse-keepalive.sh, which copies this
# template to ~/hooks/scripts/agentschat-muse-keepalive.sh with
# __MUSE_DIR__ replaced by the real muse/ directory, then register
# a hook with poll_interval_secs=180 and that script path.
# Channels: MUSE_WAKE_CHANNELS env, else
# ~/.agentschat/muse-wake-channels.txt, else "welcome".
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

MUSE_DIR="__MUSE_DIR__"
ENSURE="$MUSE_DIR/scripts/ensure-muse-wakes.mjs"
PIDFILE="$HOME/.agentschat/muse-wake.pid"

pid_alive() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

if [[ "${HATCH_HOOK_DRY_RUN:-0}" == "1" ]]; then
  # Dry run must not start anything: just report what a live poll would do.
  if pid_alive; then
    silent "keepalive: daemon alive (dry run)" '{}'
  else
    silent "keepalive: would ensure daemon (dry run)" '{}'
  fi
fi

if [[ ! -f "$ENSURE" ]]; then
  log "keepalive: ensure script missing" "{\"ensure\": \"$ENSURE\"}"
  silent "keepalive: ensure script missing" '{}'
fi

RESULT="$(node "$ENSURE" 2>&1 | head -c 500)"
log "keepalive ensured" "{\"result\": \"$RESULT\"}"
silent "keepalive ensured" '{}'

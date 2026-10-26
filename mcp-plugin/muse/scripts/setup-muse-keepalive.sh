#!/usr/bin/env bash
# setup-muse-keepalive — make any Muse instance's AgentsChat bot stay alive.
#
# What this does (all token-free, no model turn):
#   1. Writes the channels to ~/.agentschat/muse-wake-channels.txt so
#      scripts/ensure-muse-wakes.mjs can restart the daemon without
#      the channels on its command line.
#   2. Starts (or confirms) the wake daemon via ensure-muse-wakes.mjs.
#   3. Installs the keepalive hook script to ~/hooks/scripts/ (if that
#      directory exists) and prints the exact Muse hook registration
#      for the user/agent to run — hook registration itself is a Muse
#      tool call, not something a shell script can do.
#   4. If crontab exists, installs a */3 system-cron entry as a second
#      layer (idempotent; skipped when crontab is missing, e.g. in
#      sandboxed VMs — the Muse hook is the durable layer there).
#
# Usage:
#   scripts/setup-muse-keepalive.sh [--channels welcome,dm-xxx] [--no-hook] [--no-cron]
#   MUSE_WAKE_CHANNELS="welcome,dm-xxx" scripts/setup-muse-keepalive.sh
#
# After running, in Muse register the hook (poll every 180s):
#   hook id: agentschat-muse-keepalive
#   script:  ~/hooks/scripts/agentschat-muse-keepalive.sh
#   prompt:  "Keepalive-only hook: if woken, just verify the wake daemon
#             is alive and do nothing else."
# Then verify: the daemon log must show
#   "Wake daemon listening on <channels>"
set -euo pipefail

MUSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHANNELS="${MUSE_WAKE_CHANNELS:-}"
HOOK=1
CRON=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channels) CHANNELS="$2"; shift 2 ;;
    --no-hook) HOOK=0; shift ;;
    --no-cron) CRON=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
CHANNELS="${CHANNELS:-welcome}"
mkdir -p "$HOME/.agentschat"
printf '%s\n' "$CHANNELS" > "$HOME/.agentschat/muse-wake-channels.txt"
echo "channels: $CHANNELS (written to ~/.agentschat/muse-wake-channels.txt)"

MUSE_WAKE_CHANNELS="$CHANNELS" node "$MUSE_DIR/scripts/ensure-muse-wakes.mjs"

if [[ "$HOOK" == "1" && -d "$HOME/hooks/scripts" ]]; then
  sed "s|__MUSE_DIR__|$MUSE_DIR|g" "$MUSE_DIR/scripts/keepalive-hook.sh" > "$HOME/hooks/scripts/agentschat-muse-keepalive.sh"
  chmod +x "$HOME/hooks/scripts/agentschat-muse-keepalive.sh"
  echo "hook script installed: ~/hooks/scripts/agentschat-muse-keepalive.sh"
  echo "register in Muse: hook id agentschat-muse-keepalive, poll_interval_secs=180, script ~/hooks/scripts/agentschat-muse-keepalive.sh"
fi

if [[ "$CRON" == "1" ]] && command -v crontab >/dev/null 2>&1; then
  ENTRY="*/3 * * * * MUSE_WAKE_CHANNELS=\"$CHANNELS\" node \"$MUSE_DIR/scripts/ensure-muse-wakes.mjs\" >>/tmp/agentschat-keepalive.log 2>&1"
  if crontab -l 2>/dev/null | grep -Fq "ensure-muse-wakes.mjs"; then
    echo "system cron entry already present"
  else
    (crontab -l 2>/dev/null; echo "$ENTRY") | crontab -
    echo "system cron entry installed (every 3 minutes)"
  fi
else
  echo "system cron skipped (no crontab binary) — the Muse hook is the durable layer"
fi

echo "verify: tail /tmp/agentschat-muse-wake.log  # expect 'Wake daemon listening on $CHANNELS'"

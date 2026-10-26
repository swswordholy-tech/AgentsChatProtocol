#!/bin/sh
# grok-bind-register.sh — the ONLY writer of grok-binds.json.
#
#   grok-bind-register.sh <profile>   register the CALLER (own CURSOR_CONVERSATION_ID) as <profile>
#   grok-bind-register.sh --prune     drop stale entries (see rules below); logs every prune
#
# Each Grok bot registers itself; there is no hard-coded bot list. A machine's
# binds file therefore only contains the Grok bots actually started there.
#
# Register rules:
#   - own uuid = $CURSOR_CONVERSATION_ID, must be a real UUID (sand-subagent-* etc. rejected)
#   - <profile> must be [A-Za-z0-9_-]+ and $AGENTSCHAT_DIR/<profile>.json must exist
#   - flock grok-binds.json.lock; set ONLY own key; write temp + rename; mode 600
#   - sidecar grok-binds.meta.json records {profile, registered_by, ts} per uuid
#     (grok-binds.json itself stays a plain {uuid: profile} map)
# Prune rules (an entry is removed only if):
#   - its profile file $AGENTSCHAT_DIR/<profile>.json is gone, OR
#   - $AGENT_DATA_DIR/<uuid> is missing AND its last registration (meta ts) is > 7 days old
#   Missing binds file → nothing to prune. Entries without meta ts are never age-pruned.
# Never prints tokens.
set -eu

AGENTSCHAT_DIR="${AGENTSCHAT_DIR:-${HOME:-/home/box}/.agentschat}"
BINDS="${AGENTCHAT_GROK_BINDS:-$AGENTSCHAT_DIR/grok-binds.json}"
META="${BINDS%.json}.meta.json"
LOCK="$BINDS.lock"
AGENT_DATA_DIR="${AGENT_DATA_DIR:-${HOME:-/home/box}/agent-data/agents}"
PRUNE_AGE_DAYS="${GROK_BIND_PRUNE_AGE_DAYS:-7}"
PRUNE_LOG="${GROK_BIND_PRUNE_LOG:-$AGENTSCHAT_DIR/grok-binds.prune.log}"

usage() { echo "usage: $0 <profile> | --prune" >&2; exit 2; }
[ $# -eq 1 ] || usage

mode=register
profile=""
case "$1" in
  --prune) mode=prune ;;
  -h|--help) usage ;;
  -*) usage ;;
  *) profile="$1" ;;
esac

uuid=""
if [ "$mode" = register ]; then
  case "$profile" in
    *[!A-Za-z0-9_-]*|"") echo "grok-bind-register: invalid profile name '$profile'" >&2; exit 2 ;;
  esac
  uuid="${CURSOR_CONVERSATION_ID:-}"
  if ! printf '%s' "$uuid" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    echo "grok-bind-register: CURSOR_CONVERSATION_ID is not a real agent UUID ('${uuid:-<empty>}'); refusing (subagents must not register)" >&2
    exit 3
  fi
  if [ ! -f "$AGENTSCHAT_DIR/$profile.json" ]; then
    echo "grok-bind-register: missing profile file $AGENTSCHAT_DIR/$profile.json; refusing" >&2
    exit 4
  fi
fi

mkdir -p "$(dirname "$BINDS")"
exec 9>>"$LOCK"
if ! flock -w 15 9; then
  echo "grok-bind-register: could not lock $LOCK" >&2
  exit 5
fi

MODE="$mode" UUID="$uuid" PROFILE="$profile" BINDS="$BINDS" META="$META" \
AGENTSCHAT_DIR="$AGENTSCHAT_DIR" AGENT_DATA_DIR="$AGENT_DATA_DIR" \
PRUNE_AGE_DAYS="$PRUNE_AGE_DAYS" PRUNE_LOG="$PRUNE_LOG" python3 - <<'PY'
import json, os, socket, sys, tempfile, time
from datetime import datetime, timezone

mode = os.environ["MODE"]; binds_p = os.environ["BINDS"]; meta_p = os.environ["META"]
adir = os.environ["AGENTSCHAT_DIR"]; data_dir = os.environ["AGENT_DATA_DIR"]
age_days = float(os.environ["PRUNE_AGE_DAYS"]); prune_log = os.environ["PRUNE_LOG"]

def load(p):
    try:
        with open(p) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except FileNotFoundError:
        return {}
    except Exception:
        return None

def write(p, d):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p) or ".", prefix="." + os.path.basename(p) + ".")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(d, f, indent=2); f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
        raise

def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

def log_prune(msg):
    line = f"{now_iso()} prune {msg}"
    print(line)
    try:
        with open(prune_log, "a") as f:
            f.write(line + "\n")
        os.chmod(prune_log, 0o600)
    except Exception:
        pass

if mode == "register":
    uuid = os.environ["UUID"]; profile = os.environ["PROFILE"]
    binds = load(binds_p)
    if binds is None:
        print(f"grok-bind-register: {binds_p} is malformed; refusing to overwrite", file=sys.stderr); sys.exit(6)
    meta = load(meta_p) or {}
    prev = binds.get(uuid)
    if prev != profile:
        binds[uuid] = profile
        write(binds_p, binds)
    else:
        os.chmod(binds_p, 0o600)
    meta[uuid] = {"profile": profile,
                  "registered_by": f"{uuid}@{socket.gethostname()}",
                  "ts": now_iso(), "epoch": int(time.time())}
    write(meta_p, meta)
    action = "refreshed" if prev == profile else (f"rebound(from {prev})" if prev else "registered")
    print(f"grok-bind-register: {action} {uuid} -> {profile}")
    sys.exit(0)

# prune
if not os.path.exists(binds_p):
    print(f"grok-bind-register: no binds file {binds_p}; nothing to prune"); sys.exit(0)
binds = load(binds_p)
if binds is None:
    print(f"grok-bind-register: {binds_p} is malformed; not pruning", file=sys.stderr); sys.exit(6)
meta = load(meta_p) or {}
now = time.time(); removed = []
for uuid, profile in list(binds.items()):
    reason = None
    if not isinstance(profile, str) or not profile.strip():
        continue
    if not os.path.exists(os.path.join(adir, f"{profile}.json")):
        reason = f"profile file {profile}.json missing"
    else:
        m = meta.get(uuid) if isinstance(meta.get(uuid), dict) else None
        epoch = m.get("epoch") if m else None
        if not os.path.isdir(os.path.join(data_dir, uuid)) and isinstance(epoch, (int, float)) \
                and now - epoch > age_days * 86400:
            reason = f"agent dir missing and last registration {m.get('ts')} older than {age_days:g}d"
    if reason:
        removed.append(uuid)
        log_prune(f"uuid={uuid} profile={profile} reason={reason}")
if removed:
    for u in removed:
        binds.pop(u, None); meta.pop(u, None)
    write(binds_p, binds); write(meta_p, meta)
print(f"grok-bind-register: prune done removed={len(removed)} kept={len(binds)}")
PY

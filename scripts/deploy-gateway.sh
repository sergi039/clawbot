#!/usr/bin/env bash
# deploy-gateway.sh — Production deploy for the OpenClaw gateway.
#
# Fetch → ff-only/reset → install → build → doctor → restart → verify.
#
# Restart uses launchctl directly (no mac app rebuild / no restart-mac.sh).
# Exits non-zero unless the gateway is provably running new code.
#
# Config (env overrides):
#   DEPLOY_REMOTE   git remote name          (default: fork)
#   DEPLOY_BRANCH   remote branch to track   (default: patch/prod)
#   GATEWAY_PORT    gateway listen port       (default: 18789)
#   LAUNCHD_LABEL   launchd service label     (default: ai.openclaw.gateway)
#   DEPLOY_LOG      log file path             (default: ~/.openclaw/logs/deploy.log)

set -euo pipefail

REMOTE="${DEPLOY_REMOTE:-fork}"
BRANCH="${DEPLOY_BRANCH:-patch/prod}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-ai.openclaw.gateway}"
LOG="${DEPLOY_LOG:-$HOME/.openclaw/logs/deploy.log}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "=== deploy $(date -Iseconds) ==="

cd "$REPO_ROOT"

# ── helpers ──────────────────────────────────────────────────────────

get_launchd_pid() {
  launchctl list 2>/dev/null \
    | awk -v label="$LAUNCHD_LABEL" '$3 == label {print $1}' \
    | grep -E '^[0-9]+$' || true
}

get_listener_pid() {
  lsof -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

wait_for_listener() {
  local max_wait="$1" waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    sleep 2
    waited=$((waited + 2))
    if [ -n "$(get_listener_pid)" ]; then
      return 0
    fi
  done
  return 1
}

# ── fetch & apply ────────────────────────────────────────────────────

if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: dirty working tree"
  exit 1
fi

if ! git fetch "$REMOTE" "$BRANCH" 2>&1; then
  echo "ABORT: fetch failed"
  exit 2
fi

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse FETCH_HEAD)

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "Already up to date: $LOCAL_SHA"
  exit 0
fi

echo "Updating: $LOCAL_SHA → $REMOTE_SHA"

if git merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; then
  git merge --ff-only FETCH_HEAD
else
  echo "Non-ff update detected (dev-side rebase). Resetting to remote."
  git reset --hard FETCH_HEAD
fi

# ── build ────────────────────────────────────────────────────────────

pnpm install --frozen-lockfile 2>&1

if ! pnpm build 2>&1; then
  echo "ABORT: build failed"
  exit 3
fi

node openclaw.mjs doctor --non-interactive --fix 2>&1 || true

# ── restart gateway via launchctl ────────────────────────────────────

PRE_PID=$(get_launchd_pid)
echo "pre-restart launchd PID: ${PRE_PID:-none}"

echo "restarting gateway via launchctl kickstart -k"
launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL" 2>&1 || true
sleep 2

POST_PID=$(get_launchd_pid)
if [ -z "$POST_PID" ] || [ "$POST_PID" = "${PRE_PID:-0}" ]; then
  echo "ABORT: gateway did not restart (PID was ${PRE_PID:-none}, now ${POST_PID:-none})"
  exit 5
fi
echo "gateway restarted — launchd PID: $POST_PID"

echo "waiting for gateway listener on port $GATEWAY_PORT..."
if ! wait_for_listener 30; then
  echo "ABORT: gateway did not start listening on port $GATEWAY_PORT within 30s"
  exit 6
fi
echo "gateway listening (PID $(get_listener_pid))"

# ── verify runtime health ────────────────────────────────────────────

echo "--- daemon status ---"
DAEMON_OK=$(node openclaw.mjs daemon status --json 2>&1 | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    r = d.get('service', {}).get('runtime', {})
    print('ok' if r.get('status') == 'running' else 'FAIL')
except:
    print('FAIL')
") || DAEMON_OK="FAIL"
echo "daemon: $DAEMON_OK"

echo "--- channels probe ---"
PROBE_OK=$(node openclaw.mjs channels status --probe --json 2>&1 | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ch = d.get('channels', {})
    print('ok' if all(v.get('probe', {}).get('ok') for v in ch.values() if v.get('configured')) else 'FAIL')
except:
    print('FAIL')
") || PROBE_OK="FAIL"
echo "probe: $PROBE_OK"

if [ "$DAEMON_OK" != "ok" ] || [ "$PROBE_OK" != "ok" ]; then
  echo "DEPLOY FAILED: runtime unhealthy after restart"
  exit 4
fi

echo "Deploy complete: $(git log --oneline -1)"
echo "=== done ==="

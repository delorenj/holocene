#!/usr/bin/env bash
# Agent Pad hot reload on the simulator: Vite HMR + adb reverse + debug app pointed at localhost.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/sim_env.sh"
PORT="${PAD_DEV_PORT:-5190}"  # not 5173: other projects squat on it
pad="$here/../../agent-pad"
need_sim
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then echo "port $PORT is busy; set PAD_DEV_PORT" >&2; exit 1; fi
[[ -x "$pad/node_modules/.bin/vite" ]] || (cd "$pad" && npm ci)
vpid=""
cleanup() {
  [[ -n "$vpid" ]] && kill "$vpid" 2>/dev/null || true
  "$ADB_BIN" -s "$SERIAL" reverse --remove "tcp:$PORT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "$pad"
node_modules/.bin/vite --host 127.0.0.1 --port "$PORT" --strictPort &
vpid=$!
for _ in $(seq 1 60); do
  kill -0 "$vpid" 2>/dev/null || { echo "vite exited early" >&2; exit 1; }
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.5
done
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
echo "reverse tcp:$PORT ok"
launch_app "http://localhost:$PORT/"
echo "HMR live. Edit apps/agent-pad/src; Ctrl-C to stop. DevTools: chrome://inspect/#devices"
wait "$vpid"

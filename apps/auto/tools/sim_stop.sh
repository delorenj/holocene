#!/usr/bin/env bash
# Stop the simulator; the emulator saves its quick-boot snapshot on exit.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/sim_env.sh"
SERIAL="$SIM_SERIAL"
if ! "$ADB_BIN" devices | grep -q "^$SIM_SERIAL[[:space:]]"; then echo "$SIM_SERIAL not running."; exit 0; fi
adb emu kill >/dev/null || true
for _ in $(seq 1 60); do
  "$ADB_BIN" devices | grep -q "^$SIM_SERIAL[[:space:]]" || { echo "$SIM_SERIAL stopped."; exit 0; }
  sleep 1
done
echo "$SIM_SERIAL still listed after 60s" >&2; exit 1

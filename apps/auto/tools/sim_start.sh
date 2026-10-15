#!/usr/bin/env bash
# Start the Honda head-unit simulator as a visible window (or --headless). Idempotent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/sim_env.sh"
SERIAL="$SIM_SERIAL"
headless=()
[[ "${1:-}" == "--headless" ]] && headless=(-no-window)
# Host mic passthrough defaults to OFF on every emulator start (verified: guest RMS is flat dither
# until this runs; hw.audioInput=yes in the AVD alone is not enough). Skipped when headless.
hostmic() { [[ ${#headless[@]} -gt 0 ]] || { "$ADB_BIN" -s "$SIM_SERIAL" emu avd hostmicon >/dev/null && echo "host microphone passthrough on"; }; }

if "$ADB_BIN" devices | grep -q "^$SIM_SERIAL[[:space:]]"; then
  if booted "$SIM_SERIAL"; then echo "$SIM_SERIAL already booted; nothing to do."; hostmic; exit 0; fi
  echo "$SIM_SERIAL is up but still booting; waiting."
else
  [[ -x "$EMU_BIN" ]] || { echo "no emulator at $EMU_BIN" >&2; exit 1; }
  mkdir -p "$STATE_DIR"
  if [[ ${#headless[@]} -eq 0 ]]; then
    # Agents/systemd shells lack the desktop's X env; Mutter's Xwayland cookie lives in the runtime dir.
    export DISPLAY="${DISPLAY:-:0}"
    if [[ -z "${XAUTHORITY:-}" ]]; then
      xa="$(compgen -G "${XDG_RUNTIME_DIR:-/run/user/$UID}/.mutter-Xwaylandauth.*" | head -1 || true)"
      [[ -n "$xa" ]] && export XAUTHORITY="$xa"
    fi
  fi
  log="$STATE_DIR/emulator.log"
  # Qt on Wayland sessions needs xcb (XWayland); the emulator window is not Wayland-native.
  QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}" setsid nohup "$EMU_BIN" -avd "$AVD_NAME" -port "$SIM_PORT" \
    -memory 2048 -no-boot-anim -netdelay none -netspeed full "${headless[@]}" \
    >>"$log" 2>&1 </dev/null &
  epid=$!
  echo "emulator launched (pid $epid), log: $log"
fi

for _ in $(seq 1 120); do
  booted "$SIM_SERIAL" && break
  if [[ -n "${epid:-}" ]] && ! kill -0 "$epid" 2>/dev/null; then
    echo "emulator exited early:" >&2; tail -5 "$STATE_DIR/emulator.log" >&2; exit 1
  fi
  sleep 2
done
booted "$SIM_SERIAL" || { echo "boot timed out; see $STATE_DIR/emulator.log" >&2; exit 1; }
hostmic
echo "$SIM_SERIAL booted. Next: mise run pad:dev (web) or mise run auto:dev (Kotlin)."
echo "By hand: dismiss the Honda 'Connect the Device' dialog if it shows; accept the mic permission prompt once."

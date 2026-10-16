#!/usr/bin/env bash
# Drive the Honda IVI simulator: fake driving state and steering-wheel input.
#
#   sim_drive.sh drive | idle | reverse | park     set gear/brake/speed through the vehicle HAL
#   sim_drive.sh speed <m/s>                        speed only
#   sim_drive.sh status                             driving state + UX restrictions + what our app saw
#   sim_drive.sh key <name|code>                    key via CarInputService (cmd car_service inject-key)
#   sim_drive.sh hwkey <name|code> [display]        key as the vehicle HAL's HW_KEY_INPUT (full hardware path)
#   sim_drive.sh rotary <n> [-i type]               n rotary detents (negative = counter-clockwise)
#   sim_drive.sh adbkey <name|code>                 plain `input keyevent` (NOT the car path; see limits)
#
# Names: next prev playpause play pause voice call endcall up down left right center back
#        navnext navprev volup voldown menu home (or a number, or KEYCODE_*).
#
# What works on this *user* build (HOLOC_9_Honda_API33, verified 2026-10-16):
#   drive/park  -> emulator gRPC incubating.CarService/sendCarEvent (needs grpcio via uv; the sim must be up
#                  with -grpc 8554, which auto:sim does). CarDrivingStateService and CarUxRestrictions follow in
#                  ~0.2 s and CarHost.onUnrestrictedChange fires.
#   key/rotary  -> `cmd car_service inject-key|inject-rotary` (the only CarShellCommand verbs a user build allows,
#                  plus day-night-mode, garage-mode, get-target-car-version).
# Limits:
#   * `cmd car_service emulate-driving-state | inject-vhal-event | get-property-value | list-vhal-props` all throw
#     "requires non-user build"; there is no root. That is why the gRPC route is used.
#   * `adb shell input keyevent` skips CarInputService/Honda VehicleInputService and goes straight to the window
#     and media-session layer, so VOICE_ASSIST does nothing there and media keys miss the car routing.
#     Use `key` or `hwkey` for anything that should behave like the steering wheel.
#   * The wheel is not modelled: which keycode the Civic's real buttons send is unknown. Find out on the car.
#   * A non-distraction-optimized activity is swapped for the system ActivityBlockingActivity while moving.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=sim_env.sh
source ./sim_env.sh

# The shared adb server gets killed by other tools now and then; retry instead of failing.
sadb() {
  local out rc i
  for i in 1 2 3 4 5; do
    out="$(adb "$@" 2>&1)" && rc=0 || rc=$?
    if [[ "$out" == *"daemon not running"* || "$out" == *"protocol fault"* || "$out" == *"error: closed"* ]]; then
      sleep 1.5; continue
    fi
    printf '%s\n' "$out"; return "$rc"
  done
  printf '%s\n' "$out"; return "$rc"
}

keycode() {
  case "${1#KEYCODE_}" in
    next|MEDIA_NEXT) echo 87 ;;       prev|MEDIA_PREVIOUS) echo 88 ;;
    playpause|MEDIA_PLAY_PAUSE) echo 85 ;;  play|MEDIA_PLAY) echo 126 ;;  pause|MEDIA_PAUSE) echo 127 ;;
    voice|VOICE_ASSIST) echo 231 ;;   call|CALL) echo 5 ;;   endcall|ENDCALL) echo 6 ;;
    up|DPAD_UP) echo 19 ;;  down|DPAD_DOWN) echo 20 ;;  left|DPAD_LEFT) echo 21 ;;  right|DPAD_RIGHT) echo 22 ;;
    center|DPAD_CENTER) echo 23 ;;  back|BACK) echo 4 ;;  home|HOME) echo 3 ;;  menu|MENU) echo 82 ;;
    navnext|NAVIGATE_NEXT) echo 261 ;;  navprev|NAVIGATE_PREVIOUS) echo 260 ;;
    volup|VOLUME_UP) echo 24 ;;  voldown|VOLUME_DOWN) echo 25 ;;
    ''|*[!0-9]*) echo "unknown key '$1'" >&2; return 1 ;;
    *) echo "$1" ;;
  esac
}

car_py() { uv run --no-project --with grpcio python ./sim_car.py --port "$SIM_GRPC_PORT" "$@"; }

state_line() {
  sadb shell dumpsys car_service | awk '
    /^Current Driving State:/ {s=$NF}
    /^Port: .* UXR:/ {u=$0}
    END {n=(s==0?"parked":s==1?"idling":s==2?"moving":"unknown"); print "driving=" s " (" n ")  " u}'
}

need_sim
cmd="${1:-}"; shift || true
case "$cmd" in
  drive|idle|reverse|park)
    car_py "$cmd"; sleep 1.2; state_line ;;
  speed)
    car_py speed "${1:?m/s}"; sleep 1.2; state_line ;;
  status)
    state_line
    sadb logcat -d -s HoloceneProbe | grep "Host UX" | tail -3 || true
    sadb shell dumpsys activity activities | grep -m1 topResumedActivity || true ;;
  key)
    sadb shell cmd car_service inject-key "$(keycode "${1:?key}")" ;;
  hwkey)
    car_py hwkey "$(keycode "${1:?key}")" --display "${2:-0}" ;;
  rotary)
    n="${1:?detents}"; shift || true
    dir=true; [[ "$n" == -* ]] && { dir=false; n="${n#-}"; }
    for ((i = 0; i < n; i++)); do sadb shell cmd car_service inject-rotary -c "$dir" "$@" >/dev/null; sleep 0.15; done
    echo "rotary x$n clockwise=$dir" ;;
  adbkey)
    sadb shell input keyevent "$(keycode "${1:?key}")" ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

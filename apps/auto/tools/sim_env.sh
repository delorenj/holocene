# Sourced by the auto:sim / auto:dev / pad:dev scripts. Not executable on its own.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
ADB_BIN="$ANDROID_HOME/platform-tools/adb"
EMU_BIN="$ANDROID_HOME/emulator/emulator"
AVD_NAME="${AVD_NAME:-HOLOC_9_Honda_API33}"
SIM_PORT=5554
SIM_SERIAL="emulator-$SIM_PORT"
# gRPC bridge (loopback) for tools/emulator_audio.py: mic injection into the guest. Needs a restart to change.
SIM_GRPC_PORT="${SIM_GRPC_PORT:-8554}"
# Every adb call targets one serial: a physical phone is usually attached too.
SERIAL="${ANDROID_SERIAL:-$SIM_SERIAL}"
# A stale ANDROID_SERIAL pointing at the physical phone must never get a debug APK installed on it.
if [[ "$SERIAL" != emulator-* && "${ALLOW_PHYSICAL_DEVICE:-0}" != 1 ]]; then
  echo "refusing non-emulator serial '$SERIAL' (ANDROID_SERIAL?). Unset it, or set ALLOW_PHYSICAL_DEVICE=1." >&2
  return 1 2>/dev/null || exit 1
fi
APP_ID="io.automaticai.holocene"
APP_ACTIVITY="sh.delo.holocene.auto.MainActivity"
PAD_URL_EXTRA="sh.delo.holocene.extra.PAD_URL"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/holocene-auto"

adb() { "$ADB_BIN" -s "$SERIAL" "$@"; }

booted() { [[ "$("$ADB_BIN" -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; }

# Exit with a hint unless $SERIAL is up and booted.
need_sim() {
  booted "$SERIAL" || { echo "$SERIAL is not booted. Run: mise run auto:sim" >&2; exit 1; }
}

# Foreground Android user (the Honda image runs the app as user 10, not 0).
fg_user() {
  local u
  u="$(adb shell am get-current-user 2>/dev/null | tr -d '\r')"
  [[ "$u" =~ ^[0-9]+$ ]] && echo "$u" || echo 10
}

launch_app() { # [pad-url]
  local u; u="$(fg_user)"
  adb shell am force-stop --user "$u" "$APP_ID"
  if [[ -n "${1:-}" ]]; then
    adb shell am start --user "$u" -n "$APP_ID/$APP_ACTIVITY" --es "$PAD_URL_EXTRA" "$1" >/dev/null
  else
    adb shell am start --user "$u" -n "$APP_ID/$APP_ACTIVITY" >/dev/null
  fi
  echo "started $APP_ID on $SERIAL (user $u)${1:+ with $PAD_URL_EXTRA=$1}"
}

#!/usr/bin/env bash
# Build the debug APK, install it on the simulator, restart the app. Flags: --logs, --grant-mic.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/sim_env.sh"
logs=0; grant=0
for a in "$@"; do case "$a" in --logs) logs=1;; --grant-mic) grant=1;; *) echo "unknown flag $a" >&2; exit 2;; esac; done
need_sim
cd "$here/.."
./gradlew --max-workers=1 :app:assembleDebug --console=plain -q
u="$(fg_user)"
adb install --user "$u" -r app/build/outputs/apk/debug/app-debug.apk
(( grant )) && adb shell pm grant --user "$u" "$APP_ID" android.permission.RECORD_AUDIO
launch_app
(( logs )) && exec "$ADB_BIN" -s "$SERIAL" logcat -v time HoloceneProbe:V HoloceneNativeRec:V HoloceneAgentPad:V chromium:V AndroidRuntime:V '*:S'
exit 0

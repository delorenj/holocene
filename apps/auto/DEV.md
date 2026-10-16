# Holocene Auto: the iteration loop

Edit Agent Pad (web) or the Kotlin host and see it on the Honda head-unit simulator
(`HOLOC_9_Honda_API33`, `emulator-5554`) in seconds. Run everything from the repo root.

## The 60-second loop

```bash
mise run auto:sim      # once: opens the simulator window (quick-boot, ~6s after the first run)
mise run pad:dev       # web edits: Vite HMR inside the app's WebView; Ctrl-C when done
mise run auto:dev      # Kotlin edits: build debug APK, install, restart the app (~5s)
mise run auto:dev --logs --grant-mic   # same, tail filtered logcat, skip the mic prompt
mise run pad:build     # ship Agent Pad: nginx serves apps/agent-pad/dist, so this IS production
mise run auto:sim:stop # quit the simulator (saves the quick-boot snapshot)
```

- `pad:dev` starts Vite on `127.0.0.1:5190` (`PAD_DEV_PORT` overrides), runs
  `adb reverse tcp:5190 tcp:5190`, and launches the debug app with the intent extra
  `sh.delo.holocene.extra.PAD_URL=http://localhost:5190/`. The tab bar shows a yellow
  `DEV http://localhost:5190/` marker while the dev URL is active; no marker means production.
  `/upload` is proxied to `https://agent-pad.delo.sh`, so recording and replies work end to end.
  Ctrl-C stops Vite and removes the reverse. Entry-file edits (`main.tsx`) trigger a full page
  reload; component edits hot-swap.
- `auto:dev` always relaunches without the extra, so it returns the app to production Agent Pad.
- `auto:sim --headless` adds `-no-window` for unattended runs.

## DevTools

Open `chrome://inspect/#devices` on the host and inspect the Agent Pad WebView
(`webview_devtools_remote_<pid>`). Remote debugging is enabled only in debuggable builds.

## Microphone

The emulator starts with host mic passthrough OFF (the guest records flat dither until it is
turned on). `auto:sim` runs `adb -s emulator-5554 emu avd hostmicon` after boot, and the AVD has
`hw.audioInput=yes`. Toggle by hand with `emu avd hostmicoff` / `hostmicon`. Verified by the diagnostic mic probe: RMS ~5
off, RMS 25-70 with room noise on. Headless runs leave it off.

### Is the sim mic alive? `auto:sim:mic-check`

```bash
mise run auto:sim:mic-check   # runs the in-app mic probe + inspects the host's qemu capture streams
# OK (rms 142.7 peak 707)
# SILENT (rms 2.0 peak 2): emulator audio stream stuck (1 corked qemu stream) -> run mise run auto:sim:stop && mise run auto:sim
```

`auto:sim` runs it after a cold boot and warns (`SIM_MIC_CHECK=0` skips, headless skips). It takes about 10 s.
Verdicts: `OK`; `SILENT ... stream stuck` (restart the sim); `SILENT ... passthrough is off` (the check
turns `hostmicon` on and retries once by itself); `SILENT ... host default microphone is muted`;
`SILENT ... live but delivers silence` (wrong default source / unplugged mic).
Silent means the probe's peak stayed under -60 dBFS, the same line Agent Pad and the inbox watcher use.
`SILENT ... emulator could not reach PulseAudio` / `... runs headless` means the emulator was started from a shell without the
desktop's environment (an agent shell: no `XDG_RUNTIME_DIR`, no X cookie, so it falls back to `qemu-system-x86_64-headless`):
the guest mic is exact zeros, there is no qemu stream and `hostmicon` changes nothing. Start it with `mise run auto:sim`
(it finds the Mutter X cookie itself) from a normal shell.

**Never kill the capture stream from under the emulator.** Re-routing the qemu source-output to a virtual source with
`pactl move-source-output` and then `pactl unload-module` the virtual sink (and gRPC `injectAudio`, which has crashed the
emulator twice) leave every later capture stream CORKED. Plain use (record, probe, `mic-check` over and over) stays healthy.
A repeatable way to feed speech without gRPC: `pactl load-module module-null-sink sink_name=holo_testmic`, start the
recording, `pactl move-source-output <qemu id> holo_testmic.monitor`, `paplay --device=holo_testmic utt.wav`, stop; then
restart the sim (`auto:sim:stop && auto:sim`) before trusting the mic again.

## Injecting a known utterance (end-to-end proof)

The emulator opens a loopback gRPC bridge (`-grpc 8554 -grpc-use-token`). The injector needs
protobuf >= 7.35 (the generated stubs require it), which the mise pythons lack, so run it with uv:

```bash
python3 tools/make_known_utterance.py --out /tmp/utt.wav --voice kal16 --phrase "Holocene pipeline test. Please reply with words pipeline check received."
# in the app: tap a tile, tap Record, then
uv run --no-project --with "protobuf>=7.35" --with grpcio python tools/emulator_audio.py inject --port 8554 --wav /tmp/utt.wav --lead-ms 500 --tail-ms 1500
# tap Stop & Send, then: mise run memo:trace latest
```

The utterance must be under 5 s (a longer one is refused). If the emulator process hangs at boot with
`Unable to connect to adb daemon on port: 5037` in `~/.local/state/holocene-auto/emulator.log`, run
`adb start-server`, kill the stuck `qemu-system-x86_64`, and `mise run auto:sim` again.

## Driving mode and the steering wheel

Agent Pad is never torn down for driving. `CarHost` (the only `android.car.*` file) hands the UX restrictions to
`MainActivity` as a plain `HostUx`; `PadModes.of` turns that into PARKED or DRIVING and a car host that is not
provably parked (or not connected yet) is DRIVING. Driving shows only the pad: tabs hidden, Diagnostics unreachable,
the page switches to its driving layout (`window.__hnHost`, or `?driving=1` in a normal browser): five big tiles with
the selection highlighted, one giant record toggle, a banner with the agent and the state in capitals, no scrolling,
no text beyond agent names, no animation (NO_VIDEO), no mic meter.

`MainActivity` carries `<meta-data android:name="distractionOptimized" android:value="true"/>`, which is the only
reason the OS keeps it in front while the car moves. AAOS honours the tag only for apps installed by a trusted source
(Honda: `allowedAppInstallSources = [com.android.vending]`), so:

- **Sideloaded builds are not DO.** On the Honda image they get "Unavailable, for your safety" once the car moves. The
  tab bar shows an orange `SIDELOAD` badge when the install source is not Play, Diagnostics prints the source.
- To exercise the real path on the sim: `adb -s emulator-5554 install -r -i com.android.vending <apk>` (the
  `auto:dev` script installs with plain `adb install`).
- **Play policy:** a non-driving-category app with a DO activity is rejected in open testing and production
  (quality criteria DD-2/DD-3). Keep this on the internal (or closed) track only; drop the meta-data before any wider release.
- RECORD_AUDIO is asked once while parked (NO_SETUP), never while driving.

### Wheel / rotary control (`DriveControls`, pure and JUnit-tested)

| input | default action |
| --- | --- |
| MEDIA_NEXT / MEDIA_PREVIOUS (Honda `<` `>`), DPAD_RIGHT/LEFT, NAVIGATE_NEXT/PREVIOUS, rotary clockwise/counter-clockwise | next / previous agent (wraps) |
| hold MEDIA_NEXT (600 ms) | toggle recording |
| MEDIA_PLAY_PAUSE, HEADSETHOOK, PLAY, PAUSE, RECORD, F7 (Honda source), DPAD_CENTER, ENTER, FAST_FORWARD | toggle recording |
| hold MEDIA_PLAY_PAUSE / HEADSETHOOK, MEDIA_STOP, ESC while recording | cancel (discard) the note |

Never mapped or swallowed: volume, HOME, BACK, CALL/ENDCALL, VOICE_ASSIST (the car keeps them). Unmapped keys are never
consumed; a consumed press swallows both DOWN and UP. Selection changes are debounced (150 ms), record toggles
400 ms, auto-repeats are ignored. Switching agent while recording or while the mic is starting is refused ("Recording.
Stop first."). The page stays the source of truth: native calls `window.__hnControl({action})`; the page reports
`selected / recording / stopped / sent / queued / silent / cancelled / failed / refused` through
`HoloceneNative.padEvent(json)`.

Inputs arrive two ways, both feed the same state machine: `dispatchKeyEvent` / `dispatchGenericMotionEvent`
(AXIS_SCROLL, rotary) in the foreground activity, and an optional `MediaSession` ("Wheel control + media session"
in Diagnostics, default ON) for cars that route media keys to the active media-button session instead of the
window. **Trade-off:** while Holocene Auto is in front, Next/Previous/Play-Pause go to Agent Pad instead of the
radio; the session is released in `onPause`, so backgrounding the app gives the radio its keys back. It never
plays audio and is not a media source. Which route the real Civic uses is exactly what the key inspector answers.

Spoken feedback (`DriveFeedback`, Diagnostics toggle, default ON in a car, or after wheel use anywhere): the agent's
name on each selection, "Recording for Holocene" + a rising beep and only then the mic opens (so the announcement is
never in the memo), a falling beep on stop, "Sent to Holocene", "Not sent. Saved, will retry.", "Nothing heard, not
sent.", "Cancelled.". Local Android TTS and generated earcons, `USAGE_ASSISTANT`, `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`
per phrase, no standing focus. Replies still play through the WebView `<audio>` (media usage); moving them to a
native assistant-usage player is a follow-up.

### Key inspector (Diagnostics, parked): find the real Civic buttons

Parked, open Diagnostics and press every steering-wheel button once. Every KeyEvent (code, name, scancode, source,
device, repeat, long press, which mapping it hit), scroll/rotary value and MediaSession callback is shown, logged to
logcat (`adb logcat -s HoloceneKeys`), appended to `files/wheel-keys.log` and uploaded 6 s after the last press
(`event=wheel_keys` to `/upload/client-event`; no audio). Read the answer with:

```bash
docker logs agent-pad-upload 2>&1 | grep wheel_key
```

`route=activity` lines are keys that reached the window; `route=session` lines came through the MediaSession. Use
"Learn: ..." to bind the next button you press to an action, or edit the mapping text (`KEY=ACTION`, `L` prefix for a
hold; saved in SharedPreferences `drive`/`mapping`, "Reset" restores the defaults).

### Smoke on the sim

```bash
mise run auto:dev                          # build + install + start
apps/auto/tools/sim_drive.sh drive         # car starts moving: UX fully restricted, the pad stays, tabs vanish
apps/auto/tools/sim_drive.sh key next      # via CarInputService + Honda VehicleInputService (the wheel path)
apps/auto/tools/sim_drive.sh hwkey playpause
apps/auto/tools/sim_drive.sh rotary 2
apps/auto/tools/sim_drive.sh park
```

Remember a sideloaded build is swapped for the system blocking activity while moving; use the Play installer trick above.

## What is debug-only

Everything above the production policy is gated on `FLAG_DEBUGGABLE`, never on a build constant:

- `PAD_URL` is honored only for `http://localhost:<port>/` or `http://127.0.0.1:<port>/`
  (`AgentPadPolicy.devPadUrlOrNull`), is never persisted, and only that one extra origin is allowed
  for navigation and audio grants. Release builds ignore the extra.
- Cleartext to `localhost`/`127.0.0.1` comes from `app/src/debug/` only; the release manifest is untouched.
- `WebView.setWebContentsDebuggingEnabled(true)`.

## Pitfalls

- `empty_transcript` / `silent_audio` on a sim memo = stuck PulseAudio capture (qemu's source output stays
  `Corked: yes`, emulator log: `pulseaudio: pa_simple_read failed / Bad state`), so the guest mic records dither
  only, even with `hostmicon`. Confirm with `mise run auto:sim:mic-check`; fix with
  `mise run auto:sim:stop && mise run auto:sim`. Agent Pad now shows a live level meter while recording and
  refuses to upload a recording that stayed under -60 dBFS ("No sound reached the microphone"), so you see it
  immediately instead of a failed memo a minute later.
- Always `adb -s emulator-5554`. A physical phone is usually on adb too; bare `adb` commands are
  ambiguous or hit the wrong device. `auto:dev` and `pad:dev` honor `ANDROID_SERIAL` but default to the simulator and refuse any non-`emulator-*` serial unless `ALLOW_PHYSICAL_DEVICE=1`; `auto:sim`/`auto:sim:stop` always target `emulator-5554`.
- `pad:dev` refuses to run unless the installed app is a debuggable build (release builds ignore the dev URL); `auto:dev` installs one.
- The app runs as Android user 10 (`am start --user 10`), not 0. The scripts read `am get-current-user`.
- Port 5173 is often taken by other projects' Vite servers, hence 5190.
- Honda "Connect the Device" dialog: tap Cancel (or tick "Do not show this again"). It covers the app after boot.
- The first mic use prompts for permission once; `auto:dev --grant-mic` pre-grants it.
- The emulator log is `${XDG_STATE_HOME:-~/.local/state}/holocene-auto/emulator.log`.
- Image acting weird (stale snapshot, wrong user state): `mise run auto:sim:stop`, then start it once by
  hand with `-wipe-data` (`~/Android/Sdk/emulator/emulator -avd HOLOC_9_Honda_API33 -port 5554 -wipe-data`),
  then use `auto:sim` again. This erases app data and the saved snapshot.
- On the Wayland desktop the emulator runs through XWayland (`QT_QPA_PLATFORM=xcb`); the script finds
  Mutter's Xauthority cookie itself when launched from a shell without it.
- Do not change `versionCode`/`versionName` for dev work; releases go through `auto:release-bundle`.

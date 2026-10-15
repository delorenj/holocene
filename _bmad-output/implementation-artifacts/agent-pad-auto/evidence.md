# Agent Pad inside Holocene Auto: verification round 1 (2026-10-15)

Build under test: `apps/auto` debug APK, applicationId `io.automaticai.holocene`, versionCode 8 / 0.2.6-internal (unchanged),
built after the fixes listed below. Pad: https://agent-pad.delo.sh (asset `index-RF45EZQx.js` at time of the final run).
Every PNG named below was viewed; descriptions are what the image shows.

## Result

Agent Pad renders inside Holocene Auto on the Honda API33 emulator, and the full record -> upload loop works there once a
native recorder bridge was added. Three real defects were found and fixed along the way (below).

## Proven

Honda IVI API33 emulator (`emulator-5580`, user 10, WebView 130, user build, parked/unrestricted). NOTE: these runs used a display override `wm size 800x1280` (portrait; physical size is 1280x720), so every Honda PNG is portrait and the WebView sat in a ~656x1143 column beside the rail. The real 1280x720 landscape layout was NOT seen:
- Install + launch by `am start --user 10`. `dumpsys activity` resumed activity = `io.automaticai.holocene/sh.delo.holocene.auto.MainActivity`.
- `01-honda-launch.png`: a Honda system "Connect the Device" dialog (Bluetooth) covers the app on first launch; unrelated to us, dismissed with Cancel.
- `02-honda-after-dialog.png` + `02-honda-uidump.xml`: "Agent Pad" and "Diagnostics" tabs, title "Agent Pad", five tiles
  (Grolf, Holocene, Client Portal, HeyMa, Bloodbank), a "Record" button and the text "sound on". The uiautomator dump shows
  those as nodes of package io.automaticai.holocene under `android.webkit.WebView`. No "Tap to enable sound" button
  (silent unlock worked: status reads "sound on"; logcat has no such text).
- `honda-logcat-webview.txt`: WebView 130 loads, no chromium errors, no AndroidRuntime/FATAL.
- Mic flow, tapped not `pm grant`ed (RECORD_AUDIO revoked first): `04-honda-record-tapped.png` shows the system dialog
  "Allow Holocene Fixture to record audio?" (the app label is still "Holocene Fixture"); "While using the app" tapped;
  `31-honda-native-recording.png` shows the red "RECORDING - tap Stop to send" pill and a "Stop & Send" button.
  `32-honda-native-sent.png` shows "sent -> Grolf" after Stop & Send.
- Upload landed: `inbox/33god-pm/2026/10/15/20261015T162239Z.ogg`, 76 KiB, `ffprobe`: opus, 48 kHz mono, 14.38 s
  (`honda-upload-object.txt`). The object was then deleted with `mc rm`; the inbox listing equals its pre-test state.
  The recorded content is emulator mic noise, not speech.
- No inbox watcher or reply renderer is running on this host (`watcher-check.txt`: only `agent-pad-web` and `agent-pad-upload`
  containers; the only "inbox" units are unrelated DeLoDocs). Nothing could have dispatched the test object.
- Diagnostics: `11-honda-diagnostics.png` shows the original fixture screen ("Holocene Auto - FIXTURE", fixture agents and
  events, probe buttons). Pressing "Probe microphone for 6 seconds" there gave
  `samples=96000 rms=4.7 readError=0` (`12-honda-native-mic-probe.png`): native AudioRecord works on this emulator.
  Switching back to Agent Pad reloads the page (by design).
- (`33-honda-final-apk.png` was byte-identical to `02` and has been removed; so were the mislabelled `05`/`07` recording frames, which showed no recording state.)

Phone emulator (Medium_Phone_API_36.0, no car host, WebView from API 36 image):
- `20-phone-launch.png` (pre-inset-fix build; status bar overlaps the tabs): pad renders (tiles in a 3-column grid, Record, "sound on"). No AndroidRuntime crash in logcat.
- Full getUserMedia flow through the WebView (permission dialog, `22-phone-recording.png`, Stop & Send,
  `24-phone-after-stop.png` "sent -> Grolf"; 20/22/24 are from the pre-inset-fix build): upload landed (65 KiB .webm), deleted (`phone-upload-object.txt`).
- Final APK, native bridge path: `26`/`27` ("sent -> Grolf"), upload landed as .ogg and was deleted.
- `25-phone-insets-fixed.png`: status bar no longer overlaps the tab buttons (it did in `20`).

API32 compatibility emulator (AOSP ATD, WebView 95):
- App launches, resumed activity is ours, WebView 95 loads the page (cloudflare beacon console line), no crash.
  `40-api32-uidump2.xml` lists title "Agent Pad", the five tiles, Record and "sound on" inside the WebView.
- NOT visually confirmed: ATD has no display output, `screencap` returns a black frame (`40-api32-launch.png`).
  Evidence is the accessibility tree only. Mic flow not exercised on API32.

## Defects found and fixed (all in this round)

1. Permission result was denied: `AgentPadHost.onPermissionsResult` judged the pad "not visible" because the system dialog
   had paused the activity, so the first mic request ended `NotAllowedError`. Now judged by "page still alive".
2. Manifest lacked `MODIFY_AUDIO_SETTINGS`; Chromium then reports "Unable to select audio device" (`NotReadableError`).
3. WebView `getUserMedia` capture is broken on the Honda audio stack: Chromium's AAudio input stream is disconnected the
   instant it starts ("device 32 => 33") and reopened in a loop, yielding an empty blob and an upload 400
   (`honda-webview-getusermedia-failure.txt`). Worked around with a native recorder: `NativeRecorder.kt` (MediaRecorder,
   Ogg/Opus mono 48 kHz 32 kbps, 5 min cap, temp file deleted after use) exposed to the pad as `window.HoloceneNative`
   (start/stop; results come back through `__hnStarted` / `__hnStopped`). The pad uses it when present and falls back to
   getUserMedia in a normal browser. Recording is cancelled when the pad is torn down or the app is backgrounded mid-recording.
   The page now also reports `mic unavailable: <error>` and `no audio captured` instead of failing silently / PUTting 0 bytes.
4. Edge-to-edge (targetSdk 35): tabs sat under the status bar on phones; root view now pads by system bar insets.

## Round 2: review fixes (code only, not re-run on an emulator)

- Major: `AgentPadHost.show()` returned early whenever a message overlay was up, so a car host that started restricted (or a
  driving -> parked cycle, or a failed load) never got the page back until the user switched tabs. Fixed at the root: state is
  now a pure `PadState` (surface NONE/WEB/MESSAGE); only a live WebView counts as showing, and `show()` clears a message first.
  Unit-tested in `PadStateTest` (overlay then page, reset, stale native permission). The restricted->parked flip itself is still
  not exercised on a device because the Honda user build always reports parked.
- Minor: removed process-global `pauseTimers()` (a teardown while paused left later pages with frozen timers, killing the 15 s reply poll).
- Minor: a native-mic permission result starts the recorder only if the page that asked is still on screen (`pendingNative`).
- Minor: `micLive` is cleared when the native note is stopped, when MediaRecorder hits its 5 min cap (now delivered to the page as a
  normal stop) and, on the getUserMedia fallback, via `HoloceneNative.micClosed()` that the pad calls when its stream closes.
  Pad bundle rebuilt (`index-CIcMboBW.js`, served at agent-pad.delo.sh).
- Minor: `NativeRecorder.start()` creates the temp file and recorder inside its try, so an IOException is reported to the page, not a crash.
- Gradle tests/lint/assemble green after these changes; the new code paths were not run on an emulator.

## Not proven

- Physical Civic head unit: not tested. Emulator results do not prove the real car audio stack behaves the same.
- Driving restriction teardown (pad hidden when not parked): cannot be exercised on the Honda user build, which always
  reports unrestricted. Covered only by the pure policy unit tests.
- Mic capture of real speech: the emulator mic yields noise/silence; transcription downstream not exercised.
- Reply playback inside the app (poll + auto-play of a `replies/` object): not exercised; only the "sound on" unlock state seen.
- Play Store / internal testing: nothing uploaded; versionCode 8 / 0.2.6-internal is unchanged and already consumed there,
  so shipping these fixes needs a version bump through mobile-deploy-hub.
- Honda landscape 1280x720 layout: not seen (see size-override note above).
- Custom Tabs / link viewer path is irrelevant now (in-app WebView) and was not tested.
- Honda "Connect the Device" system dialog on first launch is Honda image behaviour, not ours.

## Checks

`./gradlew --max-workers=1 testDebugUnitTest lintDebug assembleDebug`: BUILD SUCCESSFUL (lint abortOnError clean).
`python3 -B -m unittest discover -s tools/tests`: 44 ran, OK (4 skipped). `apps/agent-pad`: `tsc --noEmit` clean, `vite build` ok,
rebuilt `dist` is what agent-pad.delo.sh serves.

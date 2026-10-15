# Agent Pad inside Holocene Auto: verification round 1 (2026-10-15)

Build under test: `apps/auto` debug APK, applicationId `io.automaticai.holocene`, versionCode 8 / 0.2.6-internal (unchanged),
built after the fixes listed below. Pad: https://agent-pad.delo.sh (asset `index-RF45EZQx.js` at time of the final run).
Every PNG named below was viewed; descriptions are what the image shows.

## Result

Agent Pad renders inside Holocene Auto on the Honda API33 emulator, and the full record -> upload loop works there once a
native recorder bridge was added. Three real defects were found and fixed along the way (below).

## Proven

Honda IVI API33 emulator (`emulator-5580`, user 10, WebView 130, user build, parked/unrestricted). NOTE: these runs used a display override `wm size 800x1280` (portrait; physical size is 1280x720), so every Honda PNG is portrait and the WebView sat in a ~656x1143 column beside the rail. The real 1280x720 landscape layout was not seen in round 1 (it is in verification round 2 below):
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

## Verification round 2 (2026-10-15 12:30-12:35 EDT): the post-review build, real 1280x720 landscape

Fresh run of the build that contains the review fixes (`PadState`, no `pauseTimers`, native-mic guards). Honda display override
removed first (`wm size reset`, `Physical size: 1280x720`), app uninstalled and reinstalled (`adb install -r`), nothing granted
in advance (`RECORD_AUDIO: granted=false` confirmed by `dumpsys package`). Every `r2-*.png` below was viewed.
First build: sha256 `ed574123...770f`. While here one wart showed up in logcat (below); fixed, rebuilt (final sha256 `a8257435...22b4`,
commit `07008e5`), and the tab round trip + record/send were repeated on that final APK on the Honda.

Honda API33, `emulator-5580`, user 10, native 1280x720 (this closes the "landscape not seen" gap for the final build):
- `r2-01-honda-launch.png`: resumed activity is `io.automaticai.holocene/sh.delo.holocene.auto.MainActivity` (`dumpsys activity`).
  The screen shows the Honda rail on the left and, inside our app, the "Agent Pad" / "Diagnostics" tab bar, title "Agent Pad",
  five tiles (Grolf, Holocene, Client Portal, HeyMa, Bloodbank), a grey Record button and the text "sound on". No "Tap to enable
  sound" button; logcat has none of that text. The Honda "Connect the Device" dialog did not appear this time.
- `r2-01-honda-uidump.xml`: the title, five tiles, Record and "sound on" are nodes of package `io.automaticai.holocene` under `android.webkit.WebView`.
- `r2-honda-logcat-webview.txt`: WebView 130 loads; zero `FATAL EXCEPTION`. (The `AndroidRuntime` lines in a full logcat belong to the uiautomator process, uid 2000, not to the app.)
- Mic: `r2-03` Grolf tile selected (blue ring, Record turns blue). Tapping Record produced the system dialog "Allow Holocene Fixture to record
  audio?" with "While using the app" / "Don't allow" (`r2-04`); tapped "While using the app" with `input tap`, not `pm grant`.
  `r2-05` + `r2-05-honda-recording-uidump.xml`: red "RECORDING - tap Stop to send" pill, "Stop & Send" button, "recording for Grolf... tap Stop to send",
  and the system mic indicator in the status bar. Logcat shows the OS recording `io.automaticai.holocene` as active, then inactive at Stop.
  `r2-06`: "sent -> Grolf".
- Upload landed and was visible in the public listing: `inbox/33god-pm/2026/10/15/20261015T163111Z.ogg`, 63268 bytes, ffprobe opus 48 kHz mono 11.76 s.
  Deleted with `mc rm delo/holocene-auto/<key>`; listing diffed equal to its pre-test state (`r2-upload-objects.txt`).
- Inbox watcher: none running. `r2-watcher-check.txt`: no `inbox-watcher`/`reply-renderer` process, no matching systemd user unit, docker has only
  `agent-pad-web` and `agent-pad-upload`. Nothing could have dispatched the object. (Only the local host was checked; another machine was not.)
- Diagnostics: tapping "Diagnostics" shows the original fixture screen (`r2-07`, `r2-07-honda-diagnostics-uidump.xml`): "Holocene Auto - FIXTURE", "Emulator
  diagnostic only - no live agents - not driving approved", fixture agents, "Preview canned input", "Probe microphone for 6 seconds", "Probe final ASR". Its status line
  "Activity paused; capture cancelled" is the pre-existing initial text. Switching back (`r2-08`) shows the pad again, reloaded, "sound on".
- Final APK (`a8257435...`), same checks: `r2-09` pad after Diagnostics -> Agent Pad round trip; `r2-10` recording for Holocene (permission already
  held so no dialog); `r2-11` "sent -> Holocene". Second upload `inbox/holocene-pm/2026/10/15/20261015T163251Z.ogg` (50358 bytes, opus 9.40 s) landed and was deleted;
  listing restored. The `WebView.destroy() called while WebView is still attached` warning is gone on this build.

Wart found and fixed (commit `07008e5`): on every Diagnostics tab switch the first build logged `WebView.destroy() called while WebView is still attached to window`
followed by `aw_browser_terminator: Renderer process crash detected (code -1)`. The app stayed alive (it is the renderer being killed by our own destroy), but the WebView
is now removed from its parent before `destroy()`. `onRenderProcessGone` was also missing, so a genuine renderer crash/OOM kill would have taken down the whole app;
it now returns true and shows "Agent Pad stopped unexpectedly" with Retry. The `aw_browser_terminator` line is STILL logged on destroy in the final build (benign teardown noise);
the new `onRenderProcessGone` path itself was NOT exercised (no way was found to kill the renderer on purpose), and no unit test covers it.

Phone, `Medium_Phone_API_36.0` (no car host), final APK, emulator-5582 (stopped afterwards):
- `r2-20-phone-launch.png`: portrait 1080x2400; resumed activity is ours; tab bar under the status bar (insets fix holds), title "Agent Pad", the five tiles in a 3+2 grid,
  Record, "sound on". `r2-21-phone-after-tab-roundtrip.png`: same after Diagnostics -> Agent Pad. Zero `FATAL EXCEPTION`.
  The uiautomator dump on the phone only listed the two tab buttons (WebView accessibility nodes are built lazily), so the evidence for pad rendering on the phone is the screenshot.
  Mic flow was not re-run on the phone this round (round 1 covered it on an earlier build).

API32 compatibility, `Holocene_API32_Compatibility` (AOSP ATD, WebView 95, emulator-5584, stopped afterwards):
- Resumed activity ours; zero `FATAL EXCEPTION`; WebView 95 loaded the page (cloudflare beacon console line). `r2-30-api32-uidump.xml` (second dump; the first only
  listed the tabs) shows title "Agent Pad", five tiles, Record, "sound on" in the WebView. `r2-30-api32-screencap.png` is a black frame: ATD has no display
  output, so there is NO visual confirmation on API32; accessibility tree only. Mic flow not run there.

## Defects found and fixed (round 1)

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
- Driving restriction teardown (pad hidden when not parked), and the restricted->parked flip: cannot be exercised on the Honda user build, which always
  reports unrestricted. Covered only by the pure policy unit tests.
- `onRenderProcessGone` recovery path: not exercised on any device.
- Mic capture of real speech: the emulator mic yields noise/silence; transcription downstream not exercised.
- Reply playback inside the app (poll + auto-play of a `replies/` object): not exercised; only the "sound on" unlock state seen.
- Play Store / internal testing: nothing uploaded; versionCode 8 / 0.2.6-internal is unchanged and already consumed there,
  so shipping these fixes needs a version bump through mobile-deploy-hub.
- Honda landscape 1280x720 layout: seen in verification round 2 (`r2-*.png`); only the round 1 PNGs are the 800x1280 portrait override.
- Custom Tabs / link viewer path is irrelevant now (in-app WebView) and was not tested.
- Honda "Connect the Device" system dialog on first launch is Honda image behaviour, not ours.

## Checks

`./gradlew --max-workers=1 testDebugUnitTest lintDebug assembleDebug`: BUILD SUCCESSFUL (lint abortOnError clean).
`python3 -B -m unittest discover -s tools/tests`: 44 ran, OK (4 skipped). `apps/agent-pad`: `tsc --noEmit` clean, `vite build` ok,
rebuilt `dist` is what agent-pad.delo.sh serves.

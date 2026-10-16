# Driving mode and steering-wheel control: sim proof and review

Date 2026-10-16. Build under test: `a76492d` (driving mode), `4dd894a` (first review fixes) and the second-round fixes listed
under "Review round 2" below (note survives backgrounding, native reply player, and the cheap minors). Target: Honda IVI
emulator `HOLOC_9_Honda_API33` (`emulator-5554`, Android 13, **user build**, 1280x720), app user 10, installed with the
Play installer of record (`-i com.android.vending`). Screenshots are in [`driving/`](driving/).

Short version: on the sim the pad stays up while the car moves, five agents and the record toggle work from keys alone,
a memo recorded entirely by keys went through the whole pipeline and its reply played on the pad. What nobody can
prove outside the Civic is which physical wheel buttons reach Android at all.

## Proven on the sim

| # | Claim | Evidence |
| --- | --- | --- |
| 1 | Parked layout: tabs, five tiles, record button. | `driving/01-parked.png` |
| 2 | Parked to driving (emulator gRPC `sim_drive.sh drive`: gear D, 13 m/s): `Host UX requiresDO=true, mask=511` (fully restricted). The OS does **not** replace our activity: `topResumedActivity` stays `io.automaticai.holocene/.MainActivity`, tabs vanish, the page switches to the driving layout. | `driving/02-driving.png`, `dumpsys activity activities` |
| 3 | **Negative control.** The same APK installed with no installer (`adb install`) is swapped for `com.android.systemui/.car.activity.ActivityBlockingActivity` ("You can't use this feature while driving") the moment the car moves. So the distractionOptimized tag is only honoured from a trusted installer on this image, exactly as researched. Restored with `-i com.android.vending` afterwards. | `driving/13-sideload-blocked-while-driving.png` |
| 4 | Agent selection by key while driving (`sim_drive.sh key next/prev` = `cmd car_service inject-key`, which goes through Honda `VehicleInputService`): selection moves with wraparound, the host speaks the name (logcat `HoloceneWheel: say "Grolf"`, `say "Holocene"`; Google TTS dispatched). | `driving/03-driving-selected.png`, logcat |
| 5 | Record by key: `key playpause` says "Recording for Holocene.", plays the start tone, then the mic opens (`tone START` 1.4-2 s later); the announcement is never in the memo. Switching agent while recording or arming is refused with an error tone and "Recording. Stop first." | `driving/05-recording.png`, logcat |
| 6 | Whole memo by keys for `holocene-pm`: next, next, playpause, gRPC-injected utterance "Steering wheel test. Please reply with the words wheel works.", playpause again. Spoken "Sent to Holocene". `mise run memo:trace latest`: **COMPLETE in 70.0 s**, memo `de7e0540-fcab-516a-9459-c7c065913c03`, key `inbox/holocene-pm/2026/10/16/20261016T204426Z.ogg`, lane interactive, dispatched, invocation completed, reply rendered (`replies/2026/10/16/204554Z-holocene-pm-de7e0540-....ogg`), **played on the pad** (proxy log `playback started/ended`, UA `IVI-SYSTEM`, 19.6 s after render, 8.3 s). The transcript was "Steering wheel test. Play towards wheel arcs." (flite voice misheard by whisper; the pipeline does not depend on it). Peak -11 dBFS. | `driving/07-after-stop.png`, `memo:trace` |
| 7 | Parked to driving **mid-recording**: the note keeps recording and the layout flips. (Before this feature the restriction cancelled it.) | `driving/09-park-to-drive-recording.png` |
| 8 | Cancel: `key 86` (MEDIA_STOP) while recording discards the note, "Cancelled."; hold NEXT (600 ms, `input keyevent --longpress`, repeat events) toggles recording; MEDIA_STOP with no recording is passed through to the radio (unit-tested, not observed on the sim). | `driving/10-cancelled.png`, logcat |
| 9 | Radio/media: with Agent Pad in front, `dumpsys media_session` shows `Media button session is io.automaticai.holocene/HoloceneWheel`. After HOME the session is gone (`Media button session is null`, stack = `FmMediaSession`, Bluetooth), and an injected `key next` goes through Honda `VehicleInputService.injectInputEvent` with our app not involved. Re-foreground re-acquires it. | `dumpsys media_session` |
| 10 | Key inspector (Diagnostics, parked): next/prev/playpause show on screen, in logcat `HoloceneKeys`, and as `event=wheel_keys` lines in `docker logs agent-pad-upload` ("Uploaded 18 lines" 6 s after the last key; `route=activity` and `route=session` both seen). VOICE_ASSIST (231), CALL, VOLUME never reach the app, as researched. | `driving/11-diagnostics-mapping.png`, `driving/12-key-inspector-lines.png` |
| 11 | Checks (first round): `testDebugUnitTest` 92 tests, 0 failures (re-run clean), `lintDebug` clean (abortOnError), `assembleDebug`, pad `tsc --noEmit`. `android.car` is referenced only in `CarHost.kt` (plus the manifest `uses-library` and `useLibrary`; a comment in `HostUx.kt`). | gradle log |

| 12 | **Round 2, note survives backgrounding.** Driving (mask 511), `key next` (Grolf), `key playpause`: "Recording for Grolf.", START tone, mic open. After 6 s `input keyevent HOME`. Logcat: `HoloceneAgentPad: paused mid-note: stopping and handing the note to the page`, then `tone STOP`, "Recording stopped. Sending.", `tone SENT`, "Sent to Grolf". Proxy: `record_stopped` (26807 bytes, 5414 ms) and `upload` for `inbox/33god-pm/2026/10/16/20261016T211546Z.ogg`, `audio.memo.uploaded`, watcher `discovered` 4.2 s later. Before: no send, no notice, page back at READY. | logcat + `docker logs agent-pad-upload` + `memo:trace 83bee953` (the sim mic heard noise only, so it stops at `empty_transcript`; the point is delivery) |
| 13 | **Round 2, native reply player.** Memo `0713a56c-5a22-53d9-9a36-662b41fb5561` recorded by keys for `holocene-pm` with the gRPC utterance in the same sequence: `memo:trace` **COMPLETE in 60.0 s**, reply `replies/2026/10/16/211827Z-holocene-pm-0713a56c-....ogg` **played on the pad** through the host player (`played_on_pad`: started 13.7 s after render, ended after 3.73 s). `MediaFocusControl`: `requestAudioFocus ... AA=USAGE_ASSISTANT/CONTENT_TYPE_SPEECH ... AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` from `sh.delo.holocene.auto.ReplyPlayer`, `reply focus request ... result=1` (granted), abandoned when the reply ended. No `org.chromium...AudioFocusDelegate` request while the new page was loaded. A "Grolf" announcement landing on a playing reply gave our player `LOSS_TRANSIENT` (-2): it paused and resumed on `GAIN` (+1). | logcat `HoloceneReply`, `MediaFocusControl`, `memo:trace` |
| 14 | **Round 2, no permission dialog while driving.** RECORD_AUDIO revoked, car moving, `key playpause`: tone ERROR and "Microphone permission needed. Open Holocene Auto when parked."; `topResumedActivity` stays our activity (no GrantPermissions dialog). Permission re-granted afterwards. | logcat `HoloceneWheel`, `dumpsys activity` |
| 15 | Checks (round 2): `testDebugUnitTest` 107 tests (+15), 0 failures; `lintDebug` clean; `assembleDebug`; `npm test` in `apps/agent-pad` (9 tests, new `flight.test.ts`); `tsc --noEmit`; `pad:build`. | gradle + npm |

Driving state can be simulated on this user build through the emulator gRPC `CarService` (what `sim_drive.sh` does);
`cmd car_service emulate-driving-state` still throws "requires non-user build". The October finding was too pessimistic.

## What only the real Civic can prove

1. **Which wheel buttons reach Android.** The sim injects through Honda's own `VehicleInputService`, so it proves the app
   handles the keys that arrive, not that the Civic sends them. Expected from the Honda key table (unverified):
   left `<` `>` = MEDIA_PREVIOUS (88) / MEDIA_NEXT (87); possibly FAST_FORWARD/REWIND on hold; F7 for Source. Talk (231), pick-up/hang-up,
   volume, the selector wheel and the whole right side (cruise, lane keeping, cluster) never arrive.
2. Whether the Honda radio source or AutoCore eats NEXT/PREVIOUS before they reach the window or our session (test with the radio playing and with it off).
3. That a Play **internal-testing** install is honoured as distraction-optimized on the production firmware (`allowedAppInstallSources`), the one thing the sim can only imitate with `-i com.android.vending`.
4. Rotary and D-pad: `inject-key` for DPAD/NAVIGATE targets display 0 and `inject-rotary` produced no event in the activity, so those mappings are unit-tested only. The Civic has no rotary anyway.
5. Real-radio ducking and resume after announcements and after a reply.

### In-car steps (about five minutes, parked)

1. Install from Play internal testing (not a sideload; the tab bar shows an orange `SIDELOAD` badge if the source is wrong).
2. Park, open **Diagnostics**, scroll to "Steering wheel control". Check "Install source: com.android.vending".
3. Press every left-wheel button once: `<`, `>`, a long press of each, Source/Mode if there is one, play/pause if there is one. Repeat with the radio playing, then with the radio off (and once with Maps navigating).
4. At the desk: `docker logs agent-pad-upload 2>&1 | grep wheel_key`. `route=activity` means the key reached the window; `route=session` means it came through the MediaSession. No line for a button means Android never sees it.
5. If the useful keys differ from the defaults, use "Learn: ..." in Diagnostics (press the real button) or edit the mapping text (`KEY=ACTION`, `L` prefix = hold). Then drive-test the toggle with the pad in front: short `>` = next agent, hold `>` = record.
6. If nothing arrives, the fallback is touch plus spoken feedback (five big tiles, one giant record target); wheel integration is then blocked by Honda's system-only key services, not by this app.

## Adversarial review

Severity: blocker, major, minor. No blockers found. Status says whether it is fixed in `4dd894a`.

| Sev | Finding | Detail and evidence | Status |
| --- | --- | --- | --- |
| major | A note in progress is silently discarded when the activity is paused. | `AgentPadHost.onPause` tears the page down when the mic is live. Reproduced: recording, HOME, return: no send, no spoken notice, page back at READY. A Maps prompt, a call UI or the Honda Source key mid-dictation loses the memo. | **fixed (round 2).** Backgrounding mid-note stops the recorder and hands the audio to the page, which is left running (not paused). The page now writes every recording to its IndexedDB outbox before the first attempt and deletes it on success, so a kill or a dead network mid-upload still ends in a retry (`InFlight` keeps the retry timer off a live send). The host speaks "Recording stopped. Sending." then "Sent to X" (or "Not sent. Saved, will retry."). Proof: row 12. |
| major | Reply playback takes permanent audio focus. | The WebView `<audio>` requests `AUDIOFOCUS_GAIN` with `USAGE_MUSIC` (`MediaFocusControl: requestAudioFocus ... USAGE_MEDIA, AUDIOFOCUS_GAIN`). A radio app gets a permanent loss and may not resume after the reply. Announcements and tones are fine (transient may-duck, `USAGE_ASSISTANT`; attenuation seen in `AudioFocusControl`). | **fixed (round 2).** `ReplyPlayer` (MediaPlayer, `USAGE_ASSISTANT`, `CONTENT_TYPE_SPEECH`, `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`) plays replies; the page passes the bytes over the bridge (`HoloceneNative.playReply`) and the host answers through `__hnPlayback`. A call pauses it and resumes it, another app taking focus ends it, a nav prompt just ducks it. The silent "unlock" clip is skipped in the host (it also took and kept music focus on every launch). A reply never plays into the microphone: starting a note stops it and it replays after. Browsers keep the `<audio>` path. Proof: row 13. |
| minor | Second wheel press while arming delayed the mic by ~3 s. | `QUEUE_FLUSH` dropped "Recording for X" and its continuation waited for the 4 s fallback: toggle at 41.95 s, `tone START` at 46.25 s, so the first words of the note were clipped. | fixed (`onStop` releases the continuation; re-measured 1.4 s) |
| minor | Key-log lines stranded when the activity pauses. | `onPause` cancelled the 6 s upload timer; pressing a button that opens the car's own UI lost the upload. | fixed (upload on pause) |
| minor | Touch can retarget during arming. | The tile is disabled only while `recording`; during the 1-4 s announcement a tap changes the shown agent while the memo goes to the agent snapshotted at start. The wheel path is locked correctly. | fixed (tiles disabled while arming; `chooseAgent` also ignores taps while recording or arming, which used to reset the phase and emit a bogus `selected`) |
| minor | Short tap read as a hold under lag. | Press length is measured at arrival, not from `KeyEvent.eventTime`, on purpose: Honda's injection stamps `eventTime` in nanoseconds (`eventTime=77860000000`). Observed: a gRPC hw key whose UP arrived 700 ms after DOWN became TOGGLE_RECORD. A laggy head unit (Honda logs a 500 ms pre-dispatch timeout on the first key) can do the same to a `>` tap. Not destructive: it announces and starts a note, the cancel key discards it. | fixed: a hold fires from the system's repeat events at `LONG_MS` (600 ms); a release with no repeat counts as a hold only after `LONG_UP_ONLY_MS` (1100 ms), so lag alone cannot toggle the mic (`aTapWhoseReleaseArrivesLateIsStillATap`) |
| minor | Unselected tile labels are small and dim in the driving layout. | `clamp(20px,3.6vh,32px)` at 50% opacity, about 21 px at 590 px height. The hero already shows the selection at 41 px, so eyes-free use is fine; glanceable use is weaker. | fixed: the pad has a larger, brighter label (24-38 px, 78 % opacity) in the driving layout |
| minor | Wheel keys go to Agent Pad, not the radio, while the pad is in front. | By design: the MediaSession gives the car's media-button route to the pad while resumed, released in `onPause` (proven, item 9). Mitigation is the Diagnostics toggle (parked only). | accepted |
| minor | TTS stutter on a fast rotary spin. | Select debounce 150 ms (scroll 120 ms), each accepted step flushes and re-speaks the name; a long spin chatters then settles on the final name. Does not queue up. The Civic has no rotary. | open (the Civic has no rotary) |
| minor | Mic permission asked while driving if it was refused while parked. | `startFor` falls back to `requestPermissions`; the dialog is a setup flow (NO_SETUP). | fixed: with the permission missing while driving, the host speaks "Microphone permission needed. Open Holocene Auto when parked." and shows no dialog (row 14); the WebView path denies too |
| minor | Key inspector noise. | In Diagnostics every unconsumed media key is logged twice (`activity`, then `session`), and the "session held" line is stale after render. | fixed: the same key arriving by the other route within 120 ms is logged once (`KeyRouteDedupe`); the "session held" line refreshes on every wheel sync |
| major (found in round 2) | A note that ended on its own (5-minute cap, or backgrounding) left the wheel locked. | The page only told the host `stopped` when the driver pressed stop, so `DriveControls.recording` stayed true and next/prev answered "Recording. Stop first." for good. | fixed: the page emits `stopped` (reason `auto`) whenever a note ends without the driver's stop, once per note |

Checked and found sound: Diagnostics is unreachable while driving (tabs `GONE`, `showView(false)` refused, `applyMode` returns to the pad, fixture
probes and diagnostic intents guarded by `unrestricted`); an unknown or disconnected car host fails closed to the driving layout;
restriction changes no longer cancel a pad recording; the 5-minute recorder cap auto-stops and sends; wheel selection is refused while recording or arming
and the memo target is snapshotted at start; unmapped keys, VOLUME, HOME, BACK, CALL and VOICE_ASSIST are never swallowed; UP is consumed with DOWN; the
phone build is unaffected (no car host: parked layout, no session, speech only after wheel use).

Play policy reminder: a non-driving-category app with a distractionOptimized activity is rejected in open testing and production
(quality criteria DD-2 and DD-3). Keep this build on internal or closed testing and drop the meta-data before any wider release.

## Review round 2

Both majors and every cheap minor are fixed at the root with tests; what remains open is the rotary TTS stutter (no rotary on a Civic) and
the accepted wheel/radio trade-off. Things still only the Civic can show: which buttons reach Android, radio resume after a reply (the sim has
no real radio), and that a Play-installed build is honoured as distraction-optimized on production firmware. During this round another
workflow force-stopped and relaunched the app on the same sim every minute or so; each claim above was taken in a single uninterrupted
sequence, and the page's own localStorage (selected agent, last-played reply) does not survive a force-stop there, so a recent reply replays after each relaunch on the sim.

## Environment notes

The sim was shared with the silent-mic workflow, which relaunched the app and restarted the emulator several times during this run (a
windowed start while a headless one was still alive hung on a crash dialog and had to be killed). Evidence was therefore collected in short
bursts; every claim above was observed in a single uninterrupted sequence. The sim is left windowed, parked, with Agent Pad open.

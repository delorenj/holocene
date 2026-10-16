# Silent microphone: end-to-end proof and adversarial review

Date: 2026-10-16. Simulator `emulator-5554` (Honda IVI API 33), app `io.automaticai.holocene` v10 / 0.2.8-internal (debug), user 10.
Builds on `17bcf7e` (watcher, schemas, /voice), `d72040d` (device meter, hold-back, proxy, `auto:sim:mic-check`).

## Incident being closed

Memo `394125ca-cc67-5db1-b016-aa21816bbb7a` (6.38 s, holocene-pm) showed "Failed at transcribed: empty_transcript" 47 s after it
was recorded. The audio was digital silence (volumedetect mean -83.3 dB, max -73.4 dB): the emulator's PulseAudio capture
streams were CORKED. Nothing on the journey said "the microphone is dead" until someone dug.

## Proof

### 1. Healthy mic, normal memo: COMPLETE with levels on every hop

`mise run auto:sim:mic-check` -> `OK (rms 358.6 peak 4492)` on the freshly started windowed sim.

A known utterance ("Silent mic fix test. Please reply with the words levels look good.", flite kal16, 4.4 s) was routed to the
guest mic and recorded for Holocene from the pad (memo `e3c3ebbc-64a5-5826-9520-facf73048684`). `mise run memo:trace e3c3ebbc`:

```
OK  fact:uploaded     37082 bytes ... | device heard peak -10 dBFS, rms -19 dBFS
OK  fact:received     watcher saw it, lag 2314ms
OK  fact:transcribed  59 chars in 49.99s (large-v3), audio max -10 dBFS, mean -33 dBFS over 9.2 s: 'Side MIG fix test, please reply with words levels look good'
OK  audio_level       max -10 dBFS, mean -33 dBFS over 9.2 s  -> audible | device heard peak -10 dBFS, rms -19 dBFS
OK  fact:dispatched / agent:invocation.started / .done / fact:replied / reply_object
OK  played_on_pad     reply started 8261 ms after it was rendered
VERDICT  COMPLETE in 71.0s; played on the pad 8.3s after the reply was rendered
```

`/api/modules/voice/memos/e3c3ebbc...`: `status complete`, `audio {maxDbfs -10.3, meanDbfs -33.2, silent false}`,
`capture {peakDbfs -10.3, rmsDbfs -19.3, silent false}`; the uploaded hop reads "device heard peak -10 dBFS, rms -19 dBFS", the
transcribed hop "11 words · 49.99 s · large-v3 · max -10 dBFS · mean -33 dBFS · audible".
Device and watcher agree on the peak to 0.0 dB (-10.3 both). Screenshots: `silent-mic/03-normal-recording-meter.png`,
`silent-mic/04-normal-sent.png`.

How the speech was injected: NOT through gRPC `injectAudio` (it crashed the emulator again, twice in total now). A PulseAudio
null sink was created, the guest's qemu source-output was moved onto its monitor after recording started, and the wav was
played into it. See the pitfall in `apps/auto/DEV.md`.

### 2. Silent path (reversible: `adb -s emulator-5554 emu avd hostmicoff`, no injection)

Record for Holocene with the host mic off:

- Pad, 4 s in: orange "No sound yet - speak up or check the mic" under the meter (`silent-mic/01-no-sound-yet-warning.png`).
- Stop & Send: nothing is uploaded. The pad shows "No sound reached the microphone - nothing to send / The recording is digital
  silence (peak -72.2 dBFS). Check the mic, then record again." with a small "send anyway" link
  (`silent-mic/02-held-back-no-sound.png`).
- Memo `0db0320c-f17c-5250-9c27-0f3ff0d7df7f`. Proxy: `record_silent` with peak -72.2 / rms -72.3 and the failed fact published.
  `memo:trace`: `VERDICT STOPPED AT record: silent_capture: no sound reached the microphone (peak -72.2 dBFS, threshold -60)`.
- /voice (before the fix below): stage label "Unknown". After the fix: "Silent microphone", capture chip red.

"Send anyway" (memo `32bef27c-f2ec-5432-836f-5e70c1b108a9`, same dead mic): the pad uploads with `sent_anyway: true`; the watcher
measures it 0.6 s after `received` and fails it 1.4 s later without spending a transcription:

```
FAILED audio_level  max -68 dBFS, mean -78 dBFS over 6.1 s -> SILENT | device heard peak -72 dBFS, rms -72 dBFS
VERDICT STOPPED AT transcribe: SILENT MICROPHONE - recording is silent (max -68 dBFS, mean -78 dBFS over 6.1 s): the microphone delivered
no sound; on the simulator run `mise run auto:sim:mic-check`, in the car check the mic permission and mute [device heard peak -72 dBFS, rms -72 dBFS]
```

/voice: "Silent microphone", `audio {maxDbfs -68, silent true}`, `capture {peakDbfs -72.2, silent true}`. `hostmicon` restored afterwards.

### 3. The original memo

`mise run memo:trace 394125ca`: `VERDICT STOPPED AT transcribe: SILENT MICROPHONE - recording is silent (max -73 dBFS, mean -83 dBFS over 6.4 s) ...`.
/voice: `stageLabel "Silent microphone"`, `audio {maxDbfs -73.4, meanDbfs -83.3, durationSeconds 6.38, silent true}`.

## Adversarial review

### Threshold vs real speech (checked, no change)

All 17 objects in the `holocene-auto` inbox bucket, measured with ffmpeg volumedetect (max / mean dBFS):

| kind | max | mean |
| --- | --- | --- |
| 14 real recordings (phone, Honda sim, injected) | -0.0 to -13.7 (quietest -13.7) | -16.7 to -36.5 |
| dead mics: `20261015T212137Z` (-68.0 / -78.0), `20261016T194421Z` (-73.4 / -83.3), `20261016T194742Z` (-74.7 / -83.3) | -68 to -75 | -78 to -83 |
| today's injected memo `20261016T204206Z` | -10.3 | -33.2 |

The -60 dBFS line sits 46 dB under the quietest real speech and 8 dB above the loudest dead mic. A noisy cabin raises the floor, it
does not lower speech peaks, so cabin noise cannot push a real note under the line (and noise makes a dead mic look "alive",
not the other way round). The device's native peak (`getMaxAmplitude`) and the watcher's ffmpeg peak agree within 4 dB on dead
mics (-72.2 vs -68) and 0 dB on speech.

### Defects found and fixed in this pass

1. **/voice labelled a device-held silent recording "Unknown"** (`apps/api/src/voice-memos.ts`). A `silent_capture` failure
   (stage `record`) arrives with no uploaded fact, so no hop had "happened" and the label fell through to "Unknown" in the list and
   the header. Now "Silent microphone". Test added.
2. **"Send anyway" left the memo permanently failed in /voice and in `memo:trace`.** The pad's non-retryable `silent_capture`
   stayed the terminal failure of the uploaded hop even after the recording was uploaded and the watcher took over, so a note
   sent anyway (the escape hatch for a device false-positive) could complete and still read "failed". A `silent_capture`
   is now superseded by any later uploaded fact (`voice-memos.ts`, `memo_trace.py`); any other terminal failure still wins.
   `memo:trace` also names the held-back case ("STOPPED AT record: SILENT MICROPHONE ... nothing was uploaded"). Tests added on both sides.
3. **`auto:sim:mic-check` misdiagnosed an emulator with no host audio at all.** A sim started from an agent shell (no
   `XDG_RUNTIME_DIR`/X cookie) logs "Could not init `pa' audio driver" or falls back to `qemu-system-x86_64-headless`; the guest gets
   exact zeros, no qemu stream exists, and the verdict said "passthrough is off -> hostmicon", which can never help. It now reads the
   emulator log and process list and says the emulator has no host audio and must be started from a desktop shell. Seen live today:
   another session's headless restart produced exactly this. Test added; `apps/auto/DEV.md` updated.

### Checked, no defect

- **Meter / timer leaks after stop.** `NativeRecorder` removes the sampler callback in `stop()` (and `cancel()` goes through
  `stop()`), the sampler also exits when `rec == null`, `start()` cancels any previous note first, and the `Handler` is the main
  looper so `stats` is only touched on the UI thread (every bridge call is `runOnUiThread`). The browser path clears its 50 ms
  interval and closes the `AudioContext` in `stop()`, which `mr.onstop` always calls. 13 `CaptureLevelTest` cases and the rest of
  the unit suite pass.
- **Silent check vs the IndexedDB outbox.** The hold-back sits before `sendRecording`, and `sendRecording` is the only place that
  enqueues to the outbox. A normal recording still gets the retry/outbox path and now stores its `capture` so a retried upload
  carries the header too; a held-back silent recording was never going to be retried (non-retryable, nothing in the outbox), and
  "send anyway" goes through `sendRecording`, so it is retried like any other.
- **Schema back-compat.** The new fields are optional (`required` unchanged; the only new `required` lists are inside the optional
  `capture` object). All 135 live `audio.memo.*` facts in the collection, old shapes and new, validate against the changed schemas
  (jsonschema). `/voice` keeps the old label for memos from before levels existed (test).
- **`mic-check` and the physical phone.** Every adb call goes through `adb -s emulator-5554` with the SDK adb binary
  (`SERIAL`/`ADB` constants); there is no unscoped adb call and no `/usr/bin/adb`. It does `am force-stop`/`am start` on the app, so
  it interrupts a note being recorded on the sim.
- Tests: `mise run memo:test` (watcher 41, upload-proxy 27), `pnpm test` in the API (65, incl. 2 new), `apps/auto/tools` python tests (60, 4 skipped, incl. 1 new),
  `./gradlew testDebugUnitTest lintDebug` green, both typechecks green.

### Open risks, and what was done about them (follow-up pass, same day)

1. **`getMaxAmplitude` on the real Civic is unverified: FIXED so it cannot matter.** The pad's silence verdict is now policy in
   `apps/agent-pad/src/capture.ts` (`silenceAction`, node tests, `mise run pad:test`): parked and silent -> hold back with "send
   anyway" (unchanged); **driving and silent -> never held back**: the note is uploaded with `sent_anyway: true` and the watcher's
   ffmpeg measurement (ground truth) decides. A car HAL that reports amplitude 0 for every window can therefore no longer swallow a
   note the driver dictates. The driving state is read from a ref at the moment the recording ends (the car may start moving
   mid-note). Proof on the sim, host mic off, `sim_drive.sh drive` (driving layout, `silent-mic/06`, `07`): Stop uploaded the note
   (proxy `upload ... sent_anyway: true`, `record_silent` NOT published), the pad showed SENT, memo `5ccbb641`: watcher
   `silent_audio` 1.7 s after `received`, `memo:trace` verdict `STOPPED AT transcribe: SILENT MICROPHONE ... [device heard peak -72
   dBFS, window avg -72 dBFS]`. Still worth one real note on the head unit to see what `device heard peak` reads on speech.
2. **Device `rms_dbfs` is the RMS of window peaks: RELABELLED, no schema bump.** `/voice` and `memo:trace` now print `window avg`
   (not `rms`) for the device number, so `device heard peak -10 dBFS, window avg -19 dBFS` no longer looks like a second reading of
   the watcher's `mean -33 dBFS`. The wire field stays `rms_dbfs` (the schema description already says it is the RMS of per-window
   peaks).
3. **A recording under 5 windows (about 0.5 s) is no longer called digital silence: FIXED.** `isSilent` returns false when the
   summary carries fewer than `MIN_JUDGEABLE_SAMPLES` = 5 samples, so an accidental double tap is sent (and the watcher judges it)
   instead of raising the "digital silence" banner. Test added.
4. **After every `mic-check` the pad replayed the newest reply and re-published `audio.memo.played`: ROOT-CAUSED AND FIXED, and it was
   not about `mic-check`.** The WebView's `localStorage` is empty after EVERY cold start of the app: with the marker on disk (leveldb
   log inspected over `run-as`), the next page load reads `localStorage.length == 0` and `lastDoneReply` null (checked over the
   WebView devtools socket), so the pad ran its first-run path and replayed everything newer than 30 minutes. Plain
   `am force-stop` + `am start` reproduced it with no mic-check involved, i.e. it also happens at every car ignition. Fix: the
   marker is kept natively. `PadPrefs` (SharedPreferences `pad`, `commit()`, whitelisted key, capped value, JUnit) behind
   `HoloceneNative.getPref/setPref`; the page reads/writes it through `durable.ts` (host first, localStorage fallback in a browser or
   on an old host; node tests). Proof: after the first marker write, three consecutive `force-stop` + `start` cycles produced no
   `playback` events for old replies (only a genuinely new reply played once), where before every start replayed two. The first
   attempt (sending the app HOME before force-stop so Chromium flushes) was wrong twice over: the flush is not the problem, and HOME
   raises the Honda "Connect the Device" dialog so the next probe never recorded; it was backed out.
   **Checked, fine:** IndexedDB (the outbox of unsent recordings) does survive the same cold start: a 5 kB record written over
   the devtools socket was still there after `force-stop` + `start` (database list `agentpad`, `zz_probe`; probe removed afterwards).
   Only `localStorage` is reset, so nothing queued offline is lost by a restart.
5. **`auto:sim:mic-check` came back INCONCLUSIVE after the driving-mode work: FIXED.** A car host reports "restricted" first and
   "unrestricted" about 1.7 s after start, just after the 1.5 s `HOST_SETTLE_MS`; the diagnostic intent was refused in that gap and the
   check timed out after 45 s. `MainActivity.scheduleDiagnosticIntent` now waits (up to 6 s more, 500 ms steps) for the host to
   become unrestricted before refusing. Verified: with the fix `mic-check` ran and correctly reported a REAL stuck stream
   (`SILENT (rms 2.0 peak 2): emulator audio stream stuck (2 corked qemu streams)`), and `auto:sim:stop && auto:sim` ended with
   `OK (rms 105.3 peak 480)`.
6. The gRPC `injectAudio` crash and the stuck-stream-after-a-killed-stream behaviour are emulator bugs we only work around (DEV.md).

## Commits

See `git log` for this file's commit: "review(voice): ..." touching `apps/api/src/voice-memos.*`, `services/inbox-watcher/memo_trace.py`,
`apps/auto/tools/sim_mic_check.py`, `apps/auto/DEV.md` and this evidence directory.

## End state

(Follow-up pass: simulator restarted cold with `auto:sim`, windowed, `mic-check` OK, `hostmicon`, parked, `silent-mic/08-parked-again.png`.)
Earlier pass: simulator running windowed (`qemu-system-x86_64`, not headless), `hostmicon`, `auto:sim:mic-check` = OK, Holocene Auto open on the
Agent Pad, parked layout (`silent-mic/05-final-state.png`). holocene-api restarted with the /voice fix (`/health` ok).

# Time to first response on the Honda sim: round 1 proven end to end, and the overlap audit

Date: 2026-10-20, 20:20-21:10 UTC. Simulator `emulator-5554` (HOLOC_9_Honda_API33), windowed. Debug app from holocene
`main`; version not bumped (0.2.9-internal). Evidence in [`ttfr/`](ttfr/).

## Verdict

1. **Time to first response.** After Stop & Send, the car now speaks in 0.35-0.41 s, not after the agent's whole turn.
   - It says what it heard 7.0-8.8 s after the press.
   - It narrates progress during a long turn.
   - It starts the reply 5.5-6.2 s after the agent finishes, 0.6 s after the first chunk is up.
2. **Overlap (the hard requirement).** The speech queue and the platform logs showed zero overlaps from the start, but
   the speakers did not agree. The emulator's audio output, recorded with a host-clock time on every packet, showed
   the START beep still playing 214-232 ms into both recordings on the build the round shipped, so it failed the
   requirement.
   - Three fixes followed (`2518e43`, `ddbbcc9`, `60b8d5e`), the last one from the findings of an independent code
     review.
   - The final build passes all 6 audit checks on 12 recordings. 6 of them were started while the car was still
     talking. The mic opens 40-293 ms after the beep's last sound.
3. **Not covered by the final build.** The full memos (A2, B, E-H) ran on the intermediate build `2518e43`. The final
   build was checked only with record-then-cancel cycles, and no new memo was sent on it, because Jarad's real car was
   on and playing every test reply (see "Side effects" below). The server side is unchanged since those memos. The
   final build changes three things: when a sound counts as ended, how long the next sound waits after one is cut
   (350 ms), and when the mic opens. The cycles and the unit tests cover those changes; a reply or progress clip
   arriving on the final build has not been exercised on the sim.

## Preconditions

| check | result |
|---|---|
| sim windowed, latest debug app | `mise run auto:dev` (HEAD `ba31772`); later the fix builds, installed the same way |
| `mise run auto:sim:mic-check` | first `SILENT (8 corked qemu streams)`. `auto:sim:stop && auto:sim` gave `OK (rms 25.9 peak 102)`; host mic then disabled for clean gRPC injection |
| watcher | `holocene-inbox-watcher.service` active |
| gateway lanes | `bloodbank-hermes-gateway` and `-interactive`: ack_pending 0, both pulling |
| clocks | sim clock = host - 1293 ms (3 adb samples, rtt 10-17 ms); all tables below are host/UTC |

Instruments:
- **Speech queue:** `adb logcat -v epoch`, tag HoloceneSpeech (every decision), HoloceneWheel and HoloceneReply.
- **Platform:** the OS's active recording configurations (`dumpAudioRecordingConfigurations`) and the Honda HAL's
  `MM_AF,AMP startMixing/stopMixing`.
- **Speakers:** new `apps/auto/tools/sim_audio_tap.py` records the emulator's audio output through gRPC
  `streamAudio`, with each packet's epoch time.
- **Server side:** `mise run memo:trace` and Candystore.
- **Memo input:** the memo phrase was injected over gRPC in parts of 5 s or less (flite `slt`).

## The memos

| memo | id | how | build | what it shows |
|---|---|---|---|---|
| A | `6c295765` | parked, tap | old (`ba31772`) | timeline, then the overlap torture: memo C recorded over A's progress |
| C | `c77a967a` | parked, tap, held 25 s | old | recording while A's progress and reply arrive; C's reply arrives while A's plays |
| A2 | `cacc736b` | parked, tap | `2518e43` | **clean parked timeline** |
| B | `a99d8749` | driving, wheel `playpause` | `2518e43` | **clean driving timeline** and screenshots of the status line |
| E, F | `c033a752`, `946ce7c4` | driving, wheel, back to back | `2518e43` | spoken progress (F); echo and ack contention |
| H, G | `7fc81a3f`, `0c7effbf` | driving, wheel, back to back | `2518e43` | G's progress arrives during H's 34 s reply; G's reply arrives while H's plays |

All memos went to holocene-pm. The phrase for A and A2 was "Timing test. Check the current date with a shell command
and look at the holocene board, then tell me in two sentences what you found." The full timelines are in
[`ttfr/timelines.md`](ttfr/timelines.md) and the traces in [`ttfr/traces/`](ttfr/traces/).

## Time to first response

Each step is timed from Stop & Send (the adb input). "Audible" means the first packet above silence in the speaker
capture.

| step | A2 parked | B driving | baseline (6 memos, Oct 19-20) |
|---|---|---|---|
| ack audible ("Got it, Holocene's on it.") | **+0.40 s** | **+0.35 s** | none |
| upload fact | +0.30 s | +0.22 s | < 2 s with pickup and dispatch |
| transcribed | +7.49 s | +5.61 s | 5-6 s (21-43 s on CPU) |
| heard echo audible ("Holocene heard: ...") | **+8.84 s** | **+7.00 s** | none |
| agent turn | 11.5 s | 16.6 s | 102-231 s |
| progress | none: both turns ended before the 15 s narration threshold | none (same) | none |
| agent done | +19.26 s | +22.46 s | |
| reply chunk 1 up | +24.13 s (agent done +4.9 s) | +28.06 s (+5.6 s) | the full reply only, after TTS of 8-19 s |
| **reply audible** | **+24.76 s (agent done +5.5 s)** | **+28.69 s (+6.2 s)** | agent done + 8-19 s TTS + 0.9-8.4 s car lag |
| chunk up to audible on the car | 0.63 s | 0.62 s | 0.9-8.4 s after the replied fact |
| reply ended | +41.25 s (2 chunks) | +53.76 s (3 chunks) | |

**Spoken progress** came from memos with longer turns:
- **Memo F** (35 s turn): the agent's line 2 was published at +23.8 s, its clip was up at +28.4 s, and it was audible
  at +30.9 s. It waited 2.0 s behind F's own echo.
- **Memo A** (19.7 s turn): the clip was up at +25.2 s while recording C was open. It was deferred, then dropped
  when A's reply came.
- **The tile line** stays still. The clock text updates once a second and nothing animates.
  - Parked: "Transcribing 0:01", then "Working 0:18 · I'll load the repositor...".
  - Driving: "Working 0:06" and "Working 0:22". The narration text is left off on purpose while driving
    (`statusLine(..., maxProgress = 0)`).

**Compared with the baseline:**
- The first sound now comes 0.35-0.41 s after Stop & Send. Before, nothing played until the reply, about 2-4.5
  minutes later for the baseline's turns.
- A long reply now starts about 5-6 s after the agent finishes. Before, it waited for the whole 8-19 s render plus
  the car's lag.
- The agent's turn itself is unchanged, and it is still most of the wait. My test turns (11-35 s) were much shorter
  than the baseline's 102-231 s, so the totals above are not like for like; the plumbing deltas are.

## Overlap torture (memos A, C, E-H)

All lines below are queue decisions from HoloceneSpeech, in sim-clock epoch seconds, from
[`ttfr/speech-logcat.txt`](ttfr/speech-logcat.txt).

1. **Progress arrives during a recording.** It is deferred, then dropped once its memo is final. Nothing plays until
   the mic closes.
   ```
   1792527953.897 mic recording
   1792527958.227 deferred progress id=progress:6c295765:1 reason=recording
   1792527960.484 drop progress id=progress:6c295765:1 reason=memo_final
   1792527978.717 mic idle
   ```
2. **A reply is up during a recording.** A's chunk 1 was up at 20:26:05 while C was recording until 20:26:20. The
   page offered it only after the mic closed:
   `978.929 queued reply 202600Z-...-6c295765 reason=behind_ack`, then `981.143 start reply`.
3. **A reply arrives while another reply plays.** C's reply waited behind A's and started 63 ms after A's ended
   (`997.288 end reply 6c295765`, `997.351 start reply c77a967a`). The same happened with G behind H
   (`880.231 end`, `880.303 start`). A reply from the real car's 33god-pm memo also queued on the sim.
4. **Progress arrives during a reply.** G's clip queued while H's 3-chunk reply played. It never interrupted the
   reply, and it was dropped when G's reply landed:
   ```
   1792528846.357 start reply 204026Z-...-7fc81a3f (chunk 1)
   1792528848.368 queued progress id=progress:0c7effbf:1 reason=behind_reply
   1792528874.898 drop progress id=progress:0c7effbf:1 reason=memo_final
   1792528880.231 end reply 7fc81a3f chunks=3
   ```
5. **Contention on the echo and the ack.**
   - F's echo waited behind E's reply, and G's echo waited behind the 33god-pm reply (`waited_ms=14225`).
   - F's ack waited 4.2 s behind E's echo, because the echo outranks the ack.
   - G's ack was dropped as expired after 6 s behind H's echo and a reply. That is the designed rule: an ack is never
     said late.
6. **Arming cuts what is playing.** E's ack and H's ack were halted by the next recording's arming
   (`halt ack reason=recording`).

## The overlap audit

`apps/auto/tools/speech_overlap.py` checks three independent sources: the queue, the OS, and the speakers.

| # | check | source |
|---|---|---|
| 1 | two queue utterances overlap | HoloceneSpeech start/end/halt |
| 2 | an utterance (the arming prompt included) inside a recording window | queue vs the app's mic state and the OS's active capture |
| 3 | the HAL mixing our assistant source while the OS has a capture running | Honda `MM_AF,AMP` vs `dumpAudioRecordingConfigurations` |
| 4 | sound on the speakers while the mic is open | speaker capture vs the app and OS windows |
| 5 | sound with no utterance that could own it (speech outliving its end) | speaker capture vs queue |
| 6 | a sound still running into the next utterance (no silence before the next one's own sound) | speaker capture |

Checks 2-4 forgive 30 ms at each end of a recording window: two processes log the same moment a few ms apart, and the
speaker capture is lined up by a measured clock offset. Any overlap further inside the window fails, however short.

To rerun:

```bash
E=_bmad-output/implementation-artifacts/agent-pad-auto/ttfr
zcat $E/speaker-tap.jsonl.gz > /tmp/tap.jsonl
python3 apps/auto/tools/speech_overlap.py --logcat $E/speech-logcat.txt --tap /tmp/tap.jsonl --offset-ms -1293 --from <T> --to <T>
```

| build | window | result | file |
|---|---|---|---|
| old `ba31772` (Round 1 as shipped) | memos A + C, 2 recordings | **FAIL check 4**: the START beep was still on the speakers 184-202 ms past the tolerance (raw 214-232 ms) into both recordings. Checks 1-3 PASS: the queue and the platform logs could not see it | [`overlap-1`](ttfr/overlap-1-old-build-memos-A-C.txt) |
| `2518e43` (tone ends when its last frame is reported presented) | memos A2-G, 6 recordings | **FAIL check 4**: 4 of 6 recordings caught 5-65 ms (raw 35-95 ms). Presentation timestamps ran 65-171 ms ahead of the sim's speakers | [`overlap-2`](ttfr/overlap-2-presented-only-memos-A2-B-E-F-H-G.txt) |
| uncommitted, 200 ms settle | 6 record-then-cancel cycles | **FAIL check 4**: 2 of 6 caught 2-14 ms (raw 32-44 ms). The sim's unreported latency grew to 263 ms over the session | [`overlap-2c`](ttfr/overlap-2c-settle200-cycles.txt) |
| `ddbbcc9` (300 ms settle) | 8 cycles | PASS on all 6 checks; mic 42-228 ms after the beep's last sound | [`overlap-3`](ttfr/overlap-3-settle300-cycles.txt) |
| **`60b8d5e` (final, after review)** | **12 cycles, 6 of them recording over "Cancelled."** | **PASS on all 6 checks, ZERO OVERLAPS. Mic 40-293 ms after the beep's last sound; a cut cue had 273-381 ms of silence before the prompt** | [`overlap-4`](ttfr/overlap-4-final-build-cycles.txt), [`beep-to-mic`](ttfr/beep-to-mic-final-build.txt) |

### What was wrong, and the fixes

- **Earcons ended on a timer.** A tone was declared over at `play()` plus its length plus 40 ms. The output path is
  ~0.3 s, so the START beep always sounded into the first ~0.2 s of the recording. Now a tone ends when AudioTrack
  reports its last frame presented (`SpeechTail.ToneEnd`). Without timestamps, or with timestamps that stall, the
  fallback is its length + 600 ms.
- **The mic needs more than the presented report.** On the emulator, the host audio path adds up to 263 ms that the
  HAL does not report. After the arming prompt, the mic waits 300 ms on the emulator and 150 ms on hardware
  (`SpeechTail.micSettleMs`). The hardware value is short on purpose: a deaf mic right after the beep would lose the
  driver's first word.
- **With no prompt** (spoken feedback off), the mic waits until nothing has sounded for 450 ms
  (`SpeechArbiter.quietLeftMs`). That covers a clip that was just halted and one that just ended.
- **A sound cut off mid-play kept draining.** Now the next utterance, the arming prompt included, waits 350 ms
  (`SpeechArbiter.HALT_DRAIN_MS`). Before the fix, a cut ack still sounded 319-327 ms into the prompt, leaving only
  20-50 ms of silence before the prompt's own speech. Now there are 273-381 ms.
- **The TTS 4 s guard moved on while the engine was still speaking.** B's echo took 4.45 s
  ("Holocene heard: Driving timing test, check the date with a"), longer than the 4 s guard. The guard now waits
  while the engine is speaking and cuts it at 10 s, which is under the 15 s arming watchdog. A silent engine still
  releases at 4 s.
- **A tone that failed leaked its focus and track.** The radio stayed ducked. It now releases both.

**Independent review.** I ran a separate code-review pass on `2518e43` and `ddbbcc9`. It found 10 issues. Nine are
fixed in `60b8d5e`:
- the drain after a clip that ended rather than was halted;
- the TTS wait being longer than the arming watchdog;
- the settle applied to every tone instead of only before the mic;
- one fixed settle for every device, now split into emulator and hardware values;
- the 1.5 s fallback for stalled timestamps;
- the leak when a tone fails;
- a delayed mic open not tied to the live `arm()`: now an arm sequence token, and the quiet-time rule lives in the
  pure, tested arbiter;
- the audit's tolerance applying to the whole window instead of its ends;
- the missing check for one sound running into the next (now check 6).

The tenth, the tap tool duplicating `emulator_audio` helpers, is only partly addressed: the tap now writes its sample
rate on each packet for the audit. One suggestion was not taken: scheduling a tone's end from `stamp.nanoTime`
instead of polling every 20 ms.

**Tests.** 173 JUnit tests pass, including `SpeechTailTest` and new arbiter tests for the drain, a deferred prompt
and quiet time. Several existing arbiter tests now step through the drain.

## Caveats and open points

- **Hardware is unverified.** The 150 ms hardware settle is a judgment call, not a measurement. Verify it on the real
  car once the next Play release ships this code: the car's app is still older than speech bridge v2, so it has no
  chunks and no `SpeechTail`. The HoloceneWheel line `tone START out after ... presented=` shows whether the car has
  timestamps.
- **The sim's speakers are approximate.** The capture is the emulator's host-side output, and its latency drifted by
  ~70 ms over 90 minutes. The 300 ms emulator settle covers what I measured.
- **Short turns never narrate.** Progress is spoken only from 15 s into a turn, at most once per 30 s. Every A-style
  test turn finished before that.
- **Contention costs the ack.** When the previous memo's echo or reply is playing, the new memo's ack waits behind it
  (up to 4.2 s observed) or is dropped after 6 s. A one-second "beep, then the ack" would be a possible follow-up.

## Side effects

- **Eight real memos to holocene-pm** (A, C, A2, B, E, F, H, G). Their replies were mirrored to the Earshot phone
  channel and played on the S26.
- **Jarad's real car played the test replies.** The car (Android 12, build `ACB1211S1`) opened its push stream at
  20:36:19 UTC. It then caught up on the whole day's reply backlog in order, from an 18:52 test reply of an earlier
  round to every one of mine, because every pad plays every reply in `replies/` after its last-played marker. The sim
  in turn played the car's 33god-pm replies.
  - Once I saw this, I stopped sending memos. That is why the final build was proven with record-then-cancel cycles,
    which upload nothing.
  - Before the next sim test, decide whether test replies should reach the car at all (a per-device or per-sender
    filter), and whether a car starting up should play a backlog that is hours old.
- **The sim is left running**: windowed, parked, app open, Holocene selected.

## Screenshots

| | |
|---|---|
| ![parked transcribing](ttfr/shots/01-parked-a2-transcribing.png) parked, A2 sent: tile "Transcribing 0:01" | ![recording C](ttfr/shots/02-parked-recording-C-while-A-works.png) recording C while A works: "Working 0:18 · I'll load the repositor..." |
| ![driving recording](ttfr/shots/05-driving-b-recording.png) driving, B recording (wheel) | ![driving working](ttfr/shots/06-driving-b-working-0-06.png) driving: static "Working 0:06" |
| ![driving working 22](ttfr/shots/07-driving-b-working-0-22.png) the same line 16 s later, only the clock text changed | ![driving reply](ttfr/shots/08-driving-b-reply.png) driving: banner REPLY while the reply plays |
| ![parked reply](ttfr/shots/03-parked-a2-playing-reply.png) parked: "playing reply" | ![left parked](ttfr/shots/09-left-parked-app-open.png) left parked, app open |

## Files

- Tools (committed): `apps/auto/tools/sim_audio_tap.py` and `apps/auto/tools/speech_overlap.py`.
- Run helpers (copied here as a record; they expect `/tmp/ttfr` paths): `ttfr/drive_memo.py`, `ttfr/timeline.py`
  and `ttfr/beep_gap.py`.
- Data:
  - `ttfr/speech-logcat.txt`: HoloceneSpeech, Wheel, Reply and NativeRec lines, plus the OS capture and HAL mix lines.
  - `ttfr/speaker-tap.jsonl.gz`: every speaker packet as `{t, n, rms}`, host clock.
  - `ttfr/runs/*.json`: host times of each press and injection.
  - `ttfr/traces/*.txt`: memo:trace output.

# Time to first answer: real-shaped asks on the Honda sim (round 1)

Date: 2026-10-22, 05:06-05:37 UTC. Simulator `emulator-5554` (HOLOC_9_Honda_API33), windowed. The installed debug app is
code-identical to v13: since `3435fa6` only the version lines changed, and the version was not bumped. Server side under
test:
- watcher `4e52756`, `f9c35f5`, `813c3ac`, `1914418`: voice budget prefix, answer-then-background, detach handling,
  `data.model = automaticai/personal/sol-6.1`, warm GPU whisper;
- gateway bloodbank `eac6bb0`: detach at the 300 s wall clock, per-turn `data.model`.

I changed no code and no config, and restarted nothing. Evidence is in [`ttfa/`](ttfa/).

Memo input went through the PulseAudio null sink (`holo_testmic`, `paplay`), never gRPC injection. Every phrase was
rendered by vox (`ttfa/tools/synth.py`) and driven by `ttfa/tools/drive.py`, which taps Record, plays the phrase and taps
Stop & Send. Every memo went to holocene-pm.

## Verdict

1. **Short question (A).** The first spoken answer came 24-77 s after upload. Before, it came after a median of 184 s,
   and one ask in 8 was never answered.
   - Transcription takes 0.44-0.57 s on the GPU server, and the command is dispatched 1.8-2.8 s after upload.
   - The agent turn is now most of the wait: 14-68 s on Sol, with 2-3 model calls.
2. **Long job (B).** The driver heard a quick answer at +43.7 s. The full result came later as a follow-up on the batch
   lane, in the same session.
   - There was one interactive turn and one background turn, with no kill and no re-run.
   - The follow-up itself was slow (spoken at +839 s), because its `delegate_task` ran synchronously on
     `auto/subagent`. That is the next lever (see Findings).
3. **Past the wall clock (C).** Two inline jobs (sleep 170 twice) detached at exactly 300 s and kept running.
   - Each finished in its own single turn, at +363 s and +365 s, with 3 Sol calls, no `/stop`, no batch re-run and no
     "Continuing…".
   - Each answer was spoken as a late reply: C3's on the car, and C2's on the phone, because the car's link was down
     (point 5).
   - **The slot is freed.** With both interactive slots held by C2 and C3, memo D1 waited in the stream. Its turn
     started **57 ms after C2 detached**, while C2 was still running; C2 finished 59 s later.
4. **Overlap audit.**
   - Checks 1-4 and 6 PASS on 47 utterances and 8 recordings. That means no two utterances at once, nothing during a
     recording, and no sound running into the next utterance.
   - Check 5 flags one sound: C3's late reply was still on the speakers 787 ms after its logged end. The allowance is
     700 ms, and 515 ms of silence followed before the next reply.
   - At an 800 ms allowance all 6 checks PASS (ZERO OVERLAPS).
   - The server-side audit, `proxy_overlap.py`, also reports ZERO OVERLAPS.
5. **Delivery fragility under load (not latency).** Under load average 55-60 the sim's push link dropped for up to 45 s
   at a time.
   - Two replies were not claimed by the car within the 20 s grace, so they went to the phone: D1's answer and C2's late
     answer. The S26 played both through the normal Earshot path.
   - On 2026-10-21 the real car's link had no such drops: 12 of its 13 push closes were the normal `max_age` rotation.
     See Findings.

## Before and after

"Before" covers the real car (Android 12, build `ACB1211S1`) on 2026-10-19 to 2026-10-21: 17 asks to 33god-pm,
green-in-between-pm, pile-of-dumb-things-pm and navi-pm. The source is `/tmp/latency-study/breakdown.json` (Candystore
facts plus Hermes `state.db`). "After" is this round: 8 sim memos, all times from the upload (server clock).

The asks are similar in kind but not identical, and the host load average was 55-60 during this round. That load comes
from another session's deliberate TOWE-27 load test (`governor.sh` holds load1 at 56-64), which I left running. CPU-bound
steps are therefore pessimistic here.

| step | before: real car, Oct 19-21 (17 asks) | after: sim, this round |
|---|---|---|
| upload to transcribed | 5.4-6.5 s (large-v3 CLI, GPU, uncontended); 9.2-13.1 s on Oct 21 (`small` on CPU, fast lane); 21.4 s and 43.9 s outliers | **1.4-2.4 s**. Whisper itself took 0.44-0.57 s (large-v3-turbo on the warm GPU server, 8 of 8 memos); the rest is noticing the upload and downloading it |
| upload to dispatched | median 10.0 s (5.9-45.6 s) | **1.8-2.8 s** |
| one model call in a voice turn | GLM-5.3 at max: mean 13.4 s, p90 34 s (Oct 21: mean 15.9 s) | **Sol-6.1: median 5.7 s, mean 8.1 s, max 21.7 s** (18 calls, `model_override applied` on every memo, no fallback in agent.log) |
| short or status ask: first spoken answer | **median 184 s** (120-393 s over 7 answered); 1 of 8 never answered (a 300 s timeout) | **D2 24.3 s, A2 49.2 s, A 77.2 s**. A's transcript said "policy main branch", which cost an extra disambiguation call |
| long job: first spoken answer | **median 247 s** (93-1991 s over 7 answered); 2 of 9 never answered | **B 43.7 s** (quick answer); the full result came as a follow-up at 839 s |
| turn running past 300 s | killed at 300 s and re-run on batch (4 of 17), answered at 393, 538, 1184 and 1991 s; 3 more (Oct 19) never answered | **detached at 300 s**; the same turn finished at +363/+365 s, and the late answer was audible at +369.7 s (C3). **0 kills, 0 re-runs, 0 escalations** |
| a new memo while both interactive slots are busy | waits until a turn ends, or is killed at 300 s | **starts 57 ms after the first detach** (D1) |
| narration while the agent works | (narration already worked: ~25-35 s) | first progress audible at +25 to +36 s (A, B, C3). C2's was rendered at +21.5 s but reached the car at +66 s, after a push-link gap. Heard echo at +2.9 to +9.3 s |

## The asks

| memo | id | phrase (as transcribed) | lane / turns | result |
|---|---|---|---|---|
| A | `cf45c0b9` | "What is the newest commit on the policy main branch, and who wrote it?" | interactive, 1 turn, 3 calls (21.7, 17.8, 10.9 s) | "If you meant Holocene, the latest commit on main is a92c660, authored by Jarad DeLorenzo…", audible +77.2 s |
| B | `203fffe1` | "Check every service, the voice pipeline depends on, list which are healthy, and tell me anything odd. Take your time." | interactive 37 s (quick answer + `BACKGROUND:` plan), then batch follow-up 783 s | quick answer audible +43.7 s; follow-up audible +839.1 s, played to its end (+877.9 s) |
| C1 | `2ed95c43` | (wall-clock test) | none | lost at the car: `MediaRecorder: stop failed: -1004`, `empty_capture` (Findings 2) |
| C2 | `bb5ee4c4` | "Wall clock test. Do this right now in this turn, with no background hand off. Run … sleep 170 … a second time. Then tell me the word finished." | interactive, 1 turn, 3 calls (7.6, 3.5, 1.8 s) + 2 × `sleep 170` | detached +303.0 s; "still on it" audible +306.5 s; done +362.7 s; answer played on the phone at +389.4 s |
| C3 | `14bc97c8` | (same) | interactive, 1 turn, 3 calls (9.8, 4.0, 1.8 s) | detached +302.5 s; done +364.8 s; late answer audible on the car at +369.7 s |
| D1 | `99859e9c` | "Quick one! What time is it on the server?" | interactive; waited in the stream while C2 and C3 held both slots | turn start +119.6 s, 57 ms after C2's detach; done +133.7 s; answer played on the phone at +164.8 s |
| D2 | `652474fb` | (same) | interactive, 2 calls (4.1, 2.8 s) | turn 14 s; audible +24.3 s |
| A2 | `0e9a75fc` | "What's the noobs commit on Holocene and Branch, and who wrote it?" | interactive, 3 calls (12.0, 5.0, 6.0 s) | "Holocene is on main. The newest local commit is a92c660 … Git credits Jarad DeLorenzo", audible +49.2 s |

Each memo's full timeline is in [`ttfa/traces/`](ttfa/traces/) (memo:trace). Every row of its Hermes session is in
[`ttfa/sessions/`](ttfa/sessions/). [`ttfa/runs/timelines.json`](ttfa/runs/timelines.json) is built by
`tools/timeline.py` and maps the car's speech-queue starts and speaker-tap onsets to the server clock. The sim clock was
host -806 to -877 ms, and -845 ms is used throughout.

### A: short question

| step | A | A2 | D2 |
|---|---|---|---|
| Stop & Send to upload | 1.4 s | 1.1 s | 2.3 s |
| transcribed (whisper ms) | +2.3 s (547) | +1.5 s (510) | +2.3 s (462) |
| dispatched / turn start | +2.8 / +2.7 s | +1.9 / +1.8 s | +2.8 / +2.7 s |
| heard echo on the car | +8.8 s | +7.1 s | +3.8 s |
| agent done | +71.0 s | +36.9 s | +16.7 s |
| **first spoken answer audible** | **+77.2 s** | **+49.2 s** | **+24.3 s** |

- **A:** the sim mic turned "holocene main" into "policy main". The agent checked for a `policy` repo before answering:
  one extra call, and an 11.3 s `git` command under load. Its first Sol call took 21.7 s (563 output tokens). The
  provider default effort on Sol is xhigh.
- **A2:** the reply was up 5.6 s after the agent finished, but the car learned of it 4.8 s later, when its push link
  reconnected (Finding 1).

### B: long job, answer then background

- **Quick-answer turn: 36.8 s, 2 Sol calls.** The agent said what it would do and ended with a `BACKGROUND:` plan of 940
  characters, which was never spoken.
  - The watcher dispatched follow-up 1 on the batch lane 0.3 s after the quick answer's replied fact.
  - The follow-up runs on the same thread and session: Hermes session `20261022_011028_a8c9ac02` has 2 user messages and
    no interrupted turn.
- **The quick answer played at +43.0 s** (audible at +43.7 s).
  - My driver then recorded C1 over it (+55.3 s, `halt reply reason=stopped`).
  - It was offered again and played in full at +111.4 to +130.0 s, after the C1 and C2 recordings.
- **The follow-up took 783 s.** 410 s of that was one `delegate_task` call.
  - Hermes' `delegate_task: async delivery unsupported on this session runtime; running the batch synchronously` ran two
    subagents on `automaticai/auto/subagent`, which does not get `data.model`.
  - Those subagent calls took up to 99.9 s each.
  - The follow-up was spoken by the car at +839.1 s. A `focus_denied` halt was retried after 0.5 s, and the 3 chunks
    played to +877.9 s.
- **What it found** (its own report, read-only):
  - no core service down;
  - D1's 117 s slot wait, which this test caused on purpose;
  - the C1 empty recording;
  - `agents.delo.sh` serves 404 for the page;
  - a crash-looping enrichment Dapr sidecar;
  - a title-generation effort error.

### C: past the wall clock, detached

From the gateway journal (`ttfa/lanes-poll.txt`, polled every 2 s; `executions.detached_at`) and the watcher
(`memo_detached`):

```
05:12:07.683  C2 5104db54 interactive started
05:14:49.363  C3 de6cd6fd interactive started          -> interactive ack_pending 2: both slots held
05:15:10.867  D1 bad07460 dispatched                    -> interactive pending 1 (waits in the stream)
05:17:08.061  C2 detached_at (300.4 s after start)      watcher memo_detached; "still on it" queued, audible 05:17:11.5
05:17:08.118  D1 bad07460 interactive started           <- 57 ms after the detach; ack_pending 3 (2 slots + 1 detached)
05:17:22.220  D1 completed (14.1 s turn)
05:18:07.676  C2 completed (detached turn finished, 360.0 s after start; 1 turn, "finished")
05:19:49.772  C3 detached_at (300.4 s)
05:20:43.309  D2 4c442025 started at once (C3 detached, running)
05:20:52.028  C3 completed (362.7 s)
05:20:55.7    C3's late reply starts on the car (start claim 05:20:56.166); first sound on the speakers 05:20:56.9
```

- **Hermes sessions** (`ttfa/sessions/bb5ee4c4.txt`, `14bc97c8.txt`): one user message, `sleep 170` (170.6 s),
  `sleep 170` (170.5 s), then "finished". There is no `/stop`, no "Operation interrupted", and no second user message.
  The watcher logged no escalation: zero `escalat*` and zero `turn_timeout` events.
- **The detach line.** "still on it. I will call you back when it is done." was spoken for C2 3.4 s after the detach.
  - C3's line was rendered at once, but the car received it only after a push-link gap and D2's recording, 48 s late.
  - It was halted 1.6 s later by C3's own reply (`memo_final`), which is the designed rule.
- **Not shown here:** a detached turn hitting the 2700 s ceiling, and a third long turn hitting 300 s while 2 turns are
  already detached (the "old path"). The unit tests cover both. I did not hold the lanes for 45 minutes on a live system.

## Overlap audit

`apps/auto/tools/speech_overlap.py`, whole session (device 1792645580-1792647240, offset -845 ms; also run at -810 and
-880 ms with the same result). Output: [`ttfa/overlap-session.txt`](ttfa/overlap-session.txt).

```
PASS  1 speech x speech (queue): 0 overlaps
PASS  2 speech x recording (queue vs app mic + OS capture, tolerance 30 ms): 0 overlaps
PASS  3 HAL assistant mix x OS capture (tolerance 30 ms): 0 overlaps
PASS  4 speaker output x mic open (tap, tolerance 30 ms): 0 overlaps
FAIL  5 speaker output with no owning utterance (latency 700 ms): 1 overlap(s)
        50 ms  audio speaker output [1792646460.247, 1792646461.271)  x  none no utterance within 700 ms
PASS  6 a sound running into the next utterance (no silence within 700 ms of its start): 0 overlaps
RESULT OVERLAPS FOUND  (47 utterances, 8 app recordings, 8 OS capture windows, 45 HAL mix windows)

--latency-ms 800:
RESULT ZERO OVERLAPS  (47 utterances, 8 app recordings, 8 OS capture windows, 45 HAL mix windows)
```

**The check-5 flag is not two sounds at once.**
- C3's late reply ended (`end reply`) at device 460.484. Its sound ran on the speakers to 461.271, which is 787 ms, or
  87 ms past the allowance.
- D2's reply started at 461.786, after 515 ms of silence.
- No recording was open, and checks 1 and 6 pass.
- This is the same class of flag as the post-v12 round, where the tone path was 19 ms over. Here it is the reply path,
  with the emulator's output latency inflated by load average 55.

**The server-side audit agrees.** It rebuilds the pad's speech events at the upload proxy:
[`ttfa/overlap-proxy-side.txt`](ttfa/overlap-proxy-side.txt) has 47 utterances and 8 mic windows, **ZERO OVERLAPS**.

To rerun:

```bash
E=_bmad-output/implementation-artifacts/agent-pad-auto/ttfa
zcat $E/speaker-tap.jsonl.gz > /tmp/tap.jsonl
python3 apps/auto/tools/speech_overlap.py --logcat $E/speech-logcat.txt --tap /tmp/tap.jsonl --offset-ms=-845 --from 1792645580 --to 1792647240
python3 $E/../ttfr/round2/proxy_overlap.py --since 2026-10-22T05:06:00 --until 2026-10-22T05:34:00 < $E/proxy-events.jsonl
```

## Findings (not fixed in this round)

1. **When the car's link drops for longer than the 20 s grace, the phone takes the reply.**
   - **What happened.** Between 05:00 and 05:37 the sim's push stream closed 34 times: 32 `client_gone` and 2 `max_age`.
     The gaps lasted up to 45 s (05:17:22.9 to 05:18:08.2). A chromium `handshake failed … net_error -101` was logged at
     05:16:03.
     - D1's reply (offered 05:17:27.5) and C2's late reply (offered 05:18:10.9, the same millisecond the stream closed)
       got no car claim within 20 s. The watcher's take was granted to the phone, and the car's later holds were
       refused (`owner: phone`), as designed.
     - A2's reply reached the car 4.8 s late, C2's first progress clip 44 s late, and C3's detach line 48 s late.
   - **Scope.** The real car's link on Oct 21 (19:30-21:30 UTC) had 13 push closes, 12 of them the 180 s `max_age`
     rotation, so this looks like the loaded sim. Still, the 20 s grace has no slack for a link that is reconnecting.
   - **Possible fix.** While the sending car's push stream was live within the last N s, wait for it to come back before
     the phone may take the reply.
2. **One recording was lost on the car side (C1).**
   - The note was started over B's playing quick answer. At Stop the native recorder threw:
     `MediaRecorder: stop failed: -1004` → `HoloceneNativeRec: stop failed: RuntimeException` → `record_failed
     empty_capture`. The pad had reported peak -6.8 dBFS, so there was sound.
   - The same `stop failed` line appears once in round 2's logcat.
   - The next note (C2) took 13.6 s from Stop to upload. Every other note took 0.4-3.2 s.
   - This is Kotlin, so it is a v14 candidate if it shows on the car.
3. **Follow-ups are slow where they delegate.**
   - B's follow-up spent 410 s inside one synchronous `delegate_task`, on `automaticai/auto/subagent` (GLM), with calls up
     to 99.9 s.
   - `data.model` reaches only the parent turn. Two ways to speed it up:
     - `FOLLOWUP_PREFIX` could say "do the work yourself, do not delegate";
     - the delegated subagents could inherit the turn's model.
   - The driver already has the quick answer by then, so this delays only the follow-up.
4. **Sol's first call is still 12-22 s on a fresh voice session** (A 21.7 s, A2 12.0 s, B 12.7 s). Later calls take
   2-11 s.
   - The provider effort on Sol is xhigh. The latency study measured 8.4 s at high on the heavy step.
   - A Sol-specific `extra_body.reasoning_effort: high` entry in the shared Hermes config would cut it. That is
     fleet-config, so it is your call.
   - Sol's weekly pool was about 2% at the start of the night. All 30 Sol calls in this round were served by Sol, with no
     fallback logged in agent.log. That is 18 calls in the voice turns and 12 in B's follow-up.
5. **Sim mic plus STT mangle "holocene".** It came out as "policy" and as "Holocene and Branch", and A spent one extra
   call on the mix-up. The real car's mic path may do better. A vocabulary prompt for agent names in the whisper request
   would help both.

## Side effects and state

- **Memos sent:** 8 real memos to holocene-pm (A, B, C1, C2, C3, D1, D2, A2). C1 failed at the car.
- **Replies on the phone:** D1's and C2's replies were mirrored to the phone (Earshot), and the S26 played them through
  the normal pipeline (Finding 1). I ran no adb against the phone.
- **Interactive lane held:** both interactive slots were held by C2 and C3 from 05:14:49 to 05:17:08 on purpose. The
  real car was not connected: no Android 12 push stream all night.
- **B's follow-up:** it ran read-only checks of the voice services for 13 minutes.
- **Nothing else changed:** no gateway reload, no config edit, no code change. The TOWE-27 load test was left running.
- **Sim:** left windowed, parked, app open, Holocene selected ([`ttfa/shots/09-left-parked-app-open.png`](ttfa/shots/09-left-parked-app-open.png)).
  The qemu capture stream was moved back to the default source before the null sink was unloaded, and
  `auto:sim:mic-check` reports `OK (rms 9.3 peak 41)`.

## Files

- `ttfa/speech-logcat.txt`: HoloceneSpeech, Wheel, Reply and NativeRec lines, MediaRecorder, the OS capture dumps and the
  HAL `MM_AF` lines, device clock.
- `ttfa/speaker-tap.jsonl.gz`: every speaker packet, host clock (`sim_audio_tap.py`).
- `ttfa/watcher-events.jsonl`: the watcher's structured log for the round.
- `ttfa/proxy-events.jsonl`: the upload proxy log (uploads, claims, push, speech, heard).
- `ttfa/lanes-poll.txt`: NATS consumer counts plus gateway journal rows, every 2 s, 05:15:32-05:21.
- `ttfa/runs/`: press times (`runs.jsonl`), `timelines.json`, clock samples.
- `ttfa/traces/`, `ttfa/sessions/`: memo:trace and Hermes session dumps per memo.
- `ttfa/tools/`: `synth.py` (vox phrase to 16 kHz WAV), `drive.py` (tap / paplay / tap), `timeline.py`, `lanes.sh`,
  `sess.py`, `wev.py`, `tails.py`, `logcat_loop.sh`. They expect `/tmp/ttfa` paths.

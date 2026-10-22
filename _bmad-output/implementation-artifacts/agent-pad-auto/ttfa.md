# Time to first answer: real-shaped asks on the Honda sim (rounds 1 and 2)

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
2. **Long job (B): time to the RESULT got worse.** The driver heard a quick answer at +43.7 s, but it was a plan
   ("I'll trace the full voice pipeline, check each dependency's live health and recent errors, and report..."), not a
   result, and progress narration already played at ~25-35 s before this round. The actual result was audible at
   **+839.1 s**: 3.4x the before long-job median of 247 s, and slower than every before long job except the two
   kill-and-rerun outliers (1184 s and 1991 s).
   - There was one interactive turn and one background turn, with no kill and no re-run.
   - The follow-up was slow for two reasons: its `delegate_task` ran synchronously on `auto/subagent` for 410 s
     (subagent calls up to 99.9 s), and its own Sol calls had a median of 27.8 s, max 53.6 s, at 55-120k input tokens.
   - Corrected 2026-10-22 (review): the first version of this doc counted the spoken plan as the answer.
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
facts plus Hermes `state.db`). "After" is this round: 8 sim memos recorded, 7 uploaded (C1 was lost at the car), all
times from the upload (server clock).

The asks are similar in kind but not identical, and the host load average was 55-60 during this round. That load comes
from another session's deliberate TOWE-27 load test (`governor.sh` holds load1 at 56-64), which I left running. CPU-bound
steps are therefore pessimistic here.

| step | before: real car, Oct 19-21 (17 asks) | after: sim, this round |
|---|---|---|
| upload to transcribed | 5.4-6.5 s (large-v3 CLI, GPU, uncontended); 9.2-13.1 s on Oct 21 (`small` on CPU, fast lane); 21.4 s and 43.9 s outliers | **1.4-2.4 s**. Whisper itself took 0.44-0.57 s (large-v3-turbo on the warm GPU server, 7 of 7 memos that reached the watcher; C1 was lost at the car); the rest is noticing the upload and downloading it |
| upload to dispatched | median 10.0 s (5.9-45.6 s) | **1.8-2.8 s** |
| one model call in a voice turn | GLM-5.3 at max: mean 13.4 s, p90 34 s (Oct 21: mean 15.9 s) | **Sol-6.1: median 5.7 s, mean 8.1 s, max 21.7 s** (18 calls, `model_override applied` on every memo, no fallback in agent.log) |
| short or status ask: first spoken answer | **median 184 s** (120-393 s over 7 answered); 1 of 8 never answered (a 300 s timeout) | **D2 24.3 s, A2 49.2 s, A 77.2 s**. A's transcript said "policy main branch", which cost an extra disambiguation call |
| long job: time to the spoken RESULT | **median 247 s** (93-1991 s over 7 answered); 2 of 9 never answered | **B 839.1 s** (worse: 3.4x). A spoken plan, not a result, came at +43.7 s; narration already gave a first word at ~25-35 s before |
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

## Round 2: the same asks after the review fixes

Date: 2026-10-22, 06:34:54-06:57:47 UTC. Simulator `emulator-5554` (HOLOC_9_Honda_API33), windowed. The installed debug
app is the same build as round 1 (installed 2026-10-21 05:51 EDT, after `3435fa6`), code-identical to v13; I did not
reinstall it or bump the version. Server side under test is everything in round 1, plus the review fixes:
- holocene `9df647d`, `a695ffa`, `867eca7`:
  - claims per reply file, so a follow-up gets its own car-or-phone decision;
  - follow-ups run on the agent's own model (`MEMO_FOLLOWUP_MODEL` empty);
  - neither the voice prompt nor the follow-up prompt may call `delegate_task`;
  - the stricter `BACKGROUND:` marker.
- bloodbank `f8d0cc6`: `detached_at` is per attempt, the detached fact is never published after the terminal one, and a
  refused turn undoes its `/model --once` switch.

I changed no product code and no config, and restarted nothing on the server. Evidence is in
[`ttfa/round2/`](ttfa/round2/).

Memo input went through the PulseAudio null sink as in round 1: `holo_testmic`, the qemu capture stream moved onto its
monitor, then `paplay`. I never used gRPC injection. A and B were new vox phrases. C and D reuse round 1's WAVs. Every memo
went to holocene-pm. The real car was not connected: there was no Android 12 push stream during the round. Not one reply
went to the phone: every memo ended `earshot_skipped: car_spoke`.

### Verdict

1. **Short question (A): spoken answer at +47.9 s.**
   - Before, the median was 184 s. Round 1 measured this phrase at 77.2 s.
   - Transcription took 0.51 s on the GPU server. The command was dispatched 2.0 s after upload.
   - The agent turn was 38.5 s, with 3 Sol calls: 13.8, 13.4 and 4.2 s. The first call was spent loading a skill
     (`candystore-context`) the git question did not need.
   - The server-clock ask D shows how short a plain status question can be: D1's reply was up at +23.3 s.
2. **Long job (B): quick answer at +49.7 s; full result spoken at +347.0 s, in one turn plus one follow-up.**
   - Round 1's result came at +839.1 s.
   - Hermes session `20261022_023635_33c15303` has exactly 2 user messages: the memo, then the background continuation.
     There was no "Operation interrupted", no kill, no re-run and no `delegate_task`.
   - The follow-up took 285 s, and 252 s of that was 4 model calls on `automaticai/auto`, which resolved to GLM-5.3 at
     max: 30.2, 80.2, 66.3 and 75.2 s.
   - The result is still slower than the before long-job median of 247 s, but the asks differ. See Finding 1.
3. **Past the wall clock (C): 4 of 4 detached at 300.0 s, each finished in its single turn, and each was spoken late.**
   - The four turns ended 362.4-366.7 s after they started. There was no `/stop`, no batch re-run and no escalation.
   - The car heard "still on it" 3.6-5.0 s after each detach (C2's line came later, after recording C3).
   - The late answers were audible at +369.4 to +373.4 s. C1's was audible at +455.8 s, because it waited 86 s behind a
     note my harness left open (Finding 3).
   - **The slot is freed.**
     - D2 waited in the stream for 60.6 s while C3 and C4 held both slots. It started **51 ms after C3's detach**.
       C3 then ran 63.4 s more and finished in the same turn.
     - D1 started while C1 (detached, still running) and C2 were both running: 3 turns at once on a 2-slot lane.
4. **Overlap audit: ZERO OVERLAPS.**
   - The speaker-level audit passed all 6 checks at device offsets of -25, -40 and -55 ms. It covered 61 utterances,
     10 app recordings, 10 OS capture windows, 58 HAL mix windows and 198 s of sound.
   - The server-side audit also reports ZERO OVERLAPS, over 62 utterances and 10 mic windows.
   - Round 1's check-5 flag (a reply's tail 87 ms over the 700 ms allowance) did not recur.
5. **One note was lost on the car again (C1x).** Round 1's C1 failed the same way: `MediaRecorder: stop failed: -1004`,
   `empty_capture`. This time the OS capture ended 9.7 s into the note, 2.2 s before Stop. Finding 2.

### Before and after

"Before" is the real car (Android 12, build `ACB1211S1`), 2026-10-19 to 2026-10-21: 17 asks to 33god-pm,
green-in-between-pm, pile-of-dumb-things-pm and navi-pm, from `/tmp/latency-study/breakdown.json` (the same source as
round 1). Every time is measured from the upload, on the server clock.

The asks are similar in kind but not identical. Host load average was 14-32 during this round, and 55-60 in round 1.

| step | before: real car, Oct 19-21 (17 asks) | round 1: sim | **round 2: sim, this round** |
|---|---|---|---|
| upload to transcribed | 5.4-6.5 s (large-v3 CLI on GPU, uncontended); 9.2-13.1 s on Oct 21 (`small` on CPU, fast lane); outliers 21.4 s and 43.9 s | 1.4-2.4 s | **1.2-2.2 s**. Whisper took 441-587 ms, large-v3-turbo on the warm GPU server, 8 of 8 memos |
| upload to dispatched | median 10.0 s (5.9-45.6 s) | 1.8-2.8 s | **1.5-2.5 s** |
| one model call in a voice turn | GLM-5.3 at max: mean 13.4 s, p90 34 s (Oct 21: mean 15.9 s) | Sol-6.1: median 5.7 s, mean 8.1 s, max 21.7 s | **Sol-6.1: median 6.2 s, mean 7.8 s, max 18.4 s** (20 calls; `model_override applied` on all 8 voice turns). First call 5.9-16.9 s |
| heard echo ("Holocene heard: …") | none | +2.9 to +9.3 s | **+2.9 to +3.5 s** when nothing else was playing (C2 +28.8 s and C4 +8.5 s waited behind a reply or an ack) |
| first progress narration audible | ~25-35 s (Oct 20-21 only); 3 asks on Oct 19 had none | +25 to +36 s | **+21.6 to +29.7 s**; C2's at +33.4 s waited behind B's follow-up |
| short or status ask: first spoken answer | **median 184 s** (120-393 s, 7 answered); 1 of 8 never answered | 24.3 / 49.2 / 77.2 s | **A +47.9 s.** D1's reply was up at +23.3 s, but my open note held it until +103.3 s (Finding 3). D2 at +79.9 s, of which 60.6 s was a deliberate wait for a slot; from turn start to audible it took 17.8 s |
| long job: first spoken answer | the result itself (row below); narration at ~25-35 s on Oct 20-21 | +43.7 s, a plan | **+49.7 s**, a plan ("I'll check the voice pipeline end to end and report which services are healthy…") |
| long job: spoken RESULT | **median 247 s** (93-1991 s, 7 answered); 2 of 9 never answered | +839.1 s (a 410 s `delegate_task`) | **+347.0 s**, with no `delegate_task`. The 285 s follow-up was 252 s of GLM-5.3-at-max thinking (Finding 1) |
| turn running past 300 s | killed at 300 s and re-run on batch (4 of 17), answered at 393, 538, 1184 and 1991 s; 3 more (Oct 19) never answered | detached; late answer at +369.7 s | **4 of 4 detached at 300.0 s.** One turn each, 362-367 s. Late answers audible at +369.4, +369.7 and +373.4 s (C1: +455.8 s, Finding 3). **0 kills, 0 re-runs, 0 escalations** |
| a new memo while both interactive slots are busy | waits until a turn ends, or is killed at 300 s | started 57 ms after the detach | **started 51 ms after the detach** (D2). D1 ran as a third turn next to a detached turn and an active one |

### The asks

| memo | id | phrase (as transcribed) | lane / turns | result |
|---|---|---|---|---|
| A | `12e2c5f2` | "What is the newest commit on Holocene, Maine? And who wrote it?" | interactive, 1 turn, 3 Sol calls | "The newest commit on Holocene's main branch is 867eca7, from today at 2:26 a.m. Eastern… Git lists Jarad DeLorenzo as the author, with Claude Code credited as co-author." Audible at +47.9 s |
| B | `e81e6315` | "Check every service the voice pipeline depends on, list which are healthy, and tell me anything odd. Take your time." | interactive 42.0 s (2 Sol calls; quick answer plus a 1199-character `BACKGROUND:` plan), then a 285.5 s batch follow-up (4 GLM calls) | quick answer audible at +49.7 s; follow-up audible at +347.0 s (432 spoken characters, 3 chunks) |
| C1x | `f5315743` | (wall-clock test) | none | lost at the car: `empty_capture` (Finding 2) |
| C1 | `5cdde79e` | "Wall clock test do this right now in this turn with no background handoff run the shell co[mmand sleep 170…]" | interactive, 1 turn, 2 Sol calls, one `sleep 170 && sleep 170` (340.7 s; the agent passed `timeout: 400`, Finding 5) | detached at +302.9 s; done at +365.3 s; late answer up at +368.7 s, audible at +455.8 s (Finding 3) |
| C2 | `cf6c31b1` | (same) | interactive, 1 turn, 3 calls, 2 × `sleep 170` | detached at +302.5 s; done at +369.3 s; audible at +373.4 s |
| D1 | `8c68a50a` | "Quick one! What time is it on the server?" | interactive, 2 calls (7.1, 2.6 s); started while C1 (detached) and C2 ran | turn 16.1 s; reply up at +23.3 s; audible at +103.3 s, held behind the open C3x note |
| C3x | `8ed152c2` | (wall-clock test) | none | the Stop tap was lost when the host adb server restarted; the note was cancelled after 83 s and nothing was uploaded |
| C3 | `ce601626` | (same as C1) | interactive, 1 turn, 3 calls, 2 × `sleep 170` | detached at +302.5 s; done at +365.9 s; audible at +369.7 s |
| C4 | `4984f914` | (same) | interactive, 1 turn, 3 calls, 2 × `sleep 170` | detached at +302.7 s; done at +365.1 s; audible at +369.4 s |
| D2 | `fedd0675` | (same as D1) | interactive, waited 60.6 s in the stream (C3 and C4 held both slots), 2 calls (5.9, 2.5 s) | turn start at +62.1 s, 51 ms after C3's detach; done at +75.5 s; audible at +79.9 s |

Each memo's memo:trace is in [`round2/traces/`](ttfa/round2/traces/) and its Hermes session in
[`round2/sessions/`](ttfa/round2/sessions/). `round2/runs/timelines.json` is built by `tools/timeline.py` from the device
log, the speaker tap, the proxy and watcher logs and the gateway journal. Device clock = host -11 to -44 ms (best sample:
-44 ms at 14 ms rtt); -40 ms is used throughout.

### B: answer then background, one conversation

```
06:36:32.7  upload                                 +0.0 s
06:36:34.6  dispatched (interactive, data.model sol-6.1)   +1.9 s
06:36:57.1  progress #1 "I'll load the health-check guidance, then run the full audit in the background…"
06:37:02.4  progress audible on the car            +29.7 s
06:37:17.2  quick-answer turn done (2 calls; the first loaded a quarantined skill, 16.9 s)
06:37:21.6  quick answer starts on the car         +48.7 s  (audible +49.7 s; 2 chunks, ended +63.4 s)
06:37:27.6  follow-up 1 dispatched on batch, same thread, no data.model   (0.4 s after the replied fact)
06:38:00 / 06:39:29 / 06:40:50 / 06:42:13   four automaticai/auto calls = GLM-5.3 at max: 30.2, 80.2, 66.3, 75.2 s
06:42:13.6  follow-up done (285.5 s)
06:42:18.9  follow-up chunk 1 up; the car starts it at 06:42:19.1   +346.4 s (audible +347.0 s)
06:42:45    my C2 recording halts it at +372.7 s; it is replayed in full from +390.8 to +416.9 s
```

- **What the follow-up found** (read-only): every hop is healthy. The odd things were:
  - C1x's empty recording;
  - yesterday's 16 `turn_timeout`s;
  - this morning's deploy restarts;
  - `telnyx-s3-intake.service` stuck in `activating` and `skillex-hermes-resync.service` failed, both outside the
    pipeline;
  - title-generator 400s.
- **One wrong claim:** its report says "this turn runs on Sol 6.1". agent.log and the usage ledger show
  `automaticai/auto`, which resolved to `glm-5.3` at max.

### C: past the wall clock

From the gateway journal (`round2/lanes-poll.txt.gz`, polled every 2 s) and the watcher (`memo_detached`):

```
06:39:50.311  C1 c471dcbd interactive started
06:43:02.525  C2 5357e85b interactive started            -> interactive ack_pending 2: both slots held
06:44:50.672  C1 detached_at (300.4 s)                    watcher memo_detached 06:44:51.1; "still on it" audible 06:44:55.7
06:45:46.161  D1 c66e5ae5 interactive started             -> ack_pending 3: C1 (detached, running) + C2 + D1
06:45:53.136  C1 completed (362.8 s, one turn, "finished")
06:46:02.282  D1 completed (16.1 s)
06:48:03.210  C2 detached_at; 06:49:09.949 C2 completed (367.4 s)
06:48:15.875  C3 876e80be interactive started
06:51:37.866  C4 023fcd3d interactive started             -> both slots held
06:52:15.765  D2 b90eb4e0 dispatched                       -> interactive pending 1 (waits in the stream)
06:53:16.303  C3 detached_at (300.4 s)
06:53:16.354  D2 b90eb4e0 interactive started             <- 51 ms after the detach; ack_pending 3
06:53:29.794  D2 completed (13.4 s)
06:54:19.702  C3 completed (363.8 s)
06:56:38.207  C4 detached_at; 06:57:40.571 C4 completed (362.7 s)
```

- **Sessions:**
  - C2, C3 and C4: one user message, then `sleep 170` (170.3-171.0 s) twice, then "finished".
  - C1: one `sleep 170 && sleep 170` (340.7 s), then "finished".
  - No session has a second user message or "Operation interrupted".
- **Watcher:** zero `memo_escalated`, `turn_timeout` and `late_turn_timeout` events in the round. All 4 detached turns
  completed with `detached: true` and `model_override applied`.
- **Detached limits:** no two turns were ever detached at the same time (each finished about 63 s after its detach), so
  `max_detached` (2) was never reached. The 2700 s ceiling was not exercised either.

### Overlap audit

`apps/auto/tools/speech_overlap.py`, whole round (device 1792650880-1792652275, offset -40 ms; also -25 and -55 ms, same
result). Output: [`round2/overlap-session.txt`](ttfa/round2/overlap-session.txt).

```
PASS  1 speech x speech (queue): 0 overlaps
PASS  2 speech x recording (queue vs app mic + OS capture, tolerance 30 ms): 0 overlaps
PASS  3 HAL assistant mix x OS capture (tolerance 30 ms): 0 overlaps
PASS  4 speaker output x mic open (tap, tolerance 30 ms): 0 overlaps
PASS  5 speaker output with no owning utterance (latency 700 ms): 0 overlaps
PASS  6 a sound running into the next utterance (no silence within 700 ms of its start): 0 overlaps
      speaker output: 167 spans, 198.0 s of sound in the window
RESULT ZERO OVERLAPS  (61 utterances, 10 app recordings, 10 OS capture windows, 58 HAL mix windows)
```

The round exercised these collisions:
- B's follow-up reply was halted by recording C2, and replayed in full once C2's acks were done.
- C1's late reply and D1's reply were each held for the 83 s C3x note, renewing their holds, and played once it closed.
- Detach lines and narration were queued behind recordings and replies.
- D2's late progress clip played right before its reply.

The server-side audit ([`round2/overlap-proxy-side.txt`](ttfa/round2/overlap-proxy-side.txt)) rebuilds the pad's speech
events at the upload proxy: 62 utterances, 10 mic windows, **ZERO OVERLAPS**.

To rerun:

```bash
E=_bmad-output/implementation-artifacts/agent-pad-auto/ttfa/round2
zcat $E/speaker-tap.jsonl.gz > /tmp/tap.jsonl
python3 apps/auto/tools/speech_overlap.py --logcat $E/speech-logcat.txt --tap /tmp/tap.jsonl --offset-ms=-40 --from 1792650880 --to 1792652275
python3 $E/../../ttfr/round2/proxy_overlap.py --since 2026-10-22T06:34:00 --until 2026-10-22T06:58:30 < $E/proxy-events.jsonl
```

### Findings (not fixed in this round)

1. **A long job's result is now model-bound: a GLM-at-max follow-up.**
   - B's follow-up did the work itself, as the fixed prompt asks, and finished in one 285 s turn.
   - 88% of that turn (252 s) was 4 calls of 30-80 s, each 1.3k-4.5k output tokens.
   - The cause is `MEMO_FOLLOWUP_MODEL` being empty: the follow-up runs on `automaticai/auto`, and the desks' tokens land
     that on GLM-5.3 at max.
   - The latency study measured the same heavy step at 51 s on GLM at max, 11-27 s on kimi-2.8 and 5-7 s on Sol.
   - Setting `MEMO_FOLLOWUP_MODEL=automaticai/personal/kimi-2.8` (or Sol) would likely bring the result to roughly 1-2
     minutes after the quick answer, but it spends that pool. It is your call. The driver already has the quick answer
     at ~50 s, so this only delays the result.
2. **The car's native recorder dropped a 12 s note again (C1x). Kotlin, so a v14 candidate.**
   - **What happened:**
     - The note opened at 06:37:45.5. `AudioSource: AudioRecord reported overrun!` was logged 6 times 3.7-4.0 s in.
     - The OS recording list went empty at 06:37:55.2, 9.7 s in. Stop came 2.2 s later.
     - `MediaRecorder: stop failed: -1004` → `HoloceneNativeRec: stop failed: RuntimeException` → `record_failed
       empty_capture`.
   - **How often:** this is the first long note of the round, as it was in round 1 (C1). The same WAV then uploaded
     fine 4 times out of 4 (C1-C4).
   - **Why the reason is unknown:** `NativeRecorder` sets `setOnInfoListener` and `setMaxDuration(5 min)` but no
     `setOnErrorListener`, so the reason MediaRecorder stopped is never logged.
   - **Suggested fix:** log `onError`, and keep the file written up to the error instead of discarding the whole note.
3. **A lost Stop tap left a note open, and two replies waited 80-86 s behind it.** This is a harness problem, not the
   product.
   - **Cause:** something on the host kept killing the adb server ("adb server killed by remote request" in the adb
     log). logcat had to be restarted 80 times during the 24-minute round.
   - **What happened:**
     - C3x's Stop tap at 06:46:09 never reached the sim. The note stayed open for 83 s, recording silence, until I
       cancelled it with ESC at 06:47:21.
     - The car held C1's late reply (86.4 s) and D1's reply (79.7 s) behind it, renewing its holds, as designed. Both
       played right after.
     - The product did what it should: nothing plays into a recording, and a live hold keeps the reply off the phone.
   - **Fixes in the harness:**
     - `round2/tools/drive.py` now retries an adb command until it runs, and re-taps Stop if the mic is not idle 6 s
       later.
     - `logcat_loop2.sh` restarts logcat from the last logged epoch, so a restart leaves no gap.
4. **A memo that waited for a slot plays a stale progress line.**
   - D2 waited 60.6 s in the stream. Its first progress line ("I'll check the server's clock") came 9.9 s into the turn,
     but 72 s after upload, so the watcher narrated it.
   - The clip was published 64 ms after the watcher saw the agent finish, and the car played it 3.5 s before the
     answer.
   - It is harmless, but it is a race with the existing `narration_dropped turn_finished` rule: a progress line that
     arrives after the turn ended should be dropped too.
5. **`terminal.timeout: 180` is a default, not a cap.**
   - C1 ran `sleep 170 && sleep 170` as one call with `"timeout": 400`, which the agent chose itself, and it ran 340.7
     s.
   - The detach design counted on the 180 s terminal cap to bound hung shells (latency study, `detach`). The real
     bound is the 2700 s detached ceiling.
6. **Voice turns still spend their first call on a skill.**
   - A loaded `candystore-context` before a one-line `git log`. B loaded `monitoring-stack`, which is quarantined, so the
     call failed.
   - That is one Sol call each: 13.8 s for A and 16.9 s for B, the two slowest first calls of the round.
   - Sol's first call is otherwise 5.9-12.1 s. The provider effort is still xhigh (round 1, Finding 4).
   - Possible fix: the voice prefix could say "no skill loading for a quick answer".

### Side effects and state

- **Memos:** 10 recordings. 8 memos went to holocene-pm (A, B, C1, C2, D1, C3, C4, D2). C1x failed at the car, and C3x
  was cancelled with nothing uploaded.
- **Phone:** no reply was mirrored. All 9 replies (8 answers and B's follow-up) ended `car_spoke`.
- **Interactive slots:** both were held on purpose twice:
  - 06:43:02-06:44:51, by C1 and C2;
  - 06:51:38-06:53:16, by C3 and C4.
  - The real car was not connected: there was no Android 12 push stream.
- **B's follow-up** ran read-only checks of the voice services for 285 s.
- **Server:** no gateway reload, no config edit, no product code change, no restart of any service.
- **Sim:**
  - The emulator exited silently about a minute after the first boot, at 06:31, with no crash in its log. It was started
    again and stayed up for the whole round.
  - It is left windowed, parked, with the app open and Holocene selected
    ([`round2/shots/09-left-parked-app-open.png`](ttfa/round2/shots/09-left-parked-app-open.png)).
  - The qemu capture stream was moved back to the default source before the null sink was unloaded, and
    `auto:sim:mic-check` reports `OK (rms 11.6 peak 47)`.

### Files (round 2)

- `round2/speech-logcat.txt` (device clock): HoloceneSpeech, Wheel, Reply and NativeRec lines; MediaRecorder and
  AudioSource; the OS capture dumps; the HAL `MM_AF` lines. Built from a full `logcat -d` dump, so it has no gaps.
- `round2/speaker-tap.jsonl.gz`: every speaker packet, on the host clock.
- `round2/watcher-events.jsonl`: the watcher log for the round. `round2/proxy-events.jsonl`: the upload proxy log.
- `round2/lanes-poll.txt.gz`: NATS consumer counts plus gateway journal rows, every 2 s.
- `round2/runs/`: press times (`runs.jsonl`), `timelines.json`, `memos.json` and clock samples.
- `round2/traces/` and `round2/sessions/`: memo:trace and the Hermes session for each memo.
- `round2/tools/`: `drive.py` (with the adb retry and the Stop re-tap), `timeline.py` (with follow-ups, detaches and
  escalations; `OFF_MS` sets the clock offset), `clock.py`, `logcat_loop2.sh`, `poll.sh`, `lanes.sh`, `collect.sh`,
  `wj.py`, `sess.py` and `synth.py`. They expect `/tmp/ttfa2` paths.

## Update 2026-10-22 (08:16 UTC): Sonnet 5.5 for the voice turn and the follow-up

Operator-approved: `automaticai/personal/claude-sonnet-5.5` scoped onto the gateway tokens the car agents use (`hermes`, shared
by 27 of the 29 pad desks, and `hermes-delonet-director`), and `MEMO_VOICE_MODEL` / `MEMO_FOLLOWUP_MODEL` set to it (unit env and
code defaults, holocene `6e650d9`). Watcher restarted at 08:16:41 between memos.

One sim memo, `0a24d782` (B.wav: the service-check ask), through the Honda sim:
- the command carried `model=automaticai/personal/claude-sonnet-5.5`; both turns report `model_override ... applied`;
- **neither turn ran on Sonnet.** Anthropic answered Hermes' first call of each turn with HTTP 400 "Third-party apps now draw
  from your extra usage, not your plan limits" (gateway log 04:17:09 EDT, 191 ms, token `aai:hermes`), and Hermes fell back to
  `glm-5.3` (agent.log: "Fallback activated: ...claude-sonnet-5.5 -> ...glm-5.3"; every later call `model=...glm-5.3`);
- quick answer: upload to first audio +105.8 s (the turn itself 100 s, 3 calls of 34.8, 12.2 and 31.5 s on GLM at xhigh);
  follow-up result spoken 441.7 s after the quick answer (426 s turn, 20 calls, 18k output tokens on GLM);
- the same 400 on `automaticai/intelliforia/claude-sonnet-5.5` (team account: "ask your workspace admin"). A plain
  gateway curl and a Hermes CLI call (`provider=custom`) on the same token and route succeed in 1-2 s, so it is Anthropic
  classifying the gateway-turn request, as the owner found on 2026-10-01.
Net effect today: voice turns cost one failed 0.2 s call and run on glm-5.3, which is what an exhausted Sol pool does too.
Real fixes: enable extra usage on the personal Claude account, or point the voice turn at kimi-2.8 (11-27 s on the heavy step).

### Rolled back (2026-10-22, 08:50 UTC)

Independent review found the Sonnet switch both useless and harmful, so it was reverted the same morning:
- it never ran on Sonnet (above), and quick answers got slower (+105.8 s vs +43.7 s on sol-6.1);
- scoping a Claude route onto the shared `hermes` token put it in `automaticai/auto`'s candidate set (candidates are intersected
  with the token scope), so non-voice desks on `model=automaticai/auto` (navi-pm 04:23, pile-of-dumb-things-pm 04:31 EDT) got the
  same Anthropic 400 and fell back to glm-5.3. That undid the owner's 2026-10-16 rule: hermes consumer tokens carry no Claude routes.

Done: `claude-sonnet-5.5` removed from the `hermes` and `hermes-delonet-director` token scopes (curl: sonnet 403, auto 200, glm-5.3 200
on both); watcher defaults back to `MEMO_VOICE_MODEL=automaticai/personal/sol-6.1` and `MEMO_FOLLOWUP_MODEL=` (empty), unit env lines removed.
`astra` and `gpt-5.5` stay out of the scopes (not in the route catalog). To retry Sonnet: enable extra usage on the Claude account and
scope the route onto a token `automaticai/auto` cannot reach, not the shared `hermes` one.

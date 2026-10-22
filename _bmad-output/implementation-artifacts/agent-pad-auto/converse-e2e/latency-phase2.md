# HOLOC-23 phase 2: bounded sim proof (2026-10-22, 20:28-20:50Z)

Verdict: **the p50 <= 5 s / p90 <= 8 s target is NOT shown by this run, and the run is incomplete.** The sim was
starved (host load 33 at the start, 80-106 for most of the run) and went flaky after turn 9, so the propose / send it /
Already-sent chain and the barge-in were not run. Per the hard limits (sim broken > 5 min) I stopped. Nothing in
the product was changed; only this write-up and its scratch tools were committed.

What the run does show: the server path is now fast. The LLM hop is now the largest single hop, and it is slow
because `r1` resolves to `glm-5.3` via `automaticai/auto/fast`, not DeepSeek flash.

## What was run

13 recordings against the live desk (emulator-5554 only, `converse` mode on, agent `holocene-pm`):

| turn | memo | what | result |
|---|---|---|---|
| p2-01 | 643ec8f9 | who are you / what can you do | reply (fast) |
| p2-02 | fd8876b3, 86af8d94 | say that again | 2 silent recordings (sim mic delivered no sound; first driver crashed on a Candystore timeout and re-tapped) |
| p2-03 | 3a29f622 | which agents are on my roster | reply (fast) |
| p2-04 | 22019344 | which would handle the voice pipeline | reply (fast) |
| p2-05 | 62cc8415 | why did you pick that one | reply (fast) |
| p2-06 | 1e2280d4 | what was the first thing I asked you today | `direct` / `fallback` (LLM 46 ms), **delegated to the full agent** (1 dispatched, 1 invocation). This is the one full-agent memo. |
| p2-07 | 25ea5061 | one word summary | reply (fast), no `chunk_voiced` logged |
| p2-08 | a675bc92 | what can the desk not do | reply (fast) |
| p2-09 | 74c70a0d | which agent handles infrastructure | reply (fast) |
| p2-10 | - | not run (memo budget) | |
| p2-11 | c2c0c203 | propose (date command) | silent recording / failed; the sim's mic never came up cleanly. **Not run to completion.** |
| p2-12 | f159d0a8 | "Send it." | silent recording. **Not run.** |
| p2-13 | 51d7c860 | "Send it." with no draft pending | reply (fast): "There's nothing waiting to send ..." |

Memos: 13 (limit 15). Four were silent sim-mic failures. Fast `reply` turns with usable timing: 8.
Not run: the propose + send it + one "Already sent" chain, and the barge-in during a fast reply.

## Record-stop to first audible answer, per turn

Reference point: the pad's `stopped` event (logcat `deferred ack ack:stopped`, device clock; offset to host -0.5 s
applied). That is the moment the driver is really done, so the harness's adb tap delay (0.3 s) is excluded. "First
audible" is the car's `start reply` in logcat (HoloceneSpeech); the speaker tap was running but its packets were not
joined per turn. The host clock offset is small enough that I treat start time and audible time as equal here.

Hop columns (seconds): stop->landed = device stop to the watcher's `discovered` (recorder stop + PUT + wake hint);
whisper = discovered to transcribed; LLM+ = transcribed to `converse_decided` (the LLM plus handoff); TTS+up =
decided to chunk 1 in S3; push+pad = chunk 1 in S3 to the car's `queued reply`; acks = device stop to the end of the
second ack (STOP + SENT).

| turn | stop->landed | whisper | LLM+ (llm_ms) | TTS+up | push+pad | acks done | **stop -> first start** | notes |
|---|---|---|---|---|---|---|---|---|
| p2-01 | 1.50 | 0.63 | 3.83 (3737) | 1.69 | 53.3 | - | 63.9 | harness artifact: the next turn started recording during the reply and barged it (`playback / barged_in`). Excluded from p50/p90. |
| p2-03 | 1.06 | 0.65 | 5.64 (5604) | 1.65 | 0.28 | 3.75 | **9.29** | |
| p2-04 | 3.47 | 0.63 | 4.00 (3929) | 1.96 | 2.42 | 6.77 | **12.51** (audible 54.51) | the `start reply` was halted `focus_denied` 0.8 s later (twice), then `stopped` by p2-05's recording; the first `playback started` beacon is 20:36:11.871, 54.5 s after stop |
| p2-05 | 7.84 | 0.82 | 5.31 (5263) | 1.87 | 12.0 | 10.85 | **27.85** | loaded |
| p2-07 | 0.97 | 0.56 | 3.02 (2986) | - | - | 3.48 | **5.95** | best turn |
| p2-08 | 1.07 | 0.63 | 3.46 (3417) | 1.91 | 41.1 | 5.20 | **48.18** | reply sat 41 s between chunk 1 landing and the car queueing it: it waited behind p2-06's 56 s full-agent reply (1e2280d4 played 20:37:46.050-20:38:42.591; the car held a675bc92 from 20:38:05 and started it at 20:38:47.433). Queue order, not a pad fault |
| p2-09 | 5.77 | 1.09 | 8.33 (8268) | 1.88 | 11.7 | 12.83 | **28.82** | loaded |
| p2-13 | 2.36 | 0.78 | 3.88 (3855) | 2.02 | 9.7 | 6.42 | **18.75** | |

Fast-reply turns, n=7 (p2-01 excluded as a harness artifact):

| stat | stop -> first `start reply` | stop -> first `playback started` beacon (audible) | stop -> chunk 1 in S3 (server side only, n=6, p2-07 has no chunk) |
|---|---|---|---|
| p50 (nearest rank) | 18.75 s | **28.04 s** | 9.04 s |
| p90 (nearest rank) | 48.18 s | **54.51 s** | 17.07 s |
| best / worst | 5.95 / 48.18 | 6.02 / 54.51 | 7.07 / 17.07 |

Corrected after review (21:40Z): the first version of this table gave p90 28.82 s and 17.07 -> 15.84 s; with n=7 the
nearest-rank p90 is rank 7 (48.18 s), and with n=6 server-side values (7.07, 9.00, 9.04, 10.06, 15.84, 17.07) it is
17.07 s. "First start" also counted p2-04 as 12.51 s, but that start was halted by `focus_denied` within 0.8 s and the
reply was first heard 54.5 s after stop. The audible column uses the pad's `playback started` beacon in the proxy log
(each within 0.07-0.36 s of `start reply` except p2-04).

Host load during the run (`uptime`, load 1-min, sampled at each turn start; file `runs/phase2/uptime.txt`): 33.1 (p2-01),
38.2, 49.6 (p2-03), then 80-106 from p2-04 on (106 at 16:41, 97-105 around the failed propose). For comparison the earlier
"quiet" evidence (6.81 / 9.42 s) was taken with the load far lower than this. This run therefore measures the loaded
case, and only p2-03 and p2-07 are at all comparable to "quiet" (9.29 and 5.95 s at load 38-50).

## Hop comparison against the before-state (evidence.md / the MEASURE report, ALL p50)

| hop | before | now (this run) | note |
|---|---|---|---|
| landed -> discovered | 0.68 (poll tick) | 0.01-0.02 (`detect_lag_ms` 13-20, wake hint used on every turn) | wake hint works; `wake_hint` event on every memo |
| discovered -> transcribed | 1.44 | 0.64 (0.56-1.09) | local MinIO alias, in-process S3, level probe overlapped |
| LLM + handoff | 1.18 (ministral / deepseek-flash) | **3.94 (3.0-8.3)** | `glm-5.3` on `r1 = automaticai/auto/fast`. This regressed the p50 by about 2.7 s and is now the dominant server hop. |
| decided -> chunk 1 in S3 | 2.41 + 0.43 upload | 1.88 | 45-char first beat and in-process S3 |
| stop -> chunk 1 in S3 | 8.18 (ALL) | 9.04 | LLM regression cancels the other gains; loaded host |

Sum of the non-LLM server hops went from about 5.1 s to about 2.6 s. Swap the LLM back to about 1.2-1.8 s and the
server-side stop -> chunk 1 would be about 5 s, plus the device recorder stop and the pad hops below.

## Acks and focus (what the pad does after 6345be1)

- Both acks finished 3.5-12.8 s after device stop (3.75, 6.77, 10.85, 3.48, 5.20, 12.83, 6.42). On the loaded sim they
  are slow (Android TTS is starved), and they DO gate the reply on several turns: the reply's `queued ... behind_ack`
  appears while the STOP ack is still speaking, and `SENT` plays before it. On a quiet device the earlier finding
  stands (the acks finish before the reply is ready).
- `stopped` goes out with an empty name: logcat `HoloceneWheel say "Got it, sending."` on every turn.
- p2-04 shows the new focus retry in the log (a reply halted `focus_denied` and re-queued; a first retry took 3.9 s,
  later ones 30 ms-1 s). The first gap does not match a 300 ms first retry, so the pad's schedule is not proven live;
  not investigated further. The reply was never dropped.
- 2 ms-class pad hops are not what hurts here: the large `push+pad` values (9.7-53 s) on four loaded turns are the
  starved WebView / sim. They are the biggest unexplained cost in this run and cannot be blamed on the server.

## Invariants

- speech_overlap.py (`apps/auto/tools/speech_overlap.py`, logcat + speaker tap, offset -498 ms): 52 utterances, 13 app
  recordings, 13 OS capture windows.
  - PASS 1 speech x speech, 2 speech x recording, 3 HAL mix x OS mic, 4 speaker output x mic open, 6 tail into next.
  - FAIL 5 speaker output with no owning utterance: 1 hit, a 50 ms speaker packet at 1792701760.82 (one tap packet; the
    tap is on the host clock and the offset is a median of per-turn offsets, so this is within clock slop, not audible
    overlap). With offset 0 checks 4 and 5 also showed 71 ms / 50 ms edge hits, which vanish once the measured offset is used.
  - Not exercised: a barge-in during a fast reply (not run), so "speech never overlaps a recording" is shown only for the
    harness's own start-of-recording overlaps. The one barge that did happen (p2-01 reply barged by the next recording)
    ended with `halt reply reason=stopped`, then the arming prompt. No overlap.
- Exactly-once: across the 13 memos Candystore shows 1 `routed` + 1 `replied` per answered memo, and exactly one
  `dispatched` (+ one `agent.invocation.started`) in total, on p2-06. No duplicate dispatch, no `delegated` twice. A
  `drop reply ... reason=duplicate` happened once in logcat (the pad's own duplicate-offer guard) and played nothing twice.
  The propose + send it + already-sent chain was NOT run, so the exactly-once-on-confirm path is untested in this run.
- Never Anthropic: all decisions on `glm-5.3` via `r1 = automaticai/auto/fast`. No Anthropic route was used.
- Memo never failed for an LLM reason: the four failed memos are `silent_audio` (sim mic), plus the barged playback
  (`not_played / barged_in`); none is an LLM failure. p2-06 went `direct/fallback` with the full agent, not failed.
- Kill switch: `mise run memo:converse status` shows `mode on (source: flag)`, `agents *`, `devices (any car)`,
  `routes r1=automaticai/auto/fast`, watcher heartbeat 1 s old. Off was NOT toggled. Flag file left as found.
- Pad never moves while driving: not exercised.
- Car claims arbiter (car vs phone): not exercised beyond the car's own claims.

## What this means / recommendations

1. The biggest remaining server-side lever is the LLM route, not anything in the watcher: put `r1` back on a route that
   answers in 1.2-2 s (DeepSeek flash) or keep a fast first rung ahead of `automaticai/auto/fast`. The p50 server-side
   would drop by about 2.7 s with no code change. I did not change the unit or flag file.
2. All sim numbers here are dominated by host load 80-106 (a long HeyMa transcription and other agents' sims). The pad,
   WebView, Android TTS and the recorder are starved, which is where the 10-50 s `push+pad` and the 7.8 s stop -> landed
   come from. A real-car measurement is still the only credible check of the 5 s / 8 s target.
3. Rerun this proof when the host load is under about 20 and the emulator is idle, with the propose / send it / Already
   sent chain and the barge-in. Use `runs/phase2/p2_driver_patch.py` (never re-taps the Stop button, falls back when
   Candystore times out) instead of the stock `drive_converse.py turn` under load; the stock driver crashed 3 times on
   a Candystore timeout and its stop re-tap created two silent recordings.
4. The driver's "stop -> first start" in `drive_converse.py` waits for a reply after the harness's own stop tap; here
   the reference was the pad's own `stopped` event, which is the car-relevant moment.

## Files

- `runs/phase2/hops-rows.json` per-memo hop rows; `runs/phase2/analyze.py` builds them from logcat + watcher journal.
- `runs/phase2/p2_driver_patch.py` driver wrapper; `runs/phase2/uptime.txt` load at each turn start.
- Raw logcat, speaker tap and per-turn JSON stayed in `/tmp/conv-p2` (not committed; large).

## Review fixes (2026-10-22, 21:10-21:45Z, commit 2f81e7a)

What changed after the phase-2 review, and what was measured without the sim:

| issue | fix | verified |
|---|---|---|
| 45,80 first beat left a 0.7-1.3 s pause after chunk 1 (major) | `MEMO_CONVERSE_CHUNK_CHARS=55,65,95,180,300`. Rule: chunk n+1 must render while chunk n plays; with render 1.6 s + 18 ms/char and speech about 51 ms/char, c(n+1) <= 2.8 c(n) - 89 | offline bench (below): mid-reply gaps 2.26 s total over 8 real replies -> 0.79 s, 3 replies with a pause -> 1; first chunk ready p50 1.98 -> 2.05 s after the decision |
| in-process `cp` stored `binary/octet-stream` without `--attr` (major) | s3direct guesses the type the way mc does (`.ogg`/`.opus` -> `audio/ogg`, mimetypes, else `application/octet-stream`) | live probe through the watcher's own `mc()` on `delodrive`: `cp s3direct 0`, stat `Content-Type: audio/ogg`; unit test for 4 extensions |
| cut download retried onto the same file | the body length is checked against `content-length` (a short `read()` is not an error in http.client), and the retry seeks back and truncates | unit test with a server that drops mid-body: the file equals the object |
| `mc_cli` ignored the caller's timeout | the timeout is one wall-clock budget across both attempts (capped by `MEMO_S3_DIRECT_TIMEOUT_S`), then mc runs | unit test against a socket that never answers: back in under 2.5 s with timeout 1 |
| state not saved after the final fact drain | `Watcher.shutdown` saves `state.json` after the drain | unit test: a publish failing in the drain is in the outbox on disk |
| wake listener started before the baseline | it starts after `baseline_if_first_start()`, beside the discovery watch | wiring test; live journal 21:29:49Z: `starting` then `wake_listener` |
| PhraseBank kept a fallback engine's render | only `MEMO_PHRASEBANK_ENGINES` (default `voxcpm`) renders are banked; the warm-up skips others | unit test: an `elevenlabs` render is spoken but not banked, the next `voxcpm` one is |
| tests/bench pushed hints into the live proxy | `MEMO_PUSH_HINT_URL` is off in code and set in the unit; a watcher on any bucket but `holocene-auto` never hints | subprocess test; proxy log shows no `push_hint` from the three full test-suite runs after the change |
| pad: duplicate holds 7 ms apart, a `drop duplicate` on a focus retry | the gate and the renew interval both go through `holdFor` (one in-flight hold per reply); `feedStream` re-checks that its stream is still current after the base64 encode, so an older stream cannot offer chunk 1 again after a focus retry restarted the reply | tsc, 75 pad tests; deployed bundle `index-DLS9RgDv.js` (same hash as a rebuild from HEAD). Not re-measured on the sim |
| pad: outbox row written alongside the first PUT | the row is awaited before the PUT again (one IndexedDB write); a failed row write no longer aborts the upload | tsc, pad tests |
| this file's stats | corrected above | - |

Offline chunk-gap bench (`runs/phase2/gapbench/`): the 8 real fast-reply texts of this run, split with the old and new
caps and rendered back to back through the live vox at the desk's 6 steps in the default voice, then replayed as the pad
plays them (chunk i starts at max(end of chunk i-1, landed_i + 0.3 s)). Host load 15-23.

| config | first chunk ready after the decision, p50 | replies with a pause | total pause |
|---|---|---|---|
| 45,80,170,300 | 1.98 s (one 4.8 s vox-contention outlier) | 3 of 8 (0.79, 1.04, 0.43 s) | 2.26 s |
| 55,65,95,180,300 | 2.05 s | 1 of 8 (0.79 s: a 42-character first sentence, then a 58-character chunk that took 3.2 s to render) | 0.79 s |

Latency after the fixes: the sim proof above still stands as the only end-to-end number (audible p50 28.0 s / p90 54.5 s,
loaded sim, n=7), and the target is NOT demonstrated. No sim rerun was done for these fixes: the only spoken change is
chunk timing, measured offline above. The server side is unchanged by the fixes apart from +0.07 s to the first chunk.
The dominant lever is still the LLM route (3.0-8.3 s on `automaticai/auto/fast` -> `glm-5.3`).

# Final regression of the live fast conversation desk (HOLOC-23)

Date: 2026-10-22, 18:59-19:25 EDT (22:59-23:25 UTC), 26 minutes wall clock. Live build: watcher up since 17:31 EDT (commit `c04553e`),
route `automaticai/auto/fast` (glm-5.3 served), hold cue 3 s / 9 s, PhraseBank, wake hint. Emulator `emulator-5554` only. No code was
changed except the test harness. hermes-gateway, watcher and agent-pad-upload were not restarted.

**Verdict: partial** (see "Fixes and re-run" for the follow-up pass: D1, D4, the barge-in push, D3 fixed; R6 PASS; R2 still not run). R3, R4, R5 pass; R1 passes on latency and cue behaviour but exposed a real defect (long-answer questions fall
through to the full agent); **R2 (delegation exactly-once) and R6 (kill switch) were NOT RUN** because the full-agent budget was spent
before them (see "Limits, said plainly"). The speaker tap ran, so `speech_overlap.py` ran all 6 checks.

## Setup and host load

| item | value |
|---|---|
| uptime at start | 18:59:07 load 61.86 / 45.99 / 34.38; 18:59:33 63.88; mic-check ran, then 19:00:29 load 38.45 (under the 45 gate, so no pause was needed); 19:01:24 25.8 |
| load during the run | 18-55 (1-min); 53.9 at 19:06 (R1), 18.7-26 from 19:12 on; 12.6 at the end (19:24) |
| `auto:sim:mic-check` | **INCONCLUSIVE twice** ("the app's mic probe did not report a result"), same as the earlier ladder run. Not SILENT, so no recovery applied. The first memo (`r1-01`) transcribed exactly what was spoken, which is the working proof the paplay -> holo_testmic -> emulator mic path is healthy. The qemu capture stream was already on `holo_testmic.monitor`. |
| speaker tap | `sim_audio_tap.py` started 19:01:44, 94 000 packets, ended with the run. Clock offset device-host: median -160 ms (per-turn -176..+143 ms). |
| driver | `tools/final_driver.py` (wraps `runs/phase2/p2_driver_patch.py`, survives Candystore timeouts) + two harness fixes below; `tools/final_r3.py`, `tools/final_r4.py`; `runs/final/runturns.sh`. |

Harness fixes (test harness only): (1) `rec_start` matched `HoloceneSpeech: deferred ack ... mic=recording reason=recording` (a stop cue
queued while the mic was still recording) as "mic is recording"; now only the `HoloceneSpeech: mic ` state line counts. (2) `rec_stop`
never retapped, so one lost stop tap meant a 56 s capture and a cascade (see D2); now it waits 8 s for any sign the stop registered
(`mic=idle` or `ack:stopped`) and retaps once only if there is none.

## Per-memo table

`stop` = record-STOP press (host clock). `start reply` = logcat `HoloceneSpeech: start reply` for that memo (device clock - offset).
`beacon` = the pad's `playback started` beacon in the upload-proxy log. `audible` = first tap packet with rms >= 30 after `start reply`.
All in seconds after stop. `desk` = the fast route's call, ms. Raw: [`runs/final/final-table.json`](runs/final/final-table.json),
[`table.txt`](runs/final/table.txt), [`turns.jsonl`](runs/final/turns.jsonl).

| id | memo | heard (transcript) | action / path / model | desk ms | start reply | beacon | audible | hold cue (uploaded -> played) |
|---|---|---|---|---|---|---|---|---|
| r1-01 | d02ace4a | What is the Holocene project in one sentence? | reply / fast / glm-5.3 | 2540 | 12.92 | 14.22 | 14.77 | none (desk < 3 s) |
| r1-02 | a20e3aec | Which agents are on my roster? | reply / fast / glm-5.3 | 6685 | 11.70 | 13.17 | 13.63 | "Thinking." +5.9 -> played +7.2, answer +11.7 |
| r1-03 | 73798fcb | Which commit message style does this project use? | direct / fast -> agent | 3784 | 47.44 | 47.75 | 48.31 | "Hold on." +5.1, keep-alives +13.9, +22.9, all played |
| r1-04 | c7ba14fd | What does a fast-ass do compared to the full agent? | direct / force_direct | - | 70.50 | 71.11 | 71.63 | "Still thinking." +10.3, "Still on it." +19.4 |
| r1-05 | 3a970507 | Does Holocene publish domain events, or does it only collect them? | reply / fast / glm-5.3 | 2953 | 7.29 | 7.63 | 8.04 | none |
| r1-06 | 67e62dbe | What is the production first rule for Holocene? | reply / fast / glm-5.3 | 2802 | 7.49 | 7.87 | 8.27 | none |
| r3-a | fdbc2311 | Walk me through the Holocene serving path and the change workflow step by step | direct / fallback `all_routes_failed` (outcome `empty`) | 9871 | 79.99 | 80.84 | 80.02\* | 5 uploaded (desk cues +5.1, +11.1, keep-alives to +38.0), 5 played\* |
| r3-b | df7ab335 | What is the operating model of Holocene? | reply / fast / glm-5.3 | 2999 | 37.22 | 37.48 | 37.95 | dropped `answer_ready` (+5.8) |
| r3a-a | baa574e1 | Explain in detail, in a few sentences, what the Fast Desk does ... | direct / fallback `all_routes_failed` (outcome `bad_json`) | 11190 | 62.23 | 63.32 | 64.21 | 4 uploaded, 4 played |
| r3a-b | 09c921f4 | What was the first agent you listed earlier? | reply / fast / glm-5.3 | 3626 | 32.77 | 32.90 | 33.36 | "Thinking." +5.3, queued behind a reply, dropped `memo_final`, never played |
| r3b-a | 0f75e05e | What is the Holocene project in one sentence? | reply / fast / glm-5.3 | 4224 | 9.44 | 9.97 | 10.39 | "Hang on." +6.1 -> played +6.3, answer +9.44 |
| r3b-b | 3adc1a9b | Does Holocene publish domain events, or does it only collect them? | reply / fast / glm-5.3 | 2474 | 6.79 | 7.46 | 8.15 | none |
| r4-a | ba95e3fb | Which agents are on my roster? | reply / fast / glm-5.3 | 6040 | 16.59 | 17.14 | 17.49 | "Hold on." uploaded +5.07, **never played** (R4) |
| r4-b | 5f1e6dfa | Use Morgan voice! | tool `car_set_voice` (setting_phrase) | tool 2192 | 25.06 | 25.37 | 25.79 | none |
| r5-c | 820b543f | Which agents are on my roster? | reply / fast / glm-5.3 | 6952 | 12.42 | 13.00 | 13.50 | "Hold on." in **morgan** +5.4 -> played +5.8, answer +12.4 |
| r5-d | 7f65678d | Use Rick Voice. | tool `car_set_voice` (setting_phrase) | tool 571 | 3.12 | 3.27 | 3.65 | none |

Plus two recordings that are not memos of interest: the first `r1-03` attempt (56 s capture that came back `empty_capture`, D2) and the
silent recording it triggered (`38d910f1`, 101.4 s of audio, `silent_audio`, FAILED@transcribe, nothing spoken\*). 18 recorded memos in all.

\* Corrected after the blind review: r3-a's `audible 80.02` is the `ack:sent` tail sounding 117 ms into the reply (overlap check 6
info), not the reply; r3-a played all 5 of its hold cues (the analyzer cut `progress_started` at 4); `38d910f1` failed `silent_audio`
over 101.4 s, not `empty_transcript` over 112 s. r4-a's answer itself had a content slip: it said "still twenty-nine" agents but
its list added up to 32 ("...and about nineteen more").

Reading the latency column: logcat `start reply` and the pad's beacon agree within 0.1-1.5 s (the beacon trails by the push/HTTP
round trip; r1-02 1.47 s); audible trails `start reply` by 0.5-2.0 s (r1-01 1.85, r1-02 1.93, r3b-b 1.36; corrected after review,
the first draft said 0.1-0.7 and 0.4-0.5). Fast-desk answers that were not queued behind anything (r1-01, r1-02, r1-05,
r1-06, r3b-a, r3b-b, r5-c; n=7): stop -> `start reply` 6.8 / 7.3 / 7.5 / 9.4 / 11.7 / 12.4 / 12.9 s (p50 9.4, max 12.9); stop ->
beacon p50 10.0 / max 14.2; stop -> audible p50 10.4 / max 14.8. The sub-3 s desk calls land at 7-8 s audible, the 6-7 s desk calls at
13.5-13.6 s. r1-01 is the slow outlier of the set (host load 52-64, `stop -> upload` 6.3 s against 1.2-2.4 s for the rest). Voice
tool memos (`Use X voice`) are 3.1-3.7 s audible when nothing is ahead of them.

## Scenarios

### R1: four conversational questions answerable from the card (r1-01, r1-02, r1-05, r1-06): PASS (latency, cue); defect D1 elsewhere

All four were answered by `auto/fast` (glm-5.3, 2.5 / 6.7 / 3.0 / 2.8 s), content from the card (Holocene is a sink and does not publish,
production-first rule, roster of 29 agents). Hold cue: only the desk calls over 3 s got one (r1-02 at +5.9 s after stop = 3.0 s into
the desk call; r5-c and r3b-a likewise); the 2.5-3.0 s calls got none. **Every cue that played started before that memo's answer**, none
after (checked for all memos: each `start progress` precedes `start reply`; r3a-b's cue was queued behind a reply and dropped on
`memo_final`). The cue plays 0.2-1.3 s after upload. My first replacement questions for r1-03 and r1-04 were badly chosen (see
"Limits"); they are in the table because they ran.

### R2: delegation exactly-once: **NOT RUN**

Needs a memo that reaches Hermes (the delegation dispatch). The full-agent budget (2) was already used up by then. The live
delegation path is therefore unverified by this run; the last proof remains `evidence.md` S9 and the unit tests. No `Send it.` was
spoken, nothing was dispatched as a delegation, nothing to clean up.

### R3: barge-in during a fast reply: PASS (r3b-a / r3b-b)

`r3b-a` (fast reply, 3 chunks) started at +9.44 s; the new recording was started 2.9 s later (tap press 1792711119.96). The arbiter
halted the reply (`halt reply stopped` at +12.75 s), and the pad's playback beacon for that reply key says
`phase:"skipped" error:"barged_in"` (proxy log, 23:18:41Z). After the note, `r3b-b`'s own reply played (6.8 s) and **r3b-a's reply
was never replayed** (no `start`/`queued reply` for memo 0f75e05e after the halt, in logcat or the tap). The two earlier attempts
(`r3-a`/`r3a-a`) fell through to the full agent (D1) and are not valid barge-ins of a fast reply; in `r3a-a` the barge halted the
agent's reply and that agent reply was replayed after the note (the pre-existing S9 behaviour for agent results).

### R4: cue vs recording: PASS (r4-a / r4-b)

Roster question (desk 6.0 s); the next recording was started 3.54 s after the stop (arming prompt 3.3 s, mic `recording` at +7.05 s,
idle at +12.6 s). The "Hold on." cue was uploaded at +5.07 s, in the middle of arming, and **never queued or played** (no speech event
for `ba95e3fb` before the answer; the pad dropped it, `mayPlayProgress`). Nothing played during the note or after it except the
answer, which started at +16.59 s, after the note's stop cue.

### R5: voice switch: PASS (+ finding D4)

- `Use Morgan voice!` -> tool `car_set_voice`, "Switched Holocene PM to Morgan." spoken in morgan (`voiced_voices ["morgan"]`).
- Next reply (`r5-c`) in morgan, and its hold cue was a morgan clip (`hold_cue ... voice:'morgan' text:'Hold on.'`, played +5.8 s).
- `Use Rick Voice.` -> "Switched Holocene PM to Rick." (rick). The flag file then still held `tiles: {holocene-pm: {voice: rick}}`
  (D4); `mise run memo:voice holocene-pm --clear` -> flag file `tiles: {}`, `memo:converse status` "tiles (none ...)".

### R6: kill switch: **NOT RUN**

The old interactive path is a full agent turn, and the budget was gone. `memo:converse off` was never issued: the live mode stayed
`on` throughout.

## Overlap audit (whole window 1792710100-1792711400; 95 utterances, 18 app recordings, 18 OS capture windows, 94 HAL mix windows)

All 6 checks ran, with the speaker tap ([`overlap-tap-offset-160.txt`](runs/final/overlap-tap-offset-160.txt); offsets -145 / -160 / -175 give the same result).

| tolerance | 1 speech x speech | 2 speech x recording | 3 HAL mix x OS mic | 4 audio x mic open | 5 audio with no owner | 6 tail into next |
|---|---|---|---|---|---|---|
| 60 ms (tap) | PASS 0 | **FAIL 1 (24 ms)** | PASS 0 | PASS 0 | PASS 0 | PASS 0 |
| 100 ms (tap) | PASS 0 | PASS 0 | PASS 0 | PASS 0 | PASS 0 | PASS 0 |
| 60 ms (logcat only) | PASS 0 | **FAIL 1 (24 ms)** | PASS 0 | - | - | - |

The one flag is the same artefact documented in `evidence.md` (post-fix window): the pad's own `ack:stopped` cue started at
1792710151.189, 46 ms after the app's mic went idle (`mic=idle` 151.143), while the OS audio-recording dump logged the capture as ended
at 151.273 (130 ms after the app released it; the dump lags under load). Not a fast-desk utterance over a note. Check 6's info lines
show the stop tone -> sent tone and progress -> echo hand-offs sounding 4-52 ms into the next utterance and then silence, as in earlier runs.
So: zero true overlaps; one 24 ms flag at 60 ms tolerance, none at 100 ms.

## Defects

**D1 (major): `auto/fast` returns `empty` / `bad_json` after ~10 s for long-answer requests, and the turn falls through to the full
agent.** r3-a ("Walk me through the Holocene serving path and the change workflow, step by step, in some detail"): one attempt, 9 871 ms,
HTTP 200 served by glm-5.3, outcome `empty` -> `all_routes_failed`. r3a-a ("Explain in detail, in a few sentences, what the Fast Desk
does, how drafts work, and how sending to an agent works. Take your time."): one attempt, 11 190 ms, HTTP 200, outcome `bad_json`.
~~That second prompt is the s10-a prompt that took 1.1 s and 258 chars earlier today~~ (invalid comparison: s10-a ran on
`automaticai/mistral-allowance/ministral-14b` via the old ladder's r3m, not glm-5.3). **Cause (found in review, confirmed by the
gateway token log): both calls stopped at exactly 700 completion tokens, the watcher's own default `max_tokens`, with ~698 of
them reasoning; auto/fast serves this token glm-5.3 at rung 3 / tier strong / effort xhigh -> effective `max`.** Not a gateway
output cap and not the 14 s budget. Fixed below ("Fixes"). A single attempt is
made (`attempts:1`); there is no retry inside the budget. Cost: a card-answerable conversational question became a full agent turn,
first answer at 62-80 s instead of 8-13 s, plus 4-5 hold/keep-alive cues. Suspects: `services/inbox-watcher/converse.py` (budget
and retry on `empty`/`bad_json`, the reply-length instruction) and the gateway route's output cap. Evidence: `runs/final/turns.jsonl`
(`attempt_log`), `runs/final/out/out-r3.txt`, `out-r3a.txt`.

**D2 (minor, load-related): a lost stop tap, then a 56 s capture with audible levels returned `empty_capture`.** `r1-03` (first
attempt): the stop tap 1 s after the utterance (paplay ended 282.85, tap 283.85; the first draft said 3 s) left the app at
`mic=recording` for 51 s, but the OS capture ended 0.45 s after the tap (284.296): the native MediaRecorder most likely stopped or
died without the app noticing (no `OnErrorListener`), and `stop()` on it threw and handed back nothing (review finding; the
"1 158 overrun warnings" of the first draft are not in the committed logcat, 0 lines). The next tap stopped it and the pad reported `record_failed code:"empty_capture" error:"native
recorder returned no audio" duration_ms:55990 peak_dbfs:-3.5 rms_dbfs:-21.1`: the capture had signal but the native recorder handed
back no audio. The car said nothing about the failure (only `ack:stopped`), so a driver would believe the note was sent. Evidence:
`runs/final/record_failed.jsonl`. I cannot tell a lost stop tap from an `adb input tap` dropped under host load, so only the second
half is filed as a product issue. Suspect: the pad / native recorder path (`apps/agent-pad`, Kotlin recorder), not investigated.

**D3 (minor, tooling): `mise run auto:sim:mic-check` is INCONCLUSIVE** (probe never reports; twice today and in the ladder run). The mic
path works (every memo transcribed correctly), so the check gives no signal on this sim state. Not chased.

**D4 (minor): the spoken reset "use rick voice" leaves a tile record.** After `Use Rick Voice.` the flag file still has
`tiles: {holocene-pm: {voice: rick}}`; only `memo:voice holocene-pm --clear` restores `tiles: {}`. Functionally identical to the
default, but it is not a reset, and `memo:converse status` shows a tile line until cleared. Suspect: the `car_set_voice` skill's
handling of the default voice name.

**Observation, not filed as a defect (O1): a fast reply is held behind the previous memo's reply/keep-alives.** In the three barge
cases the new note's reply had its TTS ready (`stage tts` done at +16.4 / +11.7 / +7.0 s) but `stage replied` took 22.1 / 22.2 / 19.0 s,
and the reply played 37.2 / 32.8 / 25.1 s after stop (r3-b, r3a-b, r4-b). That looks like the per-conversation order (the older memo's
reply or keep-alive plays first, and `r4-a`'s reply is 20 s long), which is by design, but it means a voice command spoken just
after a slow question is confirmed 25 s later.

## Fixes and re-run (2026-10-22, 20:00-20:35 EDT; commit `e98d65d`)

The blind review's findings, each with what was done. Code: watcher (`converse.py`, `memo_trace.py`, unit), upload proxy, agent
pad, `sim_mic_check.py`. No Kotlin (those items are listed for v14). Tests: watcher 439 OK, proxy 114 OK, pad tsc + 75 tests +
vite build OK, mic-check 14 OK. Deployed at idle: watcher restarted 20:17:18 EDT (daemon-reload; `MEMO_CONVERSE_REASK_MIN_S=2.5`
in the unit), `agent-pad-upload` recreated 20:17, pad bundle `index-CSkfGx9F.js` served at agent-pad.delo.sh (live bind mount).
hermes-gateway not touched.

| finding | verdict | what changed / why not |
|---|---|---|
| D1 (major) long answers fall to the full agent | **fixed** | Cause confirmed (review): 700 completion tokens = the watcher's default `max_tokens`, ~698 of them reasoning; auto/fast serves this token glm-5.3 at effort `max`. The review's proposed fix does **not** work, measured: an explicit `reasoning_effort: medium` is logged by the gateway as requested `xhigh` / effective `max` (auto overrides it), and `max_tokens` 1200 only moves the failure to a 12 s timeout or a cut at 1200 (3 of 12 failed, [`runs/fix/d1-bench/2-*`](runs/fix/d1-bench/)). What works, measured through the watcher's own `Desk.decide` on the live route ([`tools/d1_bench.py`](tools/d1_bench.py)): (1) a rule that a long/detailed request gets the short version and no long deliberation: 6 of 6 long-answer calls answered, 4.1-8.4 s, reasoning 189-506 tokens, against 3 of 6 cut at 700 with the old rules; (2) one bounded re-ask of the last rung on the same route (no pinned model) when the answer is `truncated` (`finish_reason` length) / `empty` / `bad_json` and at least 2.5 s of the 14 s budget is left: 7 of 7 re-asks answered in 2.9-5.1 s (total 7.9-14.0 s). A length cut no longer counts against the breaker; attempts now log `finish_reason`, `completion_tokens`, `reasoning_tokens`, `reask`. |
| Barge-in pages the phone (review, major) | **fixed** | The proxy no longer turns the pad's `skipped`/`barged_in` beacon into `audio.memo.failed` (it logs `playback_fact_skipped`); the car's `notified` halt fact records the halt. ntfy-router (bloodbank) left as is: nothing reaches it now. |
| D2 empty capture said nothing | **fixed (pad part)**; root cause **left for v14** | Pad: the `!b64` branch now emits host `silent` ("Nothing heard, not sent.", ERROR tone; it answers the open `stopped` note) and leaves the recording phase. The review's cause (MediaRecorder died without an `OnErrorListener`, `stop()` threw) is Kotlin (`NativeRecorder.kt`): v14. A watcher failure after the SENT tone (`stage=failed`, e.g. `silent_audio`) is still not spoken: the existing host events either lie ("can't be reached") or consume the next note's token (`noteAnswered`), so it needs a new host event: v14. |
| D3 mic-check INCONCLUSIVE | **fixed, verified** | A probe the app refuses while driving now prints `REFUSED ... sim_car.py park` at once. Live 20:32: `REFUSED: the car is driving (host restricted) ...` (was INCONCLUSIVE after 45 s). |
| D4 "use rick voice" pins the default | **fixed** | `memo:voice` (the skill's verb) and the built-in tool clear the tile when the resolved voice is the watcher's default. |
| O1 reply held 25-37 s behind an older reply | **left** (decision) | The review is right that it is the pad's reply queue (sorted by reply key), not the watcher. Whether a voice-command confirmation may jump an older memo's reply is a product decision; not changed. |
| ACK lost to `focus_denied` (3 of 16) | **left: Kotlin, v14** | `SpeechArbiter.kt` retries focus only for ECHO; add one retry for ACK and capture `HoloceneWheel`. Seen again in the re-run (f2-b's hold cue and first reply attempt ended `error:focus_denied`; the reply was re-queued and played). |
| Dead air between reply chunks | **left: Kotlin, v14** | `ReplyPlayer.kt` prepares each chunk only when the previous ends; prepare ahead + `setNextMediaPlayer`. Seen again (f7: 6.8 s and 11.4 s between `chunk next` lines at load 91). |
| Factual slips (7) | **fixed** | Corrected in place above (marked \*). |
| hermes title generator 400 (effort below medium) | **left** | Outside Holocene (hermes-gateway profile); no gateway restart allowed in this pass. |

### Re-run on the sim (8 memos, 20:18:20-20:31 EDT, `runs/fix/sim/`)

Host load **88-100** for the whole re-run (other agents' builds), against 18-55 in the run above; 6 of 8 transcripts were
garbled ("Use Morgan voice." -> "Boots.", "Use Rick voice." -> "Use your voice!", "...count how many test files..." -> "test
boxers", "Please have the PM count the unit tests..." -> "Flip, PM, pump the S in the inbox, walk back."). The first memo had no
lead-in (`LEAD_IN_S` unset; 1.76 s of audio); the rest used 2.5 s.

| id | memo | heard | result |
|---|---|---|---|
| f1 | f2ec92d9 | "Boots." | fast clarifying question (wasted; no lead-in) |
| f2-a | 0903722e | the Holocene one-sentence question | fast reply in **morgan** (tile set with `memo:voice` first), desk 2.9 s, reply started +9.5 s; **halted** at +12.69 s by f2-b's recording (+12.43 s), **not replayed** |
| f2-b | 78866e3f | "Use your voice!" | tool `car_set_voice` (model, args `default`) -> "Holocene PM is back to the default voice.", flag file `tiles {}` |
| f3 | 588732fc | "...test boxers..." | fast clarifying question |
| f4 | a02c6f9f | (kill switch off) | **old path**: no converse stage, **no routed fact**, interactive dispatch, agent 25 s, COMPLETE 30 s |
| f5 | 3fb68ef8 | "Flip, PM, pump the S..." | (switch back on) **routed**, path fast, clarifying question |
| f6 | 7a0dc108 | "Yes, that's right." | desk chose `direct` (it tied the yes to the agent's earlier "Did you mean what is Holocene working on?"): full agent, quick answer + its own BACKGROUND follow-up (runs the watcher tests; batch lane) |
| f7 | f3e3e305 | "Walk the path and the change workflow step by step in some..." | **fast reply**, desk 7.8 s (606 tokens, 535 reasoning, `finish_reason` stop, no re-ask needed), reply started +21.3 s (TTS 13.6 s at load 91), 4 chunks |

- **D1 / R1: PASS.** The final run's r3-a prompt now gets a card answer from the desk (7.8 s) instead of falling to the agent
  (first answer 80 s before).
- **R3 (barge-in) after the proxy fix: PASS.** f2-a's beacon `skipped`/`barged_in` at 00:20:14.944Z was logged
  `playback_fact_skipped`; f2-a has no `audio.memo.failed` (types: received, uploaded, transcribed, routed, voiced, replied,
  played, notified); `memo:trace` says **COMPLETE** (it said FAILED `fact:failed[playback]` before); `bloodbank-ntfy-router` routed
  no `audio.memo.*` event in the whole window.
- **D4 / R5: PASS with a caveat.** The spoken "Use Rick voice." was heard as "Use your voice!", so the model passed `default` and
  the tile was cleared that way. The rick-by-name path was then run on the live flag file through the real skill script
  (`car-set-voice/scripts/set_voice.py --voice Rick`, the same entrypoint the desk runs): morgan -> `tiles {}`. Unit tests cover
  both the skill verb and the built-in tool.
- **R6 (kill switch): PASS.** `memo:converse off` -> f4 took today's path (no converse stage, no routed fact, dispatched on the
  interactive lane); `memo:converse on --agents '*' --devices ''` -> the next memo (f5) was routed by the desk.
- **R2 (delegation exactly-once): NOT RUN to the end.** No draft was ever read back: two work requests were misheard (f3, f5,
  each answered with a correct clarifying question), and the "yes" (f6) was routed `direct` by the desk, which spent the second
  of the two allowed full-agent turns (f4 was the first). Nothing was delegated (no `audio.memo.delegated`); f6's agent started
  its own answer-then-background follow-up instead. That follow-up finished and was spoken 323.5 s after the quick answer (`memo:trace` COMPLETE); all 8 memos
  trace COMPLETE, nothing stuck. Exactly-once therefore still rests on the unit tests and the earlier live
  proofs (`evidence.md` S3/S4: 5 briefs, 1 journal row each, 6 repeats published nothing; h-01..h-05).
- R4 not re-run (no fix touched it). D3 verified with `auto:sim:mic-check` (REFUSED), not a memo.
- Live config at the end: flag file `{mode: on, agents: "*", devices: [], tiles: {}}`, no routes override, `memo:converse status`
  routes r1=automaticai/auto/fast, budget 14 s. hermes-gateway not restarted.

## Limits, said plainly

- **Full-agent budget exceeded: 4 memos reached a full agent turn against the limit of 2** (r1-03, r1-04, r3-a, r3a-a). Two were my
  test design: "Which commit message style does this project use?" is not on the card, so the desk correctly chose `direct` (same
  as `s1-a11`); and "What does the fast desk do compared to the full agent?" contains "full agent", which is the force-direct phrase
  (`FORCE_DIRECT_RE`), a lexicon route working as designed. Two were D1 (the fast route failing). Having passed 2, I stopped
  running anything that could reach an agent, which is why R2 and R6 were not run. They need the next budget.
- Memos recorded: 18 of 18 allowed (the lost r1-03 capture and the silent 112 s stray count). Wall clock 26 of 40 min. No timer wait
  over 60 s. The R3/R4 timings are one run each.
- `stop -> first audible` is measured from the stop *press*; the pad's stop cue and tone are part of what follows it. Not
  comparable to the phase-2 table, whose numbers were contaminated by overlapping replies.
- Live config left as found and verified: flag file `mode on`, agents `*`, devices `[]` (any car), `tiles {}`; no routes override
  (`routes r1=automaticai/auto/fast` from the unit). Voice was set to morgan and reset (`--clear`). The sim, the watcher and the
  upload proxy were not restarted. Tap and logcat loop stopped.

## Files

`runs/final/`: `turns.jsonl`, `final-table.json`, `table.txt`, `out/` (per-turn driver output), `watcher-events.jsonl.gz`,
`proxy.jsonl.gz` (agent-pad-upload log incl. playback beacons), `speech-logcat.txt.gz` (HoloceneSpeech + audio focus + OS capture
lines), `speaker-tap.jsonl.gz`, `overlap-*.txt`, `record_failed.jsonl`, `analyze_final.py`, `runturns.sh`. Harness: `tools/final_driver.py`,
`tools/final_r3.py`, `tools/final_r4.py`.

Rerun the audit: `zcat runs/final/speaker-tap.jsonl.gz > /tmp/tap.jsonl; zcat runs/final/speech-logcat.txt.gz > /tmp/l.txt;
python3 apps/auto/tools/speech_overlap.py --logcat /tmp/l.txt --tap /tmp/tap.jsonl --offset-ms=-160 --tol-ms 60 --from 1792710100 --to 1792711400`.

## R2 delegation (final build): **NOT PROVEN** (2026-10-22 20:37-20:58, 6 of 6 memos used, step 1 reached once)

Harness: `tools/final_driver.py` via `runs/r2/memo.sh` (load gate: wait while 1-min load > 40, 600 s total budget; lead-in 2.5 s).
**The load never dropped below 40** (105 at start, 75 after the 600 s wait, 72-77 for the rest), so the gate's 10-minute wait was spent
on memo 1 and every later memo ran at load 72-78 (`runs/r2/load.log`). Time used about 21 of 25 minutes. One delegation was allowed
to reach an agent turn; **zero delegations happened** (no `audio.memo.delegated`, no `Send it.` was ever spoken), but one memo did
reach a full agent turn by accident (r2-01, below).

| memo | id | heard | routed | facts / timing |
|---|---|---|---|---|
| r2-01 | 9bc4a882 | "Have Holocene write a one-paragraph summary **of the future** and report back." (PM and "hold cue feature" misheard) | `direct`, path `fallback`, `fallback_reason all_routes_failed` (r1 `timeout` at 12.0 s, load 76) | **full agent turn**: 1 `audio.memo.dispatched` (interactive lane, no followup, command 1759ebdf, holocene-pm); gateway journal row `completed/success/interactive`. Echo/progress cues `focus_denied` on the sim. I cancelled with `memo:cancel` (agent had already started; trace: CANCELLED after dispatch, reply not spoken). This consumed the agent-turn allowance without proving anything about R2. |
| r2-01b | ae87f1a1 | "Right." (7.6 s utterance, 2.2 s heard: first words clipped) | `reply` fast, glm-5.3, 10.8 s | "Understood. Anything else you want Holocene on?" (reply to a fragment, nothing dispatched). Re-record of the same step. |
| r2-01c | 1024680a | (nothing) | none | `audio.memo.failed[transcribe] silent_audio`: the sim mic delivered no sound (lead-in 6 s). Re-record attempt. |
| r2-01d | - | - | - | the mic never reached `recording` within 25 s after the Record tap (no HoloceneSpeech mic lines at all for the tap); **no memo created**. `auto:sim:mic-check` said INCONCLUSIVE (probe reported nothing). Screen showed READY. |
| r2-01e | - | - | - | same: tap delivered (IME restarted for the app), no mic arming, **no memo created**. |
| r2-01f | 7e263bcf | "Have Holocene PM write a one-paragraph summary **of the whole queue back**." | **`propose`**, fast, glm-5.3 r1, 10.9 s, `conv_turn 3`, tile holocene-pm, perm read_only | desk said "Draft for Holocene PM: Summarize the car work queue. Read-only. Say send it, or tell me what to change." (deterministic read-back format, correct). **dispatched 0, delegated 0** (Candystore types: received uploaded transcribed routed voiced replied played narrated notified). Reply started at +17.2 s, COMPLETE 17.0 s. The conv has `pending draft: 'Summarize the car work queue' for Holocene PM (read_only), brief de1a672b`. |

### What this shows

- **Step 1 (propose, read-back, nothing dispatched): observed once** (r2-01f), with a transcript that was not the requested sentence ("hold
  cue feature" came back as "whole queue back"), so the draft is a different task than the one I asked for. Format and the
  no-dispatch property held.
- **Steps 2, 3, 4 (`Send it.`, `Send it.` again, `What did it find?`): NOT RUN.** The 6-memo limit was gone: three memos were
  spent re-recording step 1 (r2-01, r2-01b, r2-01c), and r2-01d/e made no memo but the sim mic stopped arming, which would have
  blocked them anyway. Exactly-once (1 dispatched, 1 delegated, 1 journal row, the "Already sent" repeat) is still unproven on the final
  build; the last proof remains `evidence.md` S3/S4.
- **Two new observations, not fixed (not product-code work for this pass):**
  1. Under load 72-105 the desk's r1 call timed out once (r2-01: 12.0 s budget 14 s, `all_routes_failed` -> `direct`) and the
     work request went to a full agent turn instead of being proposed. The same sentence proposed fine at load 72 in r2-01f (10.9 s).
     A timed-out desk call on a work request therefore bypasses the propose/confirm gate: that agent turn was a plain interactive dispatch.
  2. The sim mic stopped arming after the silent capture (r2-01c): the Record tap was delivered but no `HoloceneSpeech: mic` line
     followed for ~2 minutes. It came back by itself for r2-01f. Cause not investigated.
- **Left behind:** a pending draft (brief de1a672b, "Summarize the car work queue", read_only) on conversation 83bbebf2 for holocene-pm. It was
  not sent and nothing about it was dispatched; it expires or is replaced by the next turn. The r2-01 agent turn completed in the
  gateway (`completed/success`) after I cancelled it; its reply was not spoken.
- Live config at the end: flag file `mode on`, agents `*`, devices any car, routes `r1=automaticai/auto/fast`, tiles none, no override.
  hermes-gateway, watcher and proxy not restarted. Emulator only.

Next attempt needs: load under 40 (or a desk budget that survives it), a 6-memo budget with the memos spent on steps 2-4 only, and a
checked mic (`auto:sim:mic-check` OK) first. Files: `runs/r2/` (`load.log`, `memo.sh`, `out-r2-01*.json`, `r2-01*.line`, `speech-logcat.txt.gz`).

## R2 delegation, injected memos: **PROVEN** (2026-10-22 21:06-21:11 EDT, 5 of 7 memos, load 110-126 throughout)

Method: the emulator mic was bypassed. Each utterance was synthesized with vox (`ttfa/round2/tools/synth.py`, voice rick), encoded to
Ogg/Opus 48 kHz mono (0.4 s lead-in and tail), and written straight into MinIO as the car's upload proxy stores it: key
`inbox/holocene-pm/<yyyy>/<mm>/<dd>/<yyyymmddTHHMMSS>Z.ogg`, content-type `audio/ogg`, object metadata
`X-Amz-Meta-Holocene-Device: e1c40830-9802-420f-98b9-d06be3f51b74` and `X-Amz-Meta-Holocene-Host: car` (same shape as the sim memo 7e263bcf,
written with `mc cp --attr` exactly as `upload_proxy.py` does). Tool: `runs/r2-injected/inject.py`. The desk treated every memo as a car
memo for holocene-pm on conversation 83bbebf2. Only inbox objects were written: no emulator contact, no restart of
hermes-gateway / watcher / proxy. Wall time about 5 min of the 30 allowed; load stayed 110-126 and the desk (glm-5.3 on r1) answered both LLM turns in 8.9-9.0 s,
so the load did not cause a fall-through this time. Memos went one at a time, each after the previous one's `replied` fact.

| step | memo | heard (transcript) | routed | facts |
|---|---|---|---|---|
| 0 | 92d78b0e | "Cancel that." | `cancel`, `cancel_only` (lexicon, no LLM, decide 32 ms), conv turn 4 | "Dropped. Nothing was sent." Pending draft (brief de1a672b) gone: `memo:conv` says `pending draft: none`. 0 dispatched, 0 delegated. |
| 1 | 66b71187 | "Have Holocene PM write a one-paragraph summary of the **Hold Queue** feature and report back." | `propose`, `fast`, glm-5.3 on r1, 8961 ms, turn 5, perm read_only | read-back "Draft for Holocene PM: Summarize the Hold Queue feature. Read-only. Say send it, or tell me what to change." Brief 4bd48069. **0 dispatched, 0 delegated**; types received transcribed narrated routed voiced replied. |
| 2 | e38fbecd | "Send it." | `confirm`, `confirm_only` (no LLM call, decide 18 ms), turn 6 | "Sending to Holocene PM: Summarize the Hold Queue feature. I'll call you back." **Exactly 1 `audio.memo.dispatched`** (followup 1, lane `batch`, lane_reason `voice_delegation`, model sol-6.1, command 251cdf53-01ec-5b18-88bf-6e77fa8fc8fc, prompt 1783 chars, dispatch 199 ms), **exactly 1 `audio.memo.delegated`** (same command id, brief 4bd48069), **exactly 1 gateway journal row** for that command id (profile holocene-pm, lane batch; `started` at +0.1 s, `completed/success` at 01:09:57). The command id equals `uuid5(urn:33god:holocene:converse, "delegation:4bd48069-...")` (recomputed). Journal total 1093 before -> 1094 after: the one new row. |
| 3 | 401826e4 | "Send it" | `confirm`, `confirm_only` (no LLM), guard `already_sent`, turn 7 | "Already sent to Holocene PM: Summarize the Hold Queue feature. I'll call you back with the result." **0 dispatched, 0 delegated**, journal still 1 row for the command id, total still 1094. |
| wait | e38fbecd followup 1 | (agent turn) | - | agent invocation started 01:08:53, completed 01:09:57 (64.9 s, `completed/success`); follow-up `replied` (late, followup 1, 633 chars, reply chunks 3) at 01:10:21.8, 102 s after the dispatch; `memo:trace` VERDICT COMPLETE, "follow-up 1 spoken 108.8s after the quick answer". Result: "The matching feature in the repo is called "Hold cue," rather than "Hold Queue": it replaces silent waits in the car with short spoken acknowledgments ..." (the agent corrected the mis-transcribed name). |
| 4 | 1ef40f78 | "What did it find?" | `reply`, `fast`, glm-5.3 on r1, 8909 ms, turn 8 | fast reply from the stored result: "The feature is actually called Hold cue. It fills silent waits with short spoken acknowledgments like "One sec" or "Still thinking," played after about three and nine seconds ..." **0 dispatched, 0 delegated, no new journal row (1094 before and after)**: no agent turn. |

Totals over the whole run: **1 dispatched, 1 delegated, 1 journal row, 1 Hermes agent turn** (the delegation); every other memo stayed on the
desk (two lexicon-only confirms, one cancel, one propose, one fast reply). Exactly-once on the final build: PROVEN (steps 2 and 3).

Timings (put -> routed / put -> replied): s0 0.8 / 21.8 s, s1 10.1 / 33.1 s, s2 1.5 / 23.5 s, s3 1.0 / 24.0 s, s4 10.2 / 33.2 s. The `replied` fact lags
`routed` by about 20 s on the lexicon paths because the car sent nothing to claim the reply and the **Earshot phone-mirror grace** ran
(`earshot_wait_seconds` 19-21 s, `phone_copy_decision`, `EARSHOT_CAR_GRACE_S` 20 s, inbox_watcher.py step_mirror); vox TTS was not the lag (the first audio chunk
of s2 was up at +3.6 s). *Corrected in "R2 follow-ups" below (F1).*

Notes and defects:
1. **Phone playback happened.** No car claimed anything, so after the grace the phone mirror played every desk reply and the follow-up on the
   S26 through Earshot (agent-pad-upload `heard` phase started/finished for all 6 reply objects, `runs/r2-injected/earshot-phone-playback.txt`;
   `memo:trace`: `phone_decision` mirrored, `earshot_reason no_car_claim`).
2. **Transcript drift, not a desk defect:** whisper heard "hold cue" as "Hold Queue" from the synthesized voice (the homophone), so the draft
   was "Summarize the Hold Queue feature". The delegated agent noticed and answered with the real feature name. Step 4 carried the right name back.
3. The injected memos have no `audio.memo.uploaded` fact and no proxy log line (`memo:trace` marks both optional/MISSING) because they bypass the
   upload proxy; the watcher picked them up by its inbox poll (lag 0.27 s on s2).
4. The emulator-mic fall-through seen earlier (a timed-out desk call on a work request becoming a plain agent turn) did not recur: both desk
   LLM calls succeeded at load 110-126 in 9 s. Still an open risk under worse load; not retested.
5. No product code changed. Live config as found at the end: flag `mode on`, agents `*`, devices any car, handoff named, routes `r1=automaticai/auto/fast`,
   tiles none, no override; the conversation has no pending draft and one finished delegation (251cdf53).

Files: `runs/r2-injected/` (`inject.py`, `out-i0-cancel.json` ... `out-i4-found.json`, `candystore-facts-all.json`, `journal-before.txt`,
`journal-after-step2.txt`, `journal-before-step4.txt`, `journal-final.txt`, `earshot-phone-playback.txt`, `run.txt`).

## R2 follow-ups (2026-10-22 22:00-22:12 EDT; code commit fba9083, watcher restarted idle at 22:03:42)

The independent check of the PROVEN R2 run found five things. All five are fixed, tested and deployed; F2 and F3 and F4 are proven live below.

| # | finding | fix |
|---|---|---|
| F1 doc | the section above blamed the `routed` -> `replied` lag on TTS | it is the Earshot phone-mirror grace; text corrected in place |
| F2 latency | a confirmed delegation was dispatched only after the read-back's `replied` fact, which waits out the 20 s phone grace when no car claims the line: agent started 22.6 s after "Send it." | `phone_copy_decision(no_wait=True)` for the `Sending to ...` read-back (a memo that carries `delegate`): the offer still goes to the proxy, a car that already started it keeps the verdict, a browser sender is still mirrored, anything else leaves the line to the car (`earshot_skipped=delegation_readback`), nothing is waited for (no grace, no live hold, no unreachable proxy). The command then goes right after the read-back is rendered and uploaded. The delegated RESULT is its own reply and is mirrored the usual way. |
| F2 exactly-once / cancel | publish is now seconds after "Send it.", so a "cancel that" after hearing the read-back is usually late | unchanged: uuid5 command id, draft `sending` -> `sent` under the lock, cancel before publish stops it (`Okay, cancelled before it left`). New: with a delegation sending or running, "cancel that" is a lexicon answer (no LLM) `It's already on its way to X, so I can't cancel it. I'll call you back with the result.`; before, with the draft already spent it fell to the model or "Okay. Nothing was waiting to send.", which would have been false. |
| F3 | a second "Send it." while the first is still `sending` had no pipeline test | `test_a_second_send_it_while_the_first_is_still_sending_publishes_nothing` (read-back held in the voice render, second confirm gets `Already sent`, 1 command total) + guard unit test; also `test_cancel_after_the_brief_was_published_says_it_is_already_on_its_way`, `test_the_delegation_is_dispatched_right_after_the_read_back_not_after_the_phone_grace`, `no_wait` cases in the `phone_copy_decision` tests |
| F4 | the delegated prompt's "driver's own words" carried the last 12 driver turns, withdrawn and failed asks included | a draft now records `built_by` (memo ids of the proposal and each edit; an edit of a proposed draft continues the chain, a new draft starts one). The prompt carries only those turns + the confirmation. A draft from before the deploy (no `built_by`) uses the turns since the last cancel/confirm/end. The stored brief is verbatim, unchanged. `test_the_delegated_prompt_carries_only_the_drivers_words_that_built_this_draft`, `test_draft_turns_are_only_the_ones_that_built_this_draft` |
| F5 | `runs/r2-injected/inject.py` printed `heard: null` (read `text`) | reads `transcript_text`; also new `--put-at <epoch>` to hold the upload for timed back-to-back memos |

### Live proof (injected memos, `runs/r2-followups/` with `out-f0..f5-*.json` facts per memo, 6 memos)

| memo | heard | result |
|---|---|---|
| f0 5ade3616 | "Have the PM look into why the garage door opener is making a grinding noise ..." | **desk r1 timed out (12.0 s) at load 130-164 -> `direct` / `fallback`**: the known fall-through. It ran as a plain agent turn (interactive 112aff66, completed) plus a BACKGROUND batch follow-up (50701f3a). I cancelled the memo (`memo:cancel`) so nothing more is spoken; the batch command was already published and cannot be recalled. It is still an "earlier failed ask" in the conversation, which is exactly what F4 needs. |
| f1 4e8c1c0d | "Have Holocene PM say in one sentence what the whole queue feature does ..." | same fall-through (12.05 s), a second plain agent turn (interactive, trivial, read-only wording). |
| f2 5b2f0094 | same request again | `reply`/`fast` (glm-5.3, 12.0 s): answered from the board with the earlier stored result, no draft. 0 dispatched. |
| f3 517dcec3 | "Please draft a task for Holocene PM, ask it to look up which port the Holocene API service listens on and report back." | `propose`/`fast` (6.8 s): "Draft for Holocene PM: Which port the Holocene API uses. Read-only. ..." 0 dispatched, 0 delegated. |
| f4 08e6c726 | "Send it" | `confirm_only` (28 ms): "Sending to Holocene PM: Which port the Holocene API uses. I'll call you back." **exactly 1 dispatched + 1 delegated**, command `537e470c-a3f9-5ef3-aa47-be3da51b1c2c` = uuid5 of brief b49bc880. `replied` carried `earshot_skipped=delegation_readback`, `earshot_wait_seconds` 0.15. |
| f5 5f0574e9 | "Send it!" put 2.0 s after f4 | `confirm_only` (13 ms): "Already sent to Holocene PM: Which port the Holocene API uses. I'll call you back with the result." **0 dispatched, 0 delegated**, no publish. |

**F2 timing** (watcher journal, `watcher-timeline-f4.txt`): confirm decided 02:10:50.235 -> read-back voiced 02:10:52/54.5 -> phone decision
02:10:54.866 (`earshot_skipped delegation_readback`, no wait) -> `replied` 02:10:55.493 -> `followup_started` 02:10:55.494 -> **`dispatched` 02:10:55.936**.
Confirm to dispatched **5.7 s** (put to dispatched 6.5 s), against **22.6 s** before. The 5.7 s is the read-back's two TTS chunks under load; the
phone grace is no longer in the path. (f5, a plain `Already sent` line that is not a delegation read-back, still waits its grace: `replied` 17.4 s, as before and by design.)

**F4 prompt check.** The conversation held 3 earlier driver turns (the garage door ask f0, the "one sentence" ask f1, its reply f2). The delegated prompt
(`delegated-prompt-from-watcher-state.txt`, sha256 equal to the dispatched fact's `prompt_sha256`) has "The driver's own words" =
`22:09:46 "Please draft a task for Holocene PM, ask it to look up which port ..."` and `22:10:50 "Send it"` only; no garage door, no
hold cue. The stored brief is above it, verbatim.

**Gateway outcome: NOT reached within the window.** Exactly-once is proven on the publish side: 1 `dispatched`, 1 `delegated`, 1 emit of command
537e470c, and the duplicate "Send it!" published nothing (no `dispatched`/`delegated` fact and no command emit for f5; the watcher's `delegation_sent` fired once). But the
gateway had written **no `executions` row** for 537e470c by 02:40 UTC (30 min after the 02:10:55 publish), so no Hermes turn has run and there is no first
user message in the holocene-pm `state.db` to compare. The batch lane was occupied the whole time by other profiles' runs
(`green-in-between-pm`, a new `started` batch row every few minutes, none for holocene-pm; the stray f0 follow-up 50701f3a published 02:05:51 is queued
the same way). The F4 check therefore uses the prompt the watcher pinned and published: `delegated-prompt-from-watcher-state.txt`, its sha256 equals the
`dispatched` fact's `prompt_sha256` (the watcher refuses to send a prompt that differs from the pinned one, `_prompt_for_send`). If the gateway
later runs the command, its first user message is that file; verify with
`sqlite3 ~/.hermes/profiles/holocene-pm/state.db` / `sqlite3 -readonly ~/.hermes/bloodbank-hermes-gateway-state.sqlite3 "select * from executions where command_id='537e470c-a3f9-5ef3-aa47-be3da51b1c2c'"`.
Not retried and not worked around (no gateway restart, no second publish).

### Notes
1. **The desk fall-through is real under this load and cost two stray agent turns** (f0, f1; r1 12 s budget, load 130-164 from other
   processes: qemu, uvicorn, a scoring job). It is the open risk already noted in "Two new observations"; the propose/confirm gate is bypassed when the
   desk times out. Not changed here (config left as found). Stray work: f0's batch follow-up 50701f3a is queued in the gateway behind another profile's
   long batch run and may still run; its result is not spoken (memo cancelled). f1 was a read-only one-sentence question.
2. The batch lane was backed up behind other profiles' batch runs, so the delegated agent has not started (see "Gateway outcome"): that is the
   gateway queue, not the watcher; the metric for F2 is confirm -> `dispatched`. Worth its own look: a voice delegation waits in the same FIFO as
   overnight batch work.
3. Live config at the end: flag `mode on`, agents `*`, devices any car, handoff named, no routes override, tiles `{}`. hermes-gateway, proxy and
   emulator not touched; only the watcher was restarted, at idle.
4. Tests: full suite 448 tests (`cd services && python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'`) at load 170: 441 pass, 7 timing failures
   (6 in `test_hold_cue` DeskWait/FallThrough, `Pipeline.test_26`), all of which pass when re-run alone (`test_hold_cue` 22/22 in 36 s, test_26 in 2 s): load flakes, not the change.

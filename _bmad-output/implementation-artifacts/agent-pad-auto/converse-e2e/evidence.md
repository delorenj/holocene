# Fast in-car conversation desk: live proof on the Honda sim (HOLOC-23, MVP step 10)

Date: 2026-10-22, 10:54-13:41 UTC. Simulator `emulator-5554` (HOLOC_9_Honda_API33), windowed, driving mode
(`sim_car.py drive`, UXR restricted), installed app unchanged. Device id of the sim: `e1c40830-9802-420f-98b9-d06be3f51b74`
(the converse flag file is restricted to it). Every phrase was synthesised by vox, played with `paplay` into the
`holo_testmic` null sink, never gRPC injection, never the phone, never `/usr/bin/adb`. Tools: `tools/drive_converse.py`
(+ `s9_*`, `s10*`, `runlist.sh`, `scenario_table.py`, `s1_breakdown.py`, `gateway_rung_bench.py`). `auto:sim:mic-check` was OK
(rms 316) before the run.

## Verdict

| gate | result |
|---|---|
| S1: record stop to first answer audio, p50 <= 8 s and p90 <= 12 s over >= 10 turns | **PASS: p50 7.80 s, p90 10.39 s, max 11.59 s (12 turns).** The car starts the reply at p50 6.81 s. |
| S1/S2/...: `model_answered` is deepseek-v4.1-flash-1017 | **NOT MET.** The Hyper account (the vault item shared with Hindsight) ran out of credit: `402 billing_error "You're out of credits"`. -1017 answered **0** of the 112 routed decisions. A non-Anthropic fallback answered every one: `ministral-14b-latest` via the gateway 39, `gemini-3.5-flash-lite` 36, `k3-256k` (kimi-k3s) 1, the rest no model call (lexicon) or direct. |
| Never Anthropic | PASS. No `model_answered`, no `answered_model` in any attempt log, matched `claude|anthropic|sonnet|opus|haiku|fable|automaticai/auto`. The gateway token `holocene-converse` (id 88) is scoped to exactly 4 routes: ministral-14b, gemini-3.5-flash-lite, kimi-k3s, glm-5.3-flash. |
| Exactly-once delegation | **PASS.** 5 confirmed briefs; each has exactly 1 gateway journal row (batch lane, uuid5 command id), 1 `audio.memo.delegated`, 1 follow-up `dispatched`. 6 further "send it" turns (duplicates, and after an expiry) published nothing. [`runs/delegations.json`](runs/delegations.json). |
| Zero overlaps | **PASS where the speaker tap ran** (periods 1 and 2, below), with two caveats listed in the audit. |

What is proven live: S1-S7, S9, S10, S11, S12 and the draft half of S13. Not proven live: the unnamed-retarget refusal of S8 (unit
tests only) and the `sim_stop.sh` half of S13. Details per scenario follow. The fast path works end to end on the sim; the one
thing that does not hold is the model name, for a reason outside the code (billing).

## What had to be fixed to get here

Nothing in the watcher, API or pad design was wrong, but the live run found these, all fixed, tested and pushed
(commits in the last section):

1. **Hyper is out of credit** (above). The ladder handled it correctly (r1 402 in 60-240 ms, r2 402, next rung), but each memo paid
   about 0.2 s and the breaker reopened every minute. A 402 now opens the rung for **10 minutes** at once.
2. **The gateway rungs were too slow to carry the desk** (kimi-k3s 4-11 s, glm-5.3-flash 7.7 s, so the 8 s budget ran out).
   I benched the fast gateway routes with the card-sized prompt, scoped the two that work onto the `holocene-converse` token and
   put them ahead of kimi/glm as `r3m` ministral-14b (p50 1.0 s, 8/8 valid JSON) and `r3c` gemini-3.5-flash-lite (p50 0.8 s, 4-8 s
   spikes). The rest are unusable here: cf glm-5.3-flash 12.5 s, nvidia-free glm timeouts, agnes 3.3 s with a timeout, zai-free
   and gemini-3.1-flash-lite 503 or timeouts ([`tools/gateway_rung_bench.py`](tools/gateway_rung_bench.py)). The unit, README and
   token scope say so.
3. **Whisper hears "Send it." as "S-Send it!"**, which missed the confirm lexicon and cost a model call plus an "Already sent" line
   about the wrong thing. `norm()` now collapses the stutter.
4. **"I've sent it" was rewritten to "Nothing was sent"** even while a confirmed delegation was running ("how's that going?").
   The sent-claim filter now only fires when nothing is on the board or a new draft is pending.
5. **Small models propose with only `say` + `action`** (no title, no brief): the read-back said "Untitled request". An incomplete
   propose now goes to the next rung (`incomplete_propose` in the attempt log); if nobody does better, the guard builds the brief
   from the driver's own words (`title_from_words`: "Check which tests cover the converse stage").
6. **A draft that timed out answered "Already sent ... <an older brief>"** to the next "send it". It now says the draft timed out
   and nothing was sent. "Send it" with nothing pending is never a new draft called "Send it" and never a direct turn to the full
   agent (found live: the model chose `direct`, which would have sent "Send it" to Sol).
7. **A timeout on one gateway channel skipped every other channel on the gateway** (ministral timing out skipped gemini). A
   timeout now blames the upstream channel (`automaticai/<channel>`), a connect error still blames the host.

## Where the time goes (S1, record stop to answer)

12 turns, one conversation, ministral-14b-latest on r3m. Times are seconds from the Stop press (host clock). `1stStart` is the car's
`HoloceneSpeech start reply`; `audible` is the first speaker-tap packet with rms >= 30 after it.
[`runs/s1-table.json`](runs/s1-table.json), traces in [`traces/s1-NN-*.txt`](traces/).

```
turn   memo       upl  recv  trans  routd   repl 1stStart  audible   llm cached  model@route (conv turn)
s1-01  274e4e9f  4.65  5.16   6.37   8.22  17.82     10.9    11.59  1621      0  ministral-14b-latest@r3m (turn 1, reply)
s1-02  fe84cfc2  0.53  0.65   1.62   2.78   7.03     5.99      6.8  1020   2916  ministral-14b-latest@r3m (turn 2, reply)
s1-03  4c74df67  0.52  1.11   2.09   3.35  10.19     6.97     7.57  1117      0  ministral-14b-latest@r3m (turn 3, reply)
s1-04  a66b53bd  0.71  1.43   2.38   3.44   8.89      5.7     6.34   928      0  ministral-14b-latest@r3m (turn 4, reply)
s1-05  ff987b9c  0.72  1.45   2.42    3.5  10.22      6.6     7.53   928      0  ministral-14b-latest@r3m (turn 5, reply)
s1-06  b92c55e4  0.82  1.72   2.64    4.9  11.46     7.51     8.14  2133      0  ministral-14b-latest@r3m (turn 6, reply)
s1-07  186d8b65   0.5  0.81   1.74    2.5   6.14     5.04     5.63   614   3172  ministral-14b-latest@r3m (turn 7, reply)
s1-08  ff1c670e  0.58   0.8    1.7   3.05  10.05     6.34     7.26  1225      0  ministral-14b-latest@r3m (turn 8, reply)
s1-09  237be94b  2.25  2.63   3.71   5.07   9.58     8.52     9.11  1056      0  ministral-14b-latest@r3m (turn 9, reply)
s1-10  e644ac41  1.72  2.82   3.88   5.83  12.31     9.42    10.39  1614      0  ministral-14b-latest@r3m (turn 10, reply)
s1-11  40cfdcdb  1.65  2.75    3.7   4.62   8.94     8.03     8.73   778      0  ministral-14b-latest@r3m (turn 11, reply)
s1-12  f99cb796   0.8  1.42   2.36   3.51   9.48     6.65     8.04  1019      0  ministral-14b-latest@r3m (turn 12, reply)
audible n=12 p50=7.80 p90=10.39 max=11.59   first-start n=12 p50=6.81 p90=9.42 max=10.90
```

- Every turn is `routed action=reply`, no `dispatched` fact. Turn 1 was slow because it was the first memo after a restart (upload
  4.65 s). From the second turn on the rest of the path is steady.
- The LLM is 0.6-2.1 s. Routed lands at p50 +3.5 s. The remaining ~3-5 s between "routed" and the first sound are TTS (vox, 6
  steps, chunk 1 <= 70 chars, 2.1-2.4 s), upload, the SSE push and the pad's two **ack cues** ("stopped" then "sent": the reply is
  queued `behind_ack` and `waited_ms` is 2.0-3.3 s in every trace). The acks are the pad's existing cues; a fast reply cannot
  preempt them. That is the largest block left and the first thing to shorten for the p50 <= 5 s goal.
- Memory: s1-02 "say that again" repeats turn 1's answer; s1-06 and s1-09-s1-12 name earlier turns correctly.
- Prefix cache: only 2 of 12 calls on ministral report cached tokens (2916, 3172); gemini and ministral do not cache reliably.

## Scenarios

Whisper's transcript is in the second column; these are not the typed phrases (the sim mic path mangles some).
Full per-turn table: [`runs/turns.jsonl`](runs/turns.jsonl) and [`runs/heard.json`](runs/heard.json).

| id | result | evidence |
|---|---|---|
| S1 | **PASS** (latency, behaviour); model criterion not met (above) | table above; traces `traces/s1-*.txt` |
| S2 | **PASS** | `s2-01` "Have the PM look into why the audio spool is disabled and report back." -> `propose`, read-back "Draft for Holocene PM: Why the audio spool is disabled. Read-only. Say send it, or tell me what to change." No dispatched fact. Car started it at +9.4 s. |
| S3 | **PASS** for exactly-once; **audio at 7 s NOT met** | `s3-01` "Send it!" -> `confirm_only`, `lexicon=true`, no model call. "Sending to Holocene PM: Why the audio spool is disabled. I'll call you back." One `dispatched` (followup=1, lane=batch, lane_reason=voice_delegation, command `8bcabbbd` uuid5), one `delegated`, one gateway row (`runs/delegations.json`). The car started it at +7.9 s and it was audible at +10.4 s: the reply waited behind the pad's two ack cues, and a `focus_denied` retry cost 1.2 s in this run. |
| S4 | **PASS** | `s4-01` (heard "S-Send it!") answered by the model (before fix 3); after the fix `s4-01 77270f62` "Send it!" -> `confirm_only`, guard `already_sent`, "Already sent to Holocene PM: Why the audio spool is disabled. I'll call you back with the result." Nothing published; the journal still has one row for `8bcabbbd`. Repeated 5 more times (`s9-03`, `s9-09`, `s13-*`): none published. |
| S5 | **PASS** | `s5-03` "How is that going?" -> `reply`, "Flume PM is checking which tests cover the converse stage ..." from the delegation board, no agent turn. `s5-02` "What did it find?" after the result landed -> a reply built from the stored result (audio spool disabled on purpose, parked mid-pipeline), no new agent turn. (`s5-01` showed fix 4.) |
| S6 | **PASS** | `s6-01` "Yes, but let it change the code." -> `propose`, perm `changes_ok`, "Draft for Holocene PM: Fix audio spool disable. Code changes OK, no deploy. Say send it, or tell me what to change." No dispatch. `s6-02` "Cancel that." -> `cancel_only`, "Dropped. Nothing was sent." |
| S7 | **PASS** | `s7-01` "Ask Holocene PM directly what is on the board." -> `direct` by the lexicon (`force_direct`, no model call). The heard echo played at +3.9 s; interactive dispatch on `automaticai/personal/sol-6.1` (`29100337`). Its prompt carries the earlier conversation (1.2 KB window, read from the Hermes session). The agent answered at +77 s (quick answer plus a background plan, as today). |
| S8 | **PARTIAL** | Retarget **PASS live**: `s8-08` "Change the target. Send it to Flume P M instead." -> `propose` target `flume-pm`, "Draft for Flume PM: Check converse stage tests ...". `s8-09` "Send it." -> dispatched `target_agent_id=flume-pm`, `tile_agent_id=holocene-pm`, `delegated` for flume-pm, journal profile `flume-pm`, one row (`3652a708`). The result was spoken after 366 s; the lead text is `"<display name>, follow-up on <title>."` (`inbox_watcher.py:2508`, unit tests), not checked by ear. The phrase "Send that to Flume PM instead" was heard as "Snack Loomam instead" on the sim mic (`s8-07`): the desk asked "Which agent did you want to send it to?". **Not run live:** the same request without naming the agent (`converse_retarget_refused`): `test_converse.py` Guard covers it (`handoff_not_named`, 0 live events). |
| S9 | **PASS** | `s9-06`/`s9-07`: the delegation result (`1309ffc9`, a trivial read-only task) began playing at +31.4 s, the driver started a note at +39.2 s (`halt ... stopped`), the note's two acks played, the result **replayed in full** (+64.4 to +92.8 s), then the fast answer to the new question (+92.9 s). `s10-c02`/`s10-d01` the same: result halted at -9.4 s by the recording, replayed after, then the answer. The overlap audit shows no overlap. (The result never landed *during* a recording: the longest hold I could keep under the desk's 90 s audio limit was 80 s and the batch lane took longer. The audit still covers a result landing seconds before a recording.) |
| S10 | **PASS** | `s10-a` (a long fast reply) was halted by a recording 2.7 s in; the proxy logged `phase:"skipped" error:"barged_in"` for its reply key, it was **not** replayed after the note, and the next fast reply (`s10-b`) played. Run twice (before and inside the tap window). The barged follow-up result **did** replay (S9). |
| S11 | **PASS** | (a) flag-file routes with the Hyper rungs on an unroutable host: `x1 connect, x2 host_down, r3m ok` -> answered by `ministral-14b-latest`, no Anthropic (`runs/s11a-routes-hyper-unroutable.json`, `s11-02`). (b) every rung on an unroutable host: `y0 connect, y1..y5 host_down` -> `direct`, `path=fallback`, `fallback_reason=all_routes_failed`, the heard echo played at +3.7 s, interactive dispatch on sol-6.1 (`s11-03`). Natural occurrences in the same run: Hyper 402 on 44 decisions (r1/r2 skipped by the breaker on the next 46) and a 60 s gateway restart (`503 gateway_restarting` on every rung) that sent `s1-a10..a12` direct with the echo (`traces/attempts/`). |
| S12 | **PASS** | `mise run memo:converse off --clear-routes`, no restart (watcher up since 12:14Z): `s12-01` has **no routed fact**, an interactive dispatch on sol-6.1, the echo at +4.0 s. Turned back on the same way. |
| S13 | **PARTIAL** | Draft half **PASS**: `s13-01` and `s13-04` were left unconfirmed; `converse_draft_expired` logged at +600 s for each ("no confirmation within 600 s", "never sent"), nothing dispatched (3 and 0 batch rows in the windows I checked, none for these briefs). The follow-up "send it" after an expiry exposed fix 6. **Not run:** `sim_stop.sh` mid-draft and the phone-after-20 s-grace half: stopping the sim would have broken the capture routing the rest of the run needed, and the claims path has its own tests and earlier rounds. |

## Overlap audit

`apps/auto/tools/speech_overlap.py` over `HoloceneSpeech` logcat (device clock; deduplicated, the logcat loop restarted 114
times because another client keeps killing the adb server, and backfills from the last epoch) and the emulator speaker tap
(`sim_audio_tap.py`, host clock). The guest clock stepped from -1.05 s to -0.25 s against the host at ~12:55Z (between S8 and
S9), so the two tap periods use different offsets. The tap ran 90 minutes and had to be restarted; **12:24-12:53Z has no tap**
(S8-d to the first S10 run, and S9), so checks 4-5 did not run there; checks 1-3 (logcat) cover the whole session.

| window | checks | result |
|---|---|---|
| period 1, 10:58-12:24Z, with tap, offset -1050 ms (-1030 and -1070 give the same), tolerance 60 ms | 1-6 | **ZERO OVERLAPS** (370 utterances, 84 recordings) |
| period 2, 12:53-13:41Z, with tap, offset -245 ms (-230, -260 same), tolerance **30 ms** | 1-6 | **ZERO OVERLAPS** (59 utterances, 14 recordings) |
| whole session, logcat only, tolerance 60 ms | 1-3 | ZERO OVERLAPS (516 utterances, 117 recordings) |
| whole session and period 1, tolerance **30 ms** | 1-3 / 1-6 | check 2 flags **2** of 117 recordings: the pad's `ack:stopped` cue started 1 ms after the app logged `mic=idle`, and the OS capture dump said "empty" 41 ms and 54 ms later |

Reading the two flags: in both, `HoloceneSpeech` logs `mic=idle` and then `start ack` 1-2 ms later, and
`dumpAudioRecordingConfigurations ... null or empty` follows 41 and 54 ms after that (`logcat 1792667828.365/.407`,
`1792670668.547/.602`). The app mic was closed; the OS list lags. They are the pad's own cue, not fast-desk output, and the same
class as the 19 ms and 87 ms flags in the earlier TTFA rounds, but they are over 30 ms, so I do not claim 30 ms-clean on the
whole of period 1. Nothing the desk said ever overlapped another utterance, a recording or the mic. Files:
[`overlap/`](overlap/) (the six-check outputs, the tap and the filtered logcat to rerun them).

Rerun:

```bash
E=_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/overlap
zcat $E/speaker-tap-period2.jsonl.gz > /tmp/tap2.jsonl; zcat $E/speech-logcat.txt.gz > /tmp/l.txt
python3 apps/auto/tools/speech_overlap.py --logcat /tmp/l.txt --tap /tmp/tap2.jsonl --offset-ms=-245 --from 1792673620 --to 1792676400
```

## Gateway journal and facts

Per delegation (`runs/delegations.json`): `journal_rows` is `select count(*) from executions where command_id=?` on
`~/.hermes/bloodbank-hermes-gateway-state.sqlite3`.

| turn | target (tile) | command id (uuid5 of the brief id: checked with `converse.command_id_for`) | journal rows | `delegated` | follow-up `dispatched` |
|---|---|---|---|---|---|
| s3-01 | holocene-pm (holocene-pm) | `8bcabbbd-0327-5229-a6bc-65c68c384444` | 1 (batch, completed) | 1 | 1 |
| s8-09 | **flume-pm** (holocene-pm) | `3652a708-7e62-54e0-a3f9-51a7dfe4efd9` | 1 (batch, completed, profile flume-pm) | 1 | 1 |
| s9-06 | holocene-pm | `1309ffc9-b25e-5002-8781-2aca0a4c6d40` | 1 | 1 | 1 |
| s9-12 | holocene-pm | `9b99f9d1-e2f8-584d-a207-da4028980e2c` | 1 | 1 | 1 |
| s10-c02 | holocene-pm | `5b2244d1-d113-54b3-a4a2-fb3a9f3ccf94` | 1 | 1 | 1 |

Results spoke 366-400 s after the read-back for the two long tasks and about 30 s for the quick one; the batch lane was the wait.

Models that answered (112 routed facts): `ministral-14b-latest` 39, `gemini-3.5-flash-lite` 36, `k3-256k` 1; none match the Anthropic
regex. Attempt outcomes over the run: r1 and r2 `http_402` 44 each and `breaker_open` 46 each; r3m `ok` 34 and `incomplete_propose` 8;
r3c `ok` 36, `timeout` 10, `http_503` 7; r3a `ok` 1. Watcher events: `converse_guard` 8, `delegation_sent` 5,
`delegation_result` 5, `converse_draft_expired` 2, `converse_draft_dropped` 3 ([`runs/watcher-converse-events.jsonl`](runs/watcher-converse-events.jsonl)).
`audio.memo.routed` and `audio.memo.delegated` validated at the gate (`bb-emit --check`, bloodbank `9561302`) and were never
`log-only`.

## Findings (not fixed here)

1. **Hyper is out of credit, and it is the key Hindsight uses.** That also stops Hindsight's consolidation on that key. AAI-53 asks
   for a dedicated key; a top-up is the only way to meet the "answered by -1017" criterion. I cannot add credit. When it is back,
   nothing needs a code change: r1 is first in the ladder and the breaker retries it every 10 minutes after a 402.
2. **The pad's two ack cues sit in front of every fast reply** (2.0-3.3 s of `waited_ms`). They are the biggest block between
   "routed" and the first sound, and the reason S3's "Sending to ..." was audible at 7.7-10.4 s rather than 5.5 s. Shortening or
   dropping the "sent" cue while a desk reply is coming is a pad change.
3. **A delegation result plays ahead of the next fast answer.** `s10-a`'s answer started at +30 s and `s1-b03`'s at +30 s because
   a 26-second result was in front of it. The queue is serial and never overlaps, but a fast turn can wait for a long result. The
   plan's phase-3 "conversation floor" is the fix.
4. **The gateway is redeployed often, and it is the only non-Hyper path.** All rungs returned `503 gateway_restarting` for about a
   minute at 11:08Z and again at 12:15Z, and a slow gateway timed out ministral and gemini at 11:28Z (before fix 7, which then skipped
   kimi and glm too) and at 13:23Z. Every memo in those windows (16 turns) went to the full agent, by design, and spent a Sol turn;
   27 of the run's dispatches were Sol turns (these, S7, S11b, S12 and the long-audio mistakes), a few cancelled after dispatch with
   their replies unspoken. A hedge between rungs would not help (every rung is on the same gateway); a rung off the gateway would.
5. **Small models are weaker drafters.** ministral and gemini-lite often send no brief and sometimes answer a work request from
   the card instead of proposing ("Holocene is on the main branch at commit f746ad9" for "check which branch", `s9-08`). With
   -1017 the plan measured 20/20 valid JSON; that run is still owed.
6. **Whisper mangles agent names** ("Flume PM" -> "Loomam", "converse.py" -> "converse.topy"). The model-proposed titles and briefs
   carry the garbled words; a vocabulary prompt for the agent roster in the whisper request would help every path.
7. **A 280 s mic hold (a harness bug of mine) became a "long audio" memo and went to the full agent**, as designed (the desk takes
   audio up to 90 s). Two such memos (`s9-bad-args*`) are in the record.

## State left behind

- `mise run memo:converse status`: mode **on** (flag file), agents `holocene-pm`, devices `e1c40830-9802-420f-98b9-d06be3f51b74`
  (the sim only), handoff `named`, no route override. The unit still ships `MEMO_CONVERSE=off`.
- Watcher starts: 7, each with no memo in flight (the unit env change, the ladder fixes, the lexicon fixes). `hermes-gateway`
  was not touched.
- Gateway token `holocene-converse` (id 88) now scopes ministral-14b, gemini-3.5-flash-lite, kimi-k3s, glm-5.3-flash (I widened it to
  ten routes for the bench, then narrowed it back to these four). The uncommitted brand/gateway files of the other agent were not
  touched.
- Sim: left in driving mode, app open, Holocene selected; the qemu capture stream is still on the `holo_testmic` null sink
  (`pactl move-source-output <qemu id> "$(pactl get-default-source)"` then unload the sink to undo it; `auto:sim:mic-check` was OK
  at the start). The speaker tap and the logcat loop were stopped at the end.
- Hindsight (bank `holocene`): one mental model retained about the Hyper credit, the gateway rungs and the lexicon gotchas.

## Commits

holocene `2755c53` (ladder rungs, 402 trip), `converse.py` follow-ups for the stutter lexicon, the sent-claim filter, the incomplete
propose and fallback title, the expired-draft line, "send it" with nothing pending, the per-channel timeout blame, the README
and unit comment, and this evidence (see `git log --oneline -- services/inbox-watcher/converse.py`).

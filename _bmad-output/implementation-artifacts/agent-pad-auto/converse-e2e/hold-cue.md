# Hold cue: no silent wait between the stop cue and the answer (HOLOC-23)

Date: 2026-10-22, 20:55-21:05 UTC (16:55-17:05 EDT). Operator request: "add the waiting cue now". Independent review (HOLOC-23, major):
the car desk calls one route (`automaticai/auto/fast`, 3-7 s typical, 12 s at its timeout); on failure the turn falls through to the
full agent, whose spoken progress starts `NARRATE_FIRST_S` = 15 s after dispatch. Between `ack:stopped` and the answer the driver
heard nothing, ~27 s worst case.

## What shipped

| piece | where | behaviour |
|---|---|---|
| desk-wait cue 1 | `Watcher.start_hold_cues` (`inbox_watcher.py`) | a thread per desk call; if the decision is not in `MEMO_CONVERSE_HOLD_CUE_S` (3, 0 = every hold cue off) after the call started, one of "One sec." / "Thinking." / "Hold on." / "Hang on." (originally also "Let me see.", dropped in the review follow-up) |
| desk-wait cue 2 | same | at `MEMO_CONVERSE_HOLD_CUE2_S` (9, 0 = none), "Still on it." / "Still thinking." (originally "Still working on it.", dropped in the review follow-up) |
| fall-through gap | `Watcher.maybe_keepalive`, called from `poll_progress` | a `conv.action=direct` turn waiting on its agent says "Still on it." / "Still thinking." 7 s after dispatch, then every 8 s, at most 3, until the agent's own narration starts (`MEMO_CONVERSE_HOLD_FALL_FIRST_S/_GAP_S/_MAX`) |
| voice | `PhraseBank` (hold lines added to `fixed_lines()`), `_tile_voice` | tile voice (`tiles[agent].voice`), default voice when vox lacks it; a cue is a file copy (`engine: phrasebank`, ~0 ms), never a vox render on the critical path; never the same line twice in a row per tile |
| wire | `memo_common.progress_key_for(..., hold=True)`, fact `audio.memo.narrated` `kind=hold_cue\|hold_cue2\|hold_keepalive` | clip `progress/<day>/<memo>-<n>h.ogg`, shares the `<n>` numbering with the agent's narration; no new Bloodbank type (`bb-emit --check --strict` valid); pushed with the early-push hint |
| pad | `status.ts` `newestProgress` (flags `hold`), `mayPlayProgress`, `main.tsx` `sayProgress` | plays it through the existing `speechProgress` queue; drops (does not defer) a hold cue while the driver is arming or recording. An older pad does not match `-<n>h.ogg` and never plays it |
| trace | `memo_trace.py` | `car:hold-cue#<n>` hops, "first hold cue" timing |

Invariants and where they are enforced:

- Speech never overlaps: the host's `SpeechArbiter` (unchanged, no Kotlin): one utterance at a time, progress rank below reply and echo
  (the arbiter's rank for a progress clip; there is no JS entry for the `cue` rank without a Kotlin change), nothing starts while arming
  or recording.
- A cue that has not started when the answer is ready is dropped: the watcher checks the desk's decision (or the agent turn) before the
  render, after it and after the upload, so a stale cue is never uploaded (`hold_cue_dropped`: `answer_ready`, `turn_finished`,
  `cancelled`, `agent_narrating`); the arbiter drops a queued progress clip once the memo has its reply (`memo_final`).
- A cue already playing is short, the answer follows it; the live run shows `waited_ms=4`. (First version: lines were limited by character count only, which the independent review showed was not a duration bound; see the follow-up below.)
- No cue while recording: arbiter defers it, and the pad drops it (`mayPlayProgress`, unit-tested).
- Non-converse memos: `maybe_keepalive` needs `m["conv"]`, the desk thread only runs in `step_converse`; the kill switch
  (`mise run memo:converse off`) skips the desk, so no desk wait and no cue.
- No Kotlin change; never Anthropic (nothing here calls an LLM).

## Tests

- `services/inbox-watcher/test_hold_cue.py`, 17 tests: slow desk gets cue 1 then cue 2 at the right marks with the clip keys
  `-1h.ogg` / `-2h.ogg`; a fast desk gets none; the second cue is not said when the answer came between; a cue mid-render when the
  decision lands is dropped and never uploaded; `0` turns it off; tile voice and default fallback for an unknown voice; PhraseBank
  serves the cue from disk after its first render; never the same line twice; every line short and banked; a cancelled memo gets none;
  the kill switch means no desk call and no cue; fall-through keep-alives (first at 7 s, not again inside the gap, at most 3,
  never in front of the agent's own narration, numbering continues so no clip is overwritten, none for a non-converse memo or when off,
  none after the agent turn is over).
- Pad: `status.test.ts` (hold clip flag and shared numbering, `mayPlayProgress`), 75 pad tests, `tsc --noEmit` clean.
- Full watcher suite: 423 tests. Two `PhoneRetry` tests failed under the suite's load (the known timing flake) and passed in a
  re-run of the class (15 tests OK).

## Deploy

Idle check first (no watcher memo activity for 10 min, no driver processes; the other workflow had committed its sim proof,
`20eb35d`). Pad: `npx tsc --noEmit && npm test && npx vite build` -> `index-CRIxKBx_.js` (agent-pad.delo.sh serves it).
Watcher: `systemctl --user restart holocene-inbox-watcher`, then `mise run memo:converse on --clear-routes`. `memo:converse status`
afterwards: mode on (flag), agents `*`, devices any car, routes `r1=automaticai/auto/fast` (from the unit), keys ok, contract routed /
delegated ok. The PhraseBank warm-up rendered the 6 new hold lines for the default voice at start-up (`phrasebank_warmed rendered=6`).

## Live proof on the Honda sim (3 memos, emulator-5554 only)

vox -> `paplay` into `holo_testmic`, record-stop pressed by `adb input tap`; times are seconds after the record-STOP press (host clock;
device clock corrected by the measured offset -0.61 s). Files: [`runs/hold-cue/`](runs/hold-cue/) (turn JSON, watcher events,
HoloceneSpeech logcat), overlap audit [`overlap/hold-cue-logcat-only-tol60.txt`](overlap/hold-cue-logcat-only-tol60.txt).

### hc-01: a natural fall-through (the desk's one route timed out at 12 s)

"What do you think is the biggest risk in the voice pipeline right now, and why?" `auto/fast` did not answer in 12 s (host load), so the
turn went to the full agent: the case the review was about.

| t after stop | watcher | car (arbiter) |
|---|---|---|
| +0.6 .. +4.1 | | ack (stop tone, "Got it") |
| +3.5 | transcribed, desk call starts | |
| +6.6 | cue 1 uploaded ("Hold on.", 3.1 s into the desk call, phrasebank) | |
| +8.9 .. +10.8 | | cue 1 plays |
| +12.6 | cue 2 uploaded ("Still working on it.", 9.1 s) | |
| +14.7 .. +17.8 | | cue 2 plays (the echo waited 0.9 s behind it, then went first) |
| +15.5 | desk falls through (`all_routes_failed`, 12 012 ms), dispatched | |
| +17.9 .. +25.5 | | "heard" echo |
| +23.7 | keep-alive 1 ("Still on it.", 8.0 s after dispatch) | |
| +25.5 .. +27.3 | | keep-alive 1 plays |
| +32.7 | keep-alive 2 ("Still working on it.", 16.9 s) | |
| +33.0 .. +35.9 | | keep-alive 2 plays |
| +43.6 | agent's first narration (render started at 22 s after dispatch, up at 27.8 s) | |
| +44.0 .. +52.4 | | narration 1 plays (keep-alives stop; numbering continued: clip 5) |
| +80.1 | | narration 2, halted by the reply (`memo_final`), as designed |

Silent stretches after the stop cue: 4.8 s (stop tone to cue 1: 3 s hold mark + transcribe + pad delivery), 3.9, 0 (echo), 0,
5.6, **8.1 s (the longest, before the agent's first narration)**. Without the cues the same turn is silent from +4.1 until the echo at +17.9 (13.8 s) and again from the echo's end at +25.5 until
the first narration at +44.0 (18.5 s). No overlap, nothing over the recording.

### hc-02: a cue that never played because it was stale

"In one sentence, why is a voice assistant hard to make feel fast?" Desk answered in 4.96 s (glm-5.3), cue 1 ("Thinking.") uploaded at
+5.3. I had started this memo while hc-01's long reply was still playing: the sim replayed that reply after my note, so the pad's queue
held the new memo's cue `behind_reply`, then dropped it on `memo_final` at +8.0 without playing it. The new memo's reply then waited
behind the old one (it started at +29.8). That ordering is the pre-existing reply queue; the cue neither delayed anything nor played
over anything. (My mistake in the run order, kept because it shows the drop rule working on the live pad.)

### hc-03: a desk wait over 3 s, cue then the answer

"In two sentences, what is the tradeoff between saying a short filler word and staying silent while a voice assistant thinks?"
Quiet car first (`wait-speech --quiet 6`).

| t after stop | event |
|---|---|
| +0.8 .. +4.2 | ack |
| +2.1 | transcribed, desk call starts |
| +5.3 | cue 1 uploaded ("Hold on.", 3.1 s into the call, phrasebank) |
| +5.8 | desk decision in (glm-5.3, 3 566 ms) |
| +6.6 .. +7.1 | cue plays on the pad (0.5 s, the arbiter reported `end reason=error:focus_denied`, see below) |
| +9.3 | **answer starts** (`waited_ms=4`, first chunk 8.3 s up, three chunks to +29.6) |

Cue start was 4.4 s after the desk call started (3 s mark + about 1.3 s from upload to the pad's queue); the answer was not delayed by it.

## Findings and limits, said plainly

- The cue is audible about 3.4-5.4 s after the desk call starts in these runs, not exactly at 3 s: the 3 s mark is the watcher's
  upload, the rest is the pad's push -> download -> hand-off (0.4 s in hc-02, 1.3 s in hc-03, 2.3 s in hc-01). The first run is the
  slowest because the host was loaded.
- In hc-03 the cue's audio focus was denied by the sim (`end reason=error:focus_denied` after 0.5 s); the answer then started
  normally. Cues in hc-01 played their full length. I did not chase the focus refusal (the platform's focus manager, the sim); a cue
  that is refused is just a missing cue, and nothing waits for it.
- The pad-level "no hold cue while recording" is covered by unit tests (`mayPlayProgress`) and by the arbiter's own deferral; it was not
  exercised live, because the budget was three memos and none recorded during a cue.
- Not run: a second, forced fall-through with a tiny route timeout. hc-01 was a genuine one (the same code path), and the budget was
  spent.
- Overlap audit over the whole window (21 utterances, 3 app recordings, 3 OS capture windows, 20 HAL mix windows), logcat only,
  tolerance 60 ms: speech x speech 0, speech x recording 0, HAL mix x OS capture 0. (I ran no speaker tap for this window, so
  the tap-based checks 4-6 did not run.)
- hc-01 shows why the keep-alive window is 8 s and not smaller: the agent's first progress line arrived at 22 s after dispatch, so
  the real narration came at +44 s after the stop; three keep-alives were budgeted and two were needed.

## Review follow-up (independent review of the above, same day)

Seven findings; the fixes are in the commit that adds this section. Measured with `ffprobe` on the banked clips (voice `rick`, 6 steps).

| finding | verdict | what changed |
|---|---|---|
| Major: clips are longer than the "<1 s" spec; "Still working on it." 1.61 s, "Let me see." 1.13 s, and the pad's queue is held 2-3 s per cue, so the echo waited 0.9 s behind cue 2 | **fixed** | Shipped lines are now One sec. 0.97 s, Thinking. 0.65 s, Hold on. 0.65 s, Hang on. 0.65 s (cue 1) and Still on it. 0.97 s, Still thinking. 0.97 s (cue 2 / keep-alive). "Let me see.", "Still working on it." removed; "Still here." and "Working on it." were tried and rendered 1.29 s, so they are not shipped. The watcher now probes the clip it is about to upload and drops one longer than `MEMO_CONVERSE_HOLD_MAX_CLIP_S` (1.2 s): `hold_cue_dropped reason=too_long`, and that line is not used again until a restart. The README states the measured durations, not character counts. Remaining pad-side cost: a cue holds the queue for its length plus about 1 s of focus hand-off (live run below: 0.65 s clip, 1.75 s span), which is the arbiter's, not ours. |
| Major: the cue ranks as `progress` (below the echo), not `cue` | **left** (disclosed) | The arbiter's `cue` rank has no JS entry point without a Kotlin change; the brief forbade one. With clips <= 1 s the cost is bounded: an echo waits at most about 2 s behind a cue that has already started, and a cue that has not started is dropped when the reply or echo arrives first. |
| Minor: `sayProgress` gated `mayPlayProgress` only before the download | **fixed** | `main.tsx` re-checks `finalAt` and `mayPlayProgress` after the download and the base64 encode, immediately before `speechProgress` / the queue, so a record press during the await drops the cue. (The pure function was already unit-tested; the re-check is a one-line call to it.) |
| Minor: a cue uploaded, then found stale after the upload, stays in S3 and can be played | **fixed** | `_hold_run` removes the object (`mc rm`) on the post-upload drop; the log carries `removed: true`. Test `test_a_cue_uploaded_just_before_the_answer_is_removed_from_the_bucket`. The clip number is not committed on that branch, and hold keys (`-<n>h.ogg`) never collide with narration keys anyway. |
| Minor: uncommitted `PHRASEBANK_ENGINES` dirt broke one hold-cue test | **not real now** | The other workflow's commit `2f81e7a` landed with `MEMO_PHRASEBANK_ENGINES=voxcpm,fakevox` in the test environment; `test_hold_cue.py` passes 22/22 on the committed tree, and the watcher now running has that code. |
| Minor: hold cues share the narration counters (`narrations=6`, status `narration` block pairs the hold key with the previous real text, `NARRATE_MAX` counts cues) | **fixed in part** | `NARRATE_MAX` now counts real narrations only (`hold_count`), and the status object's `narration` block names a hold clip with its own `text`, `kind` and a null `seq`. The shared clip numbering stays on purpose: a separate counter would hand a hold clip and a real narration the same `narration` number in the `narrated` facts (clip keys would stay distinct, the facts would not). `narrations=` in `memo_trace` still counts the clips the pad saw. Car-side speech lines in `memo_trace` still say `progress`: the arbiter's `notified` fact carries no clip key, so a hold marker is not derivable. |
| Minor: gaps the cue does not cover (1) 30 s `NARRATE_GAP_S` after the agent's first narration; (2) the reply TTS render after the decision; (3) a tile voice changed at run time is not warmed; (4) restart/retry restarts the timers | (1) **left** (2) **left** (3) **fixed** (4) **left** | (1) The brief bounds the silence *before the first narration*; the gap between agent narrations is the existing 30 s pacing, left. (2) The reply's own render (2-3 s) has no fixed text to bank. (3) While a cue waits for its mark the watcher now renders and banks the chosen line for the tile voice if it is not banked (`_hold_prime`), so the first cue after a voice change is a file copy; test `test_a_voice_that_is_not_banked_is_rendered_during_the_wait_not_at_the_mark`. (4) A restart mid-desk-call is rare and restarts the timers by design; noted in the README. |
| Minor: one sim cue lost to `focus_denied`; "zero overlaps" is logcat only | **left** (not reproducible, platform side) | In the follow-up run below the cue got focus normally. `focus_denied` is `AudioManager.requestAudioFocus` refusing on the sim and is handled by the Kotlin speech host (out of scope); a refused cue is a missing cue and nothing waits on it. The overlap result is still logcat-only (no speaker tap), as stated above. |

### Live check after the changes (1 memo, emulator-5554 only)

Watcher restarted at idle with the new code (`memo:converse on --clear-routes`, status: mode on, agents `*`, devices any car, routes
`r1=automaticai/auto/fast` from the unit). Pad rebuilt and served (`vite build`). Memo hc2-01, the hc-03 prompt: desk call 4.1 s (glm-5.3).

| t | event |
|---|---|
| +0 | ack stop tone, `ack:sent` ends at 769.64 (device clock) |
| 3.1 s into the desk call | cue 1 "Hang on." uploaded (phrasebank, `tts_ms=0`, rick) |
| 771.90 | cue queued and starts at once (`waited_ms=2`), ends 773.65: a 0.65 s clip, 1.75 s on the pad |
| 776.66 | reply queued and starts at once (`waited_ms=6`): the answer was not delayed; four chunks to 792.59 |

Files: [`runs/hold-cue/out-hc2-01.json`](runs/hold-cue/out-hc2-01.json), [`runs/hold-cue/speech-logcat-review.txt.gz`](runs/hold-cue/speech-logcat-review.txt.gz).
Not re-run: the fall-through path and the drop-while-recording path (code paths unchanged apart from the shorter line set and the
extra pad re-check; both unit-tested). Tests: `test_hold_cue.py` 22/22, full watcher suite and pad suite recorded in the commit.

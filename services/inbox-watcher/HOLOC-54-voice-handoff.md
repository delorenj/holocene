# HOLOC-54 local-only voice migration and verification handoff

This is a source candidate, not a release or audible acceptance. No real pins, overrides, registry, rendered profiles, assignments, credentials, services, or transport were changed.

## Authority and comparison

Flume alone owns the agent voice assignment. The watcher resolves the responding agent (including delegated follow-ups) through the existing registry `profile_name`, then reads that profile's rendered `config.yaml`: `tts.voice` precedes `tts.vox.voice`. A tile voice, the memo's reported `profile`, and `MEMO_PROGRESS_VOICE` no longer supersede the registered assignment. A missing/unreadable/malformed profile or missing catalog voice produces explicit sanitized fallback metadata. The configured emergency voice is not an assignment. Round locks persist across retry/resume; unrendered selection may rebind, but a conflicting rendered/announced identity under the same stamp refuses with `voice_round_changed` (identity-less legacy audio: `voice_lock_unbound`). A fresh round/reset permits reselection; transport does not get to write a voice.

## Migration decision table (fixture values, not a live inventory)

| Agent fixture | Legacy `tiles[agent].voice` | Registered rendered voice | Decision before retirement |
| --- | --- | --- | --- |
| tile-a | rick | carlin (`tts.voice`) | Conflict: operator/Flume owner must decide whether to assign rick in Flume or accept carlin. Never auto-copy the override. |
| tile-b | brule | brule (`tts.voice`, nested vox differs) | Match: confirm it was intentional, then authorize retirement of legacy metadata. |
| tile-c | ghost | unavailable/malformed | Resolve profile and availability first; no inference from old value. |

For a real migration, an authorized operator should make a **sanitized read-only** inventory of `tiles` (include voice, voice_set_at/by if present, model presence and unrelated keys) and of registered profile names and effective rendered TTS values, without exporting config text or secrets. Record source file hashes/timestamps and source status; compare by registered agent ID. Review each conflict with the Flume assignment owner; update only Flume's canonical assignment via its authorized process, render and verify the profile there. Validate the new round while old rounds finish. Only after explicit authorization, back up the flag file with protected permissions and retire legacy voice/voice_set_at/voice_set_by under the existing flag lock, preserving mode, routes, model, and unknown fields; do **not** run cleanup from this candidate. If an inventory cannot read a profile, leave it unresolved instead of manufacturing an assignment.

## Announced-audio policy (third repair; independent re-review required)

Two distinct cases, two policies, both enforced in `_audio_attempt` (the only place stale attempts retract objects):

1. **Responder/command/stamp conflict after chunk one was announced: preserve.** An announced chunk is one whose key is in
   `voiced_keys` (the cursor the pad, `/voice` and the status object advertise). Such an object is **never deleted**, so
   `voiced_keys`, `voiced_n`, the `audio.memo.voiced` fact and the stored object always agree. The conflicting attempt is
   refused (`voice_round_changed`, no further chunk is rendered or uploaded: the round stays bound to its original
   responder) and only its still-unannounced pending keys are discarded, best effort, outside `mu`. The preserved chunks are
   valid audio of the original owner and expire by the bucket lifecycle rule; a later `memo:cancel` of that memo withdraws them
   (policy 2). A fresh round/`start_followup` reset is unchanged and selects the next responder.
2. **Cancellation (`memo:cancel`): withdraw.** When the attempt finds the memo cancelled it removes every previously announced
   chunk of **that round**, plus its own pending keys. Under `mu` it deletes those entries from `voiced_keys` and fixes
   `voiced_n` (all of `voiced_keys`, `voiced_n`, `voiced_first_s/ts`, `voiced_last_s` go when none remain), then refreshes
   status; the objects are removed outside `mu`. A key belongs to the cancelled round only if it carries the round's
   deterministic chunk prefix (`chunk_prefix_for(stamp, tile agent, memo id)`, seeded into the attempt before any render), so
   a newer round's objects and cursors are never touched. This covers cancellation during a partial-round **retry** render,
   when the retry has not queued anything of its own yet, in `_voice_chunks` and in `step_speak`. Retryable upload failures
   (not cancelled, same owner) still keep valid partials. The already-emitted `audio.memo.voiced` event is immutable; the
   cancel `failed` fact is the retraction record and the status object stops advertising the chunks.
   Cancellation withdraws through one routine whatever its timing: `cancel_memo` itself drops the round's announced chunks from the cursors under `mu` (matched by the round's chunk prefix, so a newer round is never touched) and queues their objects, which the tick removes outside `mu` (`_drain_withdrawn_audio`), so a cancel between attempts is covered as well as one during an attempt. Each key leaves `voiced_keys` exactly once, so an attempt that outlives the cancel finds nothing left to delete and cannot double-delete or resurrect a cursor.

Tests (`test_voice_publication.py`, real `_voice_chunks`/`_publish_chunk`/`step_speak`, fixture synth, in-memory object store
recording every operation and whether `mu` was held): `..._conflict_after_first_announcement_keeps_announced_audio`
(responder and command; replaces the old test that asserted the delete-while-advertised behaviour),
`test_conflict_discards_only_unannounced_pending_keys`,
`test_cancel_during_partial_round_retry_render_withdraws_announced_chunks` (via `_voice_chunks` and `step_speak`; asserts a
newer round's key survives), `test_cancel_after_all_chunks_announced_clears_every_cursor`. All six new cases fail on `fc168df`.

## Second repair checkpoint (local-only; independent re-review required)

Parent candidate `3943b21064624575356e4cf435c346f114204bc2` failed both final reviews despite its passing sequential suites. Those exact reports and reproducers are preserved unchanged in `evidence/holoc54/review-3943b21/{spec,quality}/`; their FAIL verdicts still describe that parent. No independent review of this second repair has occurred in this worker (child agents forbidden).

The render now returns an immutable publication token captured under `mu` with the actual effective voice, command, responding identity, stamp, tile and unique lock generation. Single-file and chunk publishers revalidate before upload and under the commit mutex **before** facts, `reply_up`, `voiced_one`, `voiced_keys`, timing cursors or stage transitions. Stale/cancelled uploads are not announced; captured attempted objects are retracted best effort **outside** `mu` without clearing a newer round's memo. Valid same-owner retryable chunk failures retain prior announced chunks/dedup state. Render/upload overlap remains intact. A conflicting rendered or announced partial lock cannot be replaced under the same stamp; `start_followup` reset still selects the next responder.

Progress and courtesy callbacks now recheck their captured cue identity/stamp/generation both after rendering and after upload. A stale cue cannot advance narration/hold cursors or emit its fact; promotion to final ownership invalidates pending courtesy audio. Hold render-slot ownership lasts through announcement/retraction, not just upload. Slow render, upload and removal do not hold the global watcher mutex. Fact/cursor commit remains under it: with `MEMO_FACTS_ASYNC=0` the existing synchronous fact call is serialized there; this repair adds no network wait to that section.

Permanent `test_voice_publication.py` includes seven test methods and **78 scenario cases (including two successful commits)**: post-render/during-upload/precommit mutations independently cover responder, command, stamp, generation and cancellation for single/chunk publishers; rendered and announced partial conflicts plus real followup reset; a barrier after the real first chunk announcement; next-render/upload overlap; removal failure; successful fact/cursor identity joins; progress and hold boundaries including pending-to-final promotion. Fixtures use inert bytes, not synthesized audio. The broad on-call test now supplies a genuine captured cue token instead of an identity-less voice-only mock.

**Checkpoint checks actually executed, all exit 0:**

| Guarded process / check | Result | Durable log |
| --- | --- | --- |
| `run_safe_suites.py test_assigned_voices test_voice_publication test_car_desk test_voice_adapter_entrypoints` | 134 tests OK, 1 skip (external Skillex scripts); installed Hermes/Vox AST tests ran | `second-repair-logs/focused-checkpoint.log` |
| `run_safe_suites.py test_inbox_watcher` | 220 OK | `second-repair-logs/watcher-checkpoint.log` |
| `run_safe_suites.py test_converse test_converse_pipeline` (separate process) | 127 OK | `second-repair-logs/converse-checkpoint.log` |
| API and web `pnpm --filter @holocene/{api,web} typecheck` | both exit 0, pre-existing npm environment interpolation warning only | `second-repair-logs/{api,web}-typecheck-checkpoint.log` |
| Old partial reproducer | `second_error=voice_round_changed`, no second render, original carlin lock retained | `second-repair-logs/partial-probe-final.log` |
| Old post-render reproducer | now raises `voice_round_changed` before upload (exit 1 because old script does not catch the expected refusal) | `second-repair-logs/post-render-probe-final.log` |

Log paths in the table are relative to `evidence/holoc54/`. `second-repair-logs/` retains initial failures too: an obsolete voice-only on-call mock, and a newly authored overlap test that waited while holding the render's mutex. The mock and barrier were corrected; the final checkpoint runs above passed. Earlier inflated focused totals included `AssignedVoices` twice via an imported TestCase; the new module now imports its fixture by module alias. Final source hashes and exact commands are recorded in that directory. Scratch was `/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-second-repair`, guarded as below. No normal watcher startup, real network/synthesis/delivery, deploy, restart, config/pin, schedule, board, push or merge occurred.

**Acceptance hold remains external.** AC1/AC4 are **not full pass**: Hermes Telegram auto-TTS supplies no responder/profile voice and the installed Vox resolver prefers process `VOX_VOICE` over requested `tts.voice`. AST mocks prove that source behavior, not a deployed pin or two-agent audible parity. Hermes gateway/TTS and Vox/fleet owners must resolve their contract/precedence, then independently verify actual gateway adapter behavior and authorized two-agent channel playback. Local independent specification/quality review of the new commit remains a gate; aggregate HOLOC-54 stays held. No external owner has been dispatched or claimed accepted here.

## Previous repair checkpoint (3943b21; superseded by second repair)

The earlier `ef5a6e6` independent reports in `evidence/holoc54/independent-{spec,quality}/` remain FAIL for that exact old commit, not a verdict on this repair. The repaired watcher captures command/responder/stamp and both lock generations before slow profile/catalog resolution and commits only when the snapshot still matches. Identity-less persisted partial replies refuse with `voice_lock_unbound` rather than inheriting a prior responder's audio; an unrendered legacy lock reselects. Delayed cues cannot install pending fallback after final lock ownership; final rendering rejects identity/lock-generation changes, while an already-cancelled memo still suppresses publication. Profile opens now use no-follow dirfds and a bounded regular-file read keyed by opened inode metadata. The README describes Flume-only assignment and labels old HOLOC-23 voice-switch traces historical.

**Actual mocked boundaries.** `test_voice_adapter_entrypoints.py` invokes the watcher's real `step_speak` for fixture car and browser origins and a delegated tile-b responder, verifying the upload entrypoint, fact and two distinct selected voices. It AST-compiles unchanged methods from the installed Hermes `BasePlatformAdapter._synthesize_auto_tts`, Hermes plugin `_dispatch_to_plugin_provider`/`_plugin_voice_kwargs`, and external Vox `_resolve_voice` without importing their service runtimes or calling synthesis. With no process override the isolated dispatch selects fixture `carlin` and `brule`; the Telegram auto-TTS call sends text/path **without a voice** and the external Vox provider gives `VOX_VOICE` priority over its requested profile voice. This is a genuine Telegram parity blocker outside Holocene: the installed Hermes/Vox code does not demonstrate Flume profile inheritance when a process pin is present, and no external code, process pin or profile was changed. These tests skip the external-source portions if that installed tree is absent on a future host; a skip is not parity evidence. Parent must coordinate the external owner and independently re-review the new commit before accepting AC1/AC4. No real Telegram message/audio, gateway dispatch, car playback or audible two-agent proof occurred.

**Guarded local verification (not release):** `evidence/holoc54/harness/sitecustomize.py` blocks external network, subprocess targets and live synthesis; `run_safe_suites.py` imports the existing fake fixture before the watcher. Run with `TMPDIR`/`HOLOC54_SCRATCH` under the active profile scratch, `PYTHONDONTWRITEBYTECODE=1`, `MEMO_S3_DIRECT=0`, and `PYTHONPATH=services/inbox-watcher/evidence/holoc54/harness` from this worktree. Leave `MEMO_PHRASEBANK_WARM` unset for warmup-contract tests; no normal watcher startup or live synthesis was used. Final focused command `python3 -B services/inbox-watcher/evidence/holoc54/harness/run_safe_suites.py test_assigned_voices test_car_desk test_voice_adapter_entrypoints` passed **127 tests (one skip, unrelated existing skip)**, including the two installed-source Telegram/Vox probes (not skipped here). Separate `test_voice_adapter_entrypoints` passed **45 tests** (the base voice regressions and three actual-boundary methods); final focused and adapter reruns are retained in `evidence/holoc54/repair-logs.tar.gz`. Separate broad runs: `test_inbox_watcher` **220 passed** and `test_converse test_converse_pipeline` **127 passed**. Both `pnpm --filter @holocene/api typecheck` and `pnpm --filter @holocene/web typecheck` returned zero (pnpm reports a pre-existing missing local npm environment interpolation warning; no token is included here). The first combined broad run failed one cancellation guard and two shared-fixture delegation counts; cancellation was repaired and each broad suite passed in separate guarded processes. A focused run with `MEMO_PHRASEBANK_WARM=0` failed two warmup worker assertions by design; rerunning with it unset passed without generating audio. Logs preserve those failures as well as final exits. Parent review, external Telegram fix, authorized release and live two-agent playback remain outstanding.

## Earlier checkpoint verification (ef5a6e6, superseded)

The prior checkpoint passed `test_assigned_voices test_car_desk` (75 tests), `test_inbox_watcher test_converse` (283 tests), and API/web typechecks, yet both independent reviews failed. Their prior logs were in profile scratch; the reviewed verdicts and reproducers are copied under `evidence/holoc54/`. Passing old checks does not certify the repaired candidate. Independent specification and quality reviewers must inspect the **new** commit. Parent should re-run focused/fake-pipeline suites and typechecks, check privacy/call holds and cue-final priority, and coordinate the external Telegram voice owner. Runtime verification requires a separately authorized release, safe warmup suppression when synthesis is prohibited, served revision and process identity, then two-agent post-release locks and playback with explicit synthesis/delivery authorization. No live audible claim follows from this checkpoint.

Tests in `test_assigned_voices.py` and `test_voice_adapter_entrypoints.py` use fake registry/profile files, catalog, synth and transport; `test_car_desk.py` uses local fixtures/servers and fake Vox. Never run normal watcher startup or `--once` as a read-only smoke check: phrase warmup can synthesize.

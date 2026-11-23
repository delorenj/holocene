# HOLOC-54 local-only voice migration and verification handoff

This is a source candidate, not a release or audible acceptance. No real pins, overrides, registry, rendered profiles, assignments, credentials, services, or transport were changed.

## Authority and comparison

Flume alone owns the agent voice assignment. The watcher resolves the responding agent (including delegated follow-ups) through the existing registry `profile_name`, then reads that profile's rendered `config.yaml`: `tts.voice` precedes `tts.vox.voice`. A tile voice, the memo's reported `profile`, and `MEMO_PROGRESS_VOICE` no longer supersede the registered assignment. A missing/unreadable/malformed profile or missing catalog voice produces explicit sanitized fallback metadata. The configured emergency voice is not an assignment. Round locks persist across retry/resume and invalidate on the next stamp or responder change; transport does not get to write a voice.

## Migration decision table (fixture values, not a live inventory)

| Agent fixture | Legacy `tiles[agent].voice` | Registered rendered voice | Decision before retirement |
| --- | --- | --- | --- |
| tile-a | rick | carlin (`tts.voice`) | Conflict: operator/Flume owner must decide whether to assign rick in Flume or accept carlin. Never auto-copy the override. |
| tile-b | brule | brule (`tts.voice`, nested vox differs) | Match: confirm it was intentional, then authorize retirement of legacy metadata. |
| tile-c | ghost | unavailable/malformed | Resolve profile and availability first; no inference from old value. |

For a real migration, an authorized operator should make a **sanitized read-only** inventory of `tiles` (include voice, voice_set_at/by if present, model presence and unrelated keys) and of registered profile names and effective rendered TTS values, without exporting config text or secrets. Record source file hashes/timestamps and source status; compare by registered agent ID. Review each conflict with the Flume assignment owner; update only Flume's canonical assignment via its authorized process, render and verify the profile there. Validate the new round while old rounds finish. Only after explicit authorization, back up the flag file with protected permissions and retire legacy voice/voice_set_at/voice_set_by under the existing flag lock, preserving mode, routes, model, and unknown fields; do **not** run cleanup from this candidate. If an inventory cannot read a profile, leave it unresolved instead of manufacturing an assignment.

## Verification gates before release

Independent specification and quality reviews must inspect this exact checkpoint. Parent should independently verify the car/browser/Telegram adapter mapping and the gateway/profiles identity boundary with mocked channels; re-run focused and full fake-pipeline suites, API/web typechecks, privacy/call holds and cue-final priority race. Local checks: `test_assigned_voices test_car_desk` (75 tests, pass), `test_inbox_watcher test_converse` (283 tests, pass), and both API/web typechecks (pass after offline frozen, ignore-scripts pnpm install and local org-model/bloodbank-client package builds). Logs: `/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-focused-final.log` and `/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-broader-final.log`. These are mocked local checks only; no real synth or delivery was invoked. Later runtime verification needs a separately authorized release, safe warmup suppression (`MEMO_PHRASEBANK_WARM=0` when no synthesis is allowed), served revision and running process identity, then two-agent post-release locks and playback with explicit synthesis/delivery authorization. No live audible claim follows from this checkpoint.

Tests in `test_assigned_voices.py` use fake registry/profile files, fake catalog, mocked synth and transport; `test_car_desk.py` uses local fixtures/servers and fake Vox. Never run the watcher's normal startup or `--once` as a read-only smoke test: phrase warmup can synthesize.

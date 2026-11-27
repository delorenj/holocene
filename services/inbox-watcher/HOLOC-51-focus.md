# HOLOC-51 selected-agent focus candidate

Level: any registered memo-capable agent and its exact Jev source session (`belsky-doctrine`). No agent-specific assignment or alternative session detector is introduced.

## Boundary and release gate

This candidate is for independent specification/quality review before landing. Nothing here installs, starts, provisions, publishes, or deploys a service. **Live digest reads stay disabled pending HOLOC-73.**

- Jev owns the extractive roughly two-sentence digest and newest eligible source/session choice. The read-only source contract is `~/.agents/tools/jev-clairic/docs/agent-session-digest.md`.
- `pad_digest.py` is the bounded authenticated loopback consumer at `127.0.0.1:8769`. It relays to Jev's `GET /v1/agent-session-digest` at `127.0.0.1:8768`, forwarding the authenticated device bearer. It does not install Jev or create a clock, model, bus fact, memo, bucket object, or public proxy.
- Private GET `/v1/pad-digest?agentId=...` accepts optional `sourceSessionId`. `/v1/pad-summary` additionally requires exact `sourceSessionId` and `digestId`. Unknown/duplicate query fields, invalid identities and non-roster agents fail closed. Anonymous/wrong credentials get generic 401 before source access.
- Available records require agent/session/thread/event attribution, independent timezone-aware source/projection ages <2 hours, ≤1200 text characters and ≤16 source IDs. Both Jev's ISO offsets and `Z` are accepted; naive timestamps fail closed. Digest identity hashes immutable substance, not projection refresh timestamps. A separate absolute expiry is the minimum of the three timestamps plus TTL. Summary re-reads that exact session/version and re-resolves voice after rendering, then rechecks expiry immediately before return. Changed/stale source or voice never plays.
- Summary synthesis uses the existing Auto `Desk.voice_choice` resolver: registered Flume/Hermes rendered `tts.voice`, then nested `tts.vox.voice`, with the existing emergency/catalog fallback. No retired transport/tile voice override. Unknown available voice yields labelled unavailability, never invented speech.
- JSON source reads are ≤16 KiB, decoded audio ≤2 MiB, two concurrent consumer requests, no redirects, bounded HTTP/TTS waits. Source connect/headers/body/decoding share one monotonic five-second deadline; request-local socket shutdown prevents a dripping peer renewing it. Native response reads are ≤3 MB with origin/path allowlists, a total five-second digest / thirty-second summary deadline, and bearer kept out of JS. No-store responses; no request/body logging or persisted summary audio.
- `holocene-pad-digest.service` is a **disabled definition**, with no Install target and `HOLOCENE_PAD_DIGEST_ENABLED=0`. The executable also refuses by default or without a `JEV_DIGEST_DEVICES` environment map. No secrets are supplied.
- `AgentPadHost` defaults to `PadDigestClient(null, null)`. Only a debuggable test host can replace that client. HOLOC-73 must own the approved native secret storage/provisioning and authenticated HTTPS ingress before changing that default. Never expose the loopback read anonymously through Pad's origin.

## UI/native behavior

Explicit tile/wheel selection hides the grid and retains avatar/name top-left, current work-state label, source age, Replay summary and Record for the selected agent. Remembered selection stays on the grid and silent. Back restores current HOLOC-29 ordering without forcing a scroll. No new recurring clock: digest age/quiet refresh reuse the existing roster clock.

Only the first available digest delivered for a deliberate entry can request speech; transient misses keep that entry pending, including across the quiet roster refresh. Identical agent/session/version is not narrated again during that page lifetime. After a valid result or explicit cancellation, background refresh is silent; Replay is deliberate and bound to the displayed version. Missing/stale/invalid/unavailable source stays labelled without substitution. Focus state and digest text both obey host NO_TEXT.

Summary bytes use the existing native `SpeechHost`/`SpeechArbiter` and `ReplyPlayer`, not a memo/reply impersonation or second audio player. The exact source/projection expiry travels through the native bridge into the summary utterance; both queue start and the prepared player's actual start check it. Replies retain their existing no-deadline behavior. Summary cancellation/generation invalidation occurs on switch/back, record-start, page/host/visibility change, call interruption and reply delivery. Audio-focus transient loss stops summaries (replies retain their existing pause/resume policy). The existing recording closure captures target/key before mic startup and refuses retargeting while arming/recording.

Public `/api/pad/activity` adds only an allowlisted state enum to HOLOC-29's narrow projection. The canonical hub fold supplies Thinking, Waiting for you, Idle, Failed and Unknown. Using tool additionally requires a fresh identified open tool lifecycle within the exact profile session; matching tool completion, turn/session completion and failure clear it. Source failure and expired evidence never claim idle/thinking. Internal tool/session identities remain private.

## Regression map

| Criteria | Executed coverage |
| --- | --- |
| 1, 6 | `tests/focus.browser.mjs`: restored-silent selection, focus/back/A–B–A, no selection capture/upload, record target held through startup/wheel/refresh |
| 2, 3 | `test_pad_digest.py`: actual authenticated/anonymous HTTP handler, bounded real source transport, attribution/session/version/stale/missing/future rejection; `PadDigestClientTest` real loopback native transport |
| 4, 5 | Browser deliberate-once + silent refresh + Replay; real `Desk` voice assignment/fallback fixtures; post-render voice/source revalidation; `PadDigestBridgeTest`, `SummaryFocusTest`, `SpeechArbiterTest` cancellation/generation/no-overlap/mic controls; existing call wiring harness executes the real extracted handler |
| 7 | `pad-focus.test.ts`: actual SQLite scalar extraction through canonical fold + Pad projection; fresh/expired work/completion/HITL/failure/tool lifecycle, peer/session isolation. Browser all labels and outage |
| 8, 9 | Both built-asset browser suites: 1280×720, 1024×600, 800×480 focus geometry; same-viewport HOLOC-29 parked/driving density, NO_TEXT/noVideo/reduced-motion and independent activity settlement |

Required checks: API/web typechecks; API tests; Pad typecheck/unit/Vite build; watcher digest/pipeline/inbox tests and assigned-voice tests; Android unit/lint/debug assembly. Build Pad with its programmatic Vite build in the worktree, **not** `mise run pad:build` (that deploys).

## Repaired candidate checks (2026-11-27)

All executions below used the isolated `holoc-51-focus` worktree with test-only credentials and loopback fixtures. No deployment or live digest access occurred.

| Check | Observed result |
| --- | --- |
| API/web `pnpm --filter @holocene/{api,web} typecheck` | PASS; inherited missing npm environment interpolation warning |
| `pnpm --filter @holocene/api test` | 391/391 PASS, including canonical active-worker reconciliation |
| Pad `pnpm exec tsc --noEmit`, `npm test`, programmatic Vite build | PASS; 110/110 units |
| Built `tests/focus.browser.mjs` and `tests/activity.browser.mjs` | Both PASS, including unavailable→first available narration, refresh after host cancellation staying silent, and NO_TEXT focus state |
| `python3 -B -m unittest -v test_pad_digest` | 13/13 PASS; actual Jev producer→authenticated consumer HTTP, anonymous denial, offsets/naive/stale/future timestamps, final-voice expiry, real slow-drip headers/body, admission-slot recovery and malformed request-target refusal |
| `ANDROID_HOME=… ./gradlew --offline :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` | PASS; XML reports 211 tests, 0 failures/errors/skips; real bridge→arbiter queued-expiry test and native five-second slow-drip headers/body tests |
| `git diff --check` | PASS |
| Consumer start with opt-in and device map unset | Expected exit 1: private digest reads disabled (HOLOC-73) |

The independent review probes were read and rerun **unchanged**, with source SHA-256 checks before/after. They assert the original defects, not success, so nonzero exits are not reported as passing tests:

- `real_jev.py`: actual Jev is available with `+00:00`; corrected consumer returns 200 available, making its expected-503 assertion fail. The repository integration regression additionally exercises the downstream HTTP handler and anonymous 401.
- `state-probe.mjs`: canonical delegating/working and Pad working now agree, making its expected-idle assertion fail.
- `consumer_edges.py`: observed final-voice expiry now returns 409 with source stale, making its expected-200 assertion fail. Its separate fragment probe also exposed request-target normalization; the consumer now rejects fragment/absolute targets before source access, covered through raw HTTP in the repository test. A final unchanged rerun therefore stops at that earlier expected-200 assertion.
- `slow_source.py`: the seven-second source now raises `TimeoutError("source deadline")` instead of returning late. The repository test measures bounded header/body waits and verifies reusable admission slots after three failures.
- `NativeSlow.kt`: actual native read returns null at 5023 ms instead of late bytes, making its expected->6000-ms success assertion fail; the fixture peer then gets Broken pipe. Both header and body variants pass the repository transport regression.
- `QueueFreshness.kt` / `run_queue.py`: the frozen probe cannot compile against the corrected expiry-bearing playback callback (two arguments vs three). It was not edited or counted green. `PadDigestBridgeTest.summaryExpiryIsRecheckedBehindCueThroughRealBridgeAndArbiter` recreates its 7,199,000→7,201,000-ms race using the actual bridge and arbiter, covers an earlier projection deadline, observes no summary start, and verifies an ordinary reply still starts. `SummaryFocusTest` checks actual-player deadline policy at before/equal/after expiry.

Repair logs and oracle hashes are under the active profile's `$TMPDIR/holoc51-repair-*`. The independent probe files retain their original bytes.

## Historical broader checks, not rerun for this repair

The original candidate passed `test_pad_digest test_converse_pipeline` (72/72). The unsafe full watcher/assigned-voice suites were **not rerun** for these repairs. Their previously observed inherited failures remain visible, with no expectation weakening:

- The combined `test_pad_digest test_converse_pipeline test_inbox_watcher` run reported 292 tests, 291 passing and `EarshotMirror.test_a_browser_sender_goes_to_the_phone_at_once` failing (expected one proxy call, observed two). The single test reproduced unchanged with the base `15af930` watcher loaded.
- `test_serialized_real_tts_gate_stale_cue_cannot_mutate_rendered_final` timed out in its queue helper at line 698 on both candidate and base `15af930`.
- An inherited HOLOC-54 audit-harness assigned-voice run reported 52 tests with one failure and 45 relative-dirfd cleanup `PermissionError`s under Python 3.14. That harness run is not a passing product check; the isolated digest suite above is green.

## Parent-owned gates after independent review

Commit/merge/push the exact reviewed candidate, then use existing `mise run deploy` / `deploy:api` / `deploy:web`; Pad through `mise run pad:build`. Auto ships only via mobile-deploy-hub (`mise run deploy`), never a hand-installed release. Verify public rendered UI and approved native host after deployment. This candidate's browser/loopback/native-unit fixtures do not claim live acoustic or device-adoption proof. Live private reads remain disabled even after deployment until HOLOC-73 is answered.

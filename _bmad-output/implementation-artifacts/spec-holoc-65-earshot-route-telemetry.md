---
title: 'Earshot route and playback snapshots survive the upload proxy (HOLOC-65)'
type: 'feature'
created: '2026-11-26'
status: 'in-progress'
baseline_revision: '622f888f081636d8c962ccd420a13540e649a78a'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '/home/delorenj/code/earshot/.worktrees/ears-12-route-diagnostics/docs/verification/EARS-12.md'
  - '/home/delorenj/code/earshot/.worktrees/ears-12-route-diagnostics/app/src/main/java/sh/delo/earshot/core/MediaOutput.kt'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** EARS-12 (earshot `ears-12-route-diagnostics` @ `d9b63d6`, local checkpoint) emits a category-only `audio.media_route` and a receipt `playback` diagnostic (first start, latest, last zero). `validate_heard` in the upload proxy drops both, so only the minimal `played silent (media volume zero)` reason reaches `earshot status|trace`.

**Approach:** Extend the existing telemetry-only allow-list one level up: every Earshot client that reports route diagnostics, not just EARS-12's build, is retained by the same lenient sanitizer pattern as `audio`/`incall`/`call` (belsky-doctrine). Wire shape derived from `MediaOutput.kt`, `AudioState.kt` and `Beacon.kt` at `d9b63d6`.

**Wire shape (retained):**
- `audio.media_route`: `speaker | wired | bluetooth | unknown`, optional inside `audio`.
- `playback` (receipts only, never heartbeats): `{route, media_level|null, zero_on_any_start: bool, latest?: {route, media_level|null}, last_zero?: {route, media_level|null}}`. Top level is the immutable first start. Android omits `media_level` when unreadable; the proxy persists an explicit `null`.

## Boundaries & Constraints

**Always:** Strict key and enum allow-list; bounded by construction; an invalid or unknown field is dropped and the beacon still returns 200. Unreadable media level stays `null`, never 0. Old clients without the fields are byte-for-byte unchanged. `playback` joins `EARSHOT_TELEMETRY_ONLY`. Beta and private-channel suppression stays on the phone; the minimal silent `error` reason passes as before.

**Never:** Device names, addresses, ids, or any other key. Bloodbank fact data carrying `audio`, `playback`, route or level. A new route, collection, schema change or deploy. Editing the earshot repo.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error Handling |
|----------|-------|----------|----------------|
| Zero start, Bluetooth | `playback {route:bluetooth, media_level:0, zero_on_any_start:true, ...}` | kept, level int 0 | none |
| Route change | first speaker/9, `latest {route:wired}` | first stays speaker/9; latest wired, level null | none |
| Unreadable level | level absent, null, negative, non-int, >1000 | `media_level: null` | none |
| Bad route word | `media_route:"car"` | field dropped, audio block kept | none |
| Bad first route or non-bool `zero_on_any_start` | malformed | whole `playback` dropped, beacon 200 | none |
| Bad `latest`/`last_zero` | unknown route | that sub-object dropped alone | none |
| Extra keys (`device_name`, `address`) | on any level | dropped | none |
| Heartbeat with `playback` | any | `playback` dropped; `audio.media_route` kept | none |
| Beta receipt | minimal reason only | `error` kept, no detail | none |
| Old client | no new fields | unchanged | none |

</intent-contract>

## Code Map

- `services/upload-proxy/upload_proxy.py` -- `EARSHOT_MEDIA_ROUTES`, `_clean_audio` (media_route), `_clean_media_output`, `_clean_playback`, `validate_heard`, `EARSHOT_TELEMETRY_ONLY`, module docstring.
- `services/upload-proxy/fixtures/earshot-ears12-route-diagnostics.json` -- checkpoint-shaped beacon bodies, citing source files and commit.
- `services/upload-proxy/test_upload_proxy.py` -- `EarshotRouteDiagnostics`, `HttpEarshotLifecycle.test_route_diagnostics_*`.

## Tasks & Acceptance

**Acceptance Criteria:**
- Given a receipt with a valid `playback`, when validated, then first/latest/last_zero retain route and level, unreadable level as null, and no extra keys.
- Given invalid or unknown fields, when validated, then only the offending field or sub-object is dropped and the beacon is accepted.
- Given a retried or route-changed receipt, then the start snapshot is the receipt's own and is never replaced by a later route.
- Given any accepted beacon, when the Bloodbank envelope is built, then `audio`, `playback`, route and level are absent from fact data and the minimal silent reason remains.
- Given the persisted JSONL, when the checkpoint's `earshot` trace/status code reads it, then route, level, played-silent, latest and last-zero render.
- Given an old client or beta minimal receipt, then output is unchanged and no detail appears.

## Verification

**Commands:**
- `cd services/upload-proxy && python3 -m pytest test_upload_proxy.py -q`

**Not done here:** deploy (the proxy container is not rebuilt or restarted), independent review of contract and privacy (HOLOC-65 AC3), live delivery proof.

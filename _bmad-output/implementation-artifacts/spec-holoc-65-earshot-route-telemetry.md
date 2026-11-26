---
title: 'Earshot route and playback snapshots survive the upload proxy (HOLOC-65)'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '622f888f081636d8c962ccd420a13540e649a78a'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '/home/delorenj/code/earshot/.worktrees/ears-12-route-diagnostics/docs/verification/EARS-12.md'
  - '/home/delorenj/code/earshot/.worktrees/ears-12-route-diagnostics/app/src/main/java/sh/delo/earshot/core/MediaOutput.kt'
warnings: []
deferred:
  - 'Earshot repo: refresh host/fixtures/route-diagnostics-proxy-contract.json in ears-12-route-diagnostics. Its reviewed_source_sha256 pins 622f888 (the proxy before HOLOC-65, where media_route and playback are dropped); HEAD e20a8d3 hashes to 5ad231a7. Outside Holocene scope: the spec forbids editing the earshot repo.'
  - 'Live proof on a real EARS-12 build: the S26 runs app 0.1.12 (no route fields yet), so a started/finished receipt carrying media_route and playback has not been seen live. Once the EARS-12 build is installed, run earshot trace and confirm route, level and the latest/last-zero line render.'
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

**Not done at implementation time:** deploy, independent review of contract and privacy (HOLOC-65 AC3), live delivery proof. The first two were done in the review pass below; live delivery proof stays deferred (see frontmatter).

**Results (2026-11-26, after review):** `python3 -m pytest test_upload_proxy.py -q` 170 passed (rerun before deploy, no code change in the review pass).

## Review Triage Log

### 2026-11-26 — Review pass

One independent review of `e20a8d3` (verdict pass, 0 blocking). It replayed the EARS-12 `d9b63d6` payloads through the real Handler over HTTP and fed the persisted JSONL to the checkpoint's own `host/earshot.py`. Each claim was checked; no code change was needed.

| # | Finding | Verdict | Disposition |
|---|---------|---------|-------------|
| 1 | Contract holds: the proxy accepts and retains exactly what EARS-12 emits, through to `earshot trace`/`status` (31 e2e checks, 170 proxy tests) | false (confirmation, not a defect) | No action. Proxy tests rerun: 170 passed. |
| 2 | Privacy holds: only categories and levels survive; hostile names, MACs, ids and out-of-range levels drop or become null; fact data never carries `audio`, `playback`, route or level | false (confirmation) | No action. Beta and private-channel suppression stay on the phone. |
| 3 | Retries and route changes keep the start snapshot (the proxy is stateless per beacon; `latest` and `last_zero` change, `start` does not) | false (confirmation) | No action. |
| 4 | The live proxy still ran pre-HOLOC-65 code (container started 2026-11-21, no hot reload) | real, expected (the spec's own "Not done here") | **Resolved by deploy** below: container recreated, in-container `upload_proxy.py` carries `media_route` and `_clean_playback`. |
| 5 | Earshot's local `route-diagnostics-proxy-contract.json` fixture pins the superseded proxy (`622f888`) | low (real, but in another repo) | **Deferred** in frontmatter: the spec forbids editing the earshot repo; Earshot refreshes its fixture to `e20a8d3` (sha256 `5ad231a7...`). |
| 6 | The 4096-byte body cap leaves room (largest real receipt ~640 B, ~1.2 KB with a 512-char key) | false (confirmation) | No action. |

## Auto Run Result

**Summary:** HOLOC-65 finalized and deployed. Independent review passed with 0 blocking findings; 6 findings triaged (1 resolved by the deploy, 1 deferred to the Earshot repo, 4 confirmations). No code changed after `e20a8d3`.

**Deploy:** `docker compose -f /home/delorenj/docker/stacks/websites/agent-pad/compose.yml -p agent-pad up -d --no-deps --force-recreate agent-pad-upload`. Container `agent-pad-upload` recreated 2026-11-26T17:08:16Z, `Up`, startup log clean (`starting`, `wake_beat 202`, claims and call state loaded). The in-container `/app/upload_proxy.py` contains `media_route` and `_clean_playback`.

**Live checks:** (1) `docker ps` shows the container up and `docker logs --tail 50` has no errors. (2) The S26's real heartbeat at 17:08:58Z was accepted by the new process (`event: heard`, `status: 200`), and `earshot status` renders it unchanged (old client, no route fields: byte-for-byte as before). (3) No synthetic beacon was sent: `/upload/heard` has no safe synthetic-device pattern in the verification docs, and every accepted beacon is appended to the real `beacons.jsonl` history and publishes a Bloodbank fact, so a fake one would pollute the live trace. Route and playback retention is proven by the 170 proxy tests and the review's HTTP e2e replay, not by a live EARS-12 receipt.

**Files:** this spec only (no proxy code change in the review pass).

**Residual:** Earshot fixture refresh (Earshot repo) and live trace proof on a real EARS-12 build, both in frontmatter `deferred`.

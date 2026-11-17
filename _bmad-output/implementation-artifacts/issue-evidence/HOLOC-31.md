# HOLOC-31 — Quiet on a call: acceptance reconciliation (2026-11-17)

Request (operator, untagged, 2026-11-16): don't talk while I'm on a phone call;
mute and defer until I hang up. Scope (`belsky-doctrine`): one operator-on-call
signal from the phone gates every Holocene voice surface — Earshot phone copy,
car pad replies/clips, server-made car cues.

## Shipped

| Surface | Change | Where |
|---|---|---|
| Phone (Earshot 0.1.8, S26 SM-S948U) | AudioManager.mode call detection, transition heartbeat with `call`, holds/replays own playback | earshot `core/CallHold.kt`, `PlaybackController.kt`, `EarshotService.kt` |
| upload-proxy | `OperatorCall` (persisted, 150 s fresh, 3 h cap, fail-open, `OPERATOR_CALL_GATE`), `GET /upload/operator`, SSE `call`, ReplyClaims refuses take/hold/start | `services/upload-proxy/upload_proxy.py` |
| inbox-watcher | phone copy deferred via persisted `phone_retry` (no budget burn), pre-drop recheck, cues dropped `operator_on_call` (`MEMO_CALL_GATE`) | `services/inbox-watcher/inbox_watcher.py` |
| car pad | `callhold.ts`: mute + requeue at head, no strike/release/played mark, call re-read on hello/resync/10 s poll | `apps/agent-pad/src` |

Commits: `9e127a1` (feature), `563d317` (independent-verification follow-ups),
`b526ed2` (cap 1 h → 3 h after the first real call outlived 1 h), `a6e58e7`
(test flake, HOLOC-30), `afad526` + `03a7b56` (follow-up review fixes, below),
earshot `574ad97` (stale cap comment). Tests now: proxy 153 OK, pad 110/110,
watcher 520/521 in the full run (the one failure is an unrelated load flake,
HOLOC-34; 15/15 isolated), Earshot 253 at 0.1.8.

## Acceptance matrix

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Phone detects call start/end | MET (live) | proxy log `operator_call` 01:43:35Z ringing, 02:48:26Z in_communication, 03:03:00Z off; ~1 s transitions |
| 2 | Server holds quiet for the whole call, across restarts | MET (live) | proxy restart 01:48:14Z reloaded `on_call:true` from `operator-call.json` |
| 3 | Fail-open when the phone goes silent | MET (tests) | upload-proxy + watcher unit tests |
| 4 | Long call stays gated | MET after `b526ed2` | 1 h cap released 02:43:35Z, before the 03:03Z hang-up; cap now 3 h in proxy and watcher |
| 5 | A reply arriving mid-call is held, then delivered after hang-up — phone | TESTS ONLY | no memo arrived during the 2026-11-17 calls (watcher log 01:40–03:30Z has no `operator_on_call`) |
| 6 | Same, car pad (mute, requeue, replay) | TESTS ONLY | car still runs the old pad bundle until Holocene Auto restarts |
| 7 | Independent review | MET | review + verification of `9e127a1`; follow-ups reviewed twice (below), all correctness findings fixed and deployed |

## Residuals, routed

- **#5/#6 live proof → Jarad (operator-only).** Needs a real call with a memo
  reply in flight, after restarting Holocene Auto in the car. Not simulated
  overnight: a synthetic run would make the operator's phone speak unannounced.
- **Earshot 0.1.9 → Jarad (parked release).** Phone-side `CallCredit` caps at
  1 h; on a >1 h call, audio queued on the phone may age out as stale rather
  than play. Server side already holds 3 h.
- Not HOLOC-23/HOLOC-27 scope (voice identity/delegation); no overlap.

## Follow-up review of 563d317 + b526ed2 (independent, 2026-11-17)

Round 1 — PASS-WITH-FINDINGS, no deadlock, suites green:
1. A stalled off-call beat landing after the ring beat could announce off mid-ring
   (car may speak over the ring); `now` read before `_order`. **Fixed `afad526`**:
   beats ordered by the beacon's own `at` (`sent`, persisted), late beats within
   CALL_FRESH_S dropped; clock read inside `_order`.
2. Earshot `CallCredit` caps at 1 h vs the server's 3 h: on a >~90 min call an item
   already on the phone ages out `missed`. **Parked** (phone allowance + release, Jarad);
   stale comment fixed in earshot `574ad97`.
3. Pad: two overlapping operator reads could drop the newer answer. **Fixed `afad526`**
   (`callEventAt` / `callReadAsked`, applied in send order).
4. Cap release logged as `stale`. **Fixed `afad526`** (`hold_cap`).

Round 2 (re-review of `afad526`) — PASS-WITH-FINDINGS:
1. Claims read their clock before `_order`, so an off-on-off flap at the stale
   boundary was still possible. **Fixed `03a7b56`** (check() never decides earlier
   than its last decision).
2. A phone clock stepped back ≤150 s drops real beats for that span; worst case ~30 s
   of fail-open mid-call after a ≥2 min backward step. Accepted: bounded by
   CALL_FRESH_S by design.
3. Nit: `hold_cap` label only on the check() path. Log-only, accepted.
Pre-existing: pad stamps use `Date.now()` (a head-unit clock step back delays reads; push events still apply).

Live after deploy: phone heartbeats persist `sent` (`SM-S948U` `sent` ≈ arrival − 0.2 s);
`GET /upload/operator` 200 after each proxy restart; pad rebuilt and served.

## Disposition

Open. Server-side and review acceptance met; the remaining criteria (#5, #6) are
live-device proofs only the operator can produce. Routed to Jarad.

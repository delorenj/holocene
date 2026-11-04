---
title: 'HOLOC-24 slice: Candybar row actions, run health and steward profile'
type: 'feature'
created: '2026-11-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 2
context: ['/home/delorenj/code/33GOD/candybar/_bmad-output/specs/spec-cron-framework/steward-contract.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Candybar tab is read-only: to skip a fire, mark noise, disable or archive a candybar, or to understand what a candybar is for and whether it is healthy, the operator has to leave Holocene for the `candybar` CLI. Nothing shows how a job has behaved over time, what it does, or whether it should still exist.

**Approach:** Add the write path and the steward's read side, as the Holocene client of the Candybar steward contract (candybar 5edcc63). The API gains POST-only write proxies (skip, skip rest of day, noise, enabled, archived, steward) and extends the list with per-row `archived`, a 30-run `history`, the `profile` (overview, project, evaluation) and steward `tasks`. Definitions gains an Archived view, Group by project, a 30-cell run-health strip, task and evaluation chips, a structured overview/evaluation/tasks panel and an action bar (Enrich, Evaluate, Fix when failing, Mark noise, Disable, Archive). Schedule gains per-row Skip, Skip rest of day and Mark noise. Candybar owns every write and all stored data; Holocene only asks.

</frozen-after-approval>

## Implementation Notes

Decisions (mine, not user-visible gaps):

- Writes are `POST /api/modules/candybar/:id/{skip,skip-rest-of-day,noise,enabled,archived,steward}` and `GET /:id/tasks`. The id must be a UUID, every body field is validated (booleans strict, steward action one of enrich/evaluate/fix, fire time a whole-minute instant normalised to UTC), and the response is a small allowlisted `{ok, ...}`, never Candybar's detail shape (which carries the runner argv). Candybar's problem+json `detail` becomes `{error}` with the upstream status (a 409 steward duplicate also carries `taskId`); an unreachable Candybar is 502.
- Skip rest of day takes the fire's time and computes the date in the candybar's own timezone from the cached definitions (a 9 PM New York fire is already tomorrow in UTC), then posts `{date}`.
- A successful write bumps a generation counter and drops the list, profile, task (and, for fire-moving writes, schedule-window) caches, so the next list read goes back to Candybar. A read that began before the write does not repopulate them.
- History is the existing per-candybar invocations read raised from `limit=1` to `limit=30` (newest first upstream, reversed to oldest first); `lastRun` stays the newest and keeps its stale-on-failure rule. Profiles come from one `GET /profiles` and tasks from one `GET /steward/tasks?limit=200` per refresh, cached 10 s like the list. A failed read leaves `profile` or `tasks` absent and adds a warning; a readable profiles list with no entry for a candybar gives `profile: null`. While the list itself is down, no further reads are made.
- Archived rows are in `candybars` with `archived: true`, counted only in `counts.archived`, and excluded from total/active/inactive/failing. The schedule snapshot drops fires of archived candybars using the cached definitions.
- Web: the Archived tab holds archived rows alone; Group by project (`?group=project`) buckets by `profile.project.name` with "Unclassified" last and keeps the current sort inside a group. The run strip is a 30-column grid (newest at the right edge, empty slots faint on the left) that shrinks on a phone, with an `aria-label` such as "Last 30 runs: 24 passed, 6 failed". Fix is offered when the last run failed or 3 of the last 10 failed, never when archived. Archive and Disable confirm with `window.confirm`; each button shows a busy state, disables while its request or a task of that action runs, and errors appear inline (`role="alert"`). `usePoll` gained a `reload` so a write shows its result at once.
- Schedule row actions sit over the cron text on hover or focus-within on a hover-capable wide screen (the buttons stay in the tab order) and behind a small trailing button on touch and narrow screens. A single skip marks the row at once, a rest-of-day skip refetches the snapshot, noise flips the candybar's rows; the stream's `skip.applied` and `definition.changed` say the same later. Failures show as a transient alert above the list.
- Outcome chips use hub tokens only: Nominal `--cleared`, Suboptimal `--pop`, Drifted `--broken` on the soft-fail tint, Orphaned dashed `--ink-3`.

Files: `apps/api/src/candybar.ts`, `candybar-actions.test.ts` (28 tests; the API suite is 235), `apps/web/app/candybar/{candybar-model.ts,candybar-api.ts,row-parts.tsx,profile-panel.tsx,action-bar.tsx,action-store.ts,row-actions.ts,fire-actions.ts,schedule-sync.ts,focus-intent.ts}` (+ `candybar-model.test.ts`, `row-actions.test.ts`, `schedule-model.test.ts`, `schedule-sync.test.ts`, `round3.test.ts`; 66 web tests in all), `candybar-app.tsx`, `schedule-view.tsx`, `schedule-model.ts`, `candybar.css`, `types.ts`, `apps/web/app/hub/hub-app.tsx` (`usePoll.reload`).

Round 1 (after the adversarial review, 2026-11-03) changed these decisions:

- Click handling lives in plain modules (`row-actions.ts`, `fire-actions.ts`) whose side effects are injected. Busy keys, the task a POST just queued, per-candybar notes, announcements and a focus intent live in one page-wide store (`action-store.ts`, `useSyncExternalStore`). Collapsing a panel, or a row remounting in another section, loses nothing. Noise shares one key across Definitions and Schedule.
- Buttons that cannot act are `aria-disabled`, never `disabled`, and say why (`aria-describedby` to a visible line). Results go to two live regions mounted once at page level (polite, and `role="alert"` for failures). The panel shows the same text without a live role, so nothing is read twice. A panel's live region would have remounted with its row.
- The rest-of-day skip sends `expectDate` (the date the confirm named), and the proxy refuses a mismatch with 409. The schedule snapshot's candybars carry `timezone` for that.
- A steward 409 with `taskId` is read back through `GET /candybars/{id}/steward/tasks?limit=20`, so the page can say how far along the twin is.
- Steward contract v1.1 (candybar d1b3796) landed during the round: Holocene renders `followUpStatus`/`followUpTaskId`, the refactor outcomes, and `costUsd`/`tokens` (OpenCode's nested `cache` is flattened). It treats Fix as blocked while a refactor is in flight, and names a follow-up's parent action. Contract section 5 now documents Holocene's use (candybar b2306af).

Surprises:

- `background: inherit` cannot give the hover overlay a row background because rows are transparent over the list; each row state sets `--cb-fire-bg` and the overlay reads it.
- The impeccable detector flagged the evaluation block's left accent border as a side-tab; it is a boxed panel now.
- At build time Candybar did not yet serve `/profiles` or `/steward/tasks` (404); the list degrades to a warning and rows without profile or task data. The rich screenshots were taken against a local fake Candybar (real reads, synthetic profiles and tasks, writes recorded and not forwarded) routed in by Playwright.

## Review Triage Log

Round 0 (self-review), all patched: a stale in-flight read could repopulate caches a write had just cleared (generation counter, tested); the list's inflight promise could be clobbered by a later one (identity check); the project chip repeated under a project heading (hidden when grouped); the touch toggle glyph was too small.

Round 1 (adversarial review, 12 verified findings, 2026-11-03). All 12 are patched (holocene d5b9182, bf3eb22, b9e487f, 40590d7):

1. **Medium, rest of day skipped most of tomorrow silently.** The confirm now names the date, the zone and the hours of the viewer's day it covers ("Skip every fire of X on 2026-11-04 (UTC), 7:00 PM tonight to 7:00 PM tomorrow EST?"). It adds a note when the span runs past the listed day. The page sends `expectDate`, and the result names the date the API skipped. Tests cover `restOfDay`/`zonedMidnight` (DST, Tokyo, an unknown zone) and the proxy's 409 on a mismatch. Verified live: the confirm, dismissed, sent nothing.
2. **Medium, Fix and Evaluate had no confirm.** Both confirm first. Fix names `overview.source.repo`, the commit and push, and the proving run. Evaluate says its verdict queues a refactor or fix or archives, and that protected candybars are only flagged. Tested.
3. **Medium-low, the schedule cache ignored the write generation.** `readSchedule` now caches only when no write happened during its read. A race test proves the skipped fire stays gone, and it fails without the guard. Verified live: after a skip, Definitions' next fire moved to the following fire.
4. **Medium-low, steward buttons said "running" for queued tasks.** Buttons read "Evaluate queued 2m" or "Evaluating 4m". Past 2 minutes queued, they say "queued 5m: is candybar-steward running?". The 202 Task holds the button until the list shows it, which replaces the blind 4 s timer. Tested.
5. **Low-medium, focus was lost on every action.** Buttons use `aria-disabled`. A row that moved section gets focus back on the same button, else the row, else the view tab it moved to. Schedule focus goes to the row's noise button, else the next row. Results are announced. Verified live by keyboard: Archive moved focus to the Archived tab, Unarchive to Inactive, Enable to Active. Skip moved focus to the row's noise button. Noise kept focus on its button.
6. **Low, actions offered when the data was missing.** Steward buttons are off, with the reason, when profiles or tasks are unreadable. Such rows group under "Unknown (profiles unavailable)". Tested.
7. **Low, a duplicate 409 showed as a failure.** It is now a polite note ("Already running: Evaluate started 3m ago"), and the list reloads. Tested.
8. **Low, archived candybars came back into the Schedule.** `definition.changed` with `archived: true` drops the rows, ignores later rows for that candybar, and keeps it out across a refetch until it is unarchived. Tested.
9. **Low, the rest-of-day refetch lost events.** That refetch now sets `loaded = false` and buffers like `reset`.
10. **Low, one busy flag for the Schedule.** Busy state is per row and action in the page-wide store. It survives collapse and remount, and a second click sends nothing. Tested, including two fires of one candybar in flight at once.
11. **Low, risky paths untested.** There are 24 new web tests (48 total) and 5 new API tests (230 total), covering confirms, busy keys, 409s, errors, the schedule-cache race and archived stream rows.
12. **Low, the row button's name ran to about 400 characters.** It now has an explicit `aria-label`: name, state, next fire (live: "restic-vault, active, next fire in 5h 30m", 41 characters). The rest is in its `aria-describedby`. `TaskChip` is no longer a nested live region.

Also fixed in round 1:

- **React #418 on every load outside UTC** (holocene 1cd8e60). The prerendered Schedule note named the server's zone. It now renders after mount, and a Playwright check in UTC, New York and Tokyo is clean.
- **A running task's button was dashed like a queued one** (c41dc19).

Live verification (2026-11-03, holocene-web, Playwright 1440 and 390, screenshots in `/tmp/cbshots-final/`):

- **restic-vault:** the real overview (11 blocks) and the Suboptimal evaluation, with follow-up "refactor done" taken from the child task, since live rows predate `followUpStatus`. Its three tasks show.
- **Health strips:** 92 strips with 1,559 filled cells, and no warnings.
- **deploy-smoke-exec:** archived, unarchived and enabled through the UI, and restored exactly. Unmark noise, then Mark noise, on its Schedule row. A Skip of its 04:15Z fire showed at once on the acting page. A second page saw it through the stream's `skip.applied` (captured raw: reason `occurrence`, `skipped: true`).
- **Not pressed:** Enrich, Evaluate and Fix, left for the integrator.

Round 2 (second adversarial review, 8 verified defects N1-N8, 2026-11-04). All 8 are patched (holocene 5c4477a, 7d06694, 7be6c3e; candybar contract 3cc2854):

- **N1, Fix vanished mid-task.** `fixOffered`: the button stays while a fix is queued, running, being requested or just queued by this page, even when the proving run turned the last result green (the rule "3 failures in the last 10" no longer drops it). Never for an archived candybar. Tested.
- **N2, no way out of a stuck task.** `POST /api/modules/candybar/tasks/:taskId/cancel` (UUID-validated, forwards to Candybar's cancel route, answers `{ok, task}`; its 409 and 404 come back as `{error}` with that status; caches dropped). Every task in flight, a refactor included, has a Cancel beside the steward buttons. It confirms first, treats a 409 as "already finished" information, and forgets a just-queued task so the button returns. A task queued over 2 minutes says "the steward (candybar-steward) may be down. You can cancel it." API tests (3) and web tests (4). Live: queued an Enrich on `wax-calls-sync` through the UI and cancelled it queued (task `01a1a4fa-b138`) and running (`01a1a4fc-93be`, "Enriching 38s"); both ended `failed`, "cancelled by operator", and the button came back.
- **N3, events lost into a model about to be replaced.** The snapshot/stream ordering moved from the Schedule effect into `schedule-sync.ts`; `loaded` is now `!again`, so it stays false until the last queued snapshot read lands. The new test fails without the fix (checked).
- **N4, one timeout switched every steward button off.** The API keeps the last good profiles and tasks (also while the list is down), marks them stale (`stale: {profiles, tasks}` seconds, warning "from an older read (40s ago)"), and the panel says "Profiles and steward tasks are 40s old ...". Only a read that never worked, or a 404, leaves the rows without them (buttons off with the reason). API tests (3), web test (1), mock screenshot.
- **N5, "refactor done" for a refactor that changed nothing.** Without `followUpStatus` the child task's own outcome words the follow-up: `done` / `done_proven` "done", `fixed`, `not_fixed`, `done_not_proven` "done, not proven", `not_applied` "not applied, flagged for you to decide" (the flagged Suboptimal case, also styled as flagged). The child is the one named by `followUpTaskId`, else the one whose parent is the evaluation. Tested.
- **N6, one zone label for two ends of the rest-of-day range.** Each end names its own abbreviation ("8:00 PM tonight EDT to 7:00 PM tomorrow EST" across the fall-back). Tested with the 2026-11-01 change; live confirm in New York checked.
- **N7, two state-changing actions on one candybar at once, and error notes that never left.** Noise, enable or disable and archive run one at a time per candybar (the Schedule's Mark noise too): the others are `aria-disabled`, `aria-describedby` a line "Disabling is in progress; one change to a candybar at a time.", and a blocked click is announced and sends nothing, not even a confirm. Error notes clear after 10 s (others 30 s) or on the next action. Tested; verified live with a 3 s delayed Disable.
- **N8, focus pulled back after the operator clicked away.** `endOnInteraction`: any pointerdown or keydown (capture phase, auto-repeat ignored) ends the focus intent, on Definitions and on the Schedule; the 15 s timer stays as the backstop. Tested; verified live (Unmark noise keeps focus on its button, a click on empty space, one 15 s poll later focus is still on the body).

Live verification (2026-11-04, holocene-api rebuilt and restarted, holocene-web recreated, Playwright against the container on :3001; scripts in `/tmp/cbshot/round3_*.py`, screenshots `/tmp/cbshots-final/round3-*.png`):

- N2 real cancel on `wax-calls-sync`, queued and running (above).
- N1, the stuck queue with a running refactor, and N4's stale line on altered list data with every write aborted (`round3_mock.py`).
- N7 and N8 on `deploy-smoke-exec`, ending exactly as it began (enabled, not archived, noise on): Disable in flight with Archive and Noise off and their clicks sending nothing; an injected 502 note gone after 10.4 s; the N8 focus check.
- No page or console errors on Schedule and Definitions in UTC, New York and Tokyo, and none at 390 px (no horizontal scroll).
- Two things went wrong and were repaired: my first N7 script clicked an `aria-disabled` Archive through Playwright's wait, which clicked it for real once Disable finished, leaving `deploy-smoke-exec` archived and disabled for about a minute (restored through Candybar's API, then the script was fixed to force-click without waiting); and another actor recreated `holocene-web` while the first running-cancel pass was in flight (a connection refused), so that pass was rerun.
- Not pressed live: Fix and Evaluate (their confirms and states are unit-tested and mocked), and the schedule `N3` race (unit-tested only; it needs a stream event landing inside a queued snapshot read).

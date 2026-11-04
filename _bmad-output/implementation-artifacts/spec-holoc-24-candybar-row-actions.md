---
title: 'HOLOC-24 slice: Candybar row actions, run health and steward profile'
type: 'feature'
created: '2026-11-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 1
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

Files: `apps/api/src/candybar.ts`, `candybar-actions.test.ts` (23 tests; the API suite is 230), `apps/web/app/candybar/{candybar-model.ts,candybar-api.ts,row-parts.tsx,profile-panel.tsx,action-bar.tsx,action-store.ts,row-actions.ts,fire-actions.ts}` (+ `candybar-model.test.ts`, `row-actions.test.ts`, `schedule-model.test.ts`; 48 web tests in all), `candybar-app.tsx`, `schedule-view.tsx`, `schedule-model.ts`, `candybar.css`, `types.ts`, `apps/web/app/hub/hub-app.tsx` (`usePoll.reload`).

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

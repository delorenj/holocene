---
title: 'HOLOC-24 slice: Candybar row actions, run health and steward profile'
type: 'feature'
created: '2026-11-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
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

Files: `apps/api/src/candybar.ts`, `candybar-actions.test.ts` (18 tests; the API suite is 225), `apps/web/app/candybar/{candybar-model.ts,candybar-api.ts,row-parts.tsx,profile-panel.tsx,action-bar.tsx}` (+ `candybar-model.test.ts`, 24 web tests in all), `candybar-app.tsx`, `schedule-view.tsx`, `schedule-model.ts`, `candybar.css`, `types.ts`, `apps/web/app/hub/hub-app.tsx` (`usePoll.reload`).

Surprises:

- `background: inherit` cannot give the hover overlay a row background because rows are transparent over the list; each row state sets `--cb-fire-bg` and the overlay reads it.
- The impeccable detector flagged the evaluation block's left accent border as a side-tab; it is a boxed panel now.
- At build time Candybar did not yet serve `/profiles` or `/steward/tasks` (404); the list degrades to a warning and rows without profile or task data. The rich screenshots were taken against a local fake Candybar (real reads, synthetic profiles and tasks, writes recorded and not forwarded) routed in by Playwright.

## Review Triage Log

No separate review layer ran. Self-review findings, all patched: a stale in-flight read could repopulate caches a write had just cleared (generation counter, tested); the list's inflight promise could be clobbered by a later one (identity check); the project chip repeated under a project heading (hidden when grouped); the touch toggle glyph was too small.

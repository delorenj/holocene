---
title: 'HOLOC-24 slice: live Candybar Schedule tab'
type: 'feature'
created: '2026-11-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Candybar tab (holocene 1319675) lists definitions, but there is no live view of the day's fires: what already ran and how it went, what fires next, and what is coming, updating as Candybar dispatches.

**Approach:** Add a Schedule view to the `/candybar` tab, the "main live view" of the HOLOC-24 brief: today's fires as full-width rows, past rows greyed with their result, the current (next-to-fire) row solid, upcoming rows with countdowns, autoscrolling with the day. It renders a `/schedule` snapshot for the browser's local day and patches live from Candybar's SSE `/schedule/stream`, proxied through the Holocene API (Candybar has no CORS), resuming via `Last-Event-ID` and refetching once on `reset`. Read-only: skips, noise edits and create stay deferred.

</frozen-after-approval>

## Implementation Notes

Decisions (mine, not user-visible gaps):

- Schedule becomes the default sub-view of `/candybar` (the brief calls it the main live view); Definitions stays one click away (`?tab=definitions`), and every existing Definitions URL keeps working because its filter params imply that tab.
- The day is the browser's local day, `[local midnight, next local midnight)`, so DST days are 23 or 25 h; the snapshot and the stream use the same window, and the view reopens both at midnight.
- Snapshot route `GET /api/modules/candybar/schedule?from&to` reads `/schedule` in ≤5 h slices (Candybar refuses windows over 20,000 rows) and returns a compact payload (a candybar dictionary plus row tuples) because the full day is ~11.5k rows / 2.4 MB upstream.
- Stream route `GET /api/modules/candybar/schedule/stream?from&to[&after]` pipes Candybar's SSE frames through unchanged (ids, `retry`, keepalives) plus an id-less `ping` event every 15 s of quiet, forwarding `Last-Event-ID` (or `after`, for client-owned reconnects), and aborts the upstream fetch when the browser leaves or the API shuts down.
- Noise is hidden by default on Schedule (explicit flag or firing more often than every 10 min, computed with the existing `cron.ts`). Unlike Definitions, failed noisy fires stay hidden too (an every-2-min job failing all day would flood the timeline); their failures are counted per candybar above the list instead. With noise hidden, the first visible, not-skipped, not-past row is highlighted as "next".
- Rendering is bounded: the last 40 past rows and the next 150 upcoming rows, each extendable, so the 11.5k-row noisy day never mounts at once.
- Autoscroll follows the next row until the operator scrolls; a "Follow now" control resumes it.

Files: `apps/api/src/candybar.ts` (Schedule section, `withPings`, two routes), `apps/api/src/candybar-schedule.test.ts` (12 tests), `apps/api/package.json`, `apps/web/package.json` (`test` script, `tsx` dev dependency), `pnpm-lock.yaml`, `apps/web/app/candybar/{schedule-model.ts,schedule-stream.ts,schedule-view.tsx}` + two test files (17 web tests with `cron.test.ts`), `candybar-app.tsx` (sub-tabs, URL state), `candybar.css`, `types.ts`.

Surprises:

- The Next.js rewrite drops a proxied response after ~30 s without bytes, silently (no error, no end at the browser). Candybar's keepalive is once a minute, so the first build's stream died in every quiet stretch while the badge still read "live". Fixed with API-side `ping` frames every 15 s and a 45 s client silence watchdog; verified 100 s through Next and 150 s in a real browser.
- Today's window is 11,479 fires (2.4 MB upstream); the compact snapshot is ~600 KB, and ~1,000 fires remain once noise is hidden.
- Candybar's `current` is usually a hidden noise row (deploy-smoke fires every minute), so the view picks its own "next" among visible rows.
- `pnpm add` refused the default store (node_modules was linked from `~/setup-pnpm/...`); it ran with `--store-dir` pointing at the existing store.

## Review Triage Log

Layers: blind hunter (context-free) and an edge-case hunter (live API, Playwright, `ss` inside Candybar's netns). No layer skipped.

- Stream silently dies through the Next rewrite after ~30 s idle — high, patched: `withPings` (frame-aligned, id-less pings) and a client watchdog; covered by tests and re-verified live.
- No client-side stall detection — medium, patched by the same watchdog.
- Schedule URL turned into Definitions on reload (`?view=inactive` left behind) — medium, patched: Definitions-only params are written only on that tab.
- Follow ignored scrollbar drags, find-in-page and focus jumps, then yanked the page back every minute — medium, patched: any scroll outside our own `scrollIntoView` window stops it (verified with `scrollTo`).
- `aria-live` statement re-announced a per-second countdown — medium, patched: it names the next fire's clock time.
- A skip recorded against a fire that already ran marked it skipped — medium, patched: `skipped && !lastResult`, Candybar's own rule.
- Rest-of-day skips update only their first row on the stream — medium, patched: `rest_of_day` triggers one snapshot refetch.
- "Next" could be a skipped fire, and showed a "working" glyph before it ran — low, patched.
- Row names did a full reload, dropping the snapshot and stream — low, patched: in-page `update({tab, open})`, modifier clicks still open a new tab.
- 502 detail was lost because the body was read after the abort — low, patched (signal-aware test).
- `pending` grew without bound while the snapshot kept failing — medium, patched: cleared at each snapshot read, which is newer than everything before it.
- Day rollover kept yesterday's expansions and scroll state — low, patched. Fall-back DST night merged the two 1 AM dividers — low, patched (UTC-hour buckets, zone in each divider).
- Viewer-disconnect test passed without the wiring — medium (test gap), patched: real-socket mid-stream disconnect and shutdown-abort tests; the edge hunter also confirmed upstream connections close within 3 s in Candybar's netns.
- Web test script hard-coded files and `asRow` trusted non-string names; `fromSnapshot` trusted the payload shape — low, patched.
- Malformed `Last-Event-ID` silently dropped — false in practice: ids are Candybar-generated `<hex>-<seq>`, always matching.
- Deleted candybars never leave the timeline — false: the contract has no delete; `change` is `created`/`updated`.
- Slice boundaries could drop a fire — false: Candybar windows are half-open `[from, to)`.
- Hand-mirrored API/web types — rejected: the module convention across Holocene.
- Definitions poll keeps running on the Schedule tab, Follow button not sticky, midnight blanks the view, slice reads with different server `now` — low, rejected (cheap, cosmetic, or self-corrects on the next `current.advanced`).

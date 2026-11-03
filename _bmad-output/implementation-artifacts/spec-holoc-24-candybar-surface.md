---
title: 'HOLOC-24 slice: Candybar surface listing every active and inactive candybar'
type: 'feature'
created: '2026-11-03'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Candybar is the single clock for every recurring job on the host (83 registered, 79 enabled, 4 disabled on 2026-11-03), but Holocene has no view of it; the only way to see which candybars are active or not is the `candybar` CLI or raw `https://candybar.delo.sh` JSON.

**Approach:** Add a read-only Candybar tab to Holocene (`/candybar`) that lists every registered candybar, split into Active (enabled) and Inactive (disabled), with each one's schedule, timezone, tags, noise flag, next fire and last run. The Holocene API proxies the Candybar API (it sends no CORS headers) through a new `/api/modules/candybar/list` module with a short cache and a degraded "last good read" envelope when Candybar is down. This is the Definitions-list slice of HOLOC-24; the live Schedule tab, SSE, skips, noise edits and create are not part of it.

</frozen-after-approval>

## Implementation Notes

Decisions (mine, not user-visible gaps):

- Read-only. "Show" asked for a view; Candybar changes stay with the `candybar` CLI/API. No write route in the Holocene API.
- Upstream base `CANDYBAR_API_URL ?? "https://candybar.delo.sh"`, same `?? default` + trailing-slash strip as `DIRECTOR_API_URL`; no systemd unit change needed.
- Next fire comes from Candybar itself (`GET /schedule` over a 25 h window), never a client cron parser, so DST/Vixie rules match the dispatcher. The window read is ~2.3 MB, so it is cached 2 min; "next fire" is the first cached row with `fireTime > now` at request time, which stays exact for anything not skipped since the read. Candybars that fire less than daily show "after 24h" (after review: the window is read in five slices, reread when the enabled definitions change, and an older window is served only while it still reaches 24 h ahead).
- Last run comes from `GET /candybars/{id}/invocations?limit=1`, fanned out with bounded concurrency and cached 30 s. A failed per-candybar read leaves `lastRun` unknown; it never fails the list.
- The list itself is cached 10 s with in-flight dedupe; an upstream failure returns the last good list with `source.down` and `detail` (never healthy emptiness).
- Web follows the Transcripts surface: `usePoll`, hub shell, `HubTabs current="candybar"`, URL state (`?view=active|inactive&q=`), `cb-`-prefixed CSS on hub tokens only. Tab placed after Transcripts.

Files: `apps/api/src/candybar.ts` (+ `candybar.test.ts`, 17 tests), `apps/api/src/server.ts`, `apps/api/package.json` (test list), `apps/web/app/candybar/{page.tsx,candybar-app.tsx,candybar.css,types.ts,cron.ts,cron.test.ts}`, `apps/web/app/hub/ui.tsx` (one `HUB_TABS` entry).

Surprises:

- The Candybar API has no CORS headers, so the browser cannot read it directly; the API module is the only reader.
- `/schedule` refuses windows over 20,000 rows (422) and the 25 h window is already ~12,000, so the window is read in five 5 h slices.
- Live data on 2026-11-03: 83 candybars, 79 active, 4 inactive, 14 active ones failing their last run; the `skillex-hermes-resync` failures are by design (README) and still show as failed.
- `holocene.delo.sh` sits behind Google OIDC at the edge and the Kapture browser session is not an authorized account, so visual checks ran headless against the live `holocene-web` container (desktop 1440 px, phone 390 px).
- The web package has no test runner; `cron.test.ts` runs with the API package's tsx: `cd apps/api && node --import tsx --test ../web/app/candybar/cron.test.ts`.

## Review Triage Log

Layers: blind hunter (context-free) and an edge-case hunter (with the live API). No layer skipped.

- Invalid timestamps crash `Intl.format` on expand — medium, patched: projection keeps only parseable timestamps; the web formats through a validity guard.
- "Hide noise" hid failing noisy candybars and the hidden count ignored search — medium, patched: a failed last run is never hidden; the count is search-relative.
- Lede claimed every active last run "passed" when some never ran or were unread — low, patched: it now states only that none failed.
- Source strip dropped the API's list age (stale never showed) — medium, patched: `source` passes through with its age.
- "after 24h" could be false when an older window was served — medium, patched: an older window is served only while it still reaches 24 h ahead.
- New, re-enabled or rescheduled candybars read "after 24h" for up to 2 min — medium, patched: the window is reread whenever the enabled definitions' fingerprint changes.
- A failed window refresh retried after 120 s instead of 10 s — low, patched: errored reads use the short TTL.
- 25 h window has ~1.7x headroom before Candybar's 20,000-row 422 — medium, patched: five 5 h slices.
- A slow `/schedule` blocked the last-run column — low, patched: window and last runs read concurrently after the list.
- `isFrequent`/`describeCron` missed `1-59/2` and `1-59/5` (2 live jobs) — medium, patched: a full minute-field expander, tested against every live schedule shape.
- Failed last-run refreshes kept the old value silently — low, patched: still kept, now counted in the warning; deleted candybars are pruned from the cache.
- Next-fire time in the browser zone disagreed with cron words in the candybar zone — medium, patched: wall times render in the candybar's zone with a zone label.
- Glyph title duplicated "failed" for screen readers — low, patched. Sort control did nothing in the Inactive view — low, patched (hidden there). Duplicate tags would collide React keys — low, patched. Never-loaded list reported age 0 — low, patched.
- A `result: null` claim whose executor died would read "running" forever — maybe-false (no stuck claim exists live), deferred.
- Weekly/monthly candybars show "after 24h" rather than a date — low, deferred (their cron words already say "Mon 08:30").
- Operator skips can take up to 2 min to appear in next fire — low, rejected: the SSE Schedule tab (rest of HOLOC-24) is the live view.
- Module-level caches ignore per-registration `baseUrl` — false for production (one registration); rejected.
- `writeUrl` inside a `setState` updater — low, rejected: the existing Transcripts surface uses the same pattern; fixing one surface alone would split the convention.
- Hand-mirrored web types and undocumented `CANDYBAR_API_URL` — false as a defect: every Holocene upstream URL and payload type follows this convention.
- No-Candybar countdown shows "due now" until the next 15 s poll — low, rejected: self-corrects within one poll.

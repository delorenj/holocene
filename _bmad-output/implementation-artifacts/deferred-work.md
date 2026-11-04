
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Build the rest of HOLOC-24 on the Candybar tab: the live Schedule view over SSE, skip one/skip rest of day, noise add/remove, and create from Definitions.
  evidence: The user asked only to show active and inactive candybars; the slice shipped is the read-only Definitions list.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Flag a last run with `result: null` as stuck when it has been "running" far longer than its runner timeout.
  evidence: maybe-false, would be medium: a claim row whose executor died reads "running" forever and hides from the failing count; no stuck claim exists live on 2026-11-03, so it is unverified. A row older than its timeout_s in /candybars/{id}/invocations would prove it.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Show a date for weekly and monthly candybars' next fire instead of "after 24h".
  evidence: Six live candybars fire less than daily; the 25 h window cannot reach them, and a longer window would need many more /schedule slices.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-live-schedule.md`
  summary: Add the Schedule tab's write actions from the HOLOC-24 brief (skip one fire, skip rest of day, noise add/remove), which need a Holocene write path to Candybar.
  evidence: The live view shipped read-only; Holocene has no write route to Candybar yet and every skip still goes through `candybar skip`.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-live-schedule.md`
  summary: Opening a candybar from a Schedule row should scroll its Definitions row into view.
  evidence: The row opens, but in a long Active list it can sit below the fold.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Create a candybar from Definitions, and edit its schedule or runner, through the Holocene write path.
  evidence: The row actions cover skip, noise, enable, archive and the steward; registering and editing stay with `candybar register` and `candybar edit`.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Show the steward's queued, running and finished task transitions live instead of on the 15 s list poll.
  evidence: Task state comes from `GET /steward/tasks` per list refresh (10 s cache); Candybar publishes `bloodbank.cron.steward.task.*` facts that a stream could relay.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Let the operator override a candybar's project (`PUT /candybars/{id}/profile` with `method: "manual"`) from the panel.
  evidence: The contract allows a manual project; Holocene only displays the steward's choice.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Verify the write proxies and the profile/task panels against the real Candybar steward routes.
  evidence: When this slice shipped, https://candybar.delo.sh answered 404 for `/profiles` and `/steward/tasks`; the routes were tested against contract fakes and a local fake Candybar only.
  status: done 2026-11-03 (round 1). Verified live: profiles, tasks, archive, unarchive, enable, noise and skip through the UI. The steward POST (Enrich/Evaluate/Fix) is left to the integrator's live run.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Offer Cancel for a queued or running steward task (`POST /steward/tasks/{taskId}/cancel`, contract v1.1) beside the "queued 5m: is candybar-steward running?" hint.
  evidence: The route landed in candybar d1b3796 during round 1. Holocene only says the steward may be down, and the way out is still `candybar steward cancel <task-id>`.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Read active tasks with `GET /steward/tasks?active=1` as well as the newest 200, so an old stuck task still holds its button.
  evidence: maybe-false, would be low. The list reads `?limit=200` across all candybars, so a queued task older than the 200 newest would not show. Candybar's startup reaper now fails expired queued tasks, which makes this unlikely.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Run the impeccable detector as a URL scan of the live Candybar tab at 1440 and 390.
  evidence: The file scan of every changed web file returns []. The URL scan needs puppeteer, which is not installed for the skill's scripts.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-row-actions.md`
  summary: Find what recreates holocene-web outside a deploy. It was recreated twice during round 1's live pass, the IP moved between 172.19.0.91 and .96, and an in-flight Enable was cut.
  evidence: `docker inspect` showed holocene-web created 23:03:52 EST, mid-run, with no recreate from this session. The cut request left deploy-smoke-exec unarchived but disabled until it was re-enabled through the UI. Docker events did not name the actor.

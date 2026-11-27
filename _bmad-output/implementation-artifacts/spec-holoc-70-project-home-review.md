---
title: 'HOLOC-70 local slice: project home, preserved review revisions, durable annotations'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '1fffeb1d6b44e63421dc0d4b73c65ce17d4b6062'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A byte-identical copy published as a second walkthrough cannot get its own review revision; capture now answers 409.
    evidence: |-
      The revision id is the manifest hash alone (spec), so identical bytes collide across artifacts or projects. The patch makes the collision loud (409 naming the owner) instead of returning the other walkthrough's revision, which the guard would then 404. A per-project/per-artifact revision identity needs a spec change.
    location: >-
      apps/api/src/reviews.ts captureRevision
    severity: medium
  - summary: >-
      The first headless run after a deploy left the composer open after Save and stored no row; two later runs and the post-restart run passed.
    evidence: |-
      Unreproduced. Settle by running /tmp/holoc70-e2e/e2e.mjs annotate immediately after a fresh `mise run deploy` and capturing the composer status text and the proxy/API responses for the Save.
    location: >-
      apps/web/app/projects/review-view.tsx persist
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** HOLOC-70 (parent 33GOD-137) needs a stable authenticated project home at `https://holocene.delo.sh/projects/<encodeURIComponent(project_id)>` (pilot `greeninbetween`) where an operator reviews a project's published HTML walkthrough, with feedback bound to the exact bytes reviewed. Nothing exists yet: `/projects/*` 404s, catalog previews are unbound to a revision, and there is no annotation store.

**Approach:** Build the local slice the ticket says can proceed before BB-67/PJAN-234: AC1 (home + identity), AC2 (preserved revisions), AC3 (durable annotations/drafts), and AC7's local isolation. Reuse the HOLOC-53/69 catalog, the artifacts publisher (`publish.py`) and the opaque-origin srcdoc renderer; reuse Plannotator's supported HTML bridge seam (`@plannotator/ui` html-viewer bridge script + host-side anchor helpers) inside the existing sandbox. The home is generic for every PJangler project (belsky-doctrine); GIB is the first one exercised.

## Boundaries & Constraints

**Always:**
- Identity comes only from the PJangler registry (`PJ_REGISTRY_URL/v1/registry`, same read as `hub.ts readProjects`). Agreed contract (HOLOC-70 comment 2026-11-26 07:49): malformed or non-canonical segment → 400; valid unknown → 404 (`green-in-between`, `POOL` are not aliases); two registry rows resolving to one id → 409; registry unavailable → 503. Never guess.
- A review revision is the SHA-256-addressed copy of the publication's bytes (entry HTML + its bundle files) republished through `publish.py --project <id> --name review-<rev16> --no-index`; the revision id is the SHA-256 of the sorted `path\0sha256\n` manifest. Re-capturing identical bytes returns the same revision. Rendering a revision re-verifies the entry bytes against the stored hash and refuses on mismatch.
- Annotations belong to exactly one revision and keep author (from the edge identity, never the body), project, artifact, revision and the original anchor verbatim. Anchors that do not resolve are shown as unresolved, never rebound.
- Review routes require an HMAC over method, path+query, body SHA-256, author and timestamp (domain-separated key), signed only by Holocene's server-side proxy after it checks the edge user and, for mutations, a same-origin `Origin` and JSON content type.
- HTML renders only in a sandbox without `allow-same-origin` under `artifactPolicy`; the host accepts bridge messages only from that frame's `contentWindow`, origin `"null"`, the per-load key and the expected protocol version, with schema-checked, size-capped payloads.
- Desktop and 390px phone layouts without horizontal overflow; Ledger tokens from `hub.css`; both themes.

**Never:** Send feedback, outbox, command publication or any Bloodbank emit (AC4–5, BB-67); `pj dashboard` (AC6, PJAN-234); Plannotator's Inbox, its project DB, agent wake plugin, or full `HtmlViewer` UI; a second catalog or registry; `allow-same-origin`; rebinding old feedback to new bytes; synthetic/fixture-only live proof; GIB launch gates or game code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Home, known project | `/projects/greeninbetween` | Name, id, repo; HTML publications from collection `greeninbetween` with day/deep links; revisions with latest-vs-reviewed; catalog source freshness | none |
| Malformed id | `/projects/Green%20In` or `%252F` | Clear "malformed project id" | 400 |
| Unknown id | `/projects/green-in-between` | "No project greeninbetween…"-style not-found naming the id | 404 |
| Registry down | pjangler unreachable | "Project registry unavailable" | 503, retry |
| Unattributed | share/r2 items | Counted as "no project attribution", not listed under the project | none |
| Capture | Start review on an HTML publication | Revision row (hash, captured time, original + snapshot links) | publish failure → visible 502, no row |
| Same bytes again | second capture | Same revision id returned | none |
| Overwrite at old URL | original republished | Old revision unchanged; home shows "published again since review" | none |
| Snapshot tampered | snapshot entry bytes ≠ stored hash | Viewer refuses: "snapshot no longer matches" | 409 |
| Annotate text/element | bridge selection + comment | Saved row with anchor; survives reload and API restart | save failure → visible "Not saved", retry, draft kept |
| Draft | typing, not saved | Draft persisted server-side, restored on reload | same |
| Unresolved anchor | anchor not found on load | Listed with "anchor not found in this revision" | none |
| Forged message | message from another window / wrong key | Ignored | none |
| Unsigned/forged mutation | direct API call or bad HMAC | Rejected | 401 |

</intent-contract>

## Code Map

- `apps/api/src/artifacts.ts` -- catalog (`createArtifactCatalog`, `normalizeMinio`, `resolveTarget`, `readCapped`, `registerArtifactRoutes`). Reuse the catalog instance for the home; `normalizeMinio` must keep `review-<hex16>` publications out of the gallery (they are revisions, listed by the review store). Export the catalog factory call so reviews share one instance.
- `apps/api/src/artifact-documents.ts` -- `wrapHtml(html, baseUrl)`, `artifactPolicy`; revisions render through `wrapHtml` with the snapshot folder as base.
- `apps/api/src/hub.ts:125-150` -- `readProjects` registry parse and `recordFromManifest` (id lower-cased); `getRegisteredProjects` at :440. Identity resolution must detect duplicates (map currently overwrites silently) — add a resolver that keeps the raw rows.
- `apps/api/src/event-store.ts:31-62` -- `node:sqlite` `DatabaseSync` pattern (WAL, `synchronous=FULL`, mkdir 0700); `event-collector.ts:130` state path convention (`$XDG_STATE_HOME/holocene/*.sqlite3`).
- `apps/api/src/server.ts:54-65` -- route registration.
- `apps/web/app/api/artifacts/signed.ts` -- existing signed proxy (timestamp-only; read-only). The review proxy is new and stronger.
- `apps/web/app/artifacts/day-navigator.tsx:10-39`, `navigator-model.ts` (`sandboxFor`, `deepLink`, `Item`) -- iframe/srcdoc pattern and deep links to reuse.
- `apps/web/app/hub/hub-shell.tsx`, `hub.css` -- page chrome and tokens.
- `~/.agents/skills/artifacts/scripts/publish.py` -- `--project --name --date --no-index`; prints JSON receipt then URL; verifies every object by SHA-256 read-back.
- Traefik `google-auth@file` (andrewkroh google-oidc-auth-middleware, `oidc.go:226`) sets `X-Forwarded-User` to the authenticated email on every authenticated request to `holocene-web`.
- `@plannotator/ui@0.65.0` (Apache-2.0) -- only the explicitly exported `components/html-viewer/bridge-script` (`BRIDGE_SCRIPT`, `ANNOTATION_HIGHLIGHT_CSS`, protocol 2; it embeds its own sandbox shim). Its `useHtmlAnnotation`/`srcdoc`/`hostThreads` modules are not deep-importable (the `components/*` export maps to `.tsx`) and the barrel pulls in the full HtmlViewer UI, so Holocene owns the host side of the protocol. `@plannotator/core@0.25.33` `html-anchor` (`buildPersistedHtmlAnchor`) bounds the persisted anchor. Both ship raw `.ts` (Next `transpilePackages`).

## Tasks & Acceptance

**Execution:**
- `apps/api/src/project-identity.ts` (+test) -- canonical segment validation and registry resolution → `{status: 200|400|404|409|503, project?}`.
- `apps/api/src/review-store.ts` (+test) -- sqlite `revisions` and `annotations` (status `draft|saved`, `version` for optimistic concurrency); restart-durable.
- `apps/api/src/reviews.ts` (+test) -- request signature verify; capture (fetch bundle with caps, hash, stage to temp dir, `publish.py`, verify receipt URL is the expected snapshot key, insert); home payload; revision document (fetch snapshot entry, verify hash, `wrapHtml`); annotation CRUD with author from signed header.
- `apps/api/src/artifacts.ts` -- hide `review-<hex16>` publications from the gallery; share the catalog instance.
- `apps/api/src/server.ts`, `apps/api/package.json` -- register routes; add tests to the glob.
- `apps/web/app/api/projects/[...path]/route.ts` + `review-proxy.ts` -- edge-user + Origin/content-type checks, body cap, HMAC signing, proxy.
- `apps/web/app/projects/[projectId]/page.tsx`, `project-home.tsx`, `review/[revision]/page.tsx`, `review-view.tsx` (bridge host), `review-model.ts` (+test: bridge message schema, restore batch, injection point), `projects.css` -- home, revision viewer with annotation rail, bridge host adapter.
- `apps/web/package.json`, `apps/web/next.config.mjs` -- `@plannotator/ui` + `@plannotator/core` dependencies, `transpilePackages`, test glob.

**Acceptance Criteria:**
- Given the live route `/projects/greeninbetween` behind Google auth, when it loads, then it shows the registry identity, GIB HTML publications from the catalog with links to their originals and `/artifacts` deep links, catalog source freshness, and the count of unattributed items.
- Given a captured revision, when the original is republished with different bytes, then the revision still renders its original bytes and the home marks it as superseded by a later publication.
- Given a saved annotation and a saved draft, when the page reloads and `holocene-api.service` restarts, then both reappear with author, revision and original anchor intact.
- Given the review frame, when a message arrives from any other window or without the load key, then it is ignored; the frame has no `allow-same-origin`.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 30 findings — high 0, medium 5, low 12, false 9, maybe-false 4
- findings:
  - `[medium]` `[patch]` Blind: revision id not project/artifact scoped; identical bytes return another walkthrough's revision — captureRevision now 409s when the existing revision belongs to another project or artifact; test added (twin walkthrough). Separate per-walkthrough identity deferred.
  - `[false]` `[reject]` Blind: guard reads the project from `split("/")[4]` — every review route is registered under the fixed `/api/modules/projects/:project` prefix, so position 4 is always that segment; a mismatched shape never reaches the guard.
  - `[low]` `[reject]` Blind: publish succeeded but post-check failed orphans a hidden snapshot — needs a receipt/URL mismatch from publish.py (verified flags and output format match); rollback adds delete machinery for a path not met in use.
  - `[medium]` `[patch]` Blind: a 409 conflict re-sends the stale version forever — on conflict the composer now adopts the server row's version, shows its current text and lets an explicit Save replace it; autosave stays off while in conflict.
  - `[low]` `[reject]` Blind: X-Forwarded-User trusted without an edge marker — holocene-web publishes no host port (`docker port` empty); it is reachable only through Traefik google-auth; single-operator homelab policy.
  - `[low]` `[reject]` Blind: Telegram token is the HMAC root — reuses the existing artifact-read secret; both sides read the same env and restart together; domain-separated key.
  - `[low]` `[reject]` Blind: per-request registry lookup without a cache — registry is local (127.0.0.1:8764); a down registry answering 503 is the spec's identity contract; a cache adds staleness to identity.
  - `[low]` `[reject]` Blind: drafts visible to every viewer — single operator; drafts are labelled and unnumbered.
  - `[false]` `[reject]` Blind: capture uses the cached catalog, so a fresh publication 404s — the Start review button exists only for items in that same cached catalog instance (home and capture share `liveArtifactCatalog`).
  - `[low]` `[reject]` Blind: idempotent create returns the prior row when a retried body differs — needs a network failure after the server committed; draft autosave then PATCHes the difference; rare.
  - `[false]` `[reject]` Blind: injectBridge fallback lands before the CSP — unreachable: the document endpoint always renders through wrapHtml, which always emits the referrer marker.
  - `[medium]` `[patch]` Blind: web-edge helpers have no tests — grouped with the verification-gap mutation finding; `review-proxy.test.ts` added and registered.
  - `[maybe-false]` `[reject]` Blind: a malformed catalog URL 500s the home — catalog URLs are built from bucket keys; would need a row normalizeMinio never produces; if true, low.
  - `[low]` `[patch]` Blind: nothing links into the project home — the Artifacts day navigator now links its collection to `/projects/<collection>`.
  - `[low]` `[reject]` Blind: no back-pressure on concurrent captures — the button disables while capturing and insert-or-get dedupes; duplicate work only.
  - `[medium]` `[patch]` Edge: revision collision across projects/artifacts — same root cause as the first Blind row; same 409 patch.
  - `[low]` `[reject]` Edge: a user publication named `review-<hex16>` vanishes from the gallery — publisher-generated name shape; not met in use; requiring a store lookup couples the catalog to the review DB.
  - `[low]` `[patch]` Edge: an entry name with `!'()*` always 502s — encodeKey now percent-encodes those like publish.py's `quote()`; test added.
  - `[low]` `[patch]` Edge: the proxy's upstream fetch has no timeout — 11-minute AbortSignal (publish.py's ceiling is 10).
  - `[low]` `[reject]` Edge: proxy bypass with a forged X-Forwarded-User — same as the Blind row: no direct route to the container.
  - `[low]` `[reject]` Edge: orphaned snapshot after a failed receipt check — same as the Blind row.
  - `[medium]` `[patch]` Verification gap: web signReview and API reviewSignature are never tested against each other — one fixed vector asserted in both suites (`review-proxy.test.ts`, `reviews.test.ts`).
  - `[medium]` `[patch]` Verification gap: mutationAllowed (the CSRF guard) has no test — origin/scheme/null-origin/content-type/DELETE/forwarded-host cases added.
  - `[low]` `[patch]` VG other: REVIEW_PUBLICATION exported but unused and duplicated inline — moved to artifacts.ts and used by normalizeMinio.
  - `[false]` `[reject]` VG other: putRevision check-then-insert races — DatabaseSync is synchronous and putRevision has no await between the read and the INSERT, so two captures in one process cannot both insert.
  - `[maybe-false]` `[reject]` VG other: no test covers defaultPublisher's receipt parsing — verified against current publish.py output; live capture on 2026-11-26 published and verified `review-b3ccc0c636237792`; a future format change is speculative.
  - `[false]` `[reject]` Intent: live surface (edge, real storage, browser reload) has no evidence — headless Chromium against the deployed holocene-web: home, capture into MinIO, annotate, reload, `systemctl --user restart holocene-api.service`, reload: 3 saved + 2 drafts intact; public route 307s to Google auth.
  - `[maybe-false]` `[reject]` Intent: the bridge origin/source gate in review-view.tsx is untested — live check posted a forged bridge selection from the top window and no composer opened; a unit test needs a DOM; if broken, low.
  - `[low]` `[reject]` Intent: the last <900 ms of typing before a reload is not durable — inherent to debounced autosave; Save is explicit and immediate.
  - `[maybe-false]` `[reject]` Intent: page routes untested beyond href builders — exercised live (200 home, 400/404 identity, review render); if a regression, low.

### 2026-11-26 — Review pass (follow-up, live: conflict-overwrite and page-element annotations)
- verdicts: 4 findings — high 0, medium 1, low 2, false 0, maybe-false 1
- findings:
  - `[maybe-false]` `[reject]` Inline SVG pinpoint not exercised — no GIB walkthrough contains inline `<svg>`; the bridge's SVG branch is Plannotator's code; if broken, low.
  - `[low]` `[reject]` Pin badge sits at the click point (mid-word on a heading) — by design: the marker follows the stored selected point; cosmetic.
  - `[low]` `[patch]` After a remote delete, B's failed Save left the deleted row and marker in B's rail until reload — the 404 branch now removes the row and marker and keeps the text as a new draft with a fresh id; verified live (stale row gone, one saved row v2 after Save).
  - `[medium]` `[patch]` Found while verifying that patch: queued writes read the draft from a ref that updated only on render, and the reborn id was minted inside a state updater, so a Save right after an autosave produced two rows (a stray draft plus the saved one) — `updateDraft` now updates the ref synchronously with pure updaters and the id is minted outside; re-run live: one row, then the full annotate → reload → API restart → reload run passed (saved + draft intact, 0 unanchored).
- live coverage that passed (independent reviewer, two browser contexts): conflict shows the server text and keeps B's text; autosave never touches a saved annotation or a conflicted draft; second explicit Save overwrites (v3, still saved); Cancel during conflict keeps the server text; delete-in-A then Save-in-B shows "Not saved" with text kept; pinpoint on heading, image, link (ctrl-click) and `main` container stored as `kind=element` with `htmlAnchor`; all 4 markers restored after reload and after `systemctl --user restart holocene-api.service`, 0 unresolved; Interact opens no composer; switching back to Select text works. All test annotations deleted; the reviewer left the captured "Pool-hall posters v3" revision `e3756303…` in place.

## Design Notes

Mutation signature: `hex(HMAC_SHA256(HMAC_SHA256(secret, "holocene-reviews/v1"), [method, pathAndQuery, sha256(body), user, timestamp].join("\n")))`, 30 s window. The read-only catalog signature stays as is; review routes never accept it.

Bridge host: the bridge script and highlight CSS are injected into the revision srcdoc right after Holocene's CSP and referrer metas (never Plannotator's `injectIntoHead`, which strips the page CSP). In srcdoc mode the bridge posts with no token, and the page's own scripts share its realm, so a token inside the frame could be forged by the page. The per-load key is therefore the frame identity itself: every load (and every Re-place) mounts a fresh iframe element keyed by a new UUID, and the host accepts a message only when `event.source` is that load's `contentWindow`, `event.origin` is `"null"`, the load has posted `ready` with protocol 2, and the payload passes `readBridge` (prefix, shape, 10 000-character text cap, id caps). Bridge messages only propose a selection; nothing the frame posts is saved without the operator writing and saving a comment.

Saving: a fresh selection becomes a draft with a client UUID; drafts autosave (debounced) through one serialized writer, a saved annotation changes only on Save (optimistic `version`; 409 shows a conflict and the server's current row). A failed save shows "Not saved" and keeps the text.

## Verification

**Commands:**
- `pnpm --filter @holocene/api typecheck && pnpm --filter @holocene/api test` -- expected: exit 0
- `pnpm --filter @holocene/web typecheck && pnpm --filter @holocene/web test` -- expected: exit 0
- `mise run deploy` then headless Chromium against the web container: home renders, capture GIB walkthrough, annotate, reload, `systemctl --user restart holocene-api.service`, reload: annotation present; 390px no overflow.

## Auto Run Result

**Summary:** The HOLOC-70 local slice is live. `/projects/<canonical id>` resolves identity from the PJangler registry (400/404/409/503), lists the project's HTML walkthroughs from the shared artifact catalog with freshness and unattributed counts, preserves exact bytes as hash-addressed `review-<rev16>` publications, and serves a review view: the preserved copy in a sandboxed srcdoc frame (no `allow-same-origin`) hosting Plannotator's bridge protocol 2, with durable drafts and saved annotations in `node:sqlite`. Every review call goes through a signed web→API hop bound to method, path, body and the edge author. Send (AC4–5, BB-67), `pj dashboard` (AC6, PJAN-234) and the live loop (AC8) are not touched.

Note: the parent session implemented the change directly rather than through a fresh implementation subagent (the work predated this run's step-03 handoff); review layers ran context-free on the staged diff.

**Files:**
- `apps/api/src/project-identity.ts` — canonical segment parsing and registry resolution.
- `apps/api/src/review-store.ts` — revisions and annotations tables, optimistic versions, restart-durable.
- `apps/api/src/reviews.ts` — signature verify, capture/publish, home payload, verified revision document, annotation routes (+`viewer`).
- `apps/api/src/reviews.test.ts` — identity, capture, tamper, durability, signature vector, routes.
- `apps/api/src/artifacts.ts`, `server.ts`, `package.json` — hide review publications, shared catalog, route registration, test glob.
- `apps/web/app/api/projects/review-proxy.ts`, `[...path]/route.ts`, `review-proxy.test.ts` — signed proxy, same-origin mutation gate, tests.
- `apps/web/app/projects/*` — project home, review view (bridge host), pure model (+tests), styles, pages.
- `apps/web/app/artifacts/day-navigator.tsx` — link to the collection's project home.
- `apps/web/package.json`, `next.config.mjs`, `pnpm-lock.yaml` — `@plannotator/ui` 0.65.0, `@plannotator/core` 0.25.33, `transpilePackages`.

**Review breakdown:** 30 findings. Patched 10 rows (8 entries): medium ×4 entries (revision collision, conflict recovery, signature vector, mutation-gate tests), low ×4 (strict key encoding, proxy timeout, project home link, dead export). Deferred 2 (twin publications get 409 not their own revision; an unreproduced first-run composer stall). Rejected 18 as recorded above.

**Follow-up review recommended: true** — first pass patched 4 medium entries. Named unverified risk: the conflict-recovery path in `review-view.tsx` (adopt server version, explicit overwrite) is exercised by no test or live run, and the first post-deploy headless run once left the composer open with no stored row.

**Verification:**
- `pnpm --filter @holocene/api typecheck && test` — pass (380/380).
- `pnpm --filter @holocene/web typecheck && test` — pass (112/112).
- `mise run deploy` — API healthy, web healthy.
- Live (headless Chromium → holocene-web container, edge headers supplied): home 200 with 11 GIB walkthroughs; `green-in-between` 404, `Green%20In` 400, `a%252Fb` 400; capture of `launch-dashboard` → revision `b3ccc0c63623…` published and verified; text annotation with draft autosave then Save; second draft; reload and `systemctl --user restart holocene-api.service`: 3 saved (#1–#3) + 2 drafts intact, 0 unanchored; forged top-window bridge message ignored; 390px scrollWidth = clientWidth on home and review; no console errors. Test annotations deleted afterwards (DELETE 204 ×5). `https://holocene.delo.sh/projects/greeninbetween` → 307 to Google auth.

**Residual risks:** the POOL-186 page is a historical seed per the GIB PM, so the true product walkthrough is not yet named; unresolved-anchor display was not exercised live; element pinpoint annotations were not exercised live.

**Follow-up pass (2026-11-26):** conflict-overwrite and page-element annotations verified live by an independent reviewer; 2 patches (stale rail row after a remote delete; queued writes reading a stale draft ref). `followup_review_recommended` is now false: this follow-up pass patched no high. The deferred first-run composer stall may share the stale-ref root cause just fixed (a Save queued behind an autosave read a version that had not rendered yet); it stays deferred until a fresh post-deploy run reproduces or clears it.

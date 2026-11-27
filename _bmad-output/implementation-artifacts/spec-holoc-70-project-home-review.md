---
title: 'HOLOC-70 local slice: project home, preserved review revisions, durable annotations'
type: 'feature'
created: '2026-11-26'
status: 'draft'
baseline_revision: '1fffeb1d6b44e63421dc0d4b73c65ce17d4b6062'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
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
- `@plannotator/ui@0.65.0` `components/html-viewer/*` (Apache-2.0) -- bridge script string, sandbox shim, link guard, persisted-anchor helpers; raw `.ts` exports (Next `transpilePackages`).

## Tasks & Acceptance

**Execution:**
- `apps/api/src/project-identity.ts` (+test) -- canonical segment validation and registry resolution → `{status: 200|400|404|409|503, project?}`.
- `apps/api/src/review-store.ts` (+test) -- sqlite `revisions` and `annotations` (status `draft|saved`, `version` for optimistic concurrency); restart-durable.
- `apps/api/src/reviews.ts` (+test) -- request signature verify; capture (fetch bundle with caps, hash, stage to temp dir, `publish.py`, verify receipt URL is the expected snapshot key, insert); home payload; revision document (fetch snapshot entry, verify hash, `wrapHtml`); annotation CRUD with author from signed header.
- `apps/api/src/artifacts.ts` -- hide `review-<hex16>` publications from the gallery; share the catalog instance.
- `apps/api/src/server.ts`, `apps/api/package.json` -- register routes; add tests to the glob.
- `apps/web/app/api/projects/[...path]/route.ts` + `review-sign.ts` -- edge-user + Origin/content-type checks, body cap, HMAC signing, proxy.
- `apps/web/app/projects/[projectId]/page.tsx`, `project-home.tsx`, `review-view.tsx`, `review-model.ts` (+test), `plannotator-bridge.ts`, `projects.css` -- home, revision viewer with annotation rail, bridge host adapter.
- `apps/web/package.json`, `apps/web/next.config.mjs` -- `@plannotator/ui` dependency, `transpilePackages`, test glob.

**Acceptance Criteria:**
- Given the live route `/projects/greeninbetween` behind Google auth, when it loads, then it shows the registry identity, GIB HTML publications from the catalog with links to their originals and `/artifacts` deep links, catalog source freshness, and the count of unattributed items.
- Given a captured revision, when the original is republished with different bytes, then the revision still renders its original bytes and the home marks it as superseded by a later publication.
- Given a saved annotation and a saved draft, when the page reloads and `holocene-api.service` restarts, then both reappear with author, revision and original anchor intact.
- Given the review frame, when a message arrives from any other window or without the load key, then it is ignored; the frame has no `allow-same-origin`.

## Spec Change Log

## Review Triage Log

## Design Notes

Mutation signature: `hex(HMAC_SHA256(HMAC_SHA256(secret, "holocene-reviews/v1"), [method, pathAndQuery, sha256(body), user, timestamp].join("\n")))`, 30 s window. The read-only catalog signature stays as is; review routes never accept it.

## Verification

**Commands:**
- `pnpm --filter @holocene/api typecheck && pnpm --filter @holocene/api test` -- expected: exit 0
- `pnpm --filter @holocene/web typecheck && pnpm --filter @holocene/web test` -- expected: exit 0
- `mise run deploy` then headless Chromium against the web container: home renders, capture GIB walkthrough, annotate, reload, `systemctl --user restart holocene-api.service`, reload: annotation present; 390px no overflow.

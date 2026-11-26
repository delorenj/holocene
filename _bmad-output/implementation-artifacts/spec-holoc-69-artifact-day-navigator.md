---
title: 'HOLOC-69: browse artifacts by project and day with an embedded day navigator'
type: 'feature'
created: '2026-11-26'
status: 'in-review'
baseline_revision: '4b205f03eb6d4a072e1e62e1f3fcf3041d98418a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/apps/api/src/artifacts.ts'
  - '{project-root}/apps/web/app/artifacts/artifacts-app.tsx'
  - '{project-root}/_bmad-output/implementation-artifacts/HOLOC-53-candidate-verification.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Jarad approved Holocene Artifacts as the primary artifact browser instead of patching MinIO Console ("encapsulate each Project Day subdirectory ... when I click view, it opens up the day navigator"). The HOLOC-53/61 catalog is a flat, paginated card grid: it cannot show a project's day, cannot render an HTML report or Markdown inline, and offers no way to step between a day's artifacts or days. MinIO Preview hardcodes HTML/Markdown as unsupported.

**Approach:** Extend the one existing catalog with a placement model (Collection → Day → Publication) computed during normalization, then reuse that same model for gallery search ("View day" on every result and a "By day" mode), the day navigator and its deep links (belsky-doctrine: one model for every artifact consumer one level up, not a parallel index). Artifact markup renders only inside a credential-isolated sandboxed `srcdoc` iframe built server-side with a strict CSP; media renders natively.

## Boundaries & Constraints

**Always:**
- One catalog: placement (`collection`, `day`, `dayKind`, `layout`, `publication`, `primary`, `baseUrl`, `hubUrl`) is added to each `Artifact` in `normalizeMinio`/`normalizeR2`; day groups and the day view are queries over the same snapshot (`queryArtifacts`), served by the existing signed catalog route.
- Collections: the real project for `projects` (`project/YYYY-MM-DD/name/…` and legacy `project/<session>/…`), `share` for the share bucket, `video` for R2. Objects are never moved or renamed.
- Days use `America/New_York` (the zone `publish.py` dates folders in). A dated folder gives the published day (`dayKind: published`, string-compared by the date filter). Legacy/share items derive the day from their modified time (`modified`); R2 from its published metadata (`published`) else modified; no time gives `undated`. The UI labels every fallback and never calls a modification time "published" or "created".
- A publication with an HTML entry plus assets is one bundle: its primary lists every file name, and `baseUrl` + name reaches each supporting file (view, open, download). Independently usable originals keep their own entries (HOLOC-61 completeness: nothing that was listed before disappears).
- Published day hubs (`project/day/index-<hub>.html`) stay excluded as artifacts and surface only as a "Published day index" navigation link on that day.
- HTML renders in `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc>` (opaque origin, no `allow-same-origin`, no top navigation, no forms) whose document starts with `<base href=<publication folder> target=_blank>` and a CSP meta: `connect-src 'none'` (no fetch/XHR/WebSocket/beacon), scripts only inline/eval plus the publication folder and the approved CDNs, styles/images/fonts/media over https or data/blob, `frame-src`/`object-src`/`worker-src`/`form-action`/`base-uri` `'none'`, `no-referrer`. Relative assets resolve against the original folder on `s3.delo.sh`; fragment links scroll in place.
- Markdown is rendered by an escape-first renderer (raw HTML becomes text; links only http/https/mailto/relative/fragment) and shown in a sandbox **without** `allow-scripts` and with `script-src 'none'`. Text/JSON/log files render escaped in `<pre>`; PDFs, images, audio and video use native browser elements from their original URL.
- Document and download endpoints resolve targets only through the catalog by artifact id (+ optional bundle file name present in `filenames`), only on `https://s3.delo.sh/{projects,share}/` or `https://v.delo.sh/`, are HMAC-signed like the catalog, and fetch without credentials. Downloads stream as `attachment` with `nosniff` and a `sandbox` CSP.
- Deep links are `/artifacts?project=<collection>&day=<YYYY-MM-DD|undated>&artifact=<id>[&file=<name>]`; they restore the navigator on load and back/forward.

**Never:** a second index, cache or recurring scan clock; bucket policy, MinIO, Traefik or storage changes; anonymous catalog/document/download access; rendering artifact markup in Holocene's origin or with `allow-same-origin`; forwarding cookies or credentials to artifact hosts; a new npm dependency (lockfile is frozen in the web container); publishing day hubs as duplicate artifacts; presenting modified time as a published/creation time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dated publication | `tolt/2026-11-25/report/index.html` + `style.css` + `chart.png` | collection `tolt`, day `2026-11-25` published, one publication: primary `report` (all filenames) + `chart.png` original | none |
| Legacy session | `james-brennan/<uuid>/jim-position/index.html` modified `2026-11-10T22:21Z` | collection `james-brennan`, day `2026-11-10` (NY) kind `modified`, layout `session` | none |
| NY midnight boundary | legacy item modified `2026-11-11T03:30Z` | day `2026-11-10` (still 22:30 NY) | none |
| Undated | legacy item with no modified time | day `undated`, sorted after every dated day | none |
| Day hub | `tolt/2026-11-25/index-<hex>.html` | not an artifact; `hubUrl` on that day's items and navigation | none |
| R2 video | published metadata `2026-11-19T12:00Z` | collection `video`, day `2026-11-19` published, native `<video>` | none |
| Group by day | `group=days&search=brennan` | day groups (collection, day, kinds, matched, count, titles, hubUrl) newest first | invalid params → 400 |
| Day view | `project=tolt&day=2026-11-25` | that day's items in publication order (newest publication first, primary first) + `navigation.previous/next` (older/newer day in that collection) | unknown day → empty items, adjacency still computed |
| Deep link to missing artifact | `artifact` not in that day | navigator opens the day, notes the artifact is no longer there, selects the first item | none |
| Hostile HTML | script reads `parent.document`, `document.cookie`, `localStorage`, `fetch(holocene/api)`, `top.location=` | every attempt throws or is blocked by CSP; Holocene page unchanged | sandbox + CSP |
| Hostile Markdown | `<script>`, `<img onerror>`, `[x](javascript:…)` | shown as inert text; no element, no link | escape-first |
| Large document | HTML/Markdown > 4 MB | 413; UI offers Open original/Download | text > 1 MB truncated with notice |
| Binary "other" | `.zip`/`.gpg` | 415 `kind: binary`; UI offers Download/Open original | none |
| Unsigned request | document/download without HMAC | 401, no content | none |

</intent-contract>

## Code Map

- `apps/api/src/artifacts.ts` -- catalog normalizers (`normalizeMinio`, `normalizeR2`), `queryArtifacts`, signed routes. Gains placement, day groups, day view, document + download routes.
- `apps/api/src/artifact-documents.ts` (new) -- pure renderers: `documentKind`, `artifactPolicy`, `wrapHtml`, `renderMarkdown`, `wrapText`.
- `apps/api/src/artifacts.test.ts`, `apps/api/src/artifact-documents.test.ts` (new) -- node:test coverage.
- `apps/web/app/api/artifacts/signed.ts` (new) -- the one HMAC proxy for catalog/document/download.
- `apps/web/app/api/artifacts/{catalog,document,download}/route.ts` -- thin route wrappers.
- `apps/web/app/artifacts/navigator-model.ts` (new) -- pure deep-link, neighbour, viewer-kind, sandbox, label and file-URL helpers shared by the gallery and the navigator.
- `apps/web/app/artifacts/day-navigator.tsx` (new) -- the responsive navigator dialog.
- `apps/web/app/artifacts/artifacts-app.tsx`, `artifacts.css` -- "By day" mode, place breadcrumb + View day on cards, URL state.
- `apps/web/app/artifacts/artifacts.browser.mjs` -- routed Playwright acceptance incl. hostile isolation.

## Tasks & Acceptance

**Execution:**
- `apps/api/src/artifacts.ts` -- placement in both normalizers; hub capture; `project`/`day`/`group` query params; day groups + navigation; `/document` and `/download` signed routes -- one catalog, one model.
- `apps/api/src/artifact-documents.ts` -- escape-first Markdown, CSP/base injection, text shell -- testable without a browser.
- `apps/web/app/api/artifacts/*` -- shared signed proxy streaming bodies and safe headers.
- `apps/web/app/artifacts/navigator-model.ts` + test -- pure helpers; `day-navigator.tsx` + app/CSS changes -- UI.
- `apps/api/package.json`, `apps/web/package.json` -- test globs.
- Unit-test every I/O matrix row that is model-level (placement, NY boundary, undated, hub, groups, day view adjacency, hostile Markdown, CSP contents, unsigned routes, size/binary).

**Acceptance Criteria:**
- Given a gallery search for `brennan`, when Jarad clicks View day on a result, then the navigator opens on that project/day with the report rendered in the main pane and its deep link in the address bar.
- Given the navigator, when Previous/Next artifact or Previous/Next day is used, then the selection, main pane and deep link follow, and Back closes/restores state.
- Given a bundle (HTML + fonts/images), when it renders, then relative assets load from the original folder and every supporting file is listed with Open/Download.
- Given a hostile HTML or Markdown artifact, when rendered, then no script reaches Holocene's DOM, cookies, storage or API and the top page does not navigate.
- Given desktop 1440 and phone 390 viewports, when gallery and navigator render, then there is no page error and `scrollWidth` equals the viewport.

## Spec Change Log

- 2026-11-26: Initial spec from HOLOC-69's six Done-when items and the HOLOC-53/61 code at baseline `4b205f0`.
- 2026-11-26: Implemented and deployed (`mise run deploy:api`, `mise run deploy:web`). Amendments found while building, each kept:
  - Search now also matches `project`, `collection` and `day`, so a project or date search (`brennan`, `2026-11-12`) surfaces its days in By day mode; a title-only term such as `position` still narrows to the reports. KEEP: featured lookups still pick by exact original URL.
  - `queryArtifacts` (flat list / one day) and `queryDayGroups` (By day) are two functions over one `filterArtifacts`, so the catalog route returns a typed shape per mode; one-day pages may use `limit` up to 1000, everything else stays at 100.
  - Phone layout: the navigator overlay switches to block flow under 850px. With grid rows and `min-height:0` the fixed overlay shrank the viewer to a sliver and the list overlapped it (seen in the first 390px screenshot).
  - A sync XHR refused by CSP still raises a Playwright `request` event, then `requestfailed: csp`; acceptance counts only requests that produced a response as leaks.
  - Hostile acceptance fixture published as a real bundle: `https://s3.delo.sh/projects/holocene/2026-11-26/holoc-69-isolation-fixture/index.html` (index.html + assets/style.css + assets/dot.png + hostile.md).

## Review Triage Log

## Design Notes

Why `srcdoc` over a direct `s3.delo.sh` iframe: a direct frame runs under the object's own (absent) CSP, so artifact scripts could reach any network target; an injected meta CSP only exists in a document we build. The `srcdoc` frame without `allow-same-origin` has an opaque origin, so `document.cookie`/`localStorage` throw, `parent`/`top` are cross-origin, and same-site cookie rules treat its requests as cross-site; `connect-src 'none'` removes the network API on top. The original link stays one click away for full fidelity (e.g. pages that need `fetch`).

## Verification

**Commands:**
- `pnpm --filter @holocene/api typecheck` -- expected: exit 0
- `pnpm --filter @holocene/web typecheck` -- expected: exit 0
- `pnpm --filter @holocene/api test` (includes `artifacts.test.ts`, `artifact-documents.test.ts`) -- expected: all pass
- `pnpm --filter @holocene/web test` -- expected: all pass
- `mise run deploy` then `curl -fsS http://127.0.0.1:4000/health` -- expected: healthy API and web
- `ARTIFACTS_TEST_URL=http://<holocene-web IP>:3001 PLAYWRIGHT_MODULE=<playwright-core> CHROMIUM_PATH=/home/delorenj/.local/bin/google-chrome node --test apps/web/app/artifacts/artifacts.browser.mjs` -- expected: all pass
- Live headless acceptance against the container at 1440 and 390: search → day → Brennan report, adjacent navigation, bundle, legacy layout, hostile fixture isolation, originals/download/copy -- expected: no page errors, scrollWidth == viewport.

**Results (2026-11-26):** API typecheck and web typecheck exit 0; `@holocene/api` tests 368/368; `@holocene/web` tests 102/102; `artifacts.browser.mjs` 7/7 against the live container (3 HOLOC-53/61 tests plus 4 navigator tests: deep link + adjacent artifact/day + close, View day + Back, hostile HTML/Markdown isolation, 390px width). Live-data acceptance (`/tmp/holoc69/accept.mjs`, headless Chrome against `holocene-web:3001`): search `position` → View day opened `james-brennan` / Tue Nov 10 2026 ("day of last modification", session folder) with "The Position: Jim Brennan (IPM Home Services), 2026-11-10 (evening)" rendered in a sandbox whose `self.origin` is `null`; Next/Previous artifact and Previous/Next day round-trip in the URL; Open original answered 200; Download returned `attachment; filename="index.html"`; Copy link wrote the address-bar deep link, which reopened the same artifact in a fresh tab. Bundle "Who Hands Out the Work?" listed 5 files and loaded its Roboto/Noto fonts from the original folder. Hostile fixture: parent DOM, parent global, `top.location`, cookie, localStorage, top navigation → SecurityError; fetch to holocene.delo.sh / relative / 127.0.0.1:4000 and sync XHR → refused by `connect-src 'none'`; relative image loaded; zero frame requests reached Holocene; the dated day showed its "Published day index" hub link. Hostile Markdown: 0 scripts, 0 `img[src=x]`, 0 `javascript:` links, table and relative image rendered. By day for `brennan` listed project days newest first and opened the navigator. No page errors at 1440 or 390; `scrollWidth` 1440/1440 and 390/390 (gallery and navigator). `https://holocene.delo.sh/artifacts` answers 307 (Google OAuth edge).

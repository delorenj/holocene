# HOLOC-57 phase-1 investigation and verification

**2026-11-20 · isolated checkout** `.worktrees/holoc-57-products-sidebar` at `3fe12c684fef0de56c64b757381dc9da3f8bdbe1`. Investigation/spec/design only: not a deployed implementation or AC7 browser acceptance. The raw eight criteria and original attribution are preserved in [acceptance-source.md](acceptance-source.md). No board, production, merge or push mutation was authorized for this phase.

## Sources and source authority

- The PJ registry at `http://127.0.0.1:8764/v1/registry` returned registered `tolt`, `greeninbetween`, `gruvato`, `earshot` with local `repo_path` and a PM `agents/hermes/pm` role directory. `apps/api/src/hub.ts:getRegisteredProjects` reads the registry, but its public `ProjectRecord` in `hub-model.ts` does not retain agent `role_dir`. It also currently treats malformed/disconnected registry as empty; products must differentiate failure from a real empty result. Registry IDs, not names, anchor identity. Display names in registry are `TOLT`, `GreenInBetween`, `gruvato`, `Earshot`; friendly names in mocks are editorial, not canonical.
- Read `git -C <registered repo> show HEAD:.launch.yaml` for all four: `tolt`, `greeninbetween`, `gruvato` say `mode: launch`; `earshot` says `mode: live` and has a `live` block. `apps/api/src/live-model.ts:parseLaunchFile` validates live and treats other modes as `not-live`, so it cannot classify launch as written. It defaults missing mode to steady and treats some malformed non-live files as `not-live`: use a stricter tri-state parser for directory; distinguish missing/error/unknown from steady. Use a bounded, no-shell, repository-contained committed-file read; don't silently read a mutable worktree declaration.
- The first three have PM runtime `agents/hermes/pm/runtime/launch-dashboard.json`, schema `launch-dashboard/1`, with `published.url` and `published.at`; Earshot has no dashboard receipt and should link existing `/live`. The publisher in Tolt's `agents/hermes/pm/.scripts/launch-dashboard.py` writes the publication result back to PM runtime; this receipt is a destination locator, not lifecycle authority. Respect each registry role path and reject escape; do not hardcode all project directories from this intake snapshot. The three current receipt URLs are under `https://s3.delo.sh/projects/{tolt|greeninbetween|gruvato}/2026-11-18/launch-dashboard/index.html`. Read-only anonymous GET on 2026-11-20 returned HTTP 200 for each HTML and sibling `dashboard.json`; page titles were `TOLT launch dashboard`, `GreenInBetween launch dashboard`, `gruvato launch dashboard`. This is transport/content evidence, not an authenticated browser open, publication freshness guarantee or production UI test.
- `apps/api/src/live.ts:createLiveHub` already owns Live discovery/projections; do not alter Earshot operations. New directory should reuse PJ registration and validated live declaration semantics, but not invoke storefront, payments, fulfilment or other expensive Live probes just to list products.

## Navigation, visual and boundary findings

- `apps/web/app/hub/ui.tsx:HubTabs` is the shared eleven-link primary strip. It exposes real `href`s and intercepts unmodified same-tab hub clicks via `onSelect`; preserve native modified click, middle button, back/forward, `/?view=agents`, `/?view=projects` and project focus query semantics. The component has nine call sites (hub and eight specialist apps). `/hooks`, `/legacy` and `/mini` are separate legacy content surfaces; keep reachable without rewriting their content.
- Current implementation tokens are Ledger/Ledger night in `apps/web/app/hub/hub.css`; old `design/project/README.md` and older Stitch Spruce concepts are not approved current implementation. `_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/{DESIGN,EXPERIENCE}.md` are empty draft frontmatter; do not falsely mark them final before PM design choice. `.memlog.md` now records the conflict and phase boundary through its writer.
- `apps/web/next.config.mjs` rewrites `/api/modules/*` to the API; auth is at the edge rather than a `apps/web/middleware.ts` file (that file does not exist). Agent Pad nginx and `/hq` have their own auth contexts; don't route across them or relax authentication. API links must be allowlisted HTTPS outbound destinations, `/live` internal. Never serialize `live.checkout.key_ref`, payment identifiers, secret refs, or raw receipt blobs into directory metadata. Cache should retain last-good with an age and visible error, never fabricate healthy counts or imply empty when discovery fails.

## Design and implementation risks

1. Registry failure currently aliases empty in hub logic; products need a typed failure and bounded last-good behavior. Registry project identity differs from editorial brand labels, and non-PM agents may be retired.
2. A launch→live change could publish new metadata before/after a committed declaration; keyed by PJ ID, classify from commit only and treat a stale receipt as an unavailable launch link, not a second entry. Unknown/malformed declarations are errors, not guessed steady.
3. Date-stamped MinIO paths are mutable in receipts. Validate safe scheme, allowed host/path and receipt shape on every read; missing publication must disable the outbound action without hiding the project. Do not mistake HTTP 200 from intake for a permanent guarantee.
4. A sidebar across existing shells risks hub query/history regression, theme CSS bleed, horizontal overflow and keyboard focus trap. Mobile mocked interactions are not proven; test them in an isolated real browser only after implementation and PM choice.
5. Stitch's generated HTML is **untrusted and not implementation**: scripts use a CDN and placeholders, some targets use `#` or `#/live`, and its mobile image was produced on a 2020px-wide canvas despite `device: MOBILE`. It includes invented IDs and publication-checksum language; explicitly reject these, derive copy/actions from actual source states. Verify actual 320/390px viewport later.
6. No production changes or automated app tests in phase 1. Full source/auth/browser acceptance, reviewed implementation checkpoint and public serving remain pending.

## Phase-1 checks

- Parsed eight `<li>` acceptance paragraphs from dispatched live ticket JSON; count = **8** and original text retained in sibling file.
- Verified all four registered projects and committed modes; three PM publication receipts matched expected URLs and had `published.at`; Earshot lacks receipt by design.
- Fetched all six published HTML/JSON resources anonymously: HTTP **200** each on this read. This checks link availability, **not** browser navigation or authenticity/freshness of receipt data.
- Stitch CLI 0.12.1 dry-run then actual generation; fetched three private screen exports and resolved Canvas URLs. Metadata: desktop `DESKTOP`, early phone board `DESKTOP`, revised single-view phone `MOBILE`. HTML/Png exist for all three; screenshot width of revised phone is 2020px (presentation canvas), not a 390px viewport validation. Selection pending.
- `git diff --check` on tracked changes; no app code changed. Spec and export integrity checks to follow in phase-1 validation; both app typechecks intentionally reserved for post-choice implementation.

## Continuation authority

Owning PM selected desktop A + phone C with mandatory corrections and authorized isolated implementation on 2026-11-20. Phase-1 provenance above is historical, not an unresolved choice. Parent owns independent reviews, no worker self-review counts as AC7. Commit own paths only; no push, merge, board, lifecycle or production mutation.

## Source-grounded candidate implementation

- Added `products-model.ts` and `products.ts`: reuse registered PJ identity including declared PM role directory; bounded Git reads of **committed** `.launch.yaml`, explicit unknown/missing/invalid/unavailable issues; launch/live projection; no steady entries; valid live details reuse existing parser without serializing details. Five-second coalesced cache with dated last-good PJ snapshot on outage, not false emptiness. Receipt links require `launch-dashboard/1`, valid publication timestamp, canonical safe HTTPS `s3.delo.sh/projects/.../launch-dashboard/index.html`. Destination changes do not replace product identity. Registered role-path escape, symlink escape, oversized/non-regular/FIFO receipts fail closed. Open-fd containment is Linux-specific, matching the deployment host.
- `/api/modules/products` is GET-only, no-store, registered in existing server; existing `/api/modules/*` web rewrite and Google-auth edge stay unchanged. No client gets repo paths, PM paths, raw YAML/receipts, checkout IDs or credential refs. No publisher probes or new Live operations.
- Added Products page and URL-backed stage subsets. Three launch rows and Earshot `/live` are read from actual local sources. PJ currently includes **51 other registered projects with missing/invalid/unavailable lifecycle declarations**; these are shown under the labelled source-issues disclosure (collapsed, not hidden from discovery). No guessed classification and no invented health.
- HubShell/hierarchy replaces all nine HubTabs callsites. Products/subsets lead; Workspace/Media/System group current ancestor and accessible disclosures. 232px desktop sidebar; modal phone drawer uses existing Radix dependency, same hierarchy, Escape/focus return and trapped focus. Shared skip target. Existing specialist content is unchanged; direct hub query/focus/history preserved.
- Reconciled selected A+C into DESIGN/EXPERIENCE and appended owning-PM rationale through memlog writer. Stitch scripts were not executed or shipped. Private exports retained as source references, approximately 1.9MB total; browser evidence approximately 2MB.

## Executed checks (2026-11-20)

All commands ran in this isolated worktree with its own `node_modules` and `.next`; package workspace symlinks resolve inside it. No manifest/lock dependency addition. Ephemeral Playwright is in active-profile scratch `holoc57-browser-deps/node_modules/playwright/index.mjs`. pnpm emitted the pre-existing unresolved NPM_TOKEN config warning; installs/checks succeeded.

| Check | Actual result |
|---|---|
| `pnpm --filter @holocene/api typecheck` | exit 0 |
| `pnpm --filter @holocene/web typecheck` | exit 0 |
| `pnpm --filter @holocene/api test` | exit 0; 330 passed, 0 failed/cancelled/skipped |
| `pnpm --filter @holocene/web test` | exit 0; 86 passed, 0 failed/cancelled/skipped |
| `HOLOCENE_API_INTERNAL_URL=http://127.0.0.1:4107 pnpm --filter @holocene/web build` | exit 0; optimized build, 18 static pages; Products generated, 128kB first load |
| `pnpm --filter @holocene/web test:products-browser` with `PLAYWRIGHT_MODULE` and evidence path | exit 0; 3 passed, 0 failed/cancelled/skipped against **optimized `next start`**, not only dev |
| `git diff --check` | final exit 0 (recorded after removing one trailing blank line) |
| Anonymous public HEAD `/products`, `/api/modules/products` | HTTP 307 each; edge protects requests. **Not authenticated browser acceptance or candidate production serving.** |

Logs are in [checks/](checks/); browser measurements, opened URLs/titles and screenshots are in [browser/](browser/). Test source: `apps/api/src/products{,-model}.test.ts`, `apps/web/app/hub/navigation-model.test.ts`, `apps/web/app/products/products.browser.mjs`.

### Matrix audit / per-AC candidate evidence

| AC / matrix row | Executed evidence | Remaining gate |
|---|---|---|
| 1 Current directory / publication changes | API projection tests and real-browser first test: exactly TOLT, GreenInBetween, gruvato launch plus Earshot live. Clicked all three actual receipt URLs, matched page titles/content, `window.opener === null`; clicked Earshot and rendered heading at `/live`. Receipt mutation fixture updates link with same ID. | Independent acceptance, later live serving |
| 2 Promotion / declaration failures / discovery fails | API tests cover valid launch/live, missing/unknown/invalid YAML, committed vs dirty disk, missing Git file, read failure, missing/unsafe receipt, PJ malformed response, thrown/down first read and last-good snapshot, healthy empty, steady excluded, promotion same ID once. FIFOs/oversize/path and symlink escapes reject. | None known in candidate; reviewers to audit |
| 3 Design selection | Real selected screen IDs and PM rationale in handoff, DESIGN/EXPERIENCE and memlog; implementation uses Ledger tokens, compact hierarchy and phone rows, none of export mock claims. | Independent visual verdict |
| 4 Navigation | Browser second test: direct `/?view=projects&focus=earshot`, native Ctrl-click and middle-click new tabs, unmodified in-place Agents/Projects, focus/back/forward restored. Products stage back/forward/subsets. Seven specialist shells checked for one current-page link/no old tab strip and 320px no page overflow; unit test retains all old destinations including `/mini`, `/hooks`, `/legacy`. | Legacy content redesign out of scope; specialist API data not fully exercised by adapter |
| 5 Responsive/keyboard/themes | Browser at 1440×1000, 390×844, 320×740: page/body scroll width exactly viewport; desktop sidebar 232px. Both themes screenshots. Reduced motion: sidebar no animation/transition. Menu Enter, 22 Tab traversals contained, Escape and eventual focus return, disclosure aria-expanded, skip target focus, current semantics. Product provenance contrast day 6.98:1/night 5.77:1; nav text 12.13/10.81:1; nav accent focus vs background 7.31/6.82:1. Real keyboard focus outline >=2px solid. | No screen-reader session or full WCAG certification claimed |
| 6 Tests/privacy/auth | Checks above; allowlisted metadata, scheme attacks and nonserialized credential refs asserted. Existing platform compose read-only inspection: host-wide Google-auth router middleware; higher-priority bypass only HQ/static/privacy, not `/products` or `/api/modules/products`. Anonymous 307 corroborates protection without testing login. | Authenticated live browser pending |
| 7 Real desktop/phone links | Worker browser evidence includes each launch dashboard and actual Earshot heading at all three viewports, not mocks or login redirects. Failure-state browser uses a **labelled fixture-only test**, separate from real-link test. | **Independent spec + quality reviewers must run their own checks. Worker evidence is not AC7 sign-off.** |
| 8 Handoff | Explicit-path local commit, no push/merge/deploy/restart/board/lifecycle changes. Reviewed-local candidate handed to parent. | **Reviewed checkpoint and public/authenticated live acceptance remain open.** |

### Verification iterations and limits

- Initial unsafe-URL unit assertion exposed URL normalization of dot segments; fixed by requiring canonical input URL rather than weakening expectation. Full final suite passes.
- Dev browser run first observed native Ctrl-click with the wrong popup event; corrected harness to observe browser-context page. Optimized run exposed asynchronous Radix focus-return timing and pointer-vs-keyboard focus detection assumptions; harness now waits for actual returned focus and performs real Tab input before asserting visible outline. Final optimized run passes all three tests.
- Candidate workbench is read-only: `workbench.mts` serves real directory code on loopback 4107, proxies only existing Live and hub GET responses from running API 4000. It does not start a second Live pipeline or collector. Live page code is the candidate; operational data is from the existing API. Other specialist surfaces were checked for shell/navigation/layout only; their API paths intentionally are not all forwarded and some show unavailable data.
- No authenticated production UI, independent review, screen-reader pass, real device/hardware test or full legacy redesign claimed. Browser automation is isolated headless Chrome with a fresh profile, not host Chrome. The isolated desktop MCP tools were not exposed, so the task-authorized ephemeral Playwright fallback was used.

### Reproduce / temporary reviewers' services

From this worktree, build workspace packages if fresh, then:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @holocene/org-model build
pnpm --filter @holocene/bloodbank-client build
pnpm --filter @holocene/system-actions build
pnpm --filter @holocene/module-sdk build
pnpm --filter @holocene/modules-hermes-fleet build
pnpm --filter @holocene/api exec tsx ../../_bmad-output/implementation-artifacts/holoc-57/workbench.mts
# separate foreground process:
HOLOCENE_API_INTERNAL_URL=http://127.0.0.1:4107 pnpm --filter @holocene/web build
HOLOCENE_API_INTERNAL_URL=http://127.0.0.1:4107 pnpm --filter @holocene/web exec next start --hostname 127.0.0.1 -p 3107
# separate shell, use existing scratch-only Playwright or install ephemeral outside repo:
PLAYWRIGHT_MODULE="$TMPDIR/holoc57-browser-deps/node_modules/playwright/index.mjs" PRODUCTS_EVIDENCE_DIR="$PWD/_bmad-output/implementation-artifacts/holoc-57/browser" pnpm --filter @holocene/web test:products-browser
```

Review services are temporarily handed to parent: web process handle `proc_922d6069b1e8` (launcher 220593, Next 222292, cwd worktree/apps/web), API adapter `proc_62db79cf3e89` (launcher 220966, tsx child 222434, cwd worktree/apps/api). Both bind only 127.0.0.1, ports 3107/4107. Parent must terminate these handles after reviews; no persistence requested. Earlier dev/adapter handles were killed. No production service was restarted.

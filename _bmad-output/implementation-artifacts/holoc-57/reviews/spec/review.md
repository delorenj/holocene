# HOLOC-57 independent spec acceptance review

**Decision: BLOCKED — two reproducible AC2 violations.** The real current directory, desktop/phone destinations and navigation interactions work. Passing existing suites do not cover the malformed source types below. No implementation changes were made.

## Scope and identity

- Reviewed candidate `4d36eb9c237549c3ce6e0913b5960a47387c3001`, implementation `5bef5a8c400ab393e908ccd05dd1d027d92cc045`, against base `3fe12c684fef0de56c64b757381dc9da3f8bdbe1`.
- Worktree: `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar`.
- Binding inputs: `../../acceptance-source.md` (all eight original criteria), `../../../spec-holoc-57-products-sidebar.md`, candidate source, investigation/handoff, accepted DESIGN/EXPERIENCE, Stitch A/C provenance and owning-PM decision in UX `.memlog.md`.
- Browser: isolated fresh Chromium contexts, real optimized candidate `http://127.0.0.1:3107`; real products code at `4107`; existing operational Live/hub GETs proxied from `4000`. No collector, application server rebuild/restart, login bypass, operational write, board write, Git commit/push/merge or source modification.
- All files created by this review are under this `reviews/spec/` directory. Sibling quality review was not used as this review's evidence. Parent-owned service handles were not stopped.

## Blocking findings

### SPEC-F1 — array-valued lifecycle modes are classified as Live

**AC2; medium severity, acceptance blocking.**

`apps/api/src/products-model.ts:19` validates membership using `String(doc.mode)`, so YAML `mode: [launch]`, `mode: [steady]` and `mode: [live]` pass the enum check. Lines 20–21 compare the original array strictly to string values, miss both branches, then lines 22–24 unconditionally return `stage: live`. `apps/api/src/products.ts:95–96` consequently emits a Live product and an actionable `/live` destination.

Independent execution of the candidate's actual exported classifier and directory returned:

```text
classifyProduct("mode: [launch]")
=> { stage: "live", issue: "Committed live declaration is invalid; inspect its live configuration." }
classifyProduct("mode: [steady]") => same
createProductsDirectory(... raw: "mode: [launch]" ...)
=> products[0].stage == "live", destination.href == "/live", issues == []
```

The invalid-config warning does not repair the false lifecycle: a declaration that does **not** declare a scalar Live mode appears in Live with an operational action. This violates authoritative classification and the explicit no-guessed-classification constraint. Browser rendering of that actual directory-generated fixture shows it in Live.

**Required acceptance correction:** reject non-string/non-enum `mode` before classification; render a lifecycle source issue with no guessed product stage/action. Add regressions for sequence/object/null/scalar-type inputs, including `[launch]`, `[steady]`, `[live]`.

Evidence: [source-probes.mts](source-probes.mts), [source-probes.json](source-probes.json) lines 2–65, [source-probes.log](source-probes.log), `independent-browser-results.json` fixture `invalid-array-mode`, [320px screenshot](fixture-invalid-array-mode-320.png). These are labelled synthetic inputs to actual candidate logic, not mutations of any real project declaration.

### SPEC-F2 — malformed registry identity overwrites last-good with healthy emptiness

**AC2; medium severity, acceptance blocking.**

`apps/api/src/hub.ts:135–137` checks the row and repo path, but accepts a non-string `project_id`. For `{ projects: { example: { repo_path: "/registered", project_id: 123 } } }`, nullish fallback at line 136 retains the number. `recordFromManifest` at lines 91–94 cannot derive an ID and returns `undefined`; line 137 silently drops the registered project. Lines 139–150 report a successful source. `getRegisteredProjects` at lines 439–441 returns `projects: []` without `down`.

Independent execution confirmed both first-read and previously-good cases. After a valid one-product snapshot, advancing the clock 6 seconds and returning the malformed row yields:

```text
registry: { state: "ok", snapshotAt: "2026-11-20T23:40:06.000Z", ageSeconds: 0 }
products: []
issues: []
```

`createProductsDirectory` at `products.ts:78–80` trusts this as last-good, losing the earlier product. The real UI displays a fresh PJ read and “No registered products declared launch/live,” not incomplete discovery. This is precisely the false-empty/healthy state AC2 disallows.

**Required acceptance correction:** do not silently skip invalid registry identity; reject the malformed discovery (retaining dated last-good) or expose a typed source issue without claiming a fresh complete snapshot. Add malformed-row identity tests for first-read and after-last-good.

Evidence: [source-probes.mts](source-probes.mts) lines 22–40, [source-probes.json](source-probes.json) lines 67–89, [source-probes.log](source-probes.log), `independent-browser-results.json` fixture `malformed-registry-false-empty`, [320px screenshot](fixture-malformed-registry-false-empty-320.png). The registry response was intercepted only inside the bounded review process; no PJ source was changed.

## Per-AC verdicts

| AC | Verdict | Independent evidence / remaining condition |
|---|---|---|
| 1 | **PASS** | Real `/products` shows three Preparing to launch entries (TOLT, GreenInBetween, gruvato) and Earshot Live. All nine dashboard opens across 1440/390/320 CSS widths returned HTTP 200 at the exact receipt URLs with correct titles and substantial actual content; all three Earshot opens rendered its heading at candidate `/live`. Launch tabs have null opener and empty referrer. Reproduced publication-update and launch→live identity tests pass; stable route is `/products`, not receipt URL. |
| 2 | **FAIL** | Committed Git reads, steady exclusion, promotion identity, receipt lookup, bounded reads, missing/unavailable declarations, registry outage and dated last-good tests pass for covered inputs. Current real directory exposes 51 source issues and no fabricated health. However SPEC-F1 misclassifies malformed sequence modes as Live, and SPEC-F2 converts malformed registry identity into fresh healthy emptiness, including loss of last-good. Both block acceptance. |
| 3 | **PASS** | Screen IDs A `1857e1f45dbb4f88ae5dd8c0355611f7` and C `ab1b8cdd2fdd4409a3b3f89a55a747ba`, PM rationale/corrections and unselected B distinction are recorded in handoff, DESIGN, EXPERIENCE and UX memlog. Candidate implements the corrected Ledger direction: 232px hierarchy, Products first, compact ruled rows, modal phone navigation, real names/receipts/routes, no mock certification/health claims or shipped Stitch scripts. Real DOM/style measurements and captures cover actual 390/320 CSS widths, not Stitch canvas size. This is a bounded direction-conformance review, not pixel-perfect design certification. |
| 4 | **PASS** | Shared shell replaces nine prior tab call sites. All prior nav URLs retained. Independently exercised stage links/back/forward, direct `/?view=projects&focus=earshot` with rendered selected Earshot panel, direct `/?view=agents&focus=holocene-pm` with rendered agent panel at all widths, Agents/Projects keyboard navigation and focus restoration through history. Native Ctrl-click and middle-click open distinct pages without changing original focus query. Seven specialist shells have exactly one current link/no old strip; `/mini`, `/hooks`, `/legacy` remain reachable (200) without forced redesign. Actual Live route and current Workspace ancestor verified. |
| 5 | **PASS** | Products/body/page and actual Earshot Live have scroll widths exactly 1440, 390, 320. Both Ledger themes captured; shared/legacy route-width sweep and real focused Agents canvas do not overflow. Keyboard Menu reached in two Tabs, 2px solid focus, keyboard group Enter/aria-controls, 30 Tab/Shift+Tab trap steps, Escape/focus return, route-select dismissal, current-page links and skip-to-main work. Both phone drawer themes retain tokens, current-group label and zero animation/transition under reduced motion. Settled outside click at 390 dismisses; 320 drawer is full width. Reproduced contrast checks pass. No screen-reader/full-WCAG certification claimed. |
| 6 | **PARTIAL** | Both typechecks and 330 API/86 web regressions pass independently; the 3-test browser suite also passes when correctly configured. Tests cover major lifecycle/receipt/route/cache/privacy paths but miss both invalid-type cases above. Product response allowlists fields, exposes no repo paths/key refs, safe canonical HTTPS destinations only; Live remains `/live`. Existing module rewrite/edge-auth config is unchanged. Anonymous public `/products` and `/api/modules/products` each return Google 307 without metadata. Authenticated public candidate acceptance is not performed and is intentionally not a local-phase blocker; running container labels could not be inspected because `docker inspect holocene-web` returned no such object. |
| 7 | **PARTIAL** | **This independent spec review's required browser work is complete**, including actual launch dashboard opens and rendered existing Earshot Live at all three viewports. Durable commands, measurements, HTTP statuses, titles and screenshots are separate from worker evidence. The independent quality review must be considered separately by parent; this spec reviewer does not claim that review happened or passed. Fixture browser states are explicitly synthetic and are not used to establish real-link acceptance. |
| 8 | **PARTIAL** | Candidate local implementation commits remain preserved and this review provides a clear, reproducible handoff. This is a **reviewed but not accepted** checkpoint because of two blockers; parent must obtain corrections/review and own any later push/production procedure. No production deployment demanded here. Public candidate serving and authenticated live-browser acceptance remain unmet, not falsely signed off from loopback or Google redirects. Latest push authority is parent-owned and was not exercised here. |

## Executed commands and outputs

All commands below ran from the worktree root. Full machine-readable command records: [check-results.json](check-results.json), [browser-rerun-result.json](browser-rerun-result.json), [independent-command-results.json](independent-command-results.json).

```sh
python _bmad-output/implementation-artifacts/holoc-57/reviews/spec/run-checks.py
# API typecheck --incremental false: 0
# web typecheck --incremental false: 0
# API test: 0; 330 pass, 0 fail
# web test: 0; 86 pass, 0 fail
```

`--incremental false` avoids writing source-tree TypeScript cache files. Test temporary roots were review-owned and removed after execution. Initial browser attempt in that runner failed **before page navigation** because its long review-directory TMPDIR exceeded Chromium Unix socket limits. Retried with the original active-profile scratch TMPDIR:

```sh
PLAYWRIGHT_MODULE=/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs \
PRODUCTS_EVIDENCE_DIR="$PWD/_bmad-output/implementation-artifacts/holoc-57/reviews/spec/reproduced-browser" \
pnpm --filter @holocene/web test:products-browser
# 0; 3 pass, 0 fail. Re-executed by reviewer, not worker's old output.

python _bmad-output/implementation-artifacts/holoc-57/reviews/spec/run-independent.py
# All four commands exit 0:
# pnpm --filter @holocene/api exec tsx ../../_bmad-output/implementation-artifacts/holoc-57/reviews/spec/source-probes.mts
# node _bmad-output/implementation-artifacts/holoc-57/reviews/spec/independent-browser.mjs
# node _bmad-output/implementation-artifacts/holoc-57/reviews/spec/supplemental-navigation.mjs
# node _bmad-output/implementation-artifacts/holoc-57/reviews/spec/outside-click-probe.mjs
```

The reproduction probe asserts **observed defective behavior**, not expected acceptance, so its exit 0 means both defect reproductions were confirmed. No fixture result is presented as real source mutation or production acceptance.

Supplemental harness iterations corrected hidden-desktop-nav waits on phone (`attached`, not `visible`), the visually clipped current-group text read (`textContent`, not `innerText`), and timing of Radix's deferred outside-pointer listener (200ms settled probe). Outside dismissal succeeds after settling; no UI defect filed for these harness assumptions. pnpm's existing `${NPM_TOKEN?}` warning did not block any check; no credentials are recorded.

`git diff --check` returned 0. Tracked source remains unchanged. `docker inspect holocene-web` returned exit 1 / `no such object`, recorded in [container-auth-inspection.json](container-auth-inspection.json); no daemon switching/escalation/restart was attempted. Public anonymous boundary was independently checked without following redirects or retaining cookies.

## Durable browser evidence

- [independent-browser-results.json](independent-browser-results.json): 3 real viewports, each real destination's measured viewport/title/URL/opener/referrer, document HTTP 200s, current products, 51-source-issue disclosure, keyboard trap/focus details, route/width sweep, six labelled fixtures and public anonymous auth status.
- [supplemental-navigation-results.json](supplemental-navigation-results.json): rendered agent focus/history, both drawer themes, current ancestor and keyboard skip at all widths.
- [outside-click-probe.json](outside-click-probe.json): real 390px overlay hit-test/dismissal on Products and Agents.
- `independent-products-{1440,390,320}-{ledger,ledger-night}.png`, `independent-drawer-{390,320}.png`, `independent-dashboard-{tolt,greeninbetween,gruvato}-{1440,390,320}.png`, `independent-live-{1440,390,320}.png`.
- `fixture-*.png` are deliberately labelled synthetic browser states, including both blockers. `reproduced-browser/` is this review's fresh run of the implementation's reusable suite, separate from the worker's original `../../browser/` evidence.

## What remains

1. Worker fixes SPEC-F1 and SPEC-F2 with focused tests; independent reviewers verify the corrected candidate.
2. Parent reconciles separate quality verdict and preserves the reviewed checkpoint/handoff.
3. Parent alone handles authorized push and any later authorized production propagation/public authenticated acceptance. Existing specialist API data beyond products/Live/hub, screen-reader/device testing, and full legacy redesign were not exercised or claimed here.

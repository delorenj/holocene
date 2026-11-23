# HOLOC-62 independent quality/security review — FAIL

Reviewed code revision: **`7e9c5d0cbbc3f92398c82afa7f893fab56be2d65`**. Base: `018b775aa2d800946c9a20994540b354f7451c78`.
Worktree: `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-62-projects-launch-local`.
Review executed 2026-11-23 00:06–00:15 UTC. This report and all linked paths are relative to `quality-review/` unless otherwise stated.

## Findings — confirmed, new in this delta

### Q1 — P2: Empty/absent gate evidence is serialized as zero blockers/actions

- **Location:** `apps/api/src/products-model.ts:31–47`, `apps/web/app/products/products-app.tsx:12–13`.
- **Trigger:** A readable `launch-dashboard/1` receipt has `items: []` and `requirements: {}` (or a populated items list but no requirements). The existing publisher's `empty_data()` uses this shape; it is also an ordinary partial receipt, not an exotic JS object.
- **Actual GET:** Returns `state: "unknown", openActions: 0, ownerBlockers: 0`. With missing requirements alone it returns `ownerBlockers: 0` and suggests reviewing open actions instead of the missing gate coverage.
- **Consequence:** Desktop and phone render **“Readiness unknown · 0 owner-blocked gates · 0 open actions (reported; not verified current)”**. The caveat does not make absent coverage a measured zero. This violates the explicit unknown/not-zero behavior for missing evidence and can make a not-yet-populated dashboard look clear of blockers.
- **Narrow correction:** Leave the affected counts absent/unknown when their source collection/coverage is empty or unavailable. Distinguish validated, explicitly complete zero from “no entries recorded”; direct the next step to missing evidence rather than manufacturing zero. Preserve launch membership and a separately safe dashboard link.
- **Reproduction/evidence:** `adversarial-probes.mts` cases `both collections empty` and `absent gate entries`; actual handler/committed Git fixture/real receipt reader output in `adversarial-results.json`. `malformed-get-render-1440.png`, `malformed-get-render-320.png`, and `independent-browser-results.json` show that exact GET projection replayed as an explicitly labelled browser fixture.

### Q2 — P2: Status plus timestamp is promoted to current evidence even when evidence is missing

- **Location:** `apps/api/src/products-model.ts:33–45`, `apps/web/app/products/products-app.tsx:13`.
- **Trigger:** Receipt items contain `[{ status: "done", verified_at: "2026-11-22T20:00:00Z" }]`; requirements contain `{ x: { status: "met", verified_at: "2026-11-22T20:00:00Z" } }`. Neither completion has evidence; the item has no identity. This is valid JSON and passes all new guards.
- **Actual GET/render:** `state: "attention"`, `openActions: 0`, `ownerBlockers: 0`, dated observation. The UI prints **“Needs attention · 0 owner-blocked gates · 0 open actions”** and drops the “reported; not verified current” warning.
- **Consequence:** A partially malformed receipt is treated as a fully observed summary merely because an unvalidated completion claims a timestamp. It is not a green readiness claim, but the current numeric summary is unjustified. A safe publication locator does not validate its gate data.
- **Source contract checked, not executed:** The existing TOLT/gruvato publisher requires non-empty evidence for done items (`item_problems`, lines 275–279) and meaningful evidence for met gates (`requirement_problem`, lines 361–381). Owner entries also require an existing item, agent entries a ref, and n/a entries a reason. This reader currently checks none of those relationships. The publisher was read only; no import, `--check`, render, publish, or other script execution was performed.
- **Narrow correction:** Validate the minimum already-defined evidence/identity/reference invariants of statuses before treating the observation set as current. Incomplete/malformed entries must yield unknown and retain provisional counts or omit them; do not expand into a new readiness engine or copy private evidence into the response. Add actual-GET regression cases for missing done/met evidence and orphan owner references.
- **Reproduction/evidence:** `adversarial-probes.mts` case `done and met have no identity/evidence`; `adversarial-results.json`, `independent-browser-results.json`, both `malformed-get-render-*.png`. The numeric output was obtained from the actual GET, not a reimplementation of the model.

### Q3 — P2: Observation dates are permissively normalized; freshness depends on server timezone

- **Location:** `apps/api/src/products-model.ts:40–43`.
- **Trigger A:** Every observation is `2026-02-30T20:00:00Z`, at a fixture clock of `2026-03-03T00:00:00Z`.
- **Actual:** GET returns `state: "attention", observedAt: "2026-03-02T20:00:00.000Z"`. An impossible calendar date has become a fabricated current observation instead of invalid/unknown.
- **Trigger B:** Identical receipt observation `2026-11-15T21:00:00` (no timezone), identical clock `2026-11-23T00:00:00Z`.
- **Actual:** `TZ=UTC` returns **stale**, observation `2026-11-15T21:00:00.000Z`; `TZ=America/New_York` returns **attention**, observation `2026-11-16T02:00:00.000Z`. A malformed timestamp crosses the seven-day boundary solely because the process timezone changed.
- **Narrow correction:** Accept a strict calendar-valid timestamp with an explicit zone (e.g. RFC3339 with `Z` or a numeric offset), validate calendar components/round-trip rather than `Date.parse` normalization, then apply future/oldest/age checks. Invalid or zone-less input is unknown, never current. Apply this to the new gate observation path without making publication time a freshness source.
- **Reproduction/evidence:** `adversarial-probes.mts` invalid-date case, `adversarial-results.json`; `timezone-probe.mts`, `timezone-utc.txt`, `timezone-new-york.txt` exercise the actual GET with identical injected clock/receipt and only a different process timezone.

## Executed checks and security/regression coverage

| Command/check | Actual result | Evidence |
|---|---|---|
| `pnpm --filter @holocene/api typecheck` | exit 0 | `checks.txt` |
| `pnpm --filter @holocene/web typecheck` | exit 0 | `checks.txt` |
| `pnpm --filter @holocene/api test` | exit 0; 335 pass / 0 fail | `checks.txt` |
| `pnpm --filter @holocene/web test` | exit 0; 86 pass / 0 fail | `checks.txt` |
| `pnpm --filter @holocene/api exec tsx ../../_bmad-output/implementation-artifacts/holoc-62/quality-review/adversarial-probes.mts` | exit 0; 23 cases; assertions intentionally confirm the defects above as well as safe outcomes | `adversarial-run.txt`, `adversarial-results.json` |
| `TZ=UTC ... tsx .../quality-review/timezone-probe.mts` and `TZ=America/New_York ...` | both exit 0; same source gives different freshness state | `timezone-*.txt` |
| `PRODUCTS_TEST_URL=http://127.0.0.1:3162 PRODUCTS_EVIDENCE_DIR=<this>/browser PLAYWRIGHT_MODULE=/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs pnpm --filter @holocene/web test:products-browser` | exit 0; 3 pass / 0 fail; 1440/390/320, both themes, native modified links/history, real dashboards, existing Earshot `/live`, specialist routes | `browser-suite.txt`, `browser/real-navigation.json`, `browser/*.png` |
| `node _bmad-output/implementation-artifacts/holoc-62/quality-review/independent-browser.mjs` | exit 0; separately authored keyboard/collapse/current-group checks at 1440 and 320; no page errors, no horizontal overflow, real dashboard destinations at both widths; malformed GET rendering reproduced | `independent-browser-run.txt`, `independent-browser-results.json`, `independent-launch-*.png`, `malformed-get-render-*.png` |
| `curl http://127.0.0.1:3162/api/modules/products` | HTTP 200, `cache-control: no-store`; three launch IDs plus live Earshot; all real launch summaries conservatively unknown | `candidate-headers.txt`, `candidate-get.json` |
| `git diff --check 018b775..7e9c5d0 -- apps` | exit 0 | terminal run |

Additional actual-GET/on-disk checks passed: committed rather than dirty `.launch.yaml`; launch entry retained without any PM scripts/receipt; missing/malformed/oversized receipt, FIFO (nonblocking), and outside-repository symlink all fail closed with unknown summary and no dashboard action; unsafe scheme/host/dot-segment/query locators rejected; unknown statuses/null rows/array requirements isolated as unknown; future/missing observations unknown; oldest valid observation controls stale; raw private marker and repo path not serialized; concurrent reads coalesce, receipt reread after five seconds, POST returns 404. The complete API suite also exercised replacement refs, malformed YAML modes with a valid neighbor, registry outages/last-good/healthy-empty/recovery, and safe destination allowlisting.

The two independently authored browser passes opened the actual S3 dashboard URLs for GreenInBetween, gruvato, and TOLT, verified the final URL/title/nontrivial body, and confirmed null `window.opener`. These were real destinations, not mocks or login redirects. Network observation on local candidate pages saw only GETs. No dashboard controls, project workflows, issuer routes, or mutation endpoints were operated.

## Boundaries, limits, and harness correction

- Verdict is **FAIL for the three correctness/evidence-trust issues**, not an exploit claim. No new executable/mutation path, raw credential serialization, or successful path escape was found in the exercised boundary. Deterministic path protections passed; exhaustive adversarial directory-swap race testing was not performed.
- Authentication is inherited from the existing edge-owned API boundary and unchanged in the diff. This was loopback QA, **not authenticated public-serving acceptance**; no claim of production auth verification or readiness is made.
- The source contract does not timestamp every real requirement/open item; current real summaries correctly remain unknown. A repair must not invent observations or substitute `published.at` to make those entries look current.
- Initial timezoneless probe used 20:00 local and incorrectly expected it to be before the 00:00Z fixture clock. On this EST host it parsed as 01:00Z, so the candidate correctly returned unknown/future. `harness-initial-failure.txt` preserves that failure; the probe was corrected to noon. No app fix was made. The separate timezone-boundary probe then established Q3 without relying on that initial assertion.
- `pnpm` reported an unresolved `${NPM_TOKEN?}` placeholder in the pre-existing user `.npmrc`; all listed checks still exited 0. No dependencies or credentials were installed/changed. Review `.mts` files execute with `tsx`; they are not part of the app's TypeScript project.
- Hidden-workspace browser MCP tools were not exposed to this tool session. Browser checks used isolated headless Chromium and fresh temporary browser contexts, not the user's desktop/profile. All owned browser processes and private fixture directories were closed/removed by `finally` blocks.
- Initial HEAD was the reviewed code commit. During this concurrent review, the independent spec reviewer committed only `spec-review/` as `60ab16e702b9467d6cb7cf92be3ce13a384632cb`. `git diff --exit-code 7e9c5d0 -- apps` returned 0 after all quality probes: the app code remained exactly the reviewed revision. No spec evidence was edited/staged by this reviewer.
- Candidate servers were already running, loopback only (`3162`, `4162`); `/proc/<pid>/cwd` confirmed the candidate `apps/web` and `apps/api`. They were neither restarted nor stopped. No source edits, live service changes, push, merge, deploy, Plane operations, or ticket closure.

## Required handback

Fix Q1–Q3 in a separately authorized source pass, add focused actual-GET regression cases, then re-review the new exact code revision. Preserve original failing review evidence. Public authenticated acceptance remains the parent's responsibility; this report does not close HOLOC-62.

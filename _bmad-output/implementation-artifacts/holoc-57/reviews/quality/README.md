# HOLOC-57 — independent QUALITY/security review

**Verdict: CHANGES REQUIRED.** Three confirmed P2 source-authority/failure-isolation defects block approval of candidate `4d36eb9c237549c3ce6e0913b5960a47387c3001` against base `3fe12c684fef0de56c64b757381dc9da3f8bdbe1`. The independent desktop/phone browser acceptance portion passed. Passing regression suites do not cover the failing inputs below.

## Confirmed blocking findings

### Q1 · P2 · Reject non-string lifecycle modes before coercion

**Location:** `apps/api/src/products-model.ts:19–24` (failure escapes through `apps/api/src/products.ts:92`).

**Trigger:** A registered project's **committed** declaration contains `mode: [launch]`, `mode: [steady]`, `mode: [live]`, or `mode: {toString: launch}`.

**Observed via actual entrypoint:** The first three produce HTTP 200 with that project classified `stage: "live"` and an enabled `/live` action, despite not declaring the string `live`. The map form produces HTTP 500 (`Cannot convert object to primitive value`) for the entire directory. This is not mocked classifier output: a private real Git repository and loopback registry feed actual `getRegisteredProjects`, default filesystem/Git dependencies and the registered Fastify GET route.

**Cause/consequence:** `String(doc.mode)` admits single-element arrays, then strict string comparisons miss launch/steady and fall through to Live. Coercion can itself throw outside the YAML catch. One malformed project's source can misclassify a steady/launch entry or deny the whole directory rather than expose an isolated source issue (AC2/AC6).

**Narrow correction:** Require `typeof doc.mode === "string"` and exact membership before branching; return an invalid source issue for other values without invoking arbitrary coercion. Add route-level regressions for all four shapes and retain a valid neighbor product to prove isolation.

**Evidence:** `source-probes.json` → `non-string lifecycle must be invalid and not product`; `contract-assertions.log` → Q1 failure.

### Q2 · P2 · Treat an unprojectable registry row as discovery failure

**Location:** `apps/api/src/hub.ts:135–139`, consumed at `apps/api/src/products.ts:78–80`.

**Trigger:** First return a valid registered project, then return the same row with a non-null invalid `project_id` (`42`, `{}`, `[]`, `false`, or `""`) while retaining valid `repo_path`.

**Observed via actual entrypoint:** `getRegisteredProjects()` reports no `down` error and returns zero projects. After the directory TTL expires, GET replaces the successful one-product snapshot with `products: []`, `issues: []`, `registry.state: "ok"`, a new `snapshotAt`, and age zero. Initial malformed reads are also falsely healthy/empty. The browser would have no source failure to disclose.

**Cause/consequence:** The new strict registry boundary checks record/repo_path, but `recordFromManifest()` can still return undefined; `if (rec)` silently drops that row and reports success. Products then overwrites `lastGood`. The silent helper behavior existed before this feature, but its reuse as the new directory's success oracle directly violates the newly promised malformed-source/last-good contract (AC2).

**Narrow correction:** Validate projected identity at the registry boundary; if a row cannot be projected, mark discovery down instead of silently skipping it. Do not replace last-good with a partially/unprojectably read snapshot. Add valid→malformed→valid route tests and first-read malformed coverage. Do not invent an identity from invalid explicit data.

**Evidence:** `source-probes.json` → five `invalid registry project identity` cases and `malformed identity overwrites last good`; `contract-assertions.log` → Q2 failure.

### Q3 · P2 · Disable mutable Git replacement refs for committed source reads

**Location:** `apps/api/src/products.ts:26–29` (all calls in `committedDeclaration`, lines 36–41).

**Trigger:** In a private registered repository, commit `mode: launch`, build a replacement commit containing `mode: live`, then `git replace <HEAD> <replacement>` without changing HEAD or its true object. Read the actual Products GET.

**Observed via actual entrypoint:** HTTP 200 classifies the product Live, while `declaration.commit` is still the original launch commit. `git --no-replace-objects show <reportedCommit>:.launch.yaml` returns `mode: launch`; the API's reader returns `mode: live`. HEAD is unchanged. Thus a mutable local ref changes classification under the same supposedly pinned committed provenance.

**Cause/consequence:** Git follows `refs/replace/*` by default even when a full object ID is supplied. The current commit pin does not bind bytes to the reported commit, weakening the central committed-authority promise (AC2/AC6). This requires local repository metadata mutation; it is not a remote unauthenticated exploit.

**Narrow correction:** Run every declaration Git operation with global `--no-replace-objects` (or explicit `GIT_NO_REPLACE_OBJECTS=1`). Keep argv/time/output limits. Add replacement-ref regression proving returned bytes and displayed commit agree.

**Evidence:** `source-probes.json` → `local replacement refs and pinned source`; `contract-assertions.log` → Q3 failure.

## Independent execution and positive controls

| Check | Independent result |
|---|---|
| Existing browser suite, own Chromium contexts/profile and own evidence directory | **3/3 pass**; 6.6s |
| Desktop 1440×1000; phones 390×844 and 320×740 | All three actual dashboard links opened at **every** viewport; exact expected URLs/titles, substantial actual page content, no opener |
| Earshot action at every viewport | Actual candidate `/live` rendered the **Earshot heading**, not a login redirect. Live data is read-only proxied from existing API 4000; no second operational pipeline |
| Native navigation | Ctrl-click/middle click, focus query, in-place Agents/Projects, history/back/forward, stage filters pass |
| Additional targeted browser | `/products` with extra query, slash-form path, direct focus/extra query, drawer dismiss/reopen, resize across breakpoint, group-open-on-arrival, no residual scroll lock, actual Earshot body and **zero write requests** pass |
| Drawer/accessibility/layout controls | Keyboard containment, real focus-visible style, Escape/eventual Menu focus return, skip link, current-page semantics, day/night, reduced motion; no page/body overflow at 1440/390/320 |
| Additional HTTP-outage UI fixture | Four prior real products retained with explicit dated last-response warning; fixture screenshot separate from real-link evidence |
| `pnpm --filter @holocene/api test` | **330 passed**, 0 failed |
| `pnpm --filter @holocene/web test` | **86 passed**, 0 failed |
| API/web `tsc --noEmit --incremental false` | Both exit 0; incremental writing disabled to respect review-only scope |
| Receipt URL route probes | Safe control accepted; 14 scheme/host/userinfo/default-port/dot/encoding/backslash/query/hash/control/path attacks disabled; raw fixture sources/key refs/repo paths omitted |
| Receipt filesystem route probes | Oversized, FIFO and outside symlink fail closed; contained symlink control works |
| Intermediate directory-swap stress | 160 actual `readPublication` calls, 72 swaps, 1 contained success/159 rejections/**0 outside reads**. Probabilistic probe, not a race proof |
| Public edge anonymous HEAD | `/products` and `/api/modules/products`: **307 to accounts.google.com**. No cookie/state/token persisted in evidence |
| Auth/scope inspection | Existing `/api/modules/*` rewrite unchanged; no new bypass, middleware, operational mutation or dependency added. Only new module GET registration |
| Changed tracked evidence/source secret audit | All **83** changed blobs: 59 text signature/URL scans, 24 PNG OCR scans. Only two deliberate unsafe-URL unit-test fixtures flagged; **no confirmed secret leak**. Private Stitch CDN scripts are references, not app imports |
| `git diff --check BASE HEAD` | exit 0 |

## Commands and reproduction

Run from the candidate worktree (no production service startup):

```sh
Q="$PWD/_bmad-output/implementation-artifacts/holoc-57/reviews/quality"
./apps/api/node_modules/.bin/tsx "$Q/source-probes.mts" > "$Q/source-probes.log" 2>&1
node --test "$Q/assert-contract.mjs" > "$Q/contract-assertions.log" 2>&1
# Expected against reviewed candidate: exit 1, all three independent contract tests fail.
./apps/api/node_modules/.bin/tsx "$Q/receipt-probes.mjs" > "$Q/receipt-probes.log" 2>&1
node "$Q/targeted-browser.mjs" > "$Q/targeted-browser.log" 2>&1
PLAYWRIGHT_MODULE=/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs \
PRODUCTS_EVIDENCE_DIR="$Q/browser" node --test apps/web/app/products/products.browser.mjs > "$Q/browser-suite.log" 2>&1
pnpm --filter @holocene/api exec tsc --noEmit --incremental false
pnpm --filter @holocene/web exec tsc --noEmit --incremental false
pnpm --filter @holocene/api test
pnpm --filter @holocene/web test
```

`assert-contract.mjs` asserts the saved **actual entrypoint observations**; always regenerate `source-probes.json` first when checking a repair. Do not weaken this independent oracle. Source fixture repositories and registry servers are created under active-profile scratch and cleaned in `finally`. No production data is changed. Hashes of probe sources are in `oracle-sha256.json`.

## Limits / non-findings / execution issues

- This is independent QUALITY browser evidence for AC7, not independent SPEC review, production propagation, authenticated public acceptance, screen-reader certification or physical-device testing. The parent owns the remaining acceptance/release decisions.
- The supplied optimized web server and read-only adapter were reused, not started/stopped/restarted. Other specialist APIs are not all forwarded; their navigation/shell/layout were tested, not full operational workflows. No fresh build was run because that would overwrite non-evidence build output; worker's build was not counted as independent execution.
- Registered source errors are generic and allowlisted; no raw YAML/receipt/checkout values escaped in controls. URL host/path/normalization and tested receipt-containment defenses held. No new auth bypass was found. Anonymous public redirects do not prove authenticated serving of this candidate.
- Mobile non-current disclosure expansion resets when the dialog unmounts; current ancestor reopens on arrival. This is recorded, **not** a blocker under the stated contract.
- No extra finding is asserted for registry total byte/project count or whole-collection latency bounds. The code has process/output/per-file limits and concurrency four; a global bound was not adversarially certified.
- The first background browser launch failed before executing tests because shell startup moved cwd and the relative output path did not exist. Reissued with explicit cwd/absolute evidence path; suite passed. Two early targeted harness runs used an exact `Workspace` accessible name after arrival, omitting its intentional `, current group` screen-reader suffix; the corrected selector and load/current-state waits passed. These were harness failures, not candidate defects. pnpm emitted the pre-existing unresolved `NPM_TOKEN` config warning; checks succeeded.
- No candidate source fixes, commits, branch switches, board/lifecycle changes, deploys, pushes, merges or live writes were made. Only this review directory and ephemeral active-profile scratch were written by review scripts. Final candidate status remains untracked reviews only.

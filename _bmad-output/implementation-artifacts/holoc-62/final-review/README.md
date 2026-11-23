# HOLOC-62 independent combined spec + quality rereview — PASS locally

Reviewed exact app code `1b4deccc67f48986e0ebb8dba378841b9d159714` against base `018b775`. The earlier code `7e9c5d0` passed spec but failed quality; its `quality-review/` evidence is preserved unchanged. Candidate API `127.0.0.1:4162` and optimized web `127.0.0.1:3162` both returned HTTP 200 and were not restarted. No authenticated public-serving or live-deployment claim.

## Findings

No actionable spec or quality regression found in the exercised boundary. Q1–Q3 now behave conservatively:

- **Q1:** Empty collections and missing item/gate coverage return `unknown`, with neither counts nor observation timestamp; a separately validated, fully observed done/met fixture returns explicit zero counts. The safe published dashboard action survives malformed gate coverage.
- **Q2:** Missing identity/evidence, hollow completion claims, orphan owner references, missing agent ticket reference and missing n/a reason all return `unknown` without counts. The actual route and default file reader were exercised against a private Git repo with a committed launch declaration (and conflicting dirty steady declaration). Private marker and repository path were absent from JSON.
- **Q3:** Impossible February 30, timezone-less stamps, and future observations return `unknown`; the same cases pass under UTC and America/New_York. A valid old gate yields `stale` despite a recent publication, and a valid explicit-offset observed completion yields `attention` with zero counts. Publication time is not used as gate freshness.

The source diff from `7e9c5d0` changes only the API evidence classifier, its tests, and two browser expectations. The classifier requires nonempty coverage, valid unique item IDs, minimum completion evidence/relationships, complete observations, and calendar-valid zoned timestamps. No new mutation route, ledger, producer script, or lifecycle declaration changes were found in the candidate diff. `git diff --check 018b775..1b4decc -- apps` passed; `git diff --exit-code 1b4decc -- apps` was clean before evidence commit.

## Acceptance checks

| Criterion | Verdict and evidence |
| --- | --- |
| AC1 | PASS locally. Rendered desktop and 390/320 phone suite exercised expandable accessible Projects navigation, exact Live products / Launch mode products children, `/products`, `/live`, project/agent deep links, keyboard/drawer/focus/history and native modified links. |
| AC2 | PASS locally. Actual candidate GET lists Earshot live and GreenInBetween/gruvato/TOLT launch with stable IDs; issue inventory exposes missing declarations. The private GET fixture retains a committed launch despite a dirty steady file and handles missing PM receipt as unknown/no link. Existing route tests cover no-script launch, steady exclusion, source errors and transitions. |
| AC3 | PASS locally. Actual candidate GET returns the three real launch summaries as unknown without numeric counts or `observedAt`, with safe published dashboard destinations and distinct publication times. Fourteen independent actual-GET cases per timezone verify missing, invalid, stale, and explicitly complete states. GET is `no-store`; route POST regression test exists. |
| AC4 | PASS locally within bounded scope. Existing discovery, Live management and specialist hub routes, safe destination allowlisting, and three actual S3 dashboards were exercised by the browser suite; no source changes to ledgers, generators, clocks, declarations, or auth. Public edge auth not exercised. |
| AC5 | PASS locally. Both API/web typechecks exit 0. Focused optimized Chromium suite: 3 pass / 0 fail, 1440/390/320 widths, both themes, keyboard and phone drawer, real three-dashboard popup URLs/title/body/null opener, Earshot Live, no horizontal overflow. |

Raw evidence here: `recheck-get.mts`, `get-utc.txt`, `get-new-york.txt`, `typecheck-api.txt`, `typecheck-web.txt`, `browser-suite.txt`, and `browser/` screenshots plus `real-navigation.json`. The first probe run failed due to my harness variable shadowing (`data` response instead of input), not candidate behavior; corrected harness reran green in both timezones. The user `.npmrc` unresolved `${NPM_TOKEN?}` warning did not block any check. This is a local-only verdict, not ticket completion or authenticated-public acceptance. No push, merge, live restart, Plane mutation, or app-source edit was performed.

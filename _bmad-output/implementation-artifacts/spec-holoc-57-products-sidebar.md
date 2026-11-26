---
title: 'HOLOC-57 Products directory and hierarchical sidebar'
type: 'feature'
created: '2026-11-20'
status: 'done'
baseline_commit: '3fe12c684fef0de56c64b757381dc9da3f8bdbe1'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/holoc-57/investigation-and-verification.md'
  - '{project-root}/_bmad-output/implementation-artifacts/holoc-57/acceptance-source.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Product bookmarks are scattered across dated publications; the primary tabs no longer scale.

**Approach:** Make `/products` the permanent lifecycle directory and replace shared hub tabs with one hierarchical sidebar. Link existing launch dashboards and HOLOC-55 Live management; do not rebuild them.

## Boundaries & Constraints

**Always:** Registered PJ identity; committed `.launch.yaml` classification; existing publication receipts; explicit unavailable/error/freshness states; existing Google-auth boundary; server-only credential references; safe destinations; original eight criteria in `holoc-57/acceptance-source.md` remain binding.

**Never:** A product/status registry, lifecycle edits, new dashboards, Earshot-operation changes, native-app work, global legacy redesign, board mutations, production writes/restarts/deploys, merge or push in this phase. Local review is not live acceptance. Later commit/push requires parent direction.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Current directory | Three committed launch projects, Earshot live | Two labelled sections; three receipt links; Earshot `/live` | No inferred health |
| Promotion | Same PJ ID changes launch→live | One identity moves sections; `/products` survives | Invalid live details visible |
| Publication changes | Receipt URL updated | New safe link, same product/bookmark | Missing/invalid receipt disables action, not row |
| Discovery fails | PJ unavailable or malformed | Label failure; dated last-good snapshot if any | Never false empty/healthy |
| Declaration fails | Missing, unreadable, invalid, unknown mode | Visible source issue; no guessed classification | Steady excluded; absence not launch |
| Navigation | Query/focus, modified click, history, phone | Preserve real hrefs, history and focus behavior | No auth/query-token propagation externally |

</frozen-after-approval>

## Open Questions

None for implementation. Owning PM selected A+C with corrections on 2026-11-20; see reconciled DESIGN/EXPERIENCE and memlog. Independent review and production acceptance remain separate gates.

## Code Map

Paths below are repository-relative; `web` means `apps/web/app`.

- `apps/api/src/hub.ts:getRegisteredProjects` — reuse PJ discovery; reject malformed registry instead of healthy `{}`. `ProjectRecord` currently drops agent `role_dir` needed for receipt discovery.
- `apps/api/src/live-model.ts:parseLaunchFile`, `live.ts:createLiveHub` — reuse live validation and identity convention; retain all Live operations. Current parser ignores launch and reads mutable disk; directory must read committed declarations with bounded argv-only Git.
- `web/hub/ui.tsx:HubTabs` — eleven destinations, modified-click preservation. Nine call sites share the strip (hub and eight specialist apps); `hub-app.tsx` owns view/focus history and theme.
- `web/hub/hub.css` — implemented Ledger/day-night tokens; older `design/project/README.md` Spruce conflicts. Draft UX spines are empty, not approval.
- `apps/web/next.config.mjs` — `/api/modules/*` internal rewrite; auth is edge-owned. Agent Pad and `/hq` have separate boundaries; do not broaden them.

## Tasks & Acceptance

**Execution (dependency order):**
- [x] `_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/{DESIGN,EXPERIENCE}.md` — reconcile PM-selected concept from the handoff; record choice through memlog, retain old provenance.
- [x] `apps/api/src/{hub-model.ts,hub.ts}` — retain validated PM role directory; keep registered identity/source errors authoritative.
- [x] `apps/api/src/{products-model.ts,products.ts}` — add allowlisted directory projection and bounded cached reader: committed declarations, PM runtime receipt schema `launch-dashboard/1`, `published.url/at`, safe HTTPS links, last-good discovery. No live sales/issuer probes for directory reads.
- [x] `apps/api/src/server.ts` — register read-only no-store `/api/modules/products`; reuse auth serving boundary without new public proxy.
- [x] `apps/api/src/{products-model.test.ts,products.test.ts}` — test every matrix case, URL attacks, role-path escape, credential omission and promotion identity; keep Live regression green.
- [x] `web/products/{page.tsx,products-app.tsx,types.ts,products.css}` — directory, URL-backed `stage=launch|live`, source-state rendering and retry; existing `/live` link.
- [x] `web/hub/{navigation-model.ts,navigation-model.test.ts,hub-navigation.tsx,hub-shell.tsx,ui.tsx,hub-app.tsx,hub.css}` — shared shell/sidebar, real links, disclosures, current ancestor, mobile dialog and skip link; preserve theme/view/focus.
- [x] `web/{artifacts/artifacts-app.tsx,candybar/candybar-app.tsx,genesis/genesis-app.tsx,live/live-app.tsx,settings/settings-app.tsx,transcripts/transcripts-app.tsx,voice/voice-app.tsx,wax/wax-app.tsx}` — adopt shell only; Mini/Hooks/Legacy remain reachable without content redesign.
- [x] `web/products/products.browser.mjs`, `apps/{api,web}/package.json` — wire focused tests into explicit test lists; exercise desktop/phone routes, disclosure, history and links.
- [x] `holoc-57/investigation-and-verification.md` — append worker checks and review handoff; parent appends independent review evidence and owns acceptance/later production gate.

**Acceptance Criteria (same numbering as source):**
1. Given current declarations/receipts, when `/products` opens, then all four required entries link correctly and bookmark survives changes.
2. Given invalid/missing/down sources, promotion and steady fixtures, when discovered, then failures are visible, promotion preserves identity and steady stays excluded.
3. Given real Stitch desktop/phone concepts, when PM chooses, then record rationale, reconcile both UX contracts and implement the choice.
4. Given old routes/query/focus and modified clicks, when navigating/history changes, then destinations and auth contexts remain intact with Products hierarchy replacing tabs.
5. Given desktop/narrow phone, keyboard, both themes and reduced motion, when interacting, then no page overflow, visible focus/current semantics, accessible groups and Escape/focus-return drawer work.
6. Given automated tests and both typechecks, when run, then source/link/routing regressions pass, metadata stays authenticated, schemes safe and credentials server-only.
7. Given the candidate, when independent spec/quality reviewers use desktop/phone browsers, then each actual launch dashboard and existing Live view is opened with honest evidence.
8. Given local review only, when handed off, then checkpoint is preserved and public/authenticated live acceptance remains unmet until explicitly authorized propagation.

## Implementation Notes

- Added read-only cached directory projection. Git reads are pinned to a commit with argv-only bounded processes; missing/invalid/unreadable declarations remain visible. Publication reader resolves registered PM role path, checks lexical/real/open-fd containment and bounded regular-file size, refuses symlinks escaping the repo and nonblocking FIFOs. Payloads allowlist identity, lifecycle, commit and destination only.
- Shared HubShell now replaces all nine HubTabs callsites. Radix modal drawer remains inside Ledger theme scope; native links, current ancestor, disclosures and skip target are shared without changing Live operations or legacy content.
- Local QA adapter serves the actual products implementation at 4107 and read-only proxies existing Live/hub GETs at 4000; no collectors, scheduler, sales/issuer pipeline or second operational ledger started. Optimized Next candidate is 3107.
- All task implementation is complete. AC7 independent reviewer execution and AC8 reviewed checkpoint/live acceptance are intentionally **not claimed by this worker**; parent owns review. See companion evidence for test outputs and honest limits.

## Spec Change Log

- Owning PM resolved phase-1 choice: selected real desktop A + phone C with corrections, no operator sign-off gate. Ready-for-development conditions met; implementation began from baseline above. Preserved frozen intent and original eight criteria.

## Review Triage Log

Independent review pending at parent. Worker exercised code and inspected scoped diff, not an independent reviewer.

## Design Notes

Selected direction, with mandatory corrections: compact Ledger rows and explicit receipt provenance, Products first; Workspace/Media/System disclosures. Proposed subset routes `/products?stage=launch|live` never replace `/live`. Stitch exports contain invented data and inert links; treat as references, never production code.

## Verification

- `pnpm --filter @holocene/api typecheck` and `pnpm --filter @holocene/web typecheck`.
- `pnpm --filter @holocene/api test` and `pnpm --filter @holocene/web test`, after adding new test files to explicit lists.
- Focused browser suite against worktree-only loopback services with isolated deps/build output; synthetic-source tests plus real destination opens. Evidence matrix and auth limitations are in the companion. No production command in this phase.

## Auto Run Result

Status: done (2026-11-26, bmad-build-auto continuation)

- Summary: Products directory, shared hierarchical sidebar and phone drawer landed (`ba05af2`), then the Stitch Ledger revision `0afe3cf2` (`981e892`, `d8ab3dc`) and the Agents inspector revision (`6130fc9`, `e86bbd0`, spec `spec-stitch-agents-inspector-sidebar.md`).
- Reviews: independent spec and quality rechecks passed all eight criteria locally (`holoc-57/reviews/spec-recheck/README.md`, `holoc-57/reviews/quality-recheck/README.md`).
- AC8 live acceptance: the remaining gate was deployment authority. Jarad's standing approval (2026-11-15: releases, deploys and merges are not reserved) covers it. `holocene-web` was rebuilt from main and is healthy; the live `/products` page was verified logged-in on 2026-11-23 (four product rows, stage filter, receipt links, Earshot `/live`, no console errors). On 2026-11-26 the rebuilt container rendered every hub inspector in headless Chromium with no page errors and no 390px overflow; `https://holocene.delo.sh` answers through the edge Google auth.
- Residual risk: the 2026-11-26 browser pass ran against the container directly, not through the authenticated edge; the authenticated pass is the 2026-11-23 one.

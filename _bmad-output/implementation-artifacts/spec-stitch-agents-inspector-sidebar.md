---
title: 'Stitch Agents revision: shared inspector sidebar for every hub detail panel'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '57c2cf5d074a75916458efd3320affe1bdd8d1fa'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/.working/stitch/agents-sidebar-20261126/handoff.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/DESIGN.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Jarad asked to "implement the stitch suggested sidebar updates". Stitch project `14104283770497705087` gained two Agents concepts (`7d0b73a7…` Org Chart Redesign, `d470bfc8…` Mission Dispatch Sidebar) that rework the right-hand detail sidebar: status tag in the header, the current task first, a compact project block, director chips, fact tiles and a pinned action bar. The live inspector is a long unranked stack.

**Approach:** Adopt the layout, not the mock data. Build shared inspector primitives once and apply them to every hub detail sidebar (Agents: agent, contractor, You, inactive; Projects: project) so the whole hub level gets the anatomy (belsky-doctrine).

## Boundaries & Constraints

**Always:** Only sourced values (agents/projects payloads); an absent value hides its tile. Actions use routes/handlers that already exist (`onOpenProject`, `onOpenAgent`, `onFocus`, `/settings?agent=`). Preserve every existing fact, the voice picker, evidence, contractors, reports-to and copyable refs. Ledger tokens from `hub.css`; both themes; no page overflow at 390px.

**Never:** Missions, uptime/health, LIVE SYNC, Draft New Mission, Export Audit, Ping, Inspect Session, invented counters; new Bloodbank commands or API routes; canvas toolbar filter/zoom changes; executing or shipping Stitch HTML.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Agent with ticket and project | PM working on a Plane ticket | Header tag `state · held`; Working on first; Project with repo field; Open project + Agent settings pinned | none |
| Agent without project | `project` undefined | Missing-record notice inside the section; no Open project button | none |
| Director with directs | `reportsTo` matches | Directs as focusable chips with name/project/state in label | self-reference excluded |
| Unknown numeric facts | `tools`/`subs` undefined | Tile hidden | none |
| You (CEO) | stats payload | Fleet tiles from `stats`; tag only when someone needs you | none |
| Project with PM | Projects view | Kind/status header, PM section with signal tag, Open PM pinned | none |

</intent-contract>

## Code Map

- `apps/web/app/hub/ui.tsx` -- new `StatusTag`, `InspHead`, `InspTiles`, `InspSection`, `InspActions` primitives beside `Glyph`/`BandTrack`.
- `apps/web/app/hub/agents-view.tsx` -- `AgentPanel`, `ProjectBlock`, `TicketSection`, `EvidenceBlock`, `ContractorPanel`, `CeoPanel`, `InactivePanel` rebuilt on the primitives.
- `apps/web/app/hub/projects-view.tsx` -- `ProjectPanel`, `DepList` on the primitives.
- `apps/web/app/hub/hub.css` -- inspector anatomy (`.insp-headrow`, `.insp-tiles`, `.insp-section-head`, `.insp-count`, `.insp-field`, `.insp-chip`, `.insp-actions`, `.hub-btn.is-primary`); retired `.hub-link-block` inverse card rules.
- `apps/web/app/hub/voice-picker.tsx` -- read-only; keeps its own `insp-section hub-voice` root.

## Tasks & Acceptance

**Execution:**
- `apps/web/app/hub/ui.tsx` -- add the five primitives -- one anatomy for every inspector.
- `apps/web/app/hub/agents-view.tsx`, `apps/web/app/hub/projects-view.tsx` -- adopt them with sourced facts only.
- `apps/web/app/hub/hub.css` -- styles, sticky action bar, focus outlines.
- `_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/DESIGN.md` -- record accepted/rejected items.

**Acceptance Criteria:**
- Given the live Agents view, when an agent is selected, then the inspector shows header tag, Working on (if a ticket), project, voice, reports-to, directs/contractors, evidence and a pinned action bar, with no console errors.
- Given the Projects view, when a project is selected, then it uses the same header/tiles/section anatomy and pins Open PM when a PM exists.
- Given a 390px viewport, when the Agents view renders, then the page does not overflow horizontally.

## Spec Change Log

- 2026-11-26: Implemented in the same session ahead of this spec (commits `6130fc9`, `e86bbd0`), then written up so the change passes the build-auto review gate. Live-deployed via `mise run deploy:web`.

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 44 findings — high 0, medium 4, low 29, false 10, maybe-false 1
- findings:
  - `[low]` `[patch]` (blind) `sig-edge-*` class on Directs chips has no CSS — removed the dead class.
  - `[low]` `[patch]` (blind) `.insp-tag` loses `display:inline-flex` to the later `.hub-tag` rule — selector raised to `.hub-root .hub-tag.insp-tag`; computed display verified in headless Chromium.
  - `[low]` `[reject]` (blind) Long status tags clip without a `title` — 48% cap only bites on unusually long ids; adding a title prop to StatusTag is new surface for a rare case.
  - `[false]` `[reject]` (blind) Sticky bar with `bottom:-16px` renders 16px too low — measured: with `-16px` the bar bottom is 960 against the inspector's 962 outer edge (2px border); switching to `bottom:0` left a 16px gap, so Chrome deflates the sticky rect by padding. Kept `-16px` and added a comment.
  - `[false]` `[reject]` (blind) `-16px` side margins overflow at narrow widths — margins only reach into the inspector's own 16px padding; 390px viewport scrollWidth = 390.
  - `[low]` `[reject]` (blind) `> * + *` rules every child, including VoicePicker and trailing notes — VoicePicker has no own border rule, so the divider is the ruled anatomy; a ruled note reads as a section.
  - `[low]` `[reject]` (blind) "held"/"up" verbs replaced by `state · 14m` — this is the Stitch header tag the intent adopts.
  - `[low]` `[patch]` (blind) Subagent lanes/Tools show 0 tiles; old code hid zero subagent lanes — `Subagent lanes` now passes `a.subs || undefined` (old behaviour); Tools 0 stays because it is a sourced count.
  - `[low]` `[reject]` (blind) `Last moved` shows "never" and `?? 0` makes a bad timestamp read "0s ago" — the `?? 0` fallback is the file's pre-existing pattern at seven call sites; "never" is a sourced absence the old panel printed too.
  - `[low]` `[reject]` (blind) `Indexed: pjangler` tile is noise — it is the provenance fact the old panel carried as text.
  - `[low]` `[reject]` (blind) Tiles and pinned actions repeat counts and links already on the panel — the pinned action bar and tile summary are the accepted Stitch anatomy; duplication is navigational, not a wrong value.
  - `[false]` `[reject]` (blind) ProjectBlock renders an empty `insp-field` when `repoPath` is undefined — `Agent.project.repoPath` is a required `string` (`types.ts:12`); only `Project.repoPath` is optional and ProjectPanel guards it.
  - `[low]` `[reject]` (blind) ProjectPanel ticket lines keep `[state, ...labels]` and no tag — preserved existing behaviour, untouched by the intent.
  - `[low]` `[reject]` (blind) Directs shown for any role; chips show bare id with name only in title — any-role is the intent matrix row ("reportsTo matches"); the aria-label carries name/project/state and the id is the copyable machine word.
  - `[low]` `[patch]` (blind) `aria-label="Repo path"` on a role-less div — deleted the attribute in both views (CopyRef already labels itself).
  - `[false]` `[reject]` (blind) Gateway signal conveyed only by colour — the tile value is the text "active"/"inactive"; colour is redundant.
  - `[maybe-false]` `[reject]` (blind) `.hub-btn.is-primary` contrast unchecked in night theme — would need a contrast measurement of `--surface` on `--pop` in both themes; if true it is low (one button), so rejected with this note.
  - `[false]` `[reject]` (blind) `insp-id` lacks `overflow-wrap` — `.insp-id` sets `overflow-wrap: anywhere`.
  - `[low]` `[reject]` (blind) `void now;` unused prop in ProjectPanel — present at baseline `57c2cf5`, not introduced here.
  - `[low]` `[reject]` (blind) `TAG_TONE` identity map could be a Set — style only, no named harm.
  - `[false]` `[reject]` (blind) `.link-source`/`.link-basis` survive the `hub-link-block` cleanup — ProjectBlock still renders both classes.
  - `[low]` `[reject]` (blind) `.is-you` tone sits apart from the other tone rules — style only, no divergence named.
  - `[medium]` `[patch]` (blind) No test covers the primitives or tile-hiding logic — grouped with the verification-gap entry below.
  - `[false]` `[reject]` (blind) No story/acceptance record in `_bmad-output` — this spec is that record.
  - `[false]` `[reject]` (blind) DESIGN.md links a gitignored `.working` path — the handoff and exports are tracked (`git ls-files` lists them).
  - `[low]` `[reject]` (blind) Stray double blank line in DESIGN.md — cosmetic.
  - `[false]` `[reject]` (blind) No deployment recorded — Spec Change Log records `mise run deploy:web`; re-deployed after this pass.
  - `[medium]` `[patch]` (edge) `.hub-inspector > .insp-actions` reset (0,3,0) strips the action bar's 2px top rule and 12px padding — removed `.insp-actions` from the reset list; computed border-top 2px / padding-top 12px verified live.
  - `[low]` `[patch]` (edge) `.insp-tag` display overridden by `.hub-tag` — same root cause as the blind row; same fix.
  - `[low]` `[patch]` (edge) Zero Subagent lanes/Tools tiles appear — same fix as the blind row.
  - `[low]` `[reject]` (edge) `Last moved` 0s for an unparseable timestamp — pre-existing `?? 0` pattern, not caused here.
  - `[low]` `[reject]` (edge) CEO "Reports to you" renders empty with a 0 count — the CEO always has directors under it in the registry; a guard adds a branch for a state not seen.
  - `[low]` `[reject]` (edge) Header tag can render a lone glyph when state is empty — `state` is always populated by the agents payload; guard adds a branch for an unshown state.
  - `[low]` `[reject]` (edge) PM-less projects get no action bar — the intent allows only existing routes; there is no destination to pin.
  - `[low]` `[reject]` (edge) Contractor panel lacks Open project — the parent link already reaches it; new action would be extra surface.
  - `[medium]` `[patch]` (verification-gap) `InspTiles` hide-empty rule and tile facts untested — extracted `visibleFacts`, `heldTag`, `directReports`, `bySignal`, `formatDuration` into `apps/web/app/hub/inspector-model.ts` (ui.tsx re-exports `formatDuration`) and added `inspector-model.test.ts` to the web test glob.
  - `[medium]` `[patch]` (verification-gap) Directs selection (self-exclusion, any role, ranking) untested — same model module; test asserts all three.
  - `[low]` `[patch]` (verification-gap) Header tag/text rules unpinned — `heldTag` now covered; the signal-word dedupe and ticket-label fallback stay inline (filed disposition was defer; covered partly).
  - `[medium]` `[patch]` (verification-gap other) Action bar loses its 2px top rule to the reset selector — same root cause as the edge row; same fix.
  - `[low]` `[reject]` (verification-gap other) Bare `hub-note` children get a section rule — same as the blind row on `> * + *`.
  - `[medium]` `[patch]` (intent-alignment) No test on rendered DOM/CSS — partly answered by the model tests plus live headless measurement; DOM render remains outside CI (see residual risk).
  - `[low]` `[patch]` (intent-alignment) Sticky bar depends on the 16px inspector padding — documented in a CSS comment beside `bottom:-16px`.
  - `[low]` `[reject]` (intent-alignment) `Age` component dropped from the header — replaced by the Stitch tag by design.
  - `[false]` `[reject]` (intent-alignment) Gateway moved into a tile — that is the accepted sourced-tile anatomy, not a divergence.

## Verification

**Commands:**
- `pnpm --filter @holocene/web typecheck` -- expected: exit 0
- `pnpm --filter @holocene/web test` -- expected: all pass
- Headless Chromium against the web container (`/tmp/inspshots/shoot.mjs`) -- expected: inspector renders on agent, You, project and 390px views; no page errors; scrollWidth equals viewport.

## Auto Run Result

Status: done

**Summary:** Every hub detail sidebar (Agents: agent, contractor, You, inactive; Projects: project) now shares one inspector anatomy adopted from Stitch `7d0b73a7…`/`d470bfc8…`: identity row with a status tag, sourced fact tiles, ruled sections with tag/count asides, director chips, and a pinned action bar. Only sourced values render; mock missions, uptime, LIVE SYNC and similar were rejected.

**Files changed:**
- `apps/web/app/hub/ui.tsx` — `StatusTag`, `InspHead`, `InspTiles`, `InspSection`, `InspActions`; `formatDuration` now re-exported from the model.
- `apps/web/app/hub/inspector-model.ts` — pure helpers (`visibleFacts`, `heldTag`, `directReports`, `bySignal`, `formatDuration`) with one owner.
- `apps/web/app/hub/inspector-model.test.ts` — node:test coverage for tile hiding, held tag and directs.
- `apps/web/app/hub/agents-view.tsx`, `apps/web/app/hub/projects-view.tsx` — panels rebuilt on the primitives.
- `apps/web/app/hub/hub.css` — inspector anatomy, sticky action bar, focus outlines; retired `hub-link-block`.
- `apps/web/package.json` — test glob includes the inspector model test.
- `_bmad-output/planning-artifacts/ux-designs/ux-Holocene-2026-11-02/DESIGN.md` and the Stitch `handoff.md` — accepted/rejected record.

**Review breakdown:** 44 findings. Patched entries: action-bar reset selector (medium), untested inspector logic (medium), tag cascade (low), zero subagent tile (low), dead `sig-edge` class (low), role-less `aria-label` (low), sticky padding comment (low). Deferred: none. Rejected: 10 false (refutations in the log), 1 maybe-false contrast note, and 22 low items recorded above with reasons. The reviewer claim that `bottom:-16px` mis-pins the bar was disproved by measurement; switching to `0` opened a 16px gap and was reverted.

**Follow-up review:** recommended (`true`) — two medium entries were patched on a first pass. Named unverified risk: the rendered inspector DOM/CSS (action bar rule, tag layout) is checked only by a one-off headless script, not by CI.

**Verification:** `pnpm --filter @holocene/web typecheck` exit 0; `pnpm --filter @holocene/web test` 94/94 pass; `mise run deploy:web` healthy; headless Chromium against the live container: agent, You, project and 390px views render, scrollWidth equals viewport, action bar computed `border-top: 2px`, `padding-top: 12px`, bar bottom flush with the inspector border (960/962). `https://holocene.delo.sh` answers 307 (OAuth edge).

**Residual risks:** one headless run logged a single 404 console resource error on the agent view that did not reproduce with a response listener (likely a cancelled Next prefetch); contrast of the primary button in night theme is unmeasured.

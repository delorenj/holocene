---
title: Holocene — DESIGN
status: accepted-direction
created: 2026-11-02
updated: 2026-11-23
---

# Products and shared navigation (HOLOC-57)

Owning PM selected Stitch project `14104283770497705087`, desktop A `1857e1f45dbb4f88ae5dd8c0355611f7` and phone C `ab1b8cdd2fdd4409a3b3f89a55a747ba`, with corrections. [Private references and provenance](.working/stitch/holoc-57-products-sidebar/handoff.md). Earlier Spruce explorations are not selected; current `apps/web/app/hub/hub.css` Ledger tokens remain the implementation authority.

- Preserve warm paper, strong rules, Atkinson text/mono and concise Newsreader headings; inherit Ledger day/night palettes. No global legacy-page redesign.
- Persistent approximately 232px dark desktop sidebar. Products leads, with Preparing to launch and Live subsets; Workspace, Media and System disclosures follow. Content occupies the remaining flexible width.
- At narrow widths replace the sidebar with a labelled Menu trigger and modal drawer showing the same hierarchy. No extra phone tab bar. Single-column product rows; wrap source details and actions rather than clipping or horizontal page scrolling.
- Products has a concise heading, labelled lifecycle sections, ruled rows and modest actions. No oversized editorial introduction, permanent specimen panels or mock operational dashboards.
- Registered names/IDs, committed lifecycle and receipt timestamps only. Remove every invented counter, ID, telemetry value, date, checksum, verification/certification badge and health claim from the exports. Real receipt-backed HTTPS destinations and `/live`, never `#` or `#/live`.
- Visible focus uses the existing accent. Current links and current ancestor are distinguishable without color alone. Reduced motion adds no navigation animation.

This selection accepts a layout direction, not browser/accessibility proof. Generated HTML scripts are never executed or shipped. Source failure/loading/empty states and actual phone dimensions require implementation tests. Rationale: Dogfood the Platform by linking existing operational surfaces; Build LEGO, Not Statues by sharing one scalable navigation and authoritative project identity.

## 2026-11-23 revision: Stitch Products Directory `0afe3cf280a8474dbb3a23b2e002a526`

Jarad asked to incorporate this revision of A. Accepted, reconciled with the corrections above:

- Every shared-navigation link carries a decorative 18px line icon (`apps/web/app/hub/nav-icons.tsx`) before its text label; disclosure toggles use a chevron. Icons are muted (`--h-ink-3`) and take `--h-pop` on hover/current. This applies to every HubShell page, not only Products.
- Shared Ledger panel primitives live in `hub.css` for any hub surface: `.hub-panel` (2px rule, offset shadow), `.hub-panel-head` (inverse head; `.is-quiet` uses the sunken stock), `.hub-panel-count`, `.hub-panel-meta`, `.hub-tag` (bordered mono status tag tinted by state token), `.hub-tally` and `.hub-chip`.
- Products: eyebrow + `Products` heading, a tally of real counts, a segmented stage filter with counts, source chips (source, PJ read time and age, registry tag), each lifecycle stage as a panel deck with column labels on desktop, numbered rows, a receipt column (host/path in `--working`, stamp time) and a right-aligned action. A Lifecycle source issues panel shows unreadable/invalid declarations as cards and collapses missing declarations into one disclosure.
- Rejected from the mock as invented or ungrounded: image thumbnails, "Last Build", target/orders/health, parser percentages, nav total badge, footer version/status line, the "Launch Queue" rename and `//` brand labels.


## 2026-11-26 revision: Agents inspector sidebar (Stitch `7d0b73a7…`, `d470bfc8…`)

[Provenance and rejection list](.working/stitch/agents-sidebar-20261126/handoff.md). Shared inspector primitives in `apps/web/app/hub/ui.tsx` (`InspHead`, `InspTiles`, `InspSection`, `InspActions`, `StatusTag`) shape every hub detail sidebar (Agents, Projects):

- Identity row with avatar/icon tile, eyebrow, name, id and a signal-tinted `hub-tag` on the right.
- Sourced two-up fact tiles on the sunken stock; an absent value hides its tile.
- Sections ruled by 1px lines, label in `--ink-3`, tag or inverse count on the right. Working on leads; the project is a flat section with a repo field (the inverse link card is retired); directs are mono chips.
- Pinned action bar (2px top rule, primary button in `--pop`) with existing destinations only.
- Rejected: missions, uptime/health, live-sync badge, Ping, Inspect Session, invented counters.

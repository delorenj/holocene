---
title: Holocene — EXPERIENCE
status: accepted-direction
created: 2026-11-02
updated: 2026-11-23
---

# Products and navigation behavior (HOLOC-57)

Selected A+C direction and rationale: [DESIGN.md](DESIGN.md). This bounded contract supersedes empty draft spines, not unrelated legacy interactions.

- `/products` is a stable directory bookmark. `?stage=launch` and `?stage=live` are shareable subsets, not replacements for `/live`. Native links preserve history, modified and middle clicks. URL changes and back/forward update the selected stage.
- Group products as Preparing to launch and Live from registered PJ identity plus committed `.launch.yaml`. Promotion moves the same ID; steady is excluded. Receipt publication changes replace a destination, never identity.
- Launch actions open validated publication receipts in a new tab with no opener/referrer. Live actions use existing `/live`. Do not copy checkout credentials or operational detail into the directory. No new ledger or Live operations.
- Source failures remain visible: loading, first-read failure, unavailable/missing/invalid declarations, unavailable receipts, last-good registry snapshot with timestamp and age, and true empty results are distinct. Do not infer health from links. Refresh retries read-only discovery.
- Products is a major navigation entry; its subsets remain visible. Workspace contains Agents, Projects, Live management, Genesis; Media contains Voice, Wax, Transcripts, Artifacts; System contains Candybar, Settings, Mini, Hooks, Legacy. Current ancestor opens on arrival. Disclosure buttons expose expanded state and control association.
- Preserve `/?view=agents`, `/?view=projects`, project/agent focus and existing auth contexts. No external link inherits private query parameters. Shared shell replaces nine HubTabs callsites; legacy content only needs reachability, not redesign.
- Phone Menu opens a labelled modal dialog; focus is contained, Escape/outside click dismisses, close returns focus to Menu. Selecting a route closes the drawer. A skip link reaches the main content. Keyboard focus and current-page semantics work in both themes.
- Metadata uses the existing authenticated `/api/modules/*` serving path; do not create a public proxy or change edge, Pad or HQ authentication. Local loopback verification is not authenticated production acceptance.

Real desktop/320px/390px, keyboard, theme, reduced-motion and destination evidence is recorded in the implementation handoff. Independent reviewers and later authorized live serving remain separate gates.

## 2026-11-23 revision behavior

- Stage filter links keep the accessible names `All products`, `Preparing to launch`, `Live`; their visible counts are `aria-hidden`. Panel counts are labelled (`3 products`). Section headings keep their exact names.
- Each product row has exactly one link (the action). The receipt path is text, not a second link, so there is one tab stop per product.
- Issue grouping: `unavailable` and `invalid` declarations are individual cards; `missing` declarations collapse into one disclosure listing names. A degraded registry adds a dashed card with `Retry read` (same read-only refresh as `Refresh sources`).
- Phone: column labels hide, rows become a single column under the index, the filter becomes a full-width wrapped segmented control, panel meta wraps under the title.


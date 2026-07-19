---
version: alpha
name: Holocene
description: >-
  33GOD dashboard and renderer. A dark, high-density operator "mission
  control" that surfaces live fleet, tooling, and pipeline health. The UI is
  built from generic live-data collection renderers over structured backend
  payloads, not bespoke per-panel layouts.
colors:
  # Surfaces — cool navy-slate, low chroma, layered by lightness not shadow
  bg: "#0b1020"          # page background
  panel: "#121a2d"       # cards, panels, sections
  panel-raised: "#172036" # raised panel variant
  inset: "#0f1729"       # wells: meta chips, code, hook result backing
  line: "#26324d"        # all borders and dividers
  control: "#1d2943"     # button / active-tab fill
  code-line: "#30405f"   # code block border
  # Text
  text: "#eef3ff"        # primary text on dark
  bright: "#e8f5ff"      # emphasized inline text, code, selected
  muted: "#9aa8c7"       # secondary text, labels, meta
  ink: "#07111f"         # text on saturated color fills
  # Status accents — the only saturated color, reserved for state
  blue: "#7fb0ff"        # primary/accent: eyebrow, links, active, "active"
  green: "#69d3a5"       # positive: idle, clock-in, OK severity
  yellow: "#ffd166"      # warning: checking, warning severity
  red: "#ff7a90"         # attention: needs-attention, critical severity
  neutral: "#96a0b8"     # unknown / indeterminate state
typography:
  display:               # stat-collection hero title
    fontFamily: Inter
    fontSize: "3.2rem"
    fontWeight: 800
    lineHeight: "1"
  headline:              # h1 — "Holocene"
    fontFamily: Inter
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: "1.1"
  title:                 # h2 — section headings ("Fleet", "Right Now")
    fontFamily: Inter
    fontSize: "1.08rem"
    fontWeight: 700
  eyebrow:               # "33GOD Dashboard" kicker
    fontFamily: Inter
    fontSize: "0.78rem"
    fontWeight: 700
    letterSpacing: "0"
  metric-value:          # big numbers in summary cards
    fontFamily: Inter
    fontSize: "1.55rem"
    fontWeight: 700
    lineHeight: "1"
  body-md:
    fontFamily: Inter
    fontSize: "0.92rem"
    fontWeight: 400
  label:                 # metric-label, meta, notes
    fontFamily: Inter
    fontSize: "0.82rem"
    fontWeight: 400
  status:                # pill text
    fontFamily: Inter
    fontSize: "0.78rem"
    fontWeight: 800
  mono:                  # machine data: ids, paths, JSON, code
    fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', ui-monospace, monospace"
    fontSize: "0.72rem"
    fontWeight: 400
rounded:
  xs: "6px"    # meta chips
  sm: "8px"    # buttons, cards, metrics, panels — the default
  md: "10px"   # nested detail wells
  lg: "12px"   # clock card
  xl: "18px"   # hook-health result rows
  hero: "32px" # stat-collection container
  full: "999px" # status pills, legend keys
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"   # default grid gap
  lg: "16px"   # card padding
  xl: "22px"   # shell section gap
  page: "28px" # shell padding (18px on mobile)
components:
  button:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    borderColor: "{colors.line}"
    rounded: "{rounded.sm}"
    height: "40px"
    padding: "0 14px"
    typography: "{typography.body-md}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    height: "36px"
    padding: "0 12px"
  tab-active:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    borderColor: "{colors.blue}"
  card:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.line}"
    rounded: "{rounded.sm}"
    padding: "16px"
  metric:
    backgroundColor: "{colors.panel}"
    borderColor: "{colors.line}"
    rounded: "{rounded.sm}"
    height: "92px"
    padding: "16px"
  status-pill:
    rounded: "{rounded.full}"
    textColor: "{colors.ink}"
    typography: "{typography.status}"
    padding: "7px 9px"
  clock-in-button:
    backgroundColor: "{colors.green}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.6rem 1rem"
  clock-out-button:
    backgroundColor: "{colors.red}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.6rem 1rem"
  stat-collection:
    backgroundColor: "{colors.panel}"
    borderColor: "rgba(238, 243, 255, 0.72)"
    rounded: "{rounded.hero}"
    padding: "clamp(24px, 4vw, 42px)"
---

# Design System

## Overview

Holocene is the 33GOD dashboard and renderer — the mission-control surface for
a single operator watching a live agentic development pipeline. The README
leads with its purpose: *"the 33GOD dashboard and renderer that surfaces live
fleet, tooling, and pipeline health from API services, Redis-backed stats, and
SSE/polling feeds."* That live-data mandate is the whole design: every screen is
a dense, always-updating readout, never a marketing page.

The product's native shape is a **fleet monitor**, not a document. Its UI is
"built around generic live data components, where specific panels like Hook
Health are just collection renderers over structured backend payloads." So the
page organizes around **collections of status-bearing items** — agents, tickets,
services, tooling checks, containers — each carrying a state that the operator
scans at a glance.

## Lifecycle Rendering Boundary

Holocene is a dashboard/renderer and high-level command surface. It never
calculates or writes project-lifecycle truth. The approved separate headless
Lifecycle component owns versioned spec/state, deterministic reconciliation,
legal frontier, obligations, blockers, and capability validation. Bloodbank
owns canonical schemas/transport, Candystore owns durable history/read models,
and PJangler owns project/bootstrap identity.

The standalone Lifecycle service is implemented as the only deterministic
authority. Holocene's implemented client submits high-level actions through
Bloodbank and renders Lifecycle-owned results; Candystore history remains an
audit/read projection rather than current-state proof.

Every lifecycle view must render:

- lifecycle/project identity, spec version, and state version;
- provenance, observed time, freshness, and explicit unavailable/stale state;
- legal frontier, obligations, blockers, and capability context;
- command status as pending, accepted, rejected, stale, denied, or unavailable;
- history from Candystore distinctly from the authoritative current snapshot.

Controls submit idempotent high-level intent with expected state version and
capability context through Bloodbank. They never optimistically change a status
pill or derive a transition from board lanes, agent health, or event history.
Color communicates the authoritative result; it must not conceal unknown or
stale provenance.

The top-level information architecture is four tabs, defaulting to **Fleet**:

- **Fleet** — the home view. A four-metric summary (`Agents`, `Working`,
  `Needs attention`, `Snapshot`), a `Ticket Velocity` heartbeat timeline, a
  `Right Now` work feed, and the `Fleet` roster ("Live services and PM
  work-state feeds").
- **Tooling** — health of CLI tools and hooks, rendered as stat collections
  (the **Hook Health** panel is the signature example).
- **Systems** — service/system status.
- **Containers** — container reachability targets.

A persistent **Orwell** card provides "Manual clock-in / clock-out control"
(`Clock In` / `Clock Out`) — the operator's own presence toggle alongside the
machines'.

Mood: focused, technical, calm-until-something-breaks. Whitespace is tight and
purposeful — this is an information-dense instrument panel, not an airy landing
page. Color is spent almost entirely on **state**.

## Colors

The palette is a cool navy-slate dark theme (`color-scheme: dark`). Surfaces are
near-monochrome and layered by lightness; saturated color is rationed and always
means *state*.

**Surfaces**
- **bg** (`#0b1020`): page background, the darkest layer.
- **panel** (`#121a2d`): every card, section, and metric tile.
- **panel-raised** (`#172036`): the next surface up when panels stack.
- **inset** (`#0f1729`): recessed wells — meta chips, hook-result backings, code.
- **control** (`#1d2943`): button and active-tab fills.
- **line** (`#26324d`): every border and divider. Structure comes from borders,
  not shadows.

**Text**
- **text** (`#eef3ff`): primary body text.
- **bright** (`#e8f5ff`): emphasized inline text, code output, selected items.
- **muted** (`#9aa8c7`): labels, secondary meta, notes, table headers.
- **ink** (`#07111f`): text placed on saturated color fills (pills, clock buttons).

**Status accents** — reserved for meaning, never decoration:
- **blue** (`#7fb0ff`): the primary accent — eyebrow, links, focus, active states.
- **green** (`#69d3a5`): positive / idle / clock-in / OK severity.
- **yellow** (`#ffd166`): warning / checking / degraded.
- **red** (`#ff7a90`): needs-attention / critical / clock-out.
- **neutral** (`#96a0b8`): unknown / indeterminate.

For high-emphasis status icons, solid saturated variants are used
(`#9df0b9` OK, `#ffbe3d` warning, `#ff4d5e` critical) always over `ink` text.

## Typography

One family does the work: **Inter** (`ui-sans-serif, system-ui` fallback) for
everything human-readable, and a **monospace** stack
(`SFMono-Regular, Consolas, "Liberation Mono", ui-monospace`) for everything
machine-generated — IDs, paths, JSON payloads, code.

Hierarchy:
- **Display** (`clamp(2rem → 3.2rem)`, weight 800): the hero title inside a stat
  collection — the loudest thing on the page.
- **Headline / h1** (`2rem`, weight ~700, line-height 1.1): the app name, "Holocene".
- **Title / h2** (`1.08rem`, weight 700): section headings ("Fleet", "Right Now",
  "Ticket Velocity", "Orwell").
- **Eyebrow** (`0.78rem`, weight 700, **uppercase**, blue): the "33GOD Control
  Plane" kicker above the title.
- **Metric value** (`1.55rem`, weight ~700, line-height 1): the big numbers.
- **Body** (`~0.92rem`).
- **Label** (`0.82rem`, muted): metric labels, notes, meta.
- **Status** (`0.78rem`, weight 800, **capitalize**): pill text.
- **Mono / meta** (`0.68–0.72rem`): chips, code, ids — small and dense.

Rule of thumb: sans for people, mono for machines, and never mix them within a
single value.

## Layout

- **Shell**: a centered column, `max-width: 1280px`, `padding: 28px` (18px below
  820px), with a `22px` vertical rhythm between sections.
- **Top bar**: eyebrow + `Holocene` title on the left, the Orwell card / actions
  on the right, separated from the body by a bottom border.
- **Tabs**: a horizontal `role="tablist"` under the header, bottom-bordered.
- **Summary grid**: four equal metric tiles, `repeat(4, minmax(0, 1fr))`, that
  collapse to a single column on mobile.
- **Tables** (Fleet roster): full-width, `min-width: 960px`, wrapped in a
  horizontally scrollable container so dense rows never break the shell.
- **Stat collections**: the reusable live-data block — a bordered container with
  a large title and a results grid (2-up on desktop, 1-up on mobile).
- **Breakpoint**: a single `max-width: 820px` breakpoint flips flex rows to
  stacked columns and grids to one column.

Let the *collection* be the organizing unit. Group by status-bearing item; don't
invent decorative sections that carry no live data.

## Elevation & Depth

Deliberately **flat** — there are no drop shadows. Depth is communicated by:
1. **Background lightness** (`bg` → `inset` → `panel` → `control`), and
2. **1px `line` borders** on every panel, card, and divider.

The only "glow" in the system is functional: a blue focus ring
(`rgba(127, 176, 255, 0.7)` outline; `0 0 0 2px rgba(127, 176, 255, 0.46)` for a
selected stat button). Keep it that way — shadows would read as foreign.

## Shapes

- **8px** (`rounded.sm`) is the default radius: buttons, cards, metrics, panels.
- **6px** chips, **10px** nested wells, **12px** the Orwell clock card,
  **18px** hook-health rows.
- **32px** (`rounded.hero`): the stat-collection container — its generous radius
  and thick translucent-white 2px border make it the visual centerpiece.
- **999px** (`rounded.full`): status pills and legend keys — every stateful token
  is a pill.

## Components

- **Button**: `control` fill, `line` border, `8px` radius, `40px` min-height;
  border turns **blue** on hover; `opacity: 0.55` + wait cursor when disabled.
- **Tab / Tab-active**: inactive is transparent with `muted` text; active gets a
  `control` fill, **blue** border, and full-strength text.
- **Metric card**: `panel` fill, `line` border, `8px` radius, `92px` min-height;
  muted label above a large value.
- **Status pill**: `999px` pill, weight-800 capitalized text on `ink`, fill by
  state — `blue` active, `yellow` checking, `red` attention, `green` idle,
  `#26324d` unknown.
- **Clock buttons** (Orwell): full-width, `8px` radius, `ink` text — `Clock In`
  is **green**, `Clock Out` is **red**; an inline spinner uses a blue-tipped ring
  while a request is in flight.
- **Table**: borderless collapse; each row divided by a bottom `line` border;
  `muted` weight-700 headers; secondary detail as muted `small` beneath the cell.
- **Stat collection**: the hero live-data pattern — thick translucent-white
  border, `32px` radius, big title, and a results grid of status-coded buttons.
- **Hook-health result**: severity-coded rows using diagonal hatched backgrounds
  (OK green / warning yellow / critical red / unknown gray stripes) with a
  circular status badge — the most expressive, domain-specific element.

## Do's and Don'ts

- **Do** spend saturated color only on state (active/idle/checking/attention/
  unknown). Surfaces and chrome stay navy-slate and quiet.
- **Do** render data as **collections of status-bearing items**; reuse the stat-
  collection and pill patterns instead of designing one-off panels.
- **Do** use monospace for anything the machine produced — ids, paths, JSON —
  and Inter for everything a human wrote.
- **Do** build depth from `line` borders and background lightness.
- **Don't** add drop shadows, gradients (except functional severity hatching), or
  a second brand color — there isn't one.
- **Don't** introduce placeholder/marketing copy. Labels come from the product:
  `Agents`, `Working`, `Needs attention`, `Snapshot`, `Ticket Velocity`,
  `Right Now`, `Fleet`, `Orwell`, `Clock In`, `Clock Out`.
- **Don't** let dense tables break the shell — wrap them in a horizontal scroller.
- **Don't** mix rounded scales arbitrarily; reserve the 32px hero radius for the
  stat-collection and keep everything else on the 8px default.

33GOD is a self-hosted agentic development pipeline run by one operator:

- PM agents triage Plane tickets.
- Workers implement them in git worktrees.
- Every hook and decision flows through Bloodbank.
- Holocene is where the operator looks.

This system serves Holocene on the desktop, `/hq` on the phone, and Holocene Auto in the car. Its stance is **quiet by default and warm where you are needed**. Nearly everything sits in snow, spruce and ink. The only warm colour on the screen is the thing waiting on you.

The platform's oldest names come from Bon Iver songs: 33GOD, Holocene, Bloodbank, Flume. The visual language takes its cue from the same place: winter light, one lit window, numerals used as names.

## Principles

1. **Answer the question, then show the evidence.** Every view opens with one sentence that answers what it is for ("Two things need you."), followed by the list that proves it. The operator's questions, in order:
   1. What is waiting on me?
   2. Who is working on what?
   3. Is anything stuck or broken?
   4. What just happened?

   Lay views out in that order.
2. **Ochre means you.** `ochre` (alias `signal-you`) marks only things the operator can act on, plus the operator's own hand: the focus ring, an armed button, text selection. Never use it for decoration, branding chrome or emphasis.
3. **Healthy is quiet. Green is earned.** A running, healthy system draws in `ink-3`. `moss` is only for something that left the queue recently: shipped, closed, recovered.
4. **Every reading carries its age.** Data that is older than its interval says so: a `~` before the value and the stuck colour on its age. Data that was never observed says "No signal", never zero. A view built on a dead feed must look dead. Use `SourceStrip` at the top of every live view.
5. **Shape before colour.** Each state has a glyph (diamond, square, hourglass, ring, dash, disc, dotted ring), so status survives greyscale, colour blindness and forced colours. Colour only confirms it.
6. **Fold the noise.** Tool calls are 96% of all events. Collapse runs of them with `EventBurst`, show sparse high-value events (PM decisions) as individual marks, and never make the operator scroll past a thousand `tool.completed` rows to find one failure.
7. **Machine words stay machine words.** Anything a machine wrote goes in the mono face as a `Ref` that copies on click: ticket keys, SHAs, subjects, units, panes, paths. Raw states like `tool_running` stay visible beside the plain-language sentence, because they are what the operator will grep for.

## Voice and copy

- Address the operator as "you". Name agents by their id, in third person: "holocene-pm asks whether HOLOC-8 should land as one PR or three."
- Use sentence case everywhere. Uppercase appears only through the `label` style, and the source text stays sentence case.
- No emoji and no exclamation marks. A statement is a full sentence with a period. Labels and buttons have no period.
- Buttons are verbs naming exactly what happens: "Restart gateway", "Go to pane", "Acknowledge". Confirm labels name the blast radius: "Confirm: restart 29 gateways".
- Prefer counts of things to percentages: "26 of 80 probes broken", not "32.5% unhealthy".
- Every reading's note says whether the value is normal: "The same 9 for 2 days", "Growing, +41 today".
- Errors say what failed, where, and what to do, in that order: "The native hook socket is missing. CLI hooks cannot reach the hub." Never apologise; never write "Something went wrong".
- Durations use `formatDuration` (14s, 12m, 1h 06m, 4d 02h, 98d). Work done inside a row uses `formatMs` (312 ms, 1.4 s).
- Empty states prove they are empty: "Nothing needs you. 9 detectors evaluated, newest 4s ago."

| Write | Not |
|---|---|
| Two things need you. | You have 2 new notifications! |
| codex wants approval to run `git push --force-with-lease` | Permission request pending |
| Last reported working, on a heartbeat from June | Status: working |
| 26 of 80 | 32.5% |
| No signal in 98d | 0 |

## Colour

Two themes, `light` ("Snow") and `dark` ("Spruce"). Each is chosen on its own; neither is an inversion of the other. Neutrals carry a faint spruce bias, so no grey is a default grey.

**Grounds.**

- `ground` is the page.
- `surface` is for floating things: popovers, tooltips, the command palette, quiet buttons.
- `sunken` is for wells: inputs, code, Ref and Kbd chips, an opened event burst.
- Panels do not get a fill. They sit on `ground`.

**Lines.**

- `line` is the hairline between rows and under panel headings. It is decorative and never the only edge of a control.
- `line-strong` is for control borders and axes. It holds 3:1 on every ground.

**Inks.** All of these hold their stated contrast on `ground`, `surface` and `sunken` in both themes.

| Token | Use | Contrast |
|---|---|---|
| `ink` | Primary text and the primary button fill | 13:1 or better |
| `ink-2` | Sentences and secondary text | 6.8:1 or better |
| `ink-3` | Metadata, timestamps, counters, axes | 4.5:1 or better |

Text on an ink fill uses `on-ink`.

**Signal hues.** Five hues, each with exactly one meaning, and each with a `-soft` tint for row and chip backgrounds behind its own text.

| Hue | Alias | Meaning |
|---|---|---|
| `ochre` | `signal-you` | You |
| `brick` | `signal-broken` | Broken |
| `heather` | `signal-stuck` | Stuck: over its time budget, derived from time, never from an error |
| `lake` | `signal-working` | Working |
| `moss` | `signal-cleared` | Cleared |

`signal-quiet` is `ink-3`. Use the `signal-*` aliases in components so the meaning travels with the token.

**Charts.**

- `series-1` through `series-6` (slate, clay, teal, sand, plum, lichen) are a categorical set. Assign them in order and never cycle them. Fold a seventh series into "other".
- The set is validated as adjacent pairs in both themes: colour-blind ΔE ≥ 12.8 and normal-vision ΔE ≥ 18.8.
- `ramp-1` through `ramp-4` are a one-hue lake ramp for magnitude (heatmaps, density). Step 1 sits nearest the ground in both themes.
- `grid` is the hairline grid.
- Chart text always wears ink tokens, never series colours.

**Interaction.**

- `wash` is the hover and pressed overlay on any surface.
- `focus` is ochre, applied through the `focus-ring` shadow: a 2px gap in the ground colour, then 2px of solid ochre. It is 3:1 or better on every ground in both themes.
- `selection` is `ochre-soft`.

## Type

Three families, each with one job. The fonts ship as variable files in `fonts/`.

| Family | Token | Job | Why |
|---|---|---|---|
| Newsreader | `--font-display` | Statements: one sentence per view, page titles, empty states | A literary voice for the moment the page speaks to you, with optical sizes for display. |
| Atkinson Hyperlegible Next | `--font-sans` | All interface text | Every confusable glyph is distinct (I l 1, O 0, B 8), which matters when agent names and ticket keys sit in running text. |
| Atkinson Hyperlegible Mono | `--font-mono` | Everything a machine wrote: subjects, SHAs, IDs, times, durations, counters | The same disambiguation in a fixed width. Its slashed zero keeps `f9806dd` and `0O` unambiguous. |

**Scale** (px size / line height).

| Group | Styles |
|---|---|
| Statements | `display` 40/44, `title` 28/34, `statement` 20/28 italic |
| Interface | `heading` 15/20, `body` 14/20, `body-strong` 14/20, `small` 13/18, `label` 11/16 uppercase with 0.07em tracking, `figure` 32/36, `figure-sm` 20/24 |
| Data | `code` 13/20, `data` 12/16, `data-strong` 12/16 |

**Rules.**

- One `display` sentence per view, at most. The display serif never sets numbers, labels, buttons or anything inside a row.
- Figures (`figure`, `figure-sm`) use the sans with proportional numerals. Tabular numerals are for columns: the mono does this by default, and the sans takes `font-variant-numeric: tabular-nums` where digits stack.
- 14px is the body size. The UI is dense on purpose, and phone and car layouts step controls up to `control-lg`, not the type scale.
- The bundle's `.tt-display`, `.tt-title`, `.tt-statement`, `.tt-label`, `.tt-small` and `.tt-data` classes apply these styles.

## Space, shape, depth

- **Space.** A 4px grid, named by pixel value so the name is the number: `space-2` through `space-64`.
  - Rows pad `space-12` by `space-16`.
  - Panels sit `space-24` apart and sections `space-32` apart.
- **Sizes.** Controls are `control-sm` 24, `control-md` 30 and `control-lg` 40. A one-line row is at least `row` 36.
- **Corners barely soften.**

  | Token | Size | Use |
  |---|---|---|
  | `radius-2` | 2px | chips, cells, chart data-ends |
  | `radius-4` | 4px | buttons, inputs, the gate row |
  | `radius-6` | 6px | anything floating |
  | `radius-full` | | counts and discs only |

- **Hairlines and space, not boxes.** A panel is a heading over a `line`. The only filled rows are gates, in `ochre-soft`.
- **Shadows** exist only for things that float: `shadow-float` on popovers, tooltips, the palette and toasts. Nothing that sits on the page has a shadow.

## Motion

Motion confirms. It never decorates.

| Token | Value | Use |
|---|---|---|
| `duration-quick` | 120ms | Hover, press, copy |
| `duration-calm` | 240ms | Popovers, row insertion |
| `duration-armed` | 4000ms | How long a two-step button stays armed |
| `duration-orbit` | 2400ms | One turn of the working glyph: alive, not anxious |

Everything uses one curve, `ease-settle`. Under `prefers-reduced-motion` the orbit stops, the fuse stops and transitions drop. Live lists insert rows without sliding the rows around them.

## Showing data

Decide what the operator needs to do with a number before choosing how to draw it.

| Question | Component | Not |
|---|---|---|
| What is waiting on me? | `NeedsYou`, then `AllClear` when empty | A notification badge |
| Who is working on what? | `AgentLine`: a sentence, then the facts | A 12-column agent table |
| How is this ticket moving? | `LifecycleTrack` against krebs budgets | A status pill |
| Where does an agent's time go? | `StateTape`, led by time waiting on you | A pie chart |
| Is this population healthy? | `Census`: every member, with the problems named | A percentage |
| Is this value normal? | `Reading` with a note and its age | A bare number tile |
| What happened? | `EventRow` and `EventBurst`, filtered by `QueryField` | Every tool call |
| When was the fleet busy, and did errors rise? | `Strata` | A dual-axis line chart |

Chart rules:

- One y-scale per chart. Measures on different scales get their own lanes (`Strata` errors) or their own charts.
- A legend or direct labels for two or more series, with leader lines when labels would touch.
- Every chart has a crosshair or per-mark tooltip and a table view.
- Marks are thin: 2px lines, a 2px surface gap between stacked layers, and 8px end dots with a 2px ground ring.

## Iconography

- **Signal glyphs** are the system's own: seven shapes on a 10-unit grid, drawn by `Glyph` and exported in `assets/Glyphs`. Do not substitute icon-font circles or emoji.
- **Interface icons** are Lucide outlines at a 1.75 stroke: 14px in rows and 16px in controls, coloured with `currentColor` in `ink-3` or `ink-2`. `Icon` inlines the subset in use, and `assets/Icons` holds the same SVGs. Add new icons from Lucide only, at the same stroke.
- No emoji, no illustrations, no mascots. Empty states are sentences.

## The mark

The mark is 33 set against its mirror: four half-discs, with one quadrant lit in ochre. Read left to right and top to bottom, the last step is the operator's.

- The **lockup** is the mark plus "33GOD" set in Newsreader 500, outlined in `assets/Logos/33god-lockup.svg`. In product chrome, the lockup is followed by a hairline and the surface name in `small` `ink-3`: "33GOD | Holocene".
- **Clear space** around the mark equals the width of one half-disc.
- **Minimum sizes** are 12px for the mark alone and 16px tall for the lockup.
- Use `33god-mark.svg` on light grounds, `33god-mark-dark.svg` on dark grounds, and `33god-mark-mono.svg` where only one ink prints.
- `33god-app-icon.svg` is the launcher, favicon and Telegram tile.
- The lit quadrant is always ochre and always lower right. Never recolour, rotate or animate the mark.

## Surfaces

| Surface | Layout | Controls | Notes |
|---|---|---|---|
| **Holocene web** | Desktop, 1280px and wider; the home page composes as `components/Home` shows. | `control-md` | |
| **/hq** | Phone, 390px wide; one column, with `NeedsYou` first. | `control-lg` | Respect the safe-area insets. |
| **Holocene Auto** | Android Automotive at 1280×720. | | Map the colour tokens to Android colour resources by name: `ground` becomes `@color/ground`. While driving the screen shows only the `display` statement and the count of things that need you; everything else is spoken. |

## Building with it

**Loading the kit.** Load `tokens.css`, `components/bundle.css`, then React 18 and `components/bundle.js`. The components arrive as `window.ThirtyThree`. Prop types are documented in `components/index.d.ts`, and each component's `README.md` says what the consumer provides.

**Helpers the bundle exports.**

- `formatDuration` and `formatMs`: the house formats for durations.
- `signalFromAsm`: maps ASM process states onto the ladder.
- `SIGNAL_ORDER`: the sort order for lists.
- `KREBS_PHASES`: the ticket lifecycle phases with their budgets.

**Data rules.**

- Holocene renders from the shared Bloodbank collection.
- Show freshness from each source's own `observed_at`, never from when the page loaded.

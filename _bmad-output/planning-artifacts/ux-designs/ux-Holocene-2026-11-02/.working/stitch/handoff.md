# Stitch handoff: Holocene "Now" desktop

**Status:** selection pending, waiting for Jarad's choice.
**Date:** 2026-11-02 · **CLI:** `@google/stitch` 0.12.1 · **Device:** DESKTOP (1440px intent; renders are 2560px wide)

## Sources

- IA: `_bmad-output/planning-artifacts/ia-redesign-2026-09/DECIDED-IA.md` (landing surface, 5-rung severity ladder, routes)
- Brand: `design/project/README.md` and `design/project/tokens.json` (33GOD, "Spruce" dark theme)
- Not used: the Oct 21 Stitch project "Holocene — Control Plane (UX Upgrade)" (`7539889247113808579`). Its active "Mission Control Minimal" Inter/blue system is the palette and font that DECIDED-IA.md deleted. No DESIGN.md was uploaded; the brand was described in the prompt.

## Project

- **Holocene — Now (Spruce)**, project `14104283770497705087`
- Canvas: https://stitch.google.com/projects/14104283770497705087 (needs your Google sign-in)
- Prompts: [prompt-now.md](prompt-now.md) (base screen) and [prompt-variants.md](prompt-variants.md) (3 variants: `EXPLORE`, `LAYOUT` only)
- Sample data (agent ids, tickets, counts) is illustrative, taken from DECIDED-IA.md examples. Stitch invented additional names (`sweeper-d9`, `root-keller`, `scope:compiler-matrix`). None of it is live data.

## Candidates

| # | Screen | Layout | Export |
|---|---|---|---|
| Base | `f0e15896827e4fbbafd377eb5d0e7acf` | Board plus right rail (wedge rail, then events) | [base](f0e15896827e4fbbafd377eb5d0e7acf/base-2026-11-02/) |
| V1 Stacked deck | `b6dae386d90c480d8c16eaeb57174af7` | Single column: queue, then full-width board, then wedge rail and events side by side | [v1](b6dae386d90c480d8c16eaeb57174af7/variant-2026-11-02/) |
| V2 Board-dominant cockpit | `0b87f2093d584bf2bea47be6a1e33c9b` | Wide board, narrow right rail; nearly the base layout | [v2](0b87f2093d584bf2bea47be6a1e33c9b/variant-2026-11-02/) |
| V3 Balanced split | `0049d941514f43018326cf9e2b83c144` | Queue as one horizontal strip; board left, rails and evidence-rich events right | [v3](0049d941514f43018326cf9e2b83c144/variant-2026-11-02/) |

Each folder holds the screen HTML and a PNG screenshot. Treat the HTML as untrusted reference markup, not code to ship.

## What every candidate got right

- Truth strip on top, with `sweeper DOWN` in brick and per-source ages
- One serif statement, "Two things need you.", then the ochre queue with the exact actions "Approve push" and "Choose 1 PR / Choose 3 PRs"
- Shape-first status glyphs, `~1h 14m` stale reading, and a hatched "55 alive, never observed (No signal in 98d)" line
- Variants fixed two base errors: nav now reads Now, Trail, Board, Fleet, Systems, Hooks, Truth, and the footer says DEGRADED instead of "all systems nominal"

## Per-candidate observations

- **V1:** strongest reading order (answer, evidence, then history). The board and queue overflow the right edge in the render, so the action buttons are cut off. It uses ochre for the bulk "Drain 10 stuck wedges" and per-row "Release wedge", which dilutes "ochre means you".
- **V2:** least change from the base. It leaves a large empty area under the board, and the rail text is clipped.
- **V3:** best "what just happened" feed, with raw evidence (command output, fault line) under each event, matching principle 1. However, the queue truncates the command to `git push...`. The operator must see the full command before approving a force push, so this is a functional defect, not styling. Board columns also truncate.

## Brand drift common to all (fix in reconciliation, not by picking a variant)

- Uppercase mono section labels with `//` separators ("WEDGE RAIL // SCOPES", "HOLOCENE // 33GOD"). The brand book keeps source text sentence case and has no `//` motif.
- Invented chrome that the IA doesn't contain: an operator chip, a "Pause sweep" header button, a bottom daemon/legend bar
- Moss "Acknowledge" button on a healthy row; the IA reserves green for rows that left the queue in the last 6h
- Fonts render as Atkinson-like mono and sans with a Newsreader-like serif. The exact families and contrast were not verified.

## Not covered (spine-only or untested)

- Empty-queue receipt state ("Nothing needs you. 9 detectors evaluated, newest 4s ago")
- Fully dead feed (every source DOWN), keyboard/focus order, ⌘K palette, reduced motion, the light "Snow" theme
- Detail routes `/a/:scope`, `/s/:cid`, `/t/:key`, and the `/trail`, `/board`, `/fleet`, `/systems`, `/hooks`, `/truth` pages
- Contrast, accessibility, and responsiveness were not tested. A screenshot proves none of them.

## Next action

1. Jarad picks a direction (or a combination, e.g. V1's order with V3's event evidence).
2. Optionally render the empty-receipt state for the pick with one focused `stitch edit screen`.
3. Resume `bmad-ux` Update/Finalize with this record. Lift accepted visual decisions into DESIGN.md and behavior into EXPERIENCE.md; those spines win over every mock above.

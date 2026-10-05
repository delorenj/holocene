# Strata

Event volume over time as stacked sediment, with errors and PM decisions in their own lanes beneath it.

## Reading it

1. **Volume.** Stepped bands stack bottom to top, one per source. Layer n takes `series-n`, and a 2px surface gap separates the layers.
2. **Errors.** Drawn in their own brick lane with their own scale, because at 2% of volume they would vanish in the stack. The peak is labelled.
3. **Decisions.** Marks on a rail, one tick per sparse, high-value event.

## Props

- `layers`, a list of `{ id, label, values }`, and `buckets` are required.
- `errors`, `marks` (`{ at, label }`), `unit`, `height`, `marksLabel`.

## Rules

- Stack only what shares a scale. Anything else gets a lane, never a second y-axis.
- Assign series tokens in order and never cycle them. Fold a fifth CLI and beyond into "other CLIs".
- The chart ships with a crosshair tooltip, direct labels with leader lines, and a table view.

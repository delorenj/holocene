# Panel

A titled region with a heading over a hairline, not a box: panels sit directly on the ground.

## Props

- `title` (required).
- `meta`: freshness, counts or a source name, shown in ink-3 beside the title.
- `actions`: right-aligned controls, usually a small Segmented control.
- `flush`: drops the body padding, for lists that run edge to edge.

## Rules

- No fill, no shadow, no radius. The hairline and the space around the panel do the separating.
- Titles are what the panel answers ("Working now", "Waiting on you"), never what it contains ("Agent table").
- Put the panel's freshness in `meta`, as an `Age` with the verb "updated".

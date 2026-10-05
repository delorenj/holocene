# EventBurst

Many events of one kind from one session, folded into a single row that shows the count, the span, the top contributors and the rate, and opens to the individual rows.

## Props

- `count`, `type`, `from`, `to`, `span` (seconds) and `breakdown` (largest first) are required.
- `actor`, `project`.
- `rate`: events per bucket, drawn as a tiny strip.
- `children`: the individual `EventRow`s.
- `defaultOpen`.

## Rules

- Fold when the same session emits five or more events of one type in a row.
- Name the top three contributors and roll the rest into "other". The breakdown is the point of the row.
- The burst never hides a failure. A failed event inside it breaks the burst and shows as its own row.

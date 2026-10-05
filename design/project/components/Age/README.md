# Age

A compact duration that knows its budget, turning stuck and saying by how much once it is over.

## Formats

| Range | Format |
|---|---|
| under a minute | `14s` |
| under an hour | `12m` |
| under a day | `1h 06m`, or `2h` on the hour |
| under a week | `4d 02h`, or `4d` |
| beyond | `98d` |

Minutes and hours are zero-padded so columns line up in the mono face.

## Props

- `seconds` or `since`. Given `since`, the value ticks every second, and the absolute time is in the title.
- `budget`: a staleness budget in seconds. Past it, the value turns `signal-stuck` and adds `· 36m over`.
- `showBudget` appends `of 2h` while the value is under budget.
- `verb` ("waiting", "updated") and `ago` frame the value. The value itself stays the brightest part.

## Rules

- Use the krebs budgets for ticket phases: triage 10m, refining 30m, in_progress 2h, review 15m, qa 1h.
- Never write "2 hours ago" in a row. Write `2h` with `ago` only when the column does not already say it.
- Durations of work done inside a row (tool calls, handlers) use `formatMs`: `312 ms`, `1.4 s`.

# EventRow

One Bloodbank event, read left to right: when, what kind, what happened, how long.

## Columns

1. **Time** in mono with milliseconds.
2. **Type** through `Subject`: the namespace is hidden by default, the entity is faint and the verb is strongest. A failed verb turns brick.
3. **Headline**, then the actor and project in ink-3.
4. **Duration** through `formatMs`.

## Props

- `time`, `type` and `headline` are required.
- `actor`, `project`, `durationMs`.
- `failed` adds the broken glyph and a brick verb.
- `compact={false}` shows the `bloodbank.` prefix.

## Rules

- Headlines come from the event's `summary.row.headline`. Never dump the payload into the row; open it on demand.
- Tool calls are 96% of all events. Fold consecutive ones from the same session into an `EventBurst`.
- Below 600px the row stacks: time and duration on one line, then the type, then the headline.

# LifecycleTrack

Where a ticket is in the krebs lifecycle, how long each phase took, and whether the current phase is over its budget.

## Phases and budgets

`KREBS_PHASES` holds the default phases with their budgets:

| Phase | Budget |
|---|---|
| triage | 10m |
| refining | 30m |
| ready | none |
| in_progress | 2h |
| review | 15m |
| qa | 1h |
| done | none |

## Props

- `phases`: a list of `{ id, label?, status, spent?, budget?, note? }`.
  - `status` is `done`, `current`, `next`, `blocked` or `skipped`.
  - `note` carries facts such as `retry 1/3`.
- `reason`: why it is blocked, which is required whenever a phase is `blocked`.

## Reading it

| Phase status | Bar |
|---|---|
| done | Ink-3, with its spent time below. |
| current, under budget | A lake fill against its budget, with "1h 48m of 2h". |
| current, over budget | Turns heather and says "12m over". |
| next | Shows its budget as `≤ 1h`. |
| blocked | Brick, with the reason under the track. |

## Rules

- Quote the reason verbatim from the Kanban block reason, such as `review-required: …`.
- Show retries as a note on the phase, never as extra phases.

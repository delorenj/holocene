# NeedsYou

One thing that is waiting on the operator: what it is, how long it has waited, and the one way in.

## Kinds

| Kind | Meaning | Treatment |
|---|---|---|
| `gate` | A live process is blocked on a permission prompt, so you are the bottleneck. | Ochre-soft row, 12px diamond, primary action. |
| `bell` | An agent pinged you; work may continue. | |
| `decision` | A ticket in `Awaiting Decision`. | |
| `acknowledge` | `Complete but Unacknowledged`. | |

## Props

- `kind`, `title` and `waiting` (seconds) are required.
- `meta`: who and where, as data (cli · repo · Refs).
- `where`: usually a pane `Ref`.
- `action`: `{ label, onPress, kbd }`.

## Rules

- Lead every view with this list. Sort gates first, then by longest waiting.
- Write the title as one sentence with the subject first: "codex wants approval to run …".
- Exactly one action per row, named by what it does: Go to pane, Decide, Reply, Acknowledge.
- When the list is empty, render `AllClear`, never a blank panel.

# Ref

An identifier a machine wrote, shown as a mono chip that copies on click and keeps its full value in the title.

## Kinds

| Kind | Example | Notes |
|---|---|---|
| `ticket` | `HOLOC-11` | Set in semibold. |
| `commit` | `f9806dd` | Shows 7 characters, copies the full SHA. |
| `branch` | `holoc-11-play-version-6` | |
| `card` | `t_8f126526` | |
| `worker` | `proc_a91f02` | |
| `pane` | `pane 13` | |
| `session` | | |
| `subject` | `bloodbank.agent.invocation.failed` | |
| `unit` | | Long names middle-truncate with `max`. |
| `path` | | Long paths middle-truncate with `max`. |

## Props

- `value` (required).
- `kind` sets the icon and the title.
- `copy` overrides what a click copies, such as the full SHA or a focus command.
- `href` adds a separate arrow that opens in a new tab. The chip itself always copies.
- `max` sets where middle truncation starts.

## Rules

- Every machine identifier in the UI is a Ref. Never print a ticket key or SHA as plain text.
- Copy confirmation is a check icon and a polite live-region announcement. Nothing moves or flashes.
- Middle truncation keeps both the root and the leaf. Never end-truncate a path.

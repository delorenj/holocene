# Signal

A state glyph and its word; every status in 33GOD is built from it.

## The ladder

| State | Glyph | Token | Means | Typical sources |
|---|---|---|---|---|
| `you` | filled diamond | `signal-you` (ochre) | You have to act | ASM `awaiting_human`, a gate, Plane `Awaiting Decision` |
| `broken` | filled square | `signal-broken` (brick) | Something failed | `failed` units, 5xx probes, `invocation.failed`, dead letters |
| `stuck` | hourglass | `signal-stuck` (heather) | Over its time budget | krebs staleness budgets, a lease with no worker, a silent heartbeat |
| `working` | ring with a turning arc | `signal-working` (lake) | Moving | `tool_running`, `working`, `delegating`, `starting` |
| `unknown` | dotted ring | `signal-quiet` | No reading | `gone`, `unobserved`, never probed |
| `quiet` | short dash | `signal-quiet` (ink-3) | Healthy, idle, nothing to say | `idle`, HTTP 200, `active` units |
| `cleared` | filled disc | `signal-cleared` (moss) | Left the queue recently | closed, recovered, acknowledged in the last 6h |

Sort lists by this order, then by age. `SIGNAL_ORDER` exports it, and `signalFromAsm(state)` maps raw ASM states onto it.

## Props

- `state` (required).
- `label` overrides the ladder word. Pass `false` for the glyph alone, and give it a `title`.
- `freshness`:
  - `stale` dims the glyph and prefixes the word with `~`.
  - `unobserved` swaps the glyph for the dotted ring.
- `count` adds a tabular number after the word.
- `size`: `md` (10px glyph), or `sm` (8px) for rows and keys.

## Rules

- Healthy is quiet, not green. Moss is earned by leaving the queue; never paint a running system moss.
- Ochre means you. Never use `you` for anything the operator cannot act on.
- Never show colour without the glyph. The glyph is what survives greyscale, colour blindness and forced colours.
- Use `Glyph` directly only where a word would repeat a column header.

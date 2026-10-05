# SourceStrip

Every feed a view depends on and how old each one is, so the operator knows whether to trust the page.

## Props

`sources` is a list of `{ name, value?, age?, max?, down? }`.

- `value` replaces the age when a count says more, as in `asm 36/17` or `nats 143,633`.
- `max` is the expected reporting interval. Each source's state follows from its age:

| State | Rule | Shown as |
|---|---|---|
| fresh | age ≤ max | the value |
| stale | age ≤ 2 × max | a heather `~` value |
| expired | older than that | brick |
| down | `down: true` | brick, overrides age |

## Rules

- Put it at the top of every live view, right-aligned in the bar. It is the page's receipt.
- A fresh source adds no glyph. Only problems earn marks.
- Never hide a down source because the page still renders. A view built on a dead feed is worse than an empty one.

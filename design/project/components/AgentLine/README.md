# AgentLine

Who is working on what, in two lines: a sentence about what the agent is doing, then the facts as data.

## Props

- `name`, `state` (the raw ASM state) and `held` (seconds) are required.
- `doing`: one sentence.
- `budget`: past it, a working agent reads as stuck.
- `cli`, `repo`, `tools`, `subs`.
- `ticket` and `pane`: pass these as `Ref`s.
- `freshness`.

## Reading it

- Line one is the glyph, the name and the sentence, with the held time on the right.
- Line two keeps the raw state (`tool_running`, `delegating`) visible, because it is what you will grep for. Counters and Refs follow it.

## Rules

- Write the sentence from what the agent reports, in plain words, not from its ASM state.
- Map ASM to the ladder with `signalFromAsm`, and let `budget` derive stuck. Never trust a self-reported `working` past its budget.
- A stale heartbeat is shown, not hidden: `freshness="stale"` dims the glyph and prefixes the state with `~`.

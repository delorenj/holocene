# StateTape

One agent's last hours as a single strip of states, totalled underneath, leading with time spent waiting on you.

## Props

- `segments`: a list of `{ state, seconds, note? }`, built from the `asm:t:<scope>` transitions (`held_ms`).
- `start` and `end` label the edges.
- `totals` sets which states to sum, in order. The default is you, working and stuck.

## Rules

- Lead the totals with `you`. For a single operator, time agents spend blocked on you is the number to shrink.
- Coalesce ASM flapping before drawing: `tool_running` and `working` alternate every 88–342 ms, so merge runs shorter than one second.
- Quiet time is drawn in `line` so the strip reads as work against rest.

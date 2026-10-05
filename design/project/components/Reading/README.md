# Reading

One instrument reading: the value, what normal is, and how old the reading is.

## Props

- `label` and `value` are required. Write the label in sentence case with no colon.
- `of` makes the value read "x of y" and adds a meter whose track is the state's `-soft` tint.
- `unit`.
- `note`: one short phrase on what the value means right now.
- `state`.
- `trend` adds a `Spark`.
- `age` and `maxAge`: when the reading is older than `maxAge`, the figure gets `~` and the age turns stuck.

## Rules

- Prefer "26 of 80" to "32.5%". The operator thinks in things, not ratios.
- Each reading answers "is this normal?" in its note: "The same 9 for 2 days", "Growing, +41 today".
- One figure per reading, in the sans at `figure` size. Never use the display serif for numbers.
- Do not open a view with a row of readings. They support the needs-you list; they never replace it.

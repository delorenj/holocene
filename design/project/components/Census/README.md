# Census

A whole population at a glance: one cell per member, with problems sorted first and named underneath.

## Props

- `items`: a list of `{ id, label, state, detail? }`.
- `noun`: "probes", "units", "agents".
- `name`: how many problems to list before "and N more".
- `cell`: the cell edge in px.

## Reading it

- Healthy cells recede into `line-strong`.
- Broken cells are brick and stuck cells are heather. Cells with no signal are hollow.
- Hovering a cell names it in the line under the field. The key counts each state and gives the total.

## Rules

- Use it for populations of 20 to 600: HTTP probes (80), systemd units (476), PM agents (29).
- The cell field shows proportion and clustering; the list shows which members are affected. Ship both.
- Sort by ladder order, then by name, so the field reads as a single bar of trouble.

# Segmented

A set of mutually exclusive views of the same data, such as time windows and lenses, where arrow keys move the selection.

## Props

- `label` (required): the accessible name of the group.
- `options` is a list of `{ value, label, count? }`.
- `value`, plus an optional `onChange`. Leave `onChange` out for an uncontrolled control.
- `size`: use `sm` in panel headers.

## Rules

- Use it for two to six options that change what a panel shows. More options, or options that filter rather than switch, belong in the `QueryField`.
- A count shows the size of each lens before it is chosen: Tools 24,583, Errors 536.
- Time windows are always `1h · 6h · 24h · 7d`.

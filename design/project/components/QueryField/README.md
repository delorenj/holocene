# QueryField

A NATS subject filter for the event stream: `*` matches one token, a trailing `>` matches the rest, and `/` focuses it from anywhere.

## Props

- `value` and `onChange` (controlled), or leave them out.
- `matches`: the count in the current window.
- `suggestions`: common subjects shown as chips.
- `placeholder`.

## Behaviour

- An invalid subject shows the brick border and a one-line hint that explains the grammar.
- Esc clears the field and blurs it.

## Rules

- Filter on the shared Bloodbank collection. Never add a producer-specific feed to make a filter easier.
- Keep suggestions to subjects that actually fired in the last 7 days.

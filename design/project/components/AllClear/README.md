# AllClear

An empty state that proves it is empty, listing every detector that ran and what it found.

## Props

- `checks`: a list of `{ name, result, state? }`.
- `newest`: seconds since the newest check ran.
- `statement` defaults to "Nothing needs you."

## Rules

- Render it wherever `NeedsYou` would be empty. Never render a blank panel or a cheerful illustration.
- Each result is a measured fact in mono: "0 open, 17 scopes observed", "80 of 80 answering".
- The statement is the one place the display serif appears in italic.

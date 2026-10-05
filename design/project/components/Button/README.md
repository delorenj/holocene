# Button

One button with four voices; primary appears at most once per view, and destructive actions confirm in place instead of in a dialog.

## Variants

| Variant | Use |
|---|---|
| `primary` | An ink fill. The one action the view exists for, such as "Go to pane" on a gate. |
| `quiet` | The default. A surface with a `line-strong` border. |
| `ghost` | Text only, for toolbars and secondary row actions. |
| `danger` | Brick text. It always takes `confirm`. |

## Props

- `variant`, `size` (`sm`, `md` or `lg`), `icon`, `kbd`, `busy`, `disabled`, `onPress`.
- `confirm` makes the press two-step:
  1. The first press arms the button. It turns ochre, shows the confirm label, and a fuse drains for `duration-armed` (4s).
  2. The second press acts.
  3. Esc, blur or the timeout disarms it.

## Rules

- Labels are verbs that say exactly what happens: "Restart gateway", not "Submit".
- Name the blast radius in the confirm label: "Confirm: restart 29 gateways".
- `busy` swaps the icon for the working glyph and keeps the label. Write it in the present tense, such as "Syncing defaults".
- Never use a modal to confirm a single action. The armed state is the confirmation.

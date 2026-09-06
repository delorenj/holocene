# Design canvas source

Published canvas: <https://claude.ai/code/artifact/9566554f-0184-4186-930d-cda24ca71a75>

Six artboards plus the canvas manifest. These are Claude Design "Design Component" files:
`{{handlebars}}` are data holes resolved by `renderVals()` in the trailing
`<script data-dc-script>` block, `<sc-for>`/`<sc-if>` are the loop/branch elements, and the
`<script src="./support.js">` head line is replaced by a runtime at render time.

| file | route | interactive |
|---|---|---|
| `Main.dc.html`   | `/` — the landing surface | attention band toggle · unobserved-row expand |
| `Ladder.dc.html` | the severity + confidence system sheet | — |
| `Trail.dc.html`  | `/trail` — the event lens spine | lens chips · tool fold |
| `Truth.dc.html`  | `/truth` — sources & trust | — |
| `Board.dc.html`  | `/board` — tickets by `tp_band` | needs-attention filter |
| `Phone.dc.html`  | `/hq` — Telegram Mini App | chip filters · two-step restart |

## The rules these encode

Enforced mechanically, not by eye — each was verified with a script after the change:

- **One severity ladder**, six rungs, replacing five vocabularies. ASM leads the mapping table
  because it is the vocabulary actually driving `/` and `/hq`.
- **A rung hue never appears on chrome, controls, filters, captions or explainers** — only on a
  row, cell or badge whose severity it states.
- **No rung hue appears without its glyph.** BROKEN and NUDGE differ by 1.01:1 in luminance, so
  the glyph carries the meaning.
- **OK is grey.** Green means exactly one thing: left the queue in the last 6 hours.
- **Confidence is form, never hue**, and no confidence treatment may push text under 3:1
  (`opacity` is invisible to a colour audit — compute the blend).
- **STUCK is time-derived only**, never state-derived.
- **10.5px for static chrome at >=4.5:1; 11.5px minimum for anything variable.** Density comes
  from leading, not from shrinking type.
- **Rings are provenance, not severity.** Hue rotation cannot separate provenance from the rung
  palette — `agent` measures 0.2 degrees from NUDGE — so the mark's form carries it instead.
- **An inferred edge renders dotted, names its own derivation, and may never drive a severity
  count.** A verdict never wears the dotted rule.
- **Hollowness is never the sole signal.** It now carries two meanings — provenance rings and
  the UNOBSERVED `◇` — so UNOBSERVED always pairs the glyph with the diagonal hatch, and
  provenance marks stay strictly circular. The diamond belongs to the ladder alone.

## Regenerating

Edit the `.dc.html` files, then re-seed and republish to the same URL. The seeding helper ships
with the `design` skill; `--check` validates the seeded page parses.

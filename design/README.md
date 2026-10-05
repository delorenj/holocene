# 33GOD design system

This folder holds the sources of the 33GOD brand and the component kit for Holocene, `/hq` and Holocene Auto. Its published, browsable copy is the **33GOD** design system artifact: https://claude.ai/artifact/BujKg4bcBTeuW1b1qwHDRA

Read [`project/README.md`](project/README.md) first. It is the brand book: principles, voice, colour, type, motion, data display, iconography and the mark.

## Layout

| Path | What |
|---|---|
| `project/README.md` | The brand book |
| `project/tokens.json` | Every token: 40 colours in two themes, 3 type families with 13 styles, spacing, radius, shadow, size, duration, easing |
| `project/fonts/` | Newsreader, Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono, as variable WOFF2 under the OFL (see `project/FONT-LICENSES.txt`) |
| `project/components/src/index.tsx` | The React 18 component source |
| `project/components/bundle.css` | Component styles; every value is a token |
| `project/components/index.d.ts` | Prop types, as documentation |
| `project/components/<Name>/README.md` | Guidelines per component |
| `project/components/Cover/preview.html` | The artifact's cover |
| `project/assets/` | The mark, lockups and app icon; the signal glyphs; the Lucide icon subset |
| `project/design-system.json` | The artifact index, including the uploaded asset ids |
| `scripts/` | Build, previews and the contrast check |

## Generated files

These files are generated from tracked sources, so git ignores them:

- `project/components/bundle.js`: the classic-script bundle that assigns `window.ThirtyThree`.
- `project/components/*/preview.html`: the live previews, written by `scripts/previews.py`. The Cover preview is hand-written and tracked.
- `tokens.css`: CSS custom properties for consumers outside the artifact.

Regenerate them with:

```bash
python3 design/scripts/previews.py
node design/scripts/build.mjs
node design/scripts/check-contrast.mjs
```

`build.mjs` runs esbuild 0.28.2 through `npx`; set `ESBUILD_BIN` to use a local binary instead. `check-contrast.mjs` fails if any text or mark pair the brand book promises drops below its floor in either theme.

## Using it in Holocene

1. Import `design/tokens.css` once, at the root layout. Its `@font-face` rules resolve to `design/project/fonts/`. Light is the default; dark follows `prefers-color-scheme` unless `data-theme` is set on `<html>`.
2. Import `design/project/components/bundle.css`.
3. Import components from `design/project/components/src/index.tsx`, or load the built bundle as a script.

## Publishing changes

Edit the sources here, regenerate, then republish `project/` to the artifact URL above:

- Send only the changed files.
- Send `design-system.json` last, and only when an index key changed.

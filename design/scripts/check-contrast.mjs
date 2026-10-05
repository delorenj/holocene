// Checks every text and mark pair the brand book promises, in every theme.
//   node scripts/check-contrast.mjs        exits 1 on any failure
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tokens = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'project', 'tokens.json'), 'utf8'));
const themes = tokens.color.themes.map(t => t.id);
const byName = Object.fromEntries(tokens.color.tokens.map(t => [t.name, t.value]));

function resolve(name, theme, depth = 0) {
  const v = byName[name];
  if (v == null || depth > 16) throw new Error(`unknown token ${name}`);
  const raw = typeof v === 'string' ? v : v[theme] ?? v[themes[0]];
  const alias = /^\{(.+)\}$/.exec(raw);
  return alias ? resolve(alias[1], theme, depth + 1) : raw;
}
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const grounds = ['ground', 'surface', 'sunken'];
const hues = ['ochre', 'brick', 'heather', 'lake', 'moss'];
const checks = [
  ...['ink', 'ink-2', 'ink-3', ...hues].flatMap(fg => grounds.map(g => [fg, g, 4.5])),
  ...hues.map(h => [h, `${h}-soft`, 4.5]),
  ...hues.map(h => ['ink-2', `${h}-soft`, 4.5]),
  ['on-ink', 'ink', 4.5],
  ['on-ochre', 'ochre', 4.5],
  ['on-ink', 'brick', 4.5],
  ...grounds.map(g => ['line-strong', g, 3]),
  ...grounds.map(g => ['focus', g, 3]),
];

let failed = 0;
for (const theme of themes) {
  for (const [fg, bg, min] of checks) {
    const r = ratio(resolve(fg, theme), resolve(bg, theme));
    if (r < min) { failed++; console.log(`FAIL ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`); }
  }
}
console.log(failed ? `${failed} pair(s) below their floor` : `all ${checks.length * themes.length} pairs pass in ${themes.join(' and ')}`);
process.exit(failed ? 1 : 0);

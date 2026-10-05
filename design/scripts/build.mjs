// Builds the 33GOD design system from its sources.
//
//   node scripts/build.mjs            bundle + tokens.css
//   node scripts/build.mjs --render   also writes _render/<Comp>.<theme>.html harness pages
//
// Inputs:  project/tokens.json, project/components/src/index.tsx
// Outputs: project/components/bundle.js, tokens.css (for consumers outside the artifact; fonts resolve to project/fonts)
// The render harness needs REACT_UMD_DIR: a folder holding react.production.min.js and react-dom.production.min.js (18.3.1).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const project = join(root, 'project');
const ESBUILD = process.env.ESBUILD_BIN; // optional: a local esbuild binary; otherwise npx fetches the pinned version

const COMPONENTS = [
  'Signal', 'Age', 'Ref', 'Kbd', 'Button', 'Segmented', 'QueryField', 'Panel',
  'NeedsYou', 'AgentLine', 'EventRow', 'EventBurst', 'LifecycleTrack', 'StateTape',
  'Reading', 'Spark', 'Census', 'Strata', 'SourceStrip', 'AllClear',
];
const NAMESPACE = 'ThirtyThree';

/* ---------- bundle ---------- */
const header = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: NAMESPACE, components: COMPONENTS.map(name => ({ name })) })} */`;
const args = [join(project, 'components/src/index.tsx'), '--bundle', '--format=iife', '--global-name=__tt', '--target=es2019',
  '--jsx=transform', '--jsx-factory=React.createElement', '--jsx-fragment=React.Fragment', '--legal-comments=none', '--log-level=warning'];
let js = ESBUILD
  ? execFileSync(ESBUILD, args, { encoding: 'utf8', cwd: root })
  : execFileSync('npx', ['--yes', 'esbuild@0.28.2', ...args], { encoding: 'utf8', cwd: root });
js = `${header}\n(function () {\n${js}\nwindow.${NAMESPACE} = Object.assign(window.${NAMESPACE} || {}, __tt);\n})();\n`;
if (/<\/script|<!--/i.test(js)) throw new Error('bundle.js contains </script or <!-- ; consumers inline it');
writeFileSync(join(project, 'components/bundle.js'), js);

/* ---------- tokens.css ---------- */
const tokens = JSON.parse(readFileSync(join(project, 'tokens.json'), 'utf8'));
const themes = tokens.color.themes.map(t => t.id);
const val = (v, theme) => {
  const raw = typeof v === 'string' ? v : v[theme] ?? v[themes[0]];
  return raw.replace(/^\{(.+)\}$/, 'var(--$1)');
};
const block = (theme) => [
  ...tokens.color.tokens.map(t => `  --${t.name}: ${val(t.value, theme)};`),
  ...tokens.shadow.tokens.map(t => `  --${t.name}: ${val(t.value, theme)};`),
].join('\n');
const flat = Object.entries(tokens)
  .filter(([k, v]) => v && Array.isArray(v.tokens) && !['color', 'shadow'].includes(k))
  .flatMap(([, v]) => v.tokens.map(t => `  --${t.name}: ${t.value};`));
const fams = Object.entries(tokens.type.families).map(([k, v]) => `  --font-${k}: ${v};`);
const faces = (prefix) => tokens.type.fonts.map(f =>
  `@font-face { font-family: "${f.family}"; src: url("${prefix}${f.file}") format("woff2"); font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap; }`).join('\n');
const dark = themes[1];
const tokensCss = (fontPrefix) => `/* 33GOD tokens. Generated from tokens.json by scripts/build.mjs — edit the JSON, not this file. */
${faces(fontPrefix)}

:root, [data-theme="${themes[0]}"] {
  color-scheme: light;
${block(themes[0])}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="${themes[0]}"]) {
    color-scheme: dark;
${block(dark).replace(/^/gm, '  ')}
  }
}
[data-theme="${dark}"] {
  color-scheme: dark;
${block(dark)}
}
:root {
${[...flat, ...fams].join('\n')}
}
`;
writeFileSync(join(root, 'tokens.css'), tokensCss('project/'));

/* ---------- render harness ---------- */
if (process.argv.includes('--render')) {
  const libs = process.env.REACT_UMD_DIR;
  const react = readFileSync(join(libs, 'react.production.min.js'), 'utf8');
  const reactDom = readFileSync(join(libs, 'react-dom.production.min.js'), 'utf8');
  const css = readFileSync(join(project, 'components/bundle.css'), 'utf8');
  const tcss = tokensCss(`file://${project}/`).replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/, '');
  const outDir = join(root, '_render');
  mkdirSync(outDir, { recursive: true });
  const dirs = readdirSync(join(project, 'components'), { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(project, 'components', d.name, 'preview.html')));
  for (const d of dirs) {
    const src = readFileSync(join(project, 'components', d.name, 'preview.html'), 'utf8');
    for (const theme of themes) {
      const html = src.replace(/<html([^>]*)>/i, `<html$1 data-theme="${theme}">`)
        .replace(/<head>/i, `<head><style>${tcss}</style><style>${css}</style><script>${react}<\/script><script>${reactDom}<\/script><script>${js}<\/script>`);
      writeFileSync(join(outDir, `${d.name}.${theme}.html`), html);
    }
  }
  console.log('rendered', dirs.length, 'previews');
}
console.log('bundle', (js.length / 1024).toFixed(1), 'KB · tokens.css written');

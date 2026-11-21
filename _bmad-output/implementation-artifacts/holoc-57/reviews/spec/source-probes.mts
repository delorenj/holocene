import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { classifyProduct } from '../../../../../apps/api/src/products-model.ts';
import { createProductsDirectory } from '../../../../../apps/api/src/products.ts';
import { getRegisteredProjects } from '../../../../../apps/api/src/hub.ts';

const out = dirname(fileURLToPath(import.meta.url));
const classifications = ['mode: [launch]', 'mode: [steady]', 'mode: [live]', 'mode: {x: launch}', 'mode: launch', 'mode: steady'].map(raw => ({ raw, result: classifyProduct(raw) }));
const directory = createProductsDirectory({
  projects: async () => ({ projects: [{ id: 'invalid-array-mode', name: 'Invalid array mode fixture', repoPath: '/unused', indexed: true }] }),
  declaration: async () => ({ raw: 'mode: [launch]', commit: 'b'.repeat(40) }),
  receipt: async () => { throw Error('not called'); },
  now: () => Date.parse('2026-11-20T23:40:00Z')
});
const payload = await directory.read();
const fetchOriginal = globalThis.fetch;
let malformedRegistry;
let malformedFirstPayload;
let malformedAfterGoodPayload;
try {
  const malformed = { projects: { example: { repo_path: '/registered', project_id: 123 } } };
  const valid = { projects: { example: { repo_path: '/registered' } } };
  globalThis.fetch = async () => new Response(JSON.stringify(malformed));
  malformedRegistry = await getRegisteredProjects();
  const createRegistryFixture = () => createProductsDirectory({
    projects: getRegisteredProjects,
    declaration: async () => ({ raw: 'mode: launch', commit: 'c'.repeat(40) }),
    receipt: async () => ({ schema: 'launch-dashboard/1', published: { url: 'https://s3.delo.sh/projects/example/launch-dashboard/index.html', at: '2026-11-20T00:00:00Z' } }),
    now: () => fixtureNow
  });
  let fixtureNow = Date.parse('2026-11-20T23:40:00Z');
  malformedFirstPayload = await createRegistryFixture().read();
  globalThis.fetch = async () => new Response(JSON.stringify(valid));
  const formerlyGood = createRegistryFixture();
  await formerlyGood.read();
  fixtureNow += 6000;
  globalThis.fetch = async () => new Response(JSON.stringify(malformed));
  malformedAfterGoodPayload = await formerlyGood.read();
} finally { globalThis.fetch = fetchOriginal; }
await writeFile(`${out}/source-probes.json`, JSON.stringify({ classifications, payload, malformedRegistry, malformedFirstPayload, malformedAfterGoodPayload }, null, 2));
console.log(JSON.stringify({ classifications, payload, malformedRegistry, malformedFirstPayload, malformedAfterGoodPayload }, null, 2));
assert.equal(payload.products[0]?.stage, 'live', 'reproduction has changed');
assert.equal(payload.products[0]?.destination?.href, '/live');
assert.equal(malformedRegistry.projects.length, 0);
assert.equal(malformedRegistry.down, undefined);
console.log('Confirmed both candidate behaviors; assertions describe observed defects, not expected acceptance.');

// Independent read-only adversarial GET probe; synthetic registry and receipts, no source edits.
import assert from 'node:assert/strict';
import Fastify from '../../../../apps/api/node_modules/fastify/fastify.js';
import { createProductsDirectory, registerProductsRoutes } from '../../../../apps/api/src/products.js';

const now = Date.parse('2026-11-23T00:00:00Z');
const validUrl = 'https://s3.delo.sh/projects/alpha/2026-11-22/launch-dashboard/index.html';
const project = (id: string) => ({ id, name: id, repoPath: '/unused', agents: [] });
let mode = 'launch';
const receipt = (url: string, old = false, partial = false) => ({
  schema: 'launch-dashboard/1', published: { url, at: '2026-11-23T00:00:00Z' },
  items: [{ status: 'open', verified_at: old ? '2026-11-01T00:00:00Z' : '2026-11-22T00:00:00Z' }],
  requirements: { gate: { status: 'owner', verified_at: partial ? null : '2026-11-22T00:00:00Z' } },
  secret: 'op://do-not-serialize'
});
let data: unknown = receipt(validUrl);
const deps = {
  projects: async () => ({ projects: [project('alpha'), project('steady'), project('absent')] }),
  declaration: async (p: ReturnType<typeof project>) => ({ commit: 'a'.repeat(40), raw: p.id === 'steady' ? 'mode: steady' : p.id === 'absent' ? undefined : `mode: ${mode}` }),
  receipt: async () => { if (data === null) throw new Error('unavailable'); return data; },
  now: () => now
};
const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
const result = async () => {
  const response = await app.inject({ method: 'GET', url: '/api/modules/products' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json();
  assert.equal(body.products.some((p: { id: string }) => p.id === 'steady'), false);
  assert.equal(body.issues.some((p: { id: string, state: string }) => p.id === 'absent' && p.state === 'missing'), true);
  assert.equal(JSON.stringify(body).includes('op://'), false);
  return body.products.find((p: { id: string }) => p.id === 'alpha');
};
const observations = [];
let p = await result(); assert.equal(p.launch.state, 'attention'); observations.push({ case: 'fresh valid', launch: p.launch, destination: p.destination });
data = receipt(validUrl, true); // directory has five-second cache; use a fresh route to force source reread below.
await app.close();
async function probe(label: string, next: unknown, nextMode = 'launch') {
  data = next; mode = nextMode;
  const server = Fastify(); registerProductsRoutes(server, createProductsDirectory(deps));
  const response = await server.inject({ method: 'GET', url: '/api/modules/products' });
  const body = response.json();
  await server.close();
  const product = body.products.find((entry: { id: string }) => entry.id === 'alpha');
  observations.push({ case: label, launch: product?.launch, destination: product?.destination, issue: product?.issue, stage: product?.stage });
  return product;
}
p = await probe('stale observation, recent publication', receipt(validUrl, true)); assert.equal(p.launch.state, 'stale');
p = await probe('partial observation', receipt(validUrl, false, true)); assert.equal(p.launch.state, 'unknown');
p = await probe('missing receipt', null); assert.equal(p.launch.state, 'unknown'); assert.equal(p.destination, undefined);
p = await probe('unsafe publication, valid gate entries', receipt('https://attacker.test/projects/alpha/launch-dashboard/index.html')); assert.equal(p.destination, undefined);
p = await probe('transition', receipt(validUrl), 'live'); assert.equal(p.id, 'alpha'); assert.equal(p.stage, 'live'); assert.equal(p.destination.href, '/live');
console.log(JSON.stringify(observations, null, 2));

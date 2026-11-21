import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const file = new URL('./source-probes.json', import.meta.url);
const data = JSON.parse(await readFile(file, 'utf8'));
// This oracle consumes independently observed responses from the actual Fastify route,
// actual getRegisteredProjects over loopback HTTP, actual Git and actual readers.
// It is intentionally failing against candidate 4d36eb9; do not weaken expectations.
test('Q1 malformed non-string modes are isolated invalid issues, never Live or endpoint 500', () => {
 const probes=data.results.filter(x=>x.name==='non-string lifecycle must be invalid and not product');
 assert.equal(probes.length,4);
 assert.deepEqual(probes.map(x=>({raw:x.raw,ok:x.contractHolds})),probes.map(x=>({raw:x.raw,ok:true})));
});
test('Q2 malformed registry identity preserves dated last-good with discovery down', () => {
 const probe=data.results.find(x=>x.name==='malformed identity overwrites last good');
 assert.equal(probe.after.registry.state,'down');
 assert.equal(probe.after.products.length,1);
 assert.equal(probe.after.registry.snapshotAt,probe.before.registry.snapshotAt);
});
test('Q3 pinned committed declaration ignores mutable replacement refs', () => {
 const probe=data.results.find(x=>x.name==='local replacement refs and pinned source');
 assert.equal(probe.headUnchanged,true);
 assert.equal(probe.observedRaw,probe.trueObjectRaw);
 assert.equal(probe.observed.products[0].stage,'launch');
});

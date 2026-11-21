import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = '/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar';
const out = join(root, '_bmad-output/implementation-artifacts/holoc-57/reviews/quality-recheck');
const scratch = await mkdtemp(join(process.env.TMPDIR, 'holoc57-recheck-'));
const repo = join(scratch, 'bad');
const neighbor = join(scratch, 'neighbor');
const git = (dir, ...args) => execFileSync('git', ['--no-replace-objects', '-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const normalGit = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
let registry;
const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(registry)); });
const results = { commit: 'ebff673854e84ccd1fd1fe1e13c20f3516605207', checks: [] };
let app;
try {
  for (const dir of [repo, neighbor]) {
    await mkdir(dir);
    git(dir, 'init'); git(dir, 'config', 'user.name', 'Recheck fixture'); git(dir, 'config', 'user.email', 'recheck@example.invalid');
    await writeFile(join(dir, '.launch.yaml'), 'mode: launch\n');
    git(dir, 'add', '.launch.yaml'); git(dir, 'commit', '-m', 'original launch');
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PJ_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`;
  const { getRegisteredProjects } = await import(pathToFileURL(join(root, 'apps/api/src/hub.ts')).href);
  const { createProductsDirectory, defaultProductsDeps, registerProductsRoutes, committedDeclaration } = await import(pathToFileURL(join(root, 'apps/api/src/products.ts')).href);
  const { default: Fastify } = await import(pathToFileURL(join(root, 'apps/api/node_modules/fastify/fastify.js')).href);
  const valid = { projects: { bad: { project_id: 'bad', repo_path: repo }, neighbor: { project_id: 'neighbor', repo_path: neighbor } } };
  registry = structuredClone(valid);
  let now = 1800000000000;
  const deps = defaultProductsDeps(getRegisteredProjects); deps.now = () => now;
  app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
  const get = async (target = app) => { const r = await target.inject({ method: 'GET', url: '/api/modules/products' }); assert.equal(r.statusCode, 200); return r.json(); };
  const initial = await get();
  assert.equal(initial.registry.state, 'ok'); assert.deepEqual(initial.products.map(x => x.id), ['bad', 'neighbor']);
  results.checks.push({ case: 'initial healthy', state: initial.registry.state, ids: initial.products.map(x => x.id), snapshotAt: initial.registry.snapshotAt });
  for (const raw of ['mode: [launch]\n', 'mode: [steady]\n', 'mode: [live]\n', 'mode: {toString: launch}\n', 'mode: null\n', 'mode: 123\n', 'mode: true\n']) {
    await writeFile(join(repo, '.launch.yaml'), raw); git(repo, 'add', '.launch.yaml'); git(repo, 'commit', '-m', 'nonstring');
    now += 6000;
    const d = await get();
    assert.equal(d.registry.state, 'ok');
    assert.deepEqual(d.products.map(x => x.id), ['neighbor']);
    assert.deepEqual(d.issues.map(x => [x.id, x.state]), [['bad', 'invalid']]);
    assert.ok(!JSON.stringify(d).includes('"href":"/live"'));
    results.checks.push({ case: 'Q1', raw: raw.trim(), http: 200, products: d.products.map(x => x.id), issues: d.issues.map(x => [x.id, x.state]) });
  }
  await writeFile(join(repo, '.launch.yaml'), 'mode: launch\n'); git(repo, 'add', '.launch.yaml'); git(repo, 'commit', '-m', 'restored launch');
  now += 6000;
  const good = await get();
  for (const id of [42, {}, [], false, '']) {
    registry = structuredClone(valid); registry.projects.bad.project_id = id;
    const read = await getRegisteredProjects(); assert.ok(read.down, JSON.stringify(id));
    const first = Fastify(); registerProductsRoutes(first, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
    let firstRead;
    try { firstRead = await get(first); } finally { await first.close(); }
    assert.equal(firstRead.registry.state, 'down'); assert.equal(firstRead.registry.snapshotAt, undefined); assert.deepEqual(firstRead.products, []);
    now += 6000;
    const stale = await get();
    assert.equal(stale.registry.state, 'down'); assert.equal(stale.registry.snapshotAt, good.registry.snapshotAt);
    assert.deepEqual(stale.products.map(x => x.id), ['bad', 'neighbor']);
    results.checks.push({ case: 'Q2', invalidId: id, helperDown: true, firstRead: { state: firstRead.registry.state, snapshotAt: firstRead.registry.snapshotAt ?? null, count: firstRead.products.length }, retained: { state: stale.registry.state, snapshotAt: stale.registry.snapshotAt, ageSeconds: stale.registry.ageSeconds, ids: stale.products.map(x => x.id) } });
  }
  registry = { projects: {} }; now += 6000;
  const empty = await get(); assert.equal(empty.registry.state, 'ok'); assert.deepEqual(empty.products, []);
  assert.notEqual(empty.registry.snapshotAt, good.registry.snapshotAt);
  results.checks.push({ case: 'healthy empty control', state: empty.registry.state, snapshotAt: empty.registry.snapshotAt, count: empty.products.length });
  registry = structuredClone(valid);
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, '.launch.yaml'), 'mode: live\n'); git(repo, 'add', '.launch.yaml');
  const tree = git(repo, 'write-tree'); const replacement = git(repo, 'commit-tree', tree, '-m', 'replacement live');
  git(repo, 'replace', head, replacement);
  assert.equal(normalGit(repo, 'show', `${head}:.launch.yaml`), 'mode: live');
  assert.equal(git(repo, 'show', `${head}:.launch.yaml`), 'mode: launch');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  const direct = await committedDeclaration({ id: 'bad', name: 'bad', repoPath: repo, indexed: true });
  assert.equal(direct.commit, head); assert.equal(direct.raw, 'mode: launch');
  now += 6000;
  const d = await get();
  const selected = d.products.find(x => x.id === 'bad');
  assert.equal(selected.stage, 'launch'); assert.equal(selected.declaration.commit, head);
  results.checks.push({ case: 'Q3', head, replacement, normalGitRaw: 'mode: live', noReplaceRaw: git(repo, 'show', `${head}:.launch.yaml`), directRaw: direct.raw, response: { stage: selected.stage, commit: selected.declaration.commit } });
  await writeFile(join(out, 'source-recheck.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ commit: results.commit, passed: results.checks.length, cases: results.checks.map(x => x.case) }));
} finally {
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

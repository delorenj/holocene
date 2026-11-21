import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const root = '/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar';
const out = join(root, '_bmad-output/implementation-artifacts/holoc-57/reviews/quality');
const scratch = await mkdtemp(join(process.env.TMPDIR!, 'holoc57-quality-sources-'));
const repo = join(scratch, 'registered'); await mkdir(repo);
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
git('init'); git('config', 'user.email', 'quality@example.invalid'); git('config', 'user.name', 'Independent quality fixture');
let registry: any;
const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(registry)); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const addr = server.address() as any;
process.env.PJ_REGISTRY_URL = `http://127.0.0.1:${addr.port}`;
const { getRegisteredProjects } = await import(pathToFileURL(join(root, 'apps/api/src/hub.ts')).href);
const { createProductsDirectory, defaultProductsDeps, registerProductsRoutes, committedDeclaration, readPublication } = await import(pathToFileURL(join(root, 'apps/api/src/products.ts')).href);
const { default: Fastify } = await import(pathToFileURL(join(root, 'apps/api/node_modules/fastify/fastify.js')).href);
const project = { id: 'quality-fixture', name: 'Quality fixture', repoPath: repo, indexed: true, agents: [{ id: 'pm', role: 'pm', roleDir: 'roles/pm' }] };
registry = { projects: { 'quality-fixture': { project_id: project.id, name: project.name, repo_path: repo, agents: { pm: { role: 'pm', role_dir: 'roles/pm' } } } } };
const validRegistry = structuredClone(registry);
const app = Fastify();
registerProductsRoutes(app, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
const results: any[] = [];
async function commit(raw: string) { await writeFile(join(repo, '.launch.yaml'), raw); git('add', '--', '.launch.yaml'); git('commit', '-m', 'private quality fixture declaration'); }
async function payload() { const response = await app.inject({ method: 'GET', url: '/api/modules/products' }); assert.equal(response.statusCode, 200); return response.json(); }
async function fresh(raw: string) { await commit(raw); const a = Fastify(); registerProductsRoutes(a, createProductsDirectory(defaultProductsDeps(getRegisteredProjects))); try { const response = await a.inject({ method: 'GET', url: '/api/modules/products' }); return { httpStatus: response.statusCode, ...response.json() }; } finally { await a.close(); } }
try {
  await mkdir(join(repo, 'roles/pm/runtime'), { recursive: true });
  await writeFile(join(repo, 'roles/pm/runtime/launch-dashboard.json'), JSON.stringify({ schema: 'launch-dashboard/1', published: { url: 'https://s3.delo.sh/projects/quality-fixture/2026-11-20/launch-dashboard/index.html', at: '2026-11-20T22:00:00Z' }, private: 'op://FIXTURE_ONLY/DO_NOT_SERIALIZE' }));
  await commit('mode: launch\n');
  const good = await payload(); assert.equal(good.products[0].stage, 'launch'); assert.ok(!JSON.stringify(good).includes('op://')); results.push({ name: 'valid committed launch control', payload: good });
  await writeFile(join(repo, '.launch.yaml'), 'mode: live\n');
  assert.equal((await committedDeclaration(project)).raw, 'mode: launch'); results.push({ name: 'dirty worktree ignored', pass: true });
  for (const raw of ['mode: {toString: launch}\n', 'mode: [launch]\n', 'mode: [steady]\n', 'mode: [live]\n']) {
    const d = await fresh(raw); results.push({ name: 'non-string lifecycle must be invalid and not product', raw, observed: d, contractHolds: d.httpStatus === 200 && d.products?.length === 0 && d.issues?.[0]?.state === 'invalid' });
  }
  await commit('mode: launch\n');
  for (const badId of [42, {}, [], false, '']) {
    registry = structuredClone(validRegistry); registry.projects['quality-fixture'].project_id = badId;
    const read = await getRegisteredProjects();
    const a = Fastify(); registerProductsRoutes(a, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
    const d = (await a.inject({ method: 'GET', url: '/api/modules/products' })).json(); await a.close();
    results.push({ name: 'invalid registry project identity', badId, down: Boolean(read.down), projectCount: read.projects.length, observed: d, contractHolds: Boolean(read.down) && d.registry.state === 'down' });
  }
  registry = validRegistry;
  let now = Date.now(); const deps = defaultProductsDeps(getRegisteredProjects); deps.now = () => now;
  const staleApp = Fastify(); registerProductsRoutes(staleApp, createProductsDirectory(deps));
  const before = (await staleApp.inject({ method: 'GET', url: '/api/modules/products' })).json();
  registry = structuredClone(validRegistry); registry.projects['quality-fixture'].project_id = 42; now += 6000;
  const after = (await staleApp.inject({ method: 'GET', url: '/api/modules/products' })).json(); await staleApp.close();
  results.push({ name: 'malformed identity overwrites last good', before, after, contractHolds: after.registry.state === 'down' && after.products.length === 1 });
  registry = validRegistry;
  const receiptPath = join(repo, 'roles/pm/runtime/launch-dashboard.json');
  const realReceipt = await readPublication(project); assert.ok(realReceipt);
  await rm(receiptPath); execFileSync('mkfifo', [receiptPath]);
  const start = Date.now(); let fifoRejected = false; try { await readPublication(project); } catch { fifoRejected = true; }
  results.push({ name: 'FIFO bounded rejection', rejected: fifoRejected, elapsedMs: Date.now() - start }); assert.ok(fifoRejected);
  await rm(receiptPath); await writeFile(join(scratch, 'outside.json'), JSON.stringify(realReceipt)); await symlink(join(scratch, 'outside.json'), receiptPath);
  let escaped = false; try { await readPublication(project); escaped = true; } catch {}
  results.push({ name: 'outside symlink rejection', pass: !escaped }); assert.ok(!escaped);
  // Local replace refs mutate Git's view of a pinned HEAD without changing HEAD itself.
  const head = git('rev-parse', 'HEAD');
  await writeFile(join(repo, '.launch.yaml'), 'mode: live\n'); git('add', '.launch.yaml'); const tree = git('write-tree');
  const replacement = execFileSync('git', ['-C', repo, 'commit-tree', tree, '-m', 'private replacement object'], { encoding: 'utf8' }).trim();
  git('replace', head, replacement);
  const replaced = await committedDeclaration(project);
  const replaceApp = Fastify(); registerProductsRoutes(replaceApp, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
  const replacedResponse = await replaceApp.inject({ method: 'GET', url: '/api/modules/products' });
  const replacedPayload = replacedResponse.json(); await replaceApp.close();
  results.push({ name: 'local replacement refs and pinned source', httpStatus: replacedResponse.statusCode, observed: replacedPayload, headUnchanged: git('rev-parse', 'HEAD') === head, reportedCommit: replaced.commit, observedRaw: replaced.raw, trueObjectRaw: execFileSync('git', ['--no-replace-objects', '-C', repo, 'show', `${head}:.launch.yaml`], { encoding: 'utf8' }).trim() });
  await writeFile(join(out, 'source-probes.json'), JSON.stringify({ candidate: gitCandidate(), fixtureOnly: true, results }, null, 2));
  console.log(JSON.stringify(results.map(r => ({ name: r.name, raw: r.raw, badId: r.badId, contractHolds: r.contractHolds, pass: r.pass, elapsedMs: r.elapsedMs, reportedCommit: r.reportedCommit, observedRaw: r.observedRaw, trueObjectRaw: r.trueObjectRaw })), null, 2));
} finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(scratch, { force: true, recursive: true }); }
function gitCandidate() { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }

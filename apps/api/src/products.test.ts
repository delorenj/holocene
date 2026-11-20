import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { getRegisteredProjects } from "./hub.js";
import type { ProjectRecord } from "./hub-model.js";
import { committedDeclaration, createProductsDirectory, readPublication, registerProductsRoutes, type ProductsDeps } from "./products.js";

const p = (id: string): ProjectRecord => ({ id, name: id, repoPath: `/unused/${id}`, indexed: true });
const LIVE = `mode: live
live_since: 2026-11-20
live:
  name: Example
  tagline: An existing product
  store_url: https://example.invalid/store
  platform: android
  package: io.example.product
  release: https://example.invalid/latest.json
  board: TEST
  checkout:
    payment_link: plink_Fixture123
    key_ref: op://private/never-serialize
`;
const receipt = (version = "one") => ({ schema: "launch-dashboard/1", published: { url: `https://s3.delo.sh/projects/example/${version}/launch-dashboard/index.html`, at: "2026-11-20T00:00:00Z" } });
function setup() {
  let now = 1_800_000_000_000;
  let projects = [p("launch"), p("live"), p("steady")];
  const modes: Record<string, string> = { launch: "mode: launch", live: LIVE, steady: "mode: steady" };
  const deps: ProductsDeps = { now: () => now, projects: async () => ({ projects }), declaration: async (p) => ({ raw: modes[p.id], commit: "a".repeat(40) }), receipt: async () => receipt() };
  return { deps, modes, directory: createProductsDirectory(deps), advance: () => { now += 6000; }, projects: (ps: ProjectRecord[]) => { projects = ps; } };
}
test("directory joins authoritative identity and links, promotion moves same ID and receipt changes do not replace identity", async () => {
  const h = setup();
  let d = await h.directory.read();
  assert.deepEqual(d.products.map((p) => [p.id, p.stage]), [["launch", "launch"], ["live", "live"]]);
  assert.equal(d.products[1].destination?.href, "/live");
  assert.equal(d.products[1].issue, undefined);
  assert.ok(!JSON.stringify(d).includes("op://"));
  assert.ok(!JSON.stringify(d).includes("plink_"));
  h.advance(); h.deps.receipt = async () => receipt("two");
  d = await h.directory.read(); assert.match(d.products[0].destination!.href, /two/);
  h.advance(); h.modes.launch = LIVE;
  d = await h.directory.read();
  assert.equal(d.products.filter((p) => p.id === "launch").length, 1);
  assert.equal(d.products[0].stage, "live"); assert.equal(d.products[0].destination?.href, "/live");
});
test("registry outage first read vs last-good snapshot vs healthy empty are distinct, errors never serialize secrets", async () => {
  const h = setup();
  await h.directory.read(); h.advance();
  h.deps.projects = async () => { throw Error("op://private buyer@example.com"); };
  const stale = await h.directory.read();
  assert.equal(stale.registry.state, "down"); assert.equal(stale.registry.ageSeconds, 6); assert.equal(stale.products.length, 2);
  assert.ok(!JSON.stringify(stale).includes("op://"));
  const first = await createProductsDirectory(h.deps).read(); assert.equal(first.products.length, 0); assert.equal(first.registry.snapshotAt, undefined);
  h.advance(); h.deps.projects = async () => ({ projects: [], down: "malformed" });
  assert.equal((await h.directory.read()).products.length, 2);
  h.advance(); h.deps.projects = async () => ({ projects: [] });
  const empty = await h.directory.read(); assert.equal(empty.registry.state, "ok"); assert.equal(empty.products.length, 0);
});
test("missing/invalid/unreadable sources are visible; unsafe or missing receipt disables action, cache coalesces", async () => {
  const h = setup(); h.projects([p("missing"), p("invalid"), p("down"), p("launch")]); h.modes.invalid = "mode: [";
  h.deps.declaration = async (p) => { if (p.id === "down") throw Error("private"); return { raw: h.modes[p.id], commit: "b".repeat(40) }; };
  let calls = 0; h.deps.receipt = async () => { calls++; return { ...receipt(), published: { url: "javascript:alert(1)", at: "2026-11-20T00:00:00Z" } }; };
  const [d, same] = await Promise.all([h.directory.read(), h.directory.read()]); assert.equal(d, same); assert.equal(calls, 1);
  assert.deepEqual(d.issues.map((i) => i.state).sort(), ["invalid", "missing", "unavailable"]);
  assert.equal(d.products[0].destination, undefined); assert.ok(d.products[0].issue);
  h.advance(); h.deps.receipt = async () => { throw Error("private"); };
  assert.match((await h.directory.read()).products[0].issue!, /unavailable/);
});
test("registered projects rejects malformed registry and retains declared PM receipt path", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ unexpected: [] }));
    assert.ok((await getRegisteredProjects()).down);
    globalThis.fetch = async () => new Response(JSON.stringify({ projects: { example: { repo_path: "/registered", agents: { pm: { role: "pm", role_dir: "custom/pm" } } } } }));
    const read = await getRegisteredProjects(); assert.equal(read.down, undefined); assert.equal(read.projects[0].agents?.[0].roleDir, "custom/pm");
  } finally { globalThis.fetch = original; }
});
test("real Git reads committed declaration not dirty disk; receipt reads stay bounded and inside registered repo", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR!, "holoc57-source-"));
  const repo = join(root, "repo"); await mkdir(repo);
  const project = { ...p("example"), repoPath: repo, agents: [{ id: "pm", role: "pm", roleDir: "roles/pm" }] };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    await writeFile(join(repo, ".launch.yaml"), "mode: launch\n"); git("add", "--", ".launch.yaml"); git("commit", "-m", "fixture");
    await writeFile(join(repo, ".launch.yaml"), "mode: live\n");
    const decl = await committedDeclaration(project); assert.equal(decl.raw, "mode: launch"); assert.match(decl.commit, /^[a-f0-9]{40}$/);
    await mkdir(join(repo, "roles/pm/runtime"), { recursive: true });
    await writeFile(join(repo, "roles/pm/runtime/launch-dashboard.json"), JSON.stringify(receipt()));
    assert.deepEqual(await readPublication(project), receipt());
    await assert.rejects(readPublication({ ...project, agents: [{ id: "pm", role: "pm", roleDir: "../escape" }] }));
    await writeFile(join(root, "outside.json"), JSON.stringify(receipt()));
    await rm(join(repo, "roles/pm/runtime/launch-dashboard.json")); await symlink(join(root, "outside.json"), join(repo, "roles/pm/runtime/launch-dashboard.json"));
    await assert.rejects(readPublication(project));
    await rm(join(repo, "roles/pm/runtime/launch-dashboard.json")); await writeFile(join(repo, "roles/pm/runtime/launch-dashboard.json"), "x".repeat(140000));
    await assert.rejects(readPublication(project));
    await rm(join(repo, "roles/pm/runtime/launch-dashboard.json")); execFileSync("mkfifo", [join(repo, "roles/pm/runtime/launch-dashboard.json")]);
    await assert.rejects(readPublication(project));
    git("rm", "--cached", ".launch.yaml"); git("commit", "-m", "remove declaration");
    assert.equal((await committedDeclaration(project)).raw, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("read-only module route is no-store and allowlists response, no write endpoint", async () => {
  const app = Fastify(); const h = setup(); registerProductsRoutes(app, h.directory);
  try {
    const r = await app.inject({ method: "GET", url: "/api/modules/products" });
    assert.equal(r.statusCode, 200); assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.json().products.length, 2);
    assert.equal((await app.inject({ method: "POST", url: "/api/modules/products" })).statusCode, 404);
    assert.ok(!r.body.includes("repoPath")); assert.ok(!r.body.includes("key_ref"));
  } finally { await app.close(); }
});

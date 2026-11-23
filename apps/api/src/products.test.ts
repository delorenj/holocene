import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { getRegisteredProjects } from "./hub.js";
import type { ProjectRecord } from "./hub-model.js";
import { committedDeclaration, createProductsDirectory, defaultProductsDeps, readPublication, registerProductsRoutes, type ProductsDeps } from "./products.js";

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
test("every registered launch declaration remains listed without scripts, receipts, or gates; steady excluded", async () => {
  const h = setup(); h.projects([p("launch"), p("no-script"), p("no-receipt"), p("steady")]);
  h.modes["no-script"] = "mode: launch"; h.modes["no-receipt"] = "mode: launch";
  h.deps.receipt = async (project) => { if (project.id === "no-receipt") throw Error("missing"); return receipt(); };
  const d = await h.directory.read();
  assert.deepEqual(d.products.map((x) => x.id), ["launch", "no-receipt", "no-script"]);
  assert.equal(d.products.find((x) => x.id === "no-receipt")?.launch?.state, "unknown");
  assert.equal(d.products.find((x) => x.id === "no-receipt")?.destination, undefined);
  assert.equal(d.products.find((x) => x.id === "no-script")?.launch?.state, "unknown");
  assert.ok(!JSON.stringify(d).includes("repoPath"));
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

test("malformed registry identity makes the actual GET down without replacing dated last-good", async () => {
  const original = globalThis.fetch;
  let now = 1_800_000_000_000;
  let registry: unknown = { projects: { example: { repo_path: "/registered", project_id: "example" } } };
  globalThis.fetch = async () => new Response(JSON.stringify(registry));
  const deps = setup().deps;
  deps.now = () => now;
  deps.declaration = async () => ({ raw: "mode: launch\n", commit: "a".repeat(40) });
  deps.projects = getRegisteredProjects;
  const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
  const get = async () => {
    const response = await app.inject({ method: "GET", url: "/api/modules/products" });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  try {
    const good = await get();
    assert.equal(good.registry.state, "ok"); assert.deepEqual(good.products.map((x: { id: string }) => x.id), ["example"]);
    for (const badId of [42, {}, [], false, ""]) {
      registry = { projects: { example: { repo_path: "/registered", project_id: badId } } };
      assert.ok((await getRegisteredProjects()).down, JSON.stringify(badId));
      const first = Fastify(); registerProductsRoutes(first, createProductsDirectory(deps));
      try {
        const response = await first.inject({ method: "GET", url: "/api/modules/products" });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().registry.state, "down");
        assert.equal(response.json().registry.snapshotAt, undefined);
        assert.deepEqual(response.json().products, []);
      } finally { await first.close(); }
      now += 6000;
      const stale = await get();
      assert.equal(stale.registry.state, "down"); assert.equal(stale.registry.snapshotAt, good.registry.snapshotAt);
      assert.equal(stale.registry.ageSeconds, (now - 1_800_000_000_000) / 1000);
      assert.deepEqual(stale.products.map((x: { id: string }) => x.id), ["example"]);
    }
    registry = { projects: {} }; now += 6000;
    const empty = await get(); assert.equal(empty.registry.state, "ok"); assert.deepEqual(empty.products, []);
    assert.notEqual(empty.registry.snapshotAt, good.registry.snapshotAt);
    registry = { projects: { example: { repo_path: "/registered", project_id: "example" } } }; now += 6000;
    assert.deepEqual((await get()).products.map((x: { id: string }) => x.id), ["example"]);
  } finally { globalThis.fetch = original; await app.close(); }
});

test("actual GET isolates non-string committed YAML modes from a valid neighbor", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR!, "holoc57-mode-route-"));
  const original = globalThis.fetch;
  const repo = join(root, "invalid"); const neighbor = join(root, "neighbor");
  const gitAt = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    for (const path of [repo, neighbor]) {
      await mkdir(path);
      gitAt(path, "init"); gitAt(path, "config", "user.email", "fixture@example.invalid"); gitAt(path, "config", "user.name", "Fixture");
      await writeFile(join(path, ".launch.yaml"), "mode: launch\n");
      gitAt(path, "add", ".launch.yaml"); gitAt(path, "commit", "-m", "fixture");
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ projects: {
      invalid: { repo_path: repo, project_id: "invalid" }, neighbor: { repo_path: neighbor, project_id: "neighbor" }
    } }));
    for (const raw of ["mode: [launch]\n", "mode: [steady]\n", "mode: [live]\n", "mode: {toString: launch}\n", "mode: null\n", "mode: 123\n", "mode: true\n", "mode: {value: live}\n", "mode: ''\n"]) {
      await writeFile(join(repo, ".launch.yaml"), raw);
      gitAt(repo, "add", ".launch.yaml"); gitAt(repo, "commit", "-m", "invalid mode");
      const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
      try {
        const response = await app.inject({ method: "GET", url: "/api/modules/products" });
        assert.equal(response.statusCode, 200, raw);
        const body = response.json();
        assert.equal(body.registry.state, "ok");
        assert.deepEqual(body.products.map((x: { id: string }) => x.id), ["neighbor"], raw);
        assert.deepEqual(body.issues.map((x: { id: string; state: string }) => [x.id, x.state]), [["invalid", "invalid"]], raw);
        assert.ok(!response.body.includes('"href":"/live"'));
      } finally { await app.close(); }
    }
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test("replacement refs cannot alter the committed declaration or its GET provenance", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR!, "holoc57-replacement-"));
  const original = globalThis.fetch;
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    await writeFile(join(repo, ".launch.yaml"), "mode: launch\n"); git("add", ".launch.yaml"); git("commit", "-m", "original launch");
    const originalCommit = git("rev-parse", "HEAD");
    await writeFile(join(repo, ".launch.yaml"), "mode: live\n"); git("add", ".launch.yaml");
    const tree = git("write-tree"); const replacement = git("commit-tree", tree, "-m", "replacement live");
    git("replace", originalCommit, replacement);
    assert.equal(git("rev-parse", "HEAD"), originalCommit);
    assert.equal(git("show", `${originalCommit}:.launch.yaml`), "mode: live");
    globalThis.fetch = async () => new Response(JSON.stringify({ projects: { example: { repo_path: repo, project_id: "example" } } }));
    const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
    try {
      const response = await app.inject({ method: "GET", url: "/api/modules/products" });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.products[0].stage, "launch");
      assert.equal(body.products[0].declaration.commit, originalCommit);
      assert.equal((await committedDeclaration({ ...p("example"), repoPath: repo })).raw, "mode: launch");
      assert.equal(execFileSync("git", ["--no-replace-objects", "-C", repo, "show", `${originalCommit}:.launch.yaml`], { encoding: "utf8" }).trim(), "mode: launch");
    } finally { await app.close(); }
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
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
test("actual GET never reports zero for absent coverage or malformed completion evidence", async () => {
  const now = Date.parse("2026-11-23T00:00:00Z");
  const at = "2026-11-22T20:00:00Z";
  const item = { id: "action", status: "open", verified_at: at };
  const gate = { status: "owner", item: "action", verified_at: at };
  const base = { ...receipt(), items: [item], requirements: { x: gate } };
  const cases: [string, unknown][] = [
    ["both collections empty", { ...base, items: [], requirements: {} }],
    ["missing requirements", { ...base, requirements: {} }],
    ["missing items", { ...base, items: [] }],
    ["identity-less done and evidence-free met", { ...base, items: [{ status: "done", verified_at: at }], requirements: { x: { status: "met", verified_at: at } } }],
    ["duplicate item ids", { ...base, items: [item, item] }],
    ["malformed item id", { ...base, items: [{ ...item, id: "bad id" }] }],
    ["done without evidence", { ...base, items: [{ id: "action", status: "done", verified_at: at }], requirements: { x: gate } }],
    ["met without evidence", { ...base, requirements: { x: { status: "met", verified_at: at } } }],
    ["owner orphan item", { ...base, requirements: { x: { ...gate, item: "missing" } } }],
    ["agent missing ticket ref", { ...base, requirements: { x: { status: "agent", verified_at: at } } }],
    ["n/a missing reason", { ...base, requirements: { x: { status: "na", verified_at: at } } }],
    ["impossible February 30", { ...base, items: [{ ...item, verified_at: "2026-02-30T20:00:00Z" }], requirements: { x: { ...gate, verified_at: "2026-02-30T20:00:00Z" } } }],
    ["zone-less observation", { ...base, items: [{ ...item, verified_at: "2026-11-22T20:00:00" }], requirements: { x: { ...gate, verified_at: "2026-11-22T20:00:00" } } }],
  ];
  for (const [label, body] of cases) {
    const deps = setup().deps; deps.now = () => now; deps.receipt = async () => body;
    const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
    try {
      const r = await app.inject({ method: "GET", url: "/api/modules/products" });
      assert.equal(r.statusCode, 200, label); assert.equal(r.headers["cache-control"], "no-store");
      const launch = r.json().products[0].launch;
      assert.equal(launch.state, "unknown", label);
      assert.equal(launch.openActions, undefined, label); assert.equal(launch.ownerBlockers, undefined, label);
      assert.equal(launch.observedAt, undefined, label);
      assert.equal(r.json().products[0].destination.href, receipt().published.url, label);
    } finally { await app.close(); }
  }
  const complete = { ...base, items: [{ id: "action", status: "done", evidence: "https://example.invalid/receipt", verified_at: at }], requirements: { x: { status: "met", evidence: "https://example.invalid/gate", verified_at: "2026-11-22T15:00:00-05:00" } } };
  const deps = setup().deps; deps.now = () => now; deps.receipt = async () => complete;
  const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
  try {
    const r = await app.inject({ method: "GET", url: "/api/modules/products" });
    assert.equal(r.statusCode, 200);
    const launch = r.json().products[0].launch;
    assert.equal(launch.state, "attention"); assert.equal(launch.openActions, 0); assert.equal(launch.ownerBlockers, 0);
    assert.equal(launch.observedAt, "2026-11-22T20:00:00.000Z");
  } finally { await app.close(); }
});

test("actual GET treats zone-less timestamps identically across process timezones", async () => {
  const stamp = "2026-11-15T21:00:00";
  const deps = setup().deps;
  deps.now = () => Date.parse("2026-11-23T00:00:00Z");
  deps.receipt = async () => ({ ...receipt(), items: [{ id: "action", status: "open", verified_at: stamp }], requirements: { x: { status: "owner", item: "action", verified_at: stamp } } });
  const app = Fastify(); registerProductsRoutes(app, createProductsDirectory(deps));
  try {
    const r = await app.inject({ method: "GET", url: "/api/modules/products" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().products[0].launch.state, "unknown");
    assert.equal(r.json().products[0].launch.observedAt, undefined);
  } finally { await app.close(); }
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

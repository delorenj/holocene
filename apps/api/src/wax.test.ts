import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectPass, readWaxCatalog, resetWaxCatalogCache } from "./wax.js";

// The Wax tab reads one thing — `wax catalog --json` — through the API module.
// These tests pin the three safety properties the spec names: an allowlist
// projection (env/command/body keys can never pass through), a DOWN source on
// CLI failure (never healthy emptiness), and a bounded read cache.

const T0 = 1_700_000_000_000;

async function fakeWax(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "holocene-wax-"));
  const executable = join(dir, "fake-wax");
  await writeFile(executable, `#!${process.execPath}\n${script}\n`);
  await chmod(executable, 0o700);
  return executable;
}

const CATALOG = {
  generated_at: "2026-10-16T12:00:00Z",
  passes: {
    generated_at: "2026-10-16T12:00:00Z",
    passes: [
      {
        slug: "title-slug", description: "Title a transcript.", version: 2, enabled: true, auto: true,
        kind: "enrichment", capabilities: ["audio", "document"], requires: [], after: ["frontmatter-stamp"],
        emits: [], timeout_s: 60, conditions: null,
        availability: { state: "available", reason: "" },
        outcomes: { completed: 410, failed: 2, skipped: 1, running: 0, exhausted: 0, stale: 3 }
      },
      {
        slug: "diarization", enabled: false, auto: false,
        // Keys the catalog must never have leaked — the projection drops them anyway.
        env: { OPENAI_API_KEY: "sk-leak" }, command: ["python3", "-c", "print('boom')"], stderr: "raw noise",
        availability: { state: "disabled", reason: "enabled: false in its registry yaml" }
      }
    ],
    counts: { registered: 2, enabled: 1, automatic: 1, quarantined: 0, failing: 1 }
  },
  pipelines: {
    generated_at: "2026-10-16T12:00:00Z",
    pipelines: [
      {
        name: "doc-standard", trigger: "documents", enabled: false, failure_policy: "independent",
        definition_id: "abc123def456", executed_by: "wax pipeline run/scan",
        drift: { state: "authored-not-compiled", detail: "never compiled" },
        nodes: [{ slug: "title-slug", availability: { state: "available", reason: "" }, capabilities: ["document"], applicable: true }],
        edges: [{ from: "frontmatter-stamp", to: "title-slug", kind: "after" }],
        bindings: [{ binding_id: "b1", folder: "/srv/docs", enabled: false, folder_exists: false }],
        documents_processed: 0, outcomes: { "title-slug": { completed: 0 } },
        env: { SECRET: "nope" }
      }
    ],
    document_status: { bindings: [], documents_total: 0 }
  }
};

test("projection keeps the catalog fields and drops env/command/stderr keys", () => {
  const pass = projectPass(CATALOG.passes.passes[1]);
  assert.equal(pass?.slug, "diarization");
  assert.equal("env" in (pass as object), false);
  const healthy = projectPass(CATALOG.passes.passes[0]);
  assert.equal("command" in (healthy as object), false);
  assert.equal("stderr" in (healthy as object), false);
  assert.equal(healthy?.availability.state, "available");
  assert.deepEqual(healthy?.after, ["frontmatter-stamp"]);
});

test("a healthy CLI read returns the catalog with a live source", async (t) => {
  t.after(resetWaxCatalogCache);
  const executable = await fakeWax(`console.log(JSON.stringify(${JSON.stringify(CATALOG)}));`);
  const payload = await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.down, undefined);
  assert.equal(payload.source.value, "live");
  assert.equal(payload.catalog.passes?.length, 2);
  assert.equal(payload.catalog.pipelines?.[0].name, "doc-standard");
  assert.equal("env" in (payload.catalog.pipelines?.[0] as object), false);
  assert.equal(payload.catalog.pipelines?.[0].nodes?.[0].applicable, true);
});

test("a CLI failure is a DOWN source, never healthy emptiness", async (t) => {
  t.after(resetWaxCatalogCache);
  const executable = await fakeWax(`console.error('waxd lock held'); process.exit(2);`);
  const payload = await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.down, true);
  assert.match(payload.source.detail ?? "", /waxd lock held|failed/u);
  assert.deepEqual(payload.catalog, { passes: [], pipelines: [] });
});

test("a CLI failure after a good read keeps the last snapshot, labeled stale", async (t) => {
  t.after(resetWaxCatalogCache);
  const good = await fakeWax(`console.log(JSON.stringify(${JSON.stringify(CATALOG)}));`);
  await readWaxCatalog({ executable: good, root: "/srv/heyma", now: T0 });
  const bad = await fakeWax(`process.exit(1);`);
  const payload = await readWaxCatalog({ executable: bad, root: "/srv/heyma", now: T0 + 60_000 });
  assert.equal(payload.catalog.passes?.length, 2);
  assert.equal(payload.source.down, true);
  assert.equal(payload.source.value, "stale");
  assert.match(payload.source.detail ?? "", /last good read/u);
});

test("a non-object snapshot is a failure, not an empty catalog", async (t) => {
  t.after(resetWaxCatalogCache);
  const executable = await fakeWax("console.log('[1,2,3]');");
  const payload = await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.down, true);
  assert.deepEqual(payload.catalog, { passes: [], pipelines: [] });
});

test("reads inside the TTL hit the cache and do not re-run the CLI", async (t) => {
  t.after(resetWaxCatalogCache);
  const dir = await mkdtemp(join(tmpdir(), "holocene-wax-count-"));
  t.after(async () => rm(dir, { force: true, recursive: true }));
  const executable = join(dir, "fake-wax");
  const counter = join(dir, "count");
  await writeFile(
    executable,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(counter)}, 'x');
console.log(JSON.stringify(${JSON.stringify(CATALOG)}));`
  );
  await chmod(executable, 0o700);
  await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 });
  await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 + 2_000 });
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(counter, "utf8")).length, 1);
  const later = await readWaxCatalog({ executable, root: "/srv/heyma", now: T0 + 10_000 });
  assert.equal((await readFile(counter, "utf8")).length, 2);
  assert.equal(later.source.down, undefined);
});

// AC4: no /hq code may define its own envelope dialect. Any file under
// apps/web/app/hq, or any apps/api/src file that is about hq/delohq, that
// declares envelope fields or an *Envelope / *Projection type must import
// them from @holocene/delohq-contracts. Also pins that today's route payloads
// are rejected by the validator, so nobody can pass them off as envelopes.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateProjectionEnvelope } from "./index.js";

// dist-test/<file>.js -> packages/delohq-contracts -> holocene root
const here = dirname(fileURLToPath(import.meta.url));
const holoceneRoot = resolve(here, "..", "..", "..");
const HQ_WEB_DIR = join(holoceneRoot, "apps", "web", "app", "hq");
const API_SRC_DIR = join(holoceneRoot, "apps", "api", "src");

const SOURCE_FILE = /\.(ts|tsx)$/;
const HQ_MENTION = /\b(delo)?hq\b/i;
const IMPORTS_CONTRACTS = /from\s+["']@holocene\/delohq-contracts["']|import\s*\(\s*["']@holocene\/delohq-contracts["']\s*\)/;
const LOCAL_TYPE = /\b(?:type|interface)\s+(\w*(?:Envelope|Projection))\b/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_FILE.test(name)) out.push(full);
  }
  return out;
}

// Returns why a file defines a local dialect, or null when it is clean.
export function findDialectViolation(content: string): string | null {
  if (IMPORTS_CONTRACTS.test(content)) return null;
  if (/\bschema_version\b/.test(content)) return "declares schema_version";
  if (/\bgenerated_at\b/.test(content) && /\bobserved_at\b/.test(content)) return "declares generated_at + observed_at";
  const type = LOCAL_TYPE.exec(content);
  if (type) return `declares local type ${type[1]}`;
  return null;
}

function guardedFiles(): string[] {
  const web = walk(HQ_WEB_DIR);
  const api = walk(API_SRC_DIR).filter((file) => {
    const rel = relative(API_SRC_DIR, file);
    return HQ_MENTION.test(rel) || HQ_MENTION.test(readFileSync(file, "utf8"));
  });
  return [...web, ...api];
}

test("detector flags local envelope dialects", () => {
  assert.match(findDialectViolation(`return { schema_version: "1", data };`) ?? "", /schema_version/);
  assert.match(findDialectViolation(`const e = { generated_at: a, observed_at: b };`) ?? "", /generated_at/);
  assert.match(findDialectViolation(`export interface HqEnvelope<T> { data: T }`) ?? "", /HqEnvelope/);
  assert.match(findDialectViolation(`type CompanyProjection = { x: 1 }`) ?? "", /CompanyProjection/);
  assert.equal(findDialectViolation(`import { okProjection } from "@holocene/delohq-contracts";\nconst x = { schema_version };`), null);
  assert.equal(findDialectViolation(`const generated_at = 1;`), null);
});

test("the guard actually sees the /hq tree", () => {
  const files = guardedFiles().map((f) => relative(holoceneRoot, f));
  assert.ok(files.some((f) => f.endsWith(join("app", "hq", "hq-client.tsx"))), `hq-client.tsx not scanned: ${files.join(", ")}`);
  assert.ok(files.some((f) => f.includes(join("app", "hq", "api"))), "hq api routes not scanned");
  assert.ok(!files.some((f) => f.endsWith("hook-hub.test.ts")), "hook-hub is not DeloHQ and must not be scanned");
});

test("no /hq file defines a local envelope dialect", () => {
  const violations = guardedFiles()
    .map((file) => ({ file: relative(holoceneRoot, file), why: findDialectViolation(readFileSync(file, "utf8")) }))
    .filter((v) => v.why !== null);
  assert.deepEqual(
    violations,
    [],
    `local DeloHQ envelope dialects found (import from @holocene/delohq-contracts instead):\n${violations
      .map((v) => `  ${v.file}: ${v.why}`)
      .join("\n")}`
  );
});

// Payloads copied from apps/web/app/hq/api/{snapshot,org-tree,action}/route.ts
// and the raw org-tree body the org-tree route relays.
const LEGACY_FIXTURES: Record<string, unknown> = {
  not_configured: {
    ok: false,
    error: "not_configured",
    message: "TELEGRAM_HQ_BOT_TOKEN is not set on the server yet. Create @DeloHQBot and set the token."
  },
  unauthorized: { ok: false, error: "unauthorized", reason: "hash mismatch" },
  upstream_unreachable: { ok: false, error: "upstream_unreachable", message: "fetch failed" },
  bad_request: { ok: false, error: "bad_request", message: "Body must be JSON." },
  forbidden_path: { ok: false, error: "forbidden_path", message: "path must start with /api/modules/hermes-fleet/" },
  raw_org_tree: {
    generatedAt: "2026-09-27T12:00:00Z",
    source: "/home/delorenj/.hermes/org.yaml",
    company: { name: "DeLoNET" },
    root: { id: "ceo", children: [] },
    unmapped: [],
    totals: { agents: 0, working: 0, idle: 0, needsAttention: 0, unknown: 0 }
  }
};

for (const [name, fixture] of Object.entries(LEGACY_FIXTURES)) {
  test(`legacy route payload "${name}" is rejected`, () => {
    const result = validateProjectionEnvelope(fixture);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => /unknown field/.test(i)), result.issues.join("\n"));
      assert.ok(result.issues.some((i) => /missing required field "schema_version"/.test(i)));
    }
  });
}

// AC4: no /hq code may define its own browser-facing contract dialect.
//
// Scans every source file under apps/web/app/hq, plus any apps/api/src file
// whose path or content is about hq/delohq, and flags:
//   schema_version               a schema_version key or identifier (constructors
//                                stamp it; consumers never write it)
//   local-envelope-type          a local type/interface named *Envelope/*Projection
//   camel-envelope-fields        generatedAt + observedAt together
//   snake-envelope-fields        generated_at + observed_at in a file that does
//                                not import @holocene/delohq-contracts
//   legacy-ok-dialect            an object or type literal with an `ok` key plus
//                                an `error` or `status` key
//   non-registry-payload-import  (web /hq only) any (type) import from
//                                @holocene/org-model or @holocene/modules-hermes-fleet
// Importing the contract package never exempts a whole file.
//
// Files that violate today are pinned in LEGACY_DIALECT_ALLOWLIST. The list
// can only shrink: a new violation, a new reason on a listed file, or a listed
// reason that no longer occurs all fail the test.

import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateProjectionEnvelope } from "./index.js";

// dist-test/<file>.js -> packages/delohq-contracts -> holocene root
const here = dirname(fileURLToPath(import.meta.url));
const holoceneRoot = resolve(here, "..", "..", "..");
const HQ_WEB_DIR = join(holoceneRoot, "apps", "web", "app", "hq");
const API_SRC_DIR = join(holoceneRoot, "apps", "api", "src");

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// (delo)?hq, any case, not followed by a lowercase letter: matches `hq/`,
// `HQ_`, `deloHqProjection`, `hqClient`; not `hqs`-style words.
const HQ_MENTION = /(?:[Dd][Ee][Ll][Oo])?[Hh][Qq](?![a-z])/;

export const DIALECT_REASONS = [
  "schema_version",
  "local-envelope-type",
  "camel-envelope-fields",
  "snake-envelope-fields",
  "legacy-ok-dialect",
  "non-registry-payload-import"
] as const;

export type DialectReason = (typeof DIALECT_REASONS)[number];

// Holocene-root-relative, POSIX separators. Story 1.2 moves the routes onto
// envelopes; Story 1.3 moves hq-client onto the Company projection. Remove an
// entry (or a reason) as soon as it stops violating.
const LEGACY_DIALECT_ALLOWLIST: Readonly<Record<string, readonly DialectReason[]>> = {
  "apps/web/app/hq/api/action/route.ts": ["legacy-ok-dialect"],
  "apps/web/app/hq/api/org-tree/route.ts": ["legacy-ok-dialect"],
  "apps/web/app/hq/api/snapshot/route.ts": ["legacy-ok-dialect"],
  "apps/web/app/hq/hq-client.tsx": ["legacy-ok-dialect", "non-registry-payload-import"]
};

// ---- lexing ----------------------------------------------------------------

interface Lexed {
  // Comments removed, strings verbatim. Used for import detection.
  code: string;
  // Comments removed; a string becomes "<content>" when its content is a bare
  // identifier (so quoted keys survive) and "" otherwise. Braces inside
  // strings, templates, and regex literals are gone, so brace matching is safe.
  shape: string;
}

// No "<": in JSX, `</p>` must not start a regex literal.
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%>~^]$|(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

export interface LexOptions {
  // .tsx/.jsx: an apostrophe between two word characters is JSX text
  // (`don't`), not the start of a string.
  jsx?: boolean;
}

export function lex(source: string, options: LexOptions = {}): Lexed {
  let code = "";
  let shape = "";
  let i = 0;
  const n = source.length;
  const emitString = (raw: string, content: string) => {
    code += raw;
    shape += /^[A-Za-z_$][\w$]*$/.test(content) ? `"${content}"` : '""';
  };
  // Skips a quoted string starting at `start`; returns the index after it.
  const skipQuoted = (start: number, quote: string): number => {
    let j = start + 1;
    while (j < n && source[j] !== quote) {
      if (source[j] === "\\") j++;
      else if (source[j] === "\n") break;
      j++;
    }
    return Math.min(j + 1, n);
  };
  // Skips a template literal, including nested ${...} with strings/templates.
  const skipTemplate = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return j + 1;
      if (c === "$" && source[j + 1] === "{") {
        let depth = 1;
        j += 2;
        while (j < n && depth > 0) {
          const d = source[j];
          if (d === "{") depth++;
          else if (d === "}") depth--;
          else if (d === '"' || d === "'") {
            j = skipQuoted(j, d);
            continue;
          } else if (d === "`") {
            j = skipTemplate(j);
            continue;
          }
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      code += " ";
      shape += " ";
      continue;
    }
    if (c === "'" && options.jsx && /\w/.test(source[i - 1] ?? "") && /\w/.test(next ?? "")) {
      code += c;
      shape += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(i, c);
      emitString(source.slice(i, end), source.slice(i + 1, end - 1));
      i = end;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(i);
      code += source.slice(i, end);
      shape += '""';
      i = end;
      continue;
    }
    if (c === "/" && REGEX_PRECEDER.test(code.trimEnd())) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        const d = source[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(source[j])) j++;
      code += source.slice(i, j);
      shape += "/re/";
      i = j;
      continue;
    }
    code += c;
    shape += c;
    i++;
  }
  return { code, shape };
}

// ---- object / type literal keys -------------------------------------------

export interface BraceLiteral {
  // Byte offset of "{" within the shape text.
  start: number;
  keys: Map<string, string>;
  // True when the literal is the body of an `interface` or a `type X =`.
  typeLiteral: boolean;
}

// Splits a brace body on top-level `,` / `;` and returns each segment's key
// and raw value (shorthand keys map to their own name).
function topLevelKeys(body: string): Map<string, string> {
  const keys = new Map<string, string>();
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of body) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth === 0 && (c === "," || c === ";")) {
      segments.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  segments.push(current);
  for (const raw of segments) {
    const segment = raw.trim().replace(/^readonly\s+/, "");
    const keyed = /^"?([A-Za-z_$][\w$]*)"?\s*\??\s*:(?!:)([\s\S]*)$/.exec(segment);
    if (keyed) {
      keys.set(keyed[1], keyed[2].trim());
      continue;
    }
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(segment);
    if (shorthand) keys.set(shorthand[1], shorthand[1]);
  }
  return keys;
}

const INTERFACE_HEAD = /\binterface\s+[\w$]+(?:\s*<[^{]*>)?(?:\s+extends\s+[^{]+)?\s*$/;
const TYPE_ALIAS_HEAD = /\btype\s+[\w$]+(?:\s*<[^=]*>)?\s*=[^;={}]*$/;

function isTypeLiteralContext(before: string): boolean {
  const tail = before.slice(-300);
  return INTERFACE_HEAD.test(tail) || TYPE_ALIAS_HEAD.test(tail);
}

export function braceLiterals(shape: string): BraceLiteral[] {
  const out: BraceLiteral[] = [];
  const stack: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] === "{") stack.push(i);
    else if (shape[i] === "}") {
      const start = stack.pop();
      if (start === undefined) continue;
      out.push({ start, keys: topLevelKeys(shape.slice(start + 1, i)), typeLiteral: isTypeLiteralContext(shape.slice(0, start)) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function isLegacyOkLiteral(keys: Map<string, string>): boolean {
  return keys.has("ok") && (keys.has("error") || keys.has("status"));
}

// ---- detector --------------------------------------------------------------

const IMPORTS_CONTRACTS = /from\s+["']@holocene\/delohq-contracts["']|import\s*\(\s*["']@holocene\/delohq-contracts["']\s*\)/;
const LOCAL_TYPE = /\b(?:type|interface)\s+(\w*(?:Envelope|Projection))\b/;
const NON_REGISTRY_PKG = String.raw`@holocene\/(?:org-model|modules-hermes-fleet)`;
// Any import form counts: `import type`, `import { type X }`, and a plain
// `import { X }` of an interface are all the same payload type to TS, and
// `import("...")` covers type queries.
const NON_REGISTRY_TYPE_IMPORT = new RegExp(
  [
    String.raw`\b(?:import|export)\b[^;]*?\bfrom\s*["']${NON_REGISTRY_PKG}["']`,
    String.raw`\bimport\s*\(\s*["']${NON_REGISTRY_PKG}["']\s*\)`
  ].join("|")
);

export interface DialectViolation {
  reason: DialectReason;
  detail: string;
}

export interface DetectOptions extends LexOptions {
  // Web /hq files may not take browser payload types from other packages.
  browserSurface?: boolean;
}

export function findDialectViolations(content: string, options: DetectOptions = {}): DialectViolation[] {
  const { code, shape } = lex(content, options);
  const literals = braceLiterals(shape);
  const found: DialectViolation[] = [];
  if (/\bschema_version\b/.test(shape)) {
    found.push({ reason: "schema_version", detail: "writes schema_version (constructors stamp it)" });
  }
  const type = LOCAL_TYPE.exec(shape);
  if (type) found.push({ reason: "local-envelope-type", detail: `declares local type ${type[1]}` });
  if (/\bgeneratedAt\b/.test(shape) && /\bobservedAt\b/.test(shape)) {
    found.push({ reason: "camel-envelope-fields", detail: "declares generatedAt + observedAt" });
  }
  // A local type carrying both fields is a local envelope whatever the file
  // imports; an object literal (a constructor argument) is fine when the
  // contract is imported.
  const localType = literals.find((l) => l.typeLiteral && l.keys.has("generated_at") && l.keys.has("observed_at"));
  if (localType) {
    found.push({ reason: "snake-envelope-fields", detail: "declares a local type with generated_at + observed_at" });
  } else if (!IMPORTS_CONTRACTS.test(code) && /\bgenerated_at\b/.test(shape) && /\bobserved_at\b/.test(shape)) {
    found.push({ reason: "snake-envelope-fields", detail: "declares generated_at + observed_at without importing the contract" });
  }
  const legacy = literals.filter((literal) => isLegacyOkLiteral(literal.keys));
  if (legacy.length > 0) {
    const shapes = [...new Set(legacy.map((l) => `{ ${[...l.keys.keys()].join(", ")} }`))];
    found.push({ reason: "legacy-ok-dialect", detail: `legacy { ok, error|status } literal: ${shapes.join(" | ")}` });
  }
  if (options.browserSurface) {
    const imported = NON_REGISTRY_TYPE_IMPORT.exec(code);
    if (imported) {
      found.push({ reason: "non-registry-payload-import", detail: `browser payload type from a non-registry package: ${imported[0].replace(/\s+/g, " ")}` });
    }
  }
  return found;
}

// ---- file discovery ----------------------------------------------------------

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
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walk(full));
    else if (stat.isFile() && SOURCE_FILE.test(name)) out.push(full);
  }
  return out;
}

interface GuardedFile {
  path: string;
  rel: string;
  browserSurface: boolean;
}

function toRel(file: string): string {
  return relative(holoceneRoot, file).split(sep).join("/");
}

// Pure: is this apps/api/src file (path relative to apps/api/src) DeloHQ code?
export function isGuardedApiFile(relPath: string, content: string): boolean {
  return HQ_MENTION.test(relPath) || HQ_MENTION.test(content) || IMPORTS_CONTRACTS.test(content);
}

const JSX_FILE = /\.(tsx|jsx)$/;

function guardedFiles(): GuardedFile[] {
  const web = walk(HQ_WEB_DIR).map((path) => ({ path, rel: toRel(path), browserSurface: true }));
  const api = walk(API_SRC_DIR)
    .filter((file) => isGuardedApiFile(relative(API_SRC_DIR, file).split(sep).join("/"), readFileSync(file, "utf8")))
    .map((path) => ({ path, rel: toRel(path), browserSurface: false }));
  return [...web, ...api];
}

function reasonsOf(content: string, options: DetectOptions): DialectReason[] {
  return findDialectViolations(content, options).map((v) => v.reason);
}

// ---- detector unit tests ------------------------------------------------------

test("detector flags every dialect reason", () => {
  const cases: Array<[string, DialectReason, DetectOptions?]> = [
    [`return { schema_version: "1", data };`, "schema_version"],
    [`const v = body["schema_version"];`, "schema_version"],
    [`export interface HqEnvelope<T> { data: T }`, "local-envelope-type"],
    [`type CompanyProjection = { x: 1 }`, "local-envelope-type"],
    [`const s = { generatedAt: a, observedAt: b };`, "camel-envelope-fields"],
    [`const e = { generated_at: a, observed_at: b };`, "snake-envelope-fields"],
    [`return Response.json({ ok: false, error: "unauthorized", reason: result.reason }, { status: 401 });`, "legacy-ok-dialect"],
    [`type ActionResult = { ok: boolean; status: number; data: any };`, "legacy-ok-dialect"],
    [`return { ok: res.ok, status: res.status, data };`, "legacy-ok-dialect"],
    [`const x = { ok, error };`, "legacy-ok-dialect"],
    [`import type { OrgTree } from "@holocene/org-model";`, "non-registry-payload-import", { browserSurface: true }],
    [`import { useX, type Snapshot } from "@holocene/modules-hermes-fleet";`, "non-registry-payload-import", { browserSurface: true }],
    [`type T = import("@holocene/org-model").OrgNode;`, "non-registry-payload-import", { browserSurface: true }],
    [`import { OrgNode } from "@holocene/org-model";`, "non-registry-payload-import", { browserSurface: true }]
  ];
  for (const [source, reason, options] of cases) {
    assert.ok(reasonsOf(source, options ?? {}).includes(reason), `expected ${reason} for: ${source}`);
  }
});

test("importing the contract package never exempts a file", () => {
  const imports = `import { okProjection } from "@holocene/delohq-contracts";\n`;
  assert.ok(reasonsOf(`${imports}const x = { schema_version };`, {}).includes("schema_version"));
  assert.ok(reasonsOf(`${imports}interface MyEnvelope {}`, {}).includes("local-envelope-type"));
  assert.ok(reasonsOf(`${imports}const a = { generatedAt, observedAt };`, {}).includes("camel-envelope-fields"));
  assert.ok(reasonsOf(`${imports}Response.json({ ok: false, error: "x" });`, {}).includes("legacy-ok-dialect"));
  // snake_case envelope fields are the one thing the import legitimately explains.
  assert.deepEqual(reasonsOf(`${imports}const e = okProjection({ generated_at, observed_at });`, {}), []);
});

test("detector ignores plain guards, comments, strings, and unrelated shapes", () => {
  const clean = [
    `function authorize(): { ok: true } | { ok: false; response: Response } { return { ok: true }; }`,
    `export type VerifyResult = | { ok: true; user: TelegramUser } | { ok: false; reason: string };`,
    `// return { ok: false, error: "x" } and schema_version live in comments only`,
    `/* interface OldEnvelope {} generatedAt observedAt */`,
    "const msg = `{ ok: false, error: ${code} }`;",
    `const msg = "{ ok: false, status: 1 } schema_version";`,
    `if (!res.ok) setErr(r.data?.error || \`HTTP \${r.status}\`);`,
    `const generated_at = 1;`,
    `const re = /{ ok: 1, error: 2 }/; const y = { a: 1 };`
  ];
  for (const source of clean) {
    assert.deepEqual(findDialectViolations(source, { browserSurface: true }), [], source);
  }
  // Without the browser flag (apps/api), org-model type imports are fine.
  assert.deepEqual(reasonsOf(`import type { OrgTree } from "@holocene/org-model";`, {}), []);
});

test("JSX text does not derail the lexer", () => {
  const jsx = { jsx: true };
  const cases = [
    `return <div>don't panic</div>; const r = { ok: false, error };`,
    `const el = <p>it's fine</p>; Response.json({ ok: false, error: "x" });`,
    `const el = <span>a</span>; const r = { ok: false, error };`
  ];
  for (const source of cases) {
    assert.ok(reasonsOf(source, jsx).includes("legacy-ok-dialect"), source);
  }
  const { shape } = lex(`return <div>don't panic</div>; const r = { ok: false, error };`, jsx);
  assert.ok(shape.includes("{ ok: false, error }"), shape);
  // Outside JSX files an apostrophe still opens a string.
  assert.deepEqual(reasonsOf(`const s = 'x { ok: false, error } y';`, {}), []);
});

test("a local snake_case envelope type is flagged even when the package is imported", () => {
  const imports = `import { okProjection } from "@holocene/delohq-contracts";\n`;
  for (const decl of [
    `interface CompanySnapshot { generated_at: string; observed_at: string }`,
    `export interface Snap<T> extends Base { readonly generated_at: string; observed_at: string | null; data: T }`,
    `type Snap = { generated_at: string; observed_at: string };`
  ]) {
    assert.ok(reasonsOf(`${imports}${decl}`, {}).includes("snake-envelope-fields"), decl);
  }
  assert.deepEqual(reasonsOf(`${imports}const e = okProjection({ generated_at: now, observed_at: seen });`, {}), []);
});

test("isGuardedApiFile selects DeloHQ api code only", () => {
  assert.equal(isGuardedApiFile("hq/company.ts", "export const x = 1;"), true);
  assert.equal(isGuardedApiFile("company.ts", `import { okProjection } from "@holocene/delohq-contracts";`), true);
  assert.equal(isGuardedApiFile("company.ts", "export function deloHqProjection() {}"), true);
  assert.equal(isGuardedApiFile("company.ts", "const hqClient = make();"), true);
  assert.equal(isGuardedApiFile("hook-hub.ts", "export const schema_version = 1; // hook hub receipts"), false);
});

// ---- the tree ----------------------------------------------------------------

test("the guard actually sees the /hq tree and only the /hq tree", () => {
  const files = guardedFiles().map((f) => f.rel);
  assert.ok(files.includes("apps/web/app/hq/hq-client.tsx"), `hq-client.tsx not scanned: ${files.join(", ")}`);
  for (const route of ["action", "org-tree", "snapshot"]) {
    assert.ok(files.includes(`apps/web/app/hq/api/${route}/route.ts`), `${route} route not scanned`);
  }
  assert.ok(!files.some((f) => f.endsWith("hook-hub.test.ts")), "hook-hub is not DeloHQ and must not be scanned");
});

test("every allowlist entry names a scanned file and known reasons", () => {
  const scanned = new Set(guardedFiles().map((f) => f.rel));
  for (const [file, reasons] of Object.entries(LEGACY_DIALECT_ALLOWLIST)) {
    assert.ok(scanned.has(file), `allowlisted file ${file} is not scanned (moved or deleted?): remove its LEGACY_DIALECT_ALLOWLIST entry`);
    assert.ok(reasons.length > 0, `allowlist entry ${file} lists no reasons: remove it`);
    for (const reason of reasons) assert.ok((DIALECT_REASONS as readonly string[]).includes(reason), `${file}: unknown reason ${reason}`);
  }
});

test("no /hq file defines a local dialect beyond the shrink-only allowlist", () => {
  const failures: string[] = [];
  for (const file of guardedFiles()) {
    const violations = findDialectViolations(readFileSync(file.path, "utf8"), {
      browserSurface: file.browserSurface,
      jsx: JSX_FILE.test(file.path)
    });
    const allowed = LEGACY_DIALECT_ALLOWLIST[file.rel];
    if (!allowed) {
      for (const v of violations) failures.push(`${file.rel}: ${v.reason} — ${v.detail} (import from @holocene/delohq-contracts instead)`);
      continue;
    }
    const seen = new Set(violations.map((v) => v.reason));
    for (const v of violations) {
      if (!allowed.includes(v.reason)) failures.push(`${file.rel}: new violation ${v.reason} — ${v.detail} (not in its allowlist entry)`);
    }
    if (seen.size === 0) {
      failures.push(`${file.rel}: no longer violates — remove its LEGACY_DIALECT_ALLOWLIST entry`);
    } else {
      for (const reason of allowed) {
        if (!seen.has(reason)) failures.push(`${file.rel}: no longer shows ${reason} — remove that reason from its LEGACY_DIALECT_ALLOWLIST entry`);
      }
    }
  }
  assert.deepEqual(failures, [], `DeloHQ dialect guard:\n  ${failures.join("\n  ")}`);
});

// ---- legacy payloads are rejected by the validator ---------------------------

// Builds a fixture from a literal's keys: bare-identifier strings and booleans
// keep their value, anything else becomes a placeholder string.
function fixtureFrom(keys: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of keys) {
    const str = /^"([\w$]*)"$/.exec(raw);
    if (str) out[key] = str[1] || "<string>";
    else if (raw === "true" || raw === "false") out[key] = raw === "true";
    else out[key] = "<expr>";
  }
  return out;
}

// Reads every `Response.json({ ... })` body out of a route file.
function routeFixtures(file: string): Array<Record<string, unknown>> {
  const { shape } = lex(readFileSync(file, "utf8"));
  const starts = [...shape.matchAll(/Response\.json\(\s*\{/g)].map((m) => (m.index ?? 0) + m[0].length - 1);
  const literals = braceLiterals(shape);
  return starts.map((start) => {
    const literal = literals.find((l) => l.start === start);
    assert.ok(literal, `${file}: could not parse Response.json literal at ${start}`);
    return fixtureFrom(literal.keys);
  });
}

function assertRejectedAsLegacy(name: string, fixture: unknown): void {
  const result = validateProjectionEnvelope(fixture);
  assert.equal(result.ok, false, `${name} validated as an envelope`);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => /unknown field/.test(i)), `${name}: ${result.issues.join("\n")}`);
    assert.ok(result.issues.some((i) => /missing required field "schema_version"/.test(i)), name);
  }
}

// Only routes still allowlisted for the legacy dialect are read. Once a route
// is migrated and its entry removed, it simply drops out of this test.
const LEGACY_ROUTES = Object.entries(LEGACY_DIALECT_ALLOWLIST)
  .filter(([file, reasons]) => /^apps\/web\/app\/hq\/api\/.+\/route\.ts$/.test(file) && reasons.includes("legacy-ok-dialect"))
  .map(([file]) => file);

test("legacy payloads read from the allowlisted /hq routes are rejected", () => {
  for (const rel of LEGACY_ROUTES) {
    const legacy = routeFixtures(join(holoceneRoot, rel)).filter((f) => Object.prototype.hasOwnProperty.call(f, "ok"));
    assert.ok(
      legacy.length > 0,
      `${rel}: no legacy Response.json({ ok, ... }) body left — if the route is migrated, remove its LEGACY_DIALECT_ALLOWLIST entry`
    );
    for (const fixture of legacy) {
      const name = `${rel} ${JSON.stringify(fixture)}`;
      assertRejectedAsLegacy(name, fixture);
      const result = validateProjectionEnvelope(fixture);
      if (!result.ok) assert.ok(result.issues.some((i) => /unknown field "ok"/.test(i)), name);
    }
  }
});

// Hand-copied: the raw org-tree body the org-tree route relays verbatim
// (it is not a Response.json literal, so it cannot be read from the route).
const RELAYED_FIXTURES: Record<string, unknown> = {
  raw_org_tree: {
    generatedAt: "2026-09-27T12:00:00Z",
    source: "/home/delorenj/.hermes/org.yaml",
    company: { name: "DeLoNET" },
    root: { id: "ceo", children: [] },
    unmapped: [],
    totals: { agents: 0, working: 0, idle: 0, needsAttention: 0, unknown: 0 }
  },
  unauthorized: { ok: false, error: "unauthorized", reason: "hash mismatch" }
};

for (const [name, fixture] of Object.entries(RELAYED_FIXTURES)) {
  test(`legacy relayed payload "${name}" is rejected`, () => assertRejectedAsLegacy(name, fixture));
}

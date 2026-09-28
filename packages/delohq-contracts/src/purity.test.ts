// The contract package must stay pure: no IO, clock reads, or env reads
// outside test files. tsconfig.json already builds with `types: []`; this
// catches what the type system cannot (Date.now, argless new Date).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bDate\.now\s*\(/, "Date.now()"],
  [/\bnew Date\s*\(\s*\)/, "new Date()"],
  [/\bperformance\.now\s*\(/, "performance.now()"],
  [/\bprocess\./, "process access"],
  [/\bfetch\s*\(/, "fetch()"],
  [/from\s+["']node:/, "node: import"],
  [/from\s+["'](fs|path|os|child_process|http|https)["']/, "node builtin import"],
  [/\bimport\s*\(/, "dynamic import"]
];

test("src/ has no IO, clock, or env reads outside tests", () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.includes("envelope.ts"));
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(srcDir, file), "utf8");
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(text)) found.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(found, []);
});

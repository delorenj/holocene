import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "./index.js";
import {
  ContractViolationError,
  DELOHQ_CONTRACT_REGISTRY,
  DELOHQ_SCHEMA_VERSION,
  type EvidenceRef,
  type ValidationResult,
  classifyFreshness,
  degradedProjection,
  errorProjection,
  isRegisteredSurface,
  okProjection,
  refKey,
  unknownFreshness,
  unknownProjection,
  validateCanonicalRef,
  validateEvidenceRef,
  validateFreshness,
  validateProjectionEnvelope
} from "./index.js";

const now = "2026-09-27T12:00:00Z";
const observed = "2026-09-27T11:59:00Z";
const policy = { max_age_seconds: 120 };
const source = { system: "flume", adapter: "org.ts" } as const;
const evidence: EvidenceRef = {
  evidence_ref: "flume:snapshot:abc123",
  source,
  observed_at: observed,
  subject: { kind: "employee", id: "momo" }
};

function healthy(): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    surface: "company",
    source,
    generated_at: now,
    observed_at: observed,
    freshness: classifyFreshness(observed, now, policy),
    state: "ok",
    evidence: [evidence],
    error: null,
    data: { departments: [] }
  };
}

function issuesOf(result: ValidationResult<unknown>): string[] {
  assert.equal(result.ok, false, "expected validation to fail");
  return result.ok ? [] : result.issues;
}

function assertIssue(result: ValidationResult<unknown>, pattern: RegExp): void {
  const issues = issuesOf(result);
  assert.ok(issues.some((i) => pattern.test(i)), `no issue matching ${pattern} in:\n  ${issues.join("\n  ")}`);
}

test("package root exports the whole contract surface", () => {
  for (const name of [
    "validateProjectionEnvelope",
    "okProjection",
    "degradedProjection",
    "errorProjection",
    "unknownProjection",
    "validateCanonicalRef",
    "refKey",
    "CANONICAL_REF_KINDS",
    "FRESHNESS_STATES",
    "classifyFreshness",
    "PROJECTION_STATES",
    "ERROR_KINDS",
    "CANONICAL_SYSTEMS",
    "validateEvidenceRef",
    "DELOHQ_CONTRACT_REGISTRY",
    "DELOHQ_SCHEMA_VERSION",
    "isRegisteredSurface"
  ]) {
    assert.ok(name in contracts, `missing export ${name}`);
  }
  assert.equal(DELOHQ_SCHEMA_VERSION, "1.0.0");
});

test("healthy ok projection validates", () => {
  const result = validateProjectionEnvelope(healthy());
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});

for (const field of ["schema_version", "source", "generated_at", "observed_at", "freshness"]) {
  test(`missing ${field} is rejected and named`, () => {
    const env = healthy();
    delete env[field];
    assertIssue(validateProjectionEnvelope(env), new RegExp(`missing required field "${field}"`));
  });
}

test("ok without evidence is rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), evidence: [] }), /ok requires evidence/);
});

test("ok with null data is rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), data: null }), /ok requires non-null data/);
});

test("ok with an error detail is rejected", () => {
  const env = { ...healthy(), error: { kind: "internal", message: "x" } };
  assertIssue(validateProjectionEnvelope(env), /ok must have error null/);
});

test("error projection with source_unavailable validates", () => {
  const env = {
    ...healthy(),
    state: "error",
    error: { kind: "source_unavailable", message: "flume snapshot unreachable" },
    data: null,
    observed_at: null,
    evidence: [],
    freshness: unknownFreshness(policy)
  };
  const result = validateProjectionEnvelope(env);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});

for (const state of ["error", "unknown"]) {
  test(`${state} without error detail is rejected`, () => {
    const env = { ...healthy(), state, error: null, data: null, observed_at: null, freshness: unknownFreshness(policy) };
    assertIssue(validateProjectionEnvelope(env), new RegExp(`${state} requires error detail`));
  });
}

test("unknown projection validates and is never healthy", () => {
  const env = {
    ...healthy(),
    state: "unknown",
    error: { kind: "source_contradictory", message: "registry and runtime disagree" },
    data: null,
    freshness: unknownFreshness(policy)
  };
  const result = validateProjectionEnvelope(env);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
  if (result.ok) {
    assert.notEqual(result.value.state, "ok");
    assert.equal(contracts.hasProjectionData(result.value), false);
  }
});

test("unknown projection claiming fresh is rejected", () => {
  const env = { ...healthy(), state: "unknown", error: { kind: "internal", message: "x" }, data: null };
  assertIssue(validateProjectionEnvelope(env), /unknown projection must have freshness "unknown"/);
});

test("error projection claiming fresh is rejected", () => {
  const env = { ...healthy(), state: "error", error: { kind: "internal", message: "x" }, data: null };
  assertIssue(validateProjectionEnvelope(env), /cannot claim "fresh"/);
});

test("observed_at null while ok is rejected", () => {
  const env = { ...healthy(), observed_at: null, freshness: unknownFreshness(policy) };
  assertIssue(validateProjectionEnvelope(env), /ok requires an observed_at/);
});

test("observed_at null with a known freshness is rejected", () => {
  const env = { ...healthy(), state: "error", error: { kind: "internal", message: "x" }, data: null, observed_at: null, freshness: classifyFreshness("2026-09-27T11:00:00Z", now, policy) };
  assertIssue(validateProjectionEnvelope(env), /must be "unknown" when observed_at is null/);
});

test("wrong major schema_version is rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), schema_version: "2.0.0" }), /unsupported schema_version/);
});

test("compatible minor schema_version is accepted", () => {
  assert.equal(validateProjectionEnvelope({ ...healthy(), schema_version: "1.4.2" }).ok, true);
});

test("unregistered surface is rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), surface: "posture" }), /unregistered surface/);
  assert.equal(isRegisteredSurface("company"), true);
  assert.equal(isRegisteredSurface("toString"), false);
  assert.ok(Object.isFrozen(DELOHQ_CONTRACT_REGISTRY));
});

test("non-UTC timestamps are rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), generated_at: "2026-09-27T12:00:00+00:00" }), /generated_at/);
  assertIssue(validateProjectionEnvelope({ ...healthy(), generated_at: "2026-02-30T12:00:00Z" }), /generated_at/);
});

test("legacy /hq dialect is rejected with unknown keys reported", () => {
  const issues = issuesOf(validateProjectionEnvelope({ ok: false, error: "unauthorized", reason: "hash mismatch" }));
  assert.ok(issues.some((i) => /unknown field "ok"/.test(i)));
  assert.ok(issues.some((i) => /unknown field "reason"/.test(i)));
});

test("extra top-level keys are rejected", () => {
  assertIssue(validateProjectionEnvelope({ ...healthy(), projection_id: "p1" }), /unknown field "projection_id"/);
});

test("validateData runs against ok data and reports under envelope.data", () => {
  const validateData = (d: unknown): ValidationResult<{ departments: unknown[] }> =>
    Array.isArray((d as { departments?: unknown })?.departments)
      ? { ok: true, value: d as { departments: unknown[] } }
      : { ok: false, issues: ["departments: expected array"] };
  assert.equal(validateProjectionEnvelope(healthy(), validateData).ok, true);
  assertIssue(validateProjectionEnvelope({ ...healthy(), data: { nope: 1 } }, validateData), /^envelope\.data\.departments/);
});

test("validators never throw on hostile input", () => {
  for (const bad of [undefined, null, 0, "x", [], () => 1, { evidence: "x", freshness: 3, error: [], source: null }]) {
    assert.doesNotThrow(() => validateProjectionEnvelope(bad));
    assert.doesNotThrow(() => validateCanonicalRef(bad));
    assert.doesNotThrow(() => validateEvidenceRef(bad));
    assert.doesNotThrow(() => validateFreshness(bad));
    assert.equal(validateProjectionEnvelope(bad).ok, false);
  }
});

// ---- refs -------------------------------------------------------------------

test("ref by label or empty id is rejected", () => {
  assert.equal(validateCanonicalRef({ kind: "employee", name: "Momo" }).ok, false);
  assert.equal(validateCanonicalRef({ kind: "employee", id: "" }).ok, false);
  assert.equal(validateCanonicalRef({ kind: "person", id: "x" }).ok, false);
  assert.equal(validateCanonicalRef({ kind: "employee", id: 7 }).ok, false);
  assert.equal(validateCanonicalRef({ kind: "project", id: "p" }, "employee").ok, false);
});

test("opaque id survives a JSON round trip byte-for-byte", () => {
  const id = " Agent-X/01 ";
  const parsed = JSON.parse(JSON.stringify({ kind: "employee", id }));
  const result = validateCanonicalRef(parsed, "employee");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.id, id);
    assert.equal(refKey(result.value), `employee:${id}`);
  }
});

// ---- freshness --------------------------------------------------------------

test("classifyFreshness boundaries", () => {
  const at = (secondsAgo: number) => new Date(Date.parse(now) - secondsAgo * 1000).toISOString();
  assert.equal(classifyFreshness(at(0), now, policy).state, "fresh");
  assert.equal(classifyFreshness(at(120), now, policy).state, "fresh");
  assert.equal(classifyFreshness(at(121), now, policy).state, "stale");
  assert.equal(classifyFreshness(at(240), now, policy).state, "stale");
  assert.equal(classifyFreshness(at(241), now, policy).state, "expired");
  assert.deepEqual(classifyFreshness(at(30), new Date(now), policy), { state: "fresh", max_age_seconds: 120, age_seconds: 30 });
});

test("classifyFreshness yields unknown for null, invalid, and far-future observations", () => {
  const at = (secondsAgo: number) => new Date(Date.parse(now) - secondsAgo * 1000).toISOString();
  for (const observedAt of [null, undefined, "", "yesterday", "2026-09-27T12:00:00+02:00", at(-61)]) {
    const f = classifyFreshness(observedAt, now, policy);
    assert.equal(f.state, "unknown", String(observedAt));
    assert.equal(f.age_seconds, null);
  }
  const skewed = classifyFreshness(at(-60), now, policy);
  assert.deepEqual(skewed, { state: "fresh", max_age_seconds: 120, age_seconds: 0 });
});

test("classifyFreshness rejects an invalid policy", () => {
  assert.throws(() => classifyFreshness(observed, now, { max_age_seconds: 0 }), RangeError);
  assert.throws(() => classifyFreshness(observed, "nope", policy), RangeError);
});

test("validateFreshness rejects a state that contradicts the age", () => {
  assert.equal(validateFreshness({ state: "fresh", max_age_seconds: 60, age_seconds: 500 }).ok, false);
  assert.equal(validateFreshness({ state: "unknown", max_age_seconds: 60, age_seconds: 5 }).ok, false);
  assert.equal(validateFreshness({ state: "stale", max_age_seconds: 60, age_seconds: 100 }).ok, true);
});

// ---- constructors -----------------------------------------------------------

test("constructors produce envelopes that validate", () => {
  const freshness = classifyFreshness(observed, now, policy);
  const base = { surface: "company", source, generated_at: now } as const;
  const built = [
    okProjection({ ...base, observed_at: observed, freshness, evidence: [evidence], data: { departments: [] } }),
    degradedProjection({ ...base, observed_at: observed, freshness, evidence: [evidence], data: { departments: [] }, error: { kind: "source_timeout", message: "hermes runtime slow", retryable: true } }),
    errorProjection({ ...base, freshness: unknownFreshness(policy), error: { kind: "auth_invalid", message: "initData hash mismatch" } }),
    unknownProjection({ ...base, freshness: unknownFreshness(policy), error: { kind: "source_contradictory", message: "two snapshots disagree" } })
  ];
  for (const envelope of built) {
    const result = validateProjectionEnvelope(JSON.parse(JSON.stringify(envelope)));
    assert.equal(result.ok, true, result.ok ? "" : `${envelope.state}: ${result.issues.join("; ")}`);
    assert.equal(envelope.schema_version, "1.0.0");
  }
  assert.equal(built[0].state, "ok");
  assert.equal(built[0].error, null);
});

test("constructors refuse incoherent input", () => {
  assert.throws(
    () => okProjection({ surface: "company", source, generated_at: now, observed_at: observed, freshness: classifyFreshness(observed, now, policy), evidence: [], data: {} }),
    ContractViolationError
  );
});

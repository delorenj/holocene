import assert from "node:assert/strict";
import test from "node:test";
import { missingLifecycleProjection, normalizeLifecycleProjection } from "./index.js";

const lifecycleId = "11111111-1111-4111-8111-111111111111";

test("missing projection is explicit unknown and degraded", () => {
  const value = missingLifecycleProjection(lifecycleId, "2026-07-18T12:00:00Z");
  assert.equal(value.projection_status, "missing");
  assert.equal(value.status, "unknown");
  assert.equal(value.health, "degraded");
  assert.deepEqual(value.legal_frontier, []);
});

test("current projection preserves authoritative render fields", () => {
  const input = projection("current");
  const value = normalizeLifecycleProjection(input, lifecycleId);
  assert.equal(value.state_version, 7);
  assert.equal(value.status, "active");
  assert.equal(value.health, "nominal");
  assert.deepEqual(value.provenance, input.provenance);
  assert.deepEqual(value.freshness, input.freshness);
  assert.deepEqual(value.legal_frontier, input.legal_frontier);
  assert.deepEqual(value.command_verdicts, input.command_verdicts);
});

test("stale projection preserves authority state but degrades display health", () => {
  const input = projection("stale");
  const value = normalizeLifecycleProjection(input, lifecycleId);
  assert.equal(value.projection_status, "stale");
  assert.equal(value.health, "degraded");
  assert.equal(value.authority_state?.health, "nominal");
  assert.equal(value.state_version, 7);
});

test("identity mismatch fails closed", () => {
  const value = normalizeLifecycleProjection(projection("current"), "different");
  assert.equal(value.projection_status, "missing");
  assert.match(value.read_error ?? "", /identity mismatch/);
});

function projection(status: "current" | "stale") {
  return {
    lifecycle_id: lifecycleId,
    repo: "delorenj/33GOD",
    spec_version: 2,
    state_version: 7,
    previous_state_version: 6,
    status: "active",
    health: "nominal",
    phase: "build",
    progress_percent: 50,
    fingerprint: null,
    projection_status: status,
    authority_state: {
      status: "active",
      health: "nominal",
      phase: "build",
      progress_percent: 50,
      fingerprint: null
    },
    legal_frontier: [{ id: "mode:manual", allowed: true }],
    obligations: [],
    blockers: [],
    gates: [],
    capabilities: [],
    provenance: { authority: "delorenj/lifecycle" },
    freshness: { status: status === "current" ? "fresh" : "stale" },
    publication: { event_sequence: 9 },
    source: {
      event_id: "22222222-2222-4222-8222-222222222222",
      event_type: "bloodbank.v1.lifecycle.snapshot.updated",
      event_time: "2026-07-18T12:00:00Z",
      ordering_key: lifecycleId,
      projected_at: "2026-07-18T12:00:01Z"
    },
    command_verdicts: [{ command_id: "command", verdict: "applied" }]
  };
}

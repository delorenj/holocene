import assert from "node:assert/strict";
import test from "node:test";
import {
  missingLifecycleProjection,
  normalizeLifecycleProjection,
  type LifecycleObligation
} from "./index.js";

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
  assert.equal(value.capabilities[0]?.capability_version, 7);
  assert.equal(value.source?.correlation_id, "33333333-3333-4333-8333-333333333333");
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

test("missing canonical capability version degrades the whole projection", () => {
  const input = projection("current");
  delete (input.capabilities[0] as Partial<(typeof input.capabilities)[number]>).capability_version;
  const value = normalizeLifecycleProjection(input, lifecycleId);
  assert.equal(value.projection_status, "missing");
  assert.equal(value.health, "degraded");
  assert.match(value.read_error ?? "", /client fields/);
});

test("non-authority, missing-provenance, and causal-free projections fail closed", () => {
  const mutations: Array<(value: ReturnType<typeof projection>) => void> = [
    (value) => {
      value.source.authority_source = "urn:attacker";
    },
    (value) => {
      value.source.subject = "evil.subject";
    },
    (value) => {
      value.provenance.authority = "attacker";
    },
    (value) => {
      delete (value.source as { causation_id?: string | null }).causation_id;
    },
    (value) => {
      value.source.correlation_id = "not-an-event-id";
    },
    (value) => {
      value.source.actor.instance = "other-authority";
    }
  ];
  for (const mutate of mutations) {
    const input = projection("current");
    mutate(input);
    const normalized = normalizeLifecycleProjection(input, lifecycleId);
    assert.equal(normalized.projection_status, "missing");
    assert.equal(normalized.health, "degraded");
    assert.match(normalized.read_error ?? "", /authority|causal|causation|provenance/);
  }
});

test("obligation occurrence identity and activation are preserved exactly", () => {
  const input = projection("current");
  input.obligations = [
    {
      id: "independent-review",
      obligation_instance_id: "55555555-5555-4555-8555-555555555555",
      activated_at: "2026-07-18T11:55:00Z",
      kind: "independent_review",
      status: "pending",
      description: "Obtain independent review",
      skill_ref: { name: "bmad-code-review", selector: "6.10.2" },
      owner_id: "agent:independent-reviewer",
      due_at: null,
      source_observation_ids: []
    }
  ];
  const normalized = normalizeLifecycleProjection(input, lifecycleId);
  assert.equal(
    normalized.obligations[0]?.obligation_instance_id,
    "55555555-5555-4555-8555-555555555555"
  );
  assert.equal(normalized.obligations[0]?.activated_at, "2026-07-18T11:55:00Z");

  delete (input.obligations[0] as { obligation_instance_id?: string }).obligation_instance_id;
  assert.equal(normalizeLifecycleProjection(input, lifecycleId).projection_status, "missing");
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
    obligations: [] as LifecycleObligation[],
    blockers: [],
    gates: [],
    capabilities: [
      {
        capability_id: "holocene-grant",
        capability_version: 7,
        actor_id: "operator:holocene",
        actions: ["lifecycle.intent.submit"],
        scope: `lifecycle:${lifecycleId}`,
        issued_at: "2026-07-18T11:00:00Z",
        expires_at: null,
        state_version: 7
      }
    ],
    provenance: {
      authority: "delorenj/lifecycle",
      authority_instance: "lifecycle-authority-1"
    },
    freshness: { status: status === "current" ? "fresh" : "stale" },
    publication: { event_sequence: 9 },
    source: {
      event_id: "22222222-2222-4222-8222-222222222222",
      event_type: "bloodbank.v1.lifecycle.snapshot.updated",
      event_time: "2026-07-18T12:00:00Z",
      ordering_key: `lifecycle:${lifecycleId}`,
      projected_at: "2026-07-18T12:00:01Z",
      subject: "bloodbank.evt.v1.lifecycle.snapshot.updated",
      authority_source: "urn:33god:service:lifecycle",
      producer: "delorenj/lifecycle",
      service: "lifecycle",
      kind: "event",
      domain: "lifecycle",
      schema_ref: "bloodbank.v1.lifecycle.snapshot.updated.v3",
      data_schema:
        "apicurio://holyfields/bloodbank.v1.lifecycle.snapshot.updated/versions/3",
      actor: {
        type: "service",
        agent_id: "delorenj.lifecycle",
        instance: "lifecycle-authority-1"
      },
      correlation_id: "33333333-3333-4333-8333-333333333333",
      causation_id: "44444444-4444-4444-8444-444444444444"
    },
    command_verdicts: [{ command_id: "command", verdict: "applied" }]
  };
}

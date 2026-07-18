import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerLifecycleRoutes, type LifecycleDependencies } from "./lifecycle.js";

const lifecycleId = "11111111-1111-4111-8111-111111111111";
const snapshotEventId = "33333333-3333-4333-8333-333333333333";

test("GET renders Candystore fields faithfully and POST queues a complete command", async () => {
  const published: Array<{ subject: string; envelope: Record<string, unknown> }> = [];
  const dependencies = fixtureDependencies(published);
  const app = Fastify();
  registerLifecycleRoutes(app, dependencies);

  const read = await app.inject({ method: "GET", url: `/api/modules/lifecycle/${lifecycleId}` });
  assert.equal(read.statusCode, 200);
  const rendered = read.json();
  assert.equal(rendered.state_version, 7);
  assert.equal(rendered.provenance.authority, "delorenj/lifecycle");
  assert.equal(rendered.freshness.observed_through, "2026-07-18T11:59:00Z");
  assert.equal(rendered.command_verdicts[0].verdict, "stale");

  const action = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload: {
      frontier_id: "transition:planned:active",
      expected_state_version: 7,
      actor: { type: "operator", agent_id: "operator:holocene" },
      capability_id: "holocene-grant",
      capability_version: 1,
      idempotency_key: "holocene:transition:planned:active:state:7",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: snapshotEventId,
      parameters: {}
    }
  });
  assert.equal(action.statusCode, 202);
  assert.equal(action.json().authority_accepted, false);
  assert.equal(published.length, 1);
  const envelope = published[0]!.envelope as any;
  assert.equal(published[0]!.subject, "bloodbank.cmd.v1.lifecycle.intent.submit");
  assert.equal(envelope.data.expected_state_version, 7);
  assert.equal(envelope.data.capability.capability_id, "holocene-grant");
  assert.equal(envelope.data.capability.capability_version, 1);
  assert.equal(envelope.actor.agent_id, "operator:holocene");
  assert.equal(envelope.correlationid, "22222222-2222-4222-8222-222222222222");
  assert.equal(envelope.causationid, snapshotEventId);
  assert.equal(envelope.data.intent.target, "active");

  const after = await app.inject({ method: "GET", url: `/api/modules/lifecycle/${lifecycleId}` });
  assert.deepEqual(after.json(), rendered, "Holocene must not optimistically mutate its read model");
  await app.close();
});

test("stale projection and illegal frontier publish nothing", async () => {
  const published: Array<{ subject: string; envelope: Record<string, unknown> }> = [];
  const dependencies = fixtureDependencies(published, { projection_status: "stale" });
  const app = Fastify();
  registerLifecycleRoutes(app, dependencies);
  const response = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload: {}
  });
  assert.equal(response.statusCode, 409);
  assert.equal(published.length, 0);
  await app.close();
});

test("Candystore outage renders explicit unknown/degraded", async () => {
  const dependencies = fixtureDependencies([]);
  dependencies.fetch = async () => {
    throw new Error("offline");
  };
  const app = Fastify();
  registerLifecycleRoutes(app, dependencies);
  const response = await app.inject({ method: "GET", url: `/api/modules/lifecycle/${lifecycleId}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().projection_status, "missing");
  assert.equal(response.json().status, "unknown");
  assert.equal(response.json().health, "degraded");
  await app.close();
});

function fixtureDependencies(
  published: Array<{ subject: string; envelope: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {}
): LifecycleDependencies {
  const projection = {
    lifecycle_id: lifecycleId,
    repo: "delorenj/33GOD",
    spec_version: 1,
    state_version: 7,
    previous_state_version: 6,
    status: "planned",
    health: "nominal",
    phase: "plan",
    progress_percent: 10,
    fingerprint: null,
    projection_status: "current",
    authority_state: {
      status: "planned",
      health: "nominal",
      phase: "plan",
      progress_percent: 10,
      fingerprint: null
    },
    legal_frontier: [
      {
        id: "transition:planned:active",
        kind: "state_transition",
        action: "transition",
        allowed: true,
        capability_required: "lifecycle.intent.submit",
        reason_code: "LEGAL_TRANSITION",
        expected_state_version: 7
      }
    ],
    obligations: [],
    blockers: [],
    gates: [],
    capabilities: [
      {
        capability_id: "holocene-grant",
        actor_id: "operator:holocene",
        actions: ["lifecycle.intent.submit"],
        scope: `lifecycle:${lifecycleId}`,
        issued_at: "2026-07-18T11:00:00Z",
        expires_at: null,
        state_version: 7
      }
    ],
    provenance: { authority: "delorenj/lifecycle", policy_version: "1.0.0" },
    freshness: {
      status: "fresh",
      observed_through: "2026-07-18T11:59:00Z",
      evaluated_at: "2026-07-18T12:00:00Z",
      as_of: "2026-07-18T12:00:00Z"
    },
    publication: { event_sequence: 14 },
    source: {
      event_id: snapshotEventId,
      event_type: "bloodbank.v1.lifecycle.snapshot.updated",
      event_time: "2026-07-18T12:00:00Z",
      ordering_key: lifecycleId,
      projected_at: "2026-07-18T12:00:01Z"
    },
    command_verdicts: [{ verdict: "stale", reason_code: "EXPECTED_STATE_VERSION_MISMATCH" }],
    ...overrides
  };
  return {
    candystoreUrl: "http://candystore.test",
    fetch: async () => new Response(JSON.stringify(projection), { status: 200 }),
    publisher: {
      async publish(subject, envelope) {
        published.push({ subject, envelope });
      }
    },
    now: () => new Date("2026-07-18T12:00:00Z")
  };
}

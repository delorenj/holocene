import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerLifecycleRoutes, type LifecycleDependencies } from "./lifecycle.js";

const lifecycleId = "11111111-1111-4111-8111-111111111111";
const snapshotEventId = "33333333-3333-4333-8333-333333333333";

test("GET renders authority fields and POST publishes a deterministic complete command", async () => {
  const published: Published[] = [];
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
  assert.equal(rendered.capabilities[0].capability_version, 7);

  const payload = actionPayload();
  const first = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload
  });
  const retry = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload
  });
  assert.equal(first.statusCode, 202);
  assert.equal(retry.statusCode, 202);
  assert.equal(first.json().broker_processed, true);
  assert.equal(first.json().durable_jetstream_acknowledged, false);
  assert.equal(first.json().authority_accepted, false);
  assert.match(first.json().message, /not a durable JetStream acknowledgment/);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], published[0], "identical retries reproduce exact envelopes");

  const envelope = published[0]!.envelope as any;
  assert.equal(published[0]!.subject, "bloodbank.cmd.v1.lifecycle.intent.submit");
  assert.equal(envelope.data.expected_state_version, 7);
  assert.equal(envelope.data.capability.capability_id, "holocene-grant");
  assert.equal(envelope.data.capability.capability_version, 7);
  assert.equal(envelope.actor.agent_id, "operator:holocene");
  assert.equal(envelope.data.intent.target, "active");
  assert.equal(envelope.data.intent.parameters.selected_frontier_id, "transition:planned:active");
  assert.equal(envelope.data.intent.parameters.authority_snapshot_event_id, snapshotEventId);
  assert.equal(envelope.time, "2026-07-18T12:00:00.000Z");

  const after = await app.inject({ method: "GET", url: `/api/modules/lifecycle/${lifecycleId}` });
  assert.deepEqual(after.json(), rendered, "Holocene must not optimistically mutate its read model");
  await app.close();
});

test("allowed=false frontier item publishes nothing", async () => {
  await assertNoPublish(
    (projection) => {
      projection.legal_frontier[0].allowed = false;
    },
    actionPayload(),
    409
  );
});

test("missing frontier item publishes nothing", async () => {
  await assertNoPublish(
    (projection) => {
      projection.legal_frontier = [];
    },
    actionPayload(),
    409
  );
});

test("wrong frontier identity publishes nothing", async () => {
  await assertNoPublish(undefined, { ...actionPayload(), frontier_id: "transition:waiting:active" }, 409);
});

test("request and frontier state-version mismatches publish nothing", async () => {
  await assertNoPublish(
    undefined,
    { ...actionPayload(), expected_state_version: 6 },
    409
  );
  await assertNoPublish(
    (projection) => {
      projection.legal_frontier[0].expected_state_version = 6;
    },
    actionPayload(),
    409
  );
});

test("caller-supplied capability version or identity fields are rejected", async () => {
  for (const forbidden of [
    ["capability_version", 1],
    ["idempotency_key", "manual"],
    ["correlation_id", "22222222-2222-4222-8222-222222222222"],
    ["causation_id", snapshotEventId]
  ] as const) {
    await assertNoPublish(
      undefined,
      { ...actionPayload(), [forbidden[0]]: forbidden[1] },
      400
    );
  }
});

test("missing authoritative capability version degrades and publishes nothing", async () => {
  await assertNoPublish(
    (projection) => {
      delete (projection.capabilities[0] as Partial<
        (typeof projection.capabilities)[number]
      >).capability_version;
    },
    actionPayload(),
    409
  );
});

test("gate resolution without a choice is rejected; explicit resolution is complete", async () => {
  const mutate = (projection: ProjectionFixture) => {
    projection.legal_frontier = [
      {
        id: "gate:approval-1:resolve",
        kind: "gate_resolution",
        action: "resolve_gate",
        allowed: true,
        capability_required: "lifecycle.intent.submit",
        reason_code: "LEGAL_GATE_RESOLUTION",
        expected_state_version: 7
      }
    ];
  };
  const base = {
    ...actionPayload(),
    frontier_id: "gate:approval-1:resolve",
    parameters: {}
  };
  await assertNoPublish(mutate, base, 400);

  const published: Published[] = [];
  const app = Fastify();
  registerLifecycleRoutes(app, fixtureDependencies(published, mutate));
  const response = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload: { ...base, parameters: { resolution: "approved" } }
  });
  assert.equal(response.statusCode, 202);
  assert.equal(published.length, 1);
  const data = (published[0]!.envelope as any).data;
  assert.equal(data.intent.name, "resolve_gate");
  assert.equal(data.intent.target, "approval-1");
  assert.equal(data.intent.parameters.resolution, "approved");
  await app.close();
});

test("material parameter changes produce a different full semantic identity", async () => {
  const published: Published[] = [];
  const app = Fastify();
  registerLifecycleRoutes(app, fixtureDependencies(published));
  for (const parameters of [{ confirmed: true }, { confirmed: false }]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/modules/lifecycle/${lifecycleId}/actions`,
      payload: { ...actionPayload(), parameters }
    });
    assert.equal(response.statusCode, 202);
  }
  const first = published[0]!.envelope as any;
  const second = published[1]!.envelope as any;
  for (const field of ["id", "command_id", "correlationid", "causationid", "idempotency_key"]) {
    assert.notEqual(first[field], second[field]);
  }
  await app.close();
});

test("stale projection publishes nothing", async () => {
  await assertNoPublish(
    (projection) => {
      projection.projection_status = "stale";
    },
    actionPayload(),
    409
  );
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

type Published = { subject: string; envelope: Record<string, unknown> };
type ProjectionFixture = ReturnType<typeof projectionFixture>;

async function assertNoPublish(
  mutate: ((projection: ProjectionFixture) => void) | undefined,
  payload: Record<string, unknown>,
  expectedStatus: number
) {
  const published: Published[] = [];
  const app = Fastify();
  registerLifecycleRoutes(app, fixtureDependencies(published, mutate));
  const response = await app.inject({
    method: "POST",
    url: `/api/modules/lifecycle/${lifecycleId}/actions`,
    payload
  });
  assert.equal(response.statusCode, expectedStatus, response.body);
  assert.equal(published.length, 0);
  await app.close();
}

function actionPayload() {
  return {
    frontier_id: "transition:planned:active",
    expected_state_version: 7,
    actor: { type: "operator", agent_id: "operator:holocene" },
    capability_id: "holocene-grant",
    parameters: {}
  };
}

function fixtureDependencies(
  published: Published[],
  mutate?: (projection: ProjectionFixture) => void
): LifecycleDependencies {
  const projection = projectionFixture();
  mutate?.(projection);
  return {
    candystoreUrl: "http://candystore.test",
    fetch: async () => new Response(JSON.stringify(projection), { status: 200 }),
    publisher: {
      async publish(subject, envelope) {
        assert.equal(subject, envelope.subject);
        published.push({ subject, envelope });
        return {
          transport: "core_nats",
          acknowledgment: "server_processed",
          durable: false,
          server: "nats://bloodbank.test:4222"
        };
      }
    },
    now: () => new Date("2026-07-18T12:00:00Z")
  };
}

function projectionFixture() {
  return {
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
        capability_version: 7,
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
    command_verdicts: [{ verdict: "stale", reason_code: "EXPECTED_STATE_VERSION_MISMATCH" }]
  };
}

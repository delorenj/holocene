import assert from "node:assert/strict";
import test from "node:test";
import {
  NatsBloodbankPublisher,
  buildLifecycleIntentEnvelope,
  encodeNatsPublish
} from "./index.js";

const input = {
  lifecycleId: "11111111-1111-4111-8111-111111111111",
  repo: "delorenj/33GOD",
  expectedStateVersion: 7,
  intent: { name: "transition", target: "active", parameters: { confirmed: true } },
  capability: {
    capability_id: "holocene-grant",
    capability_version: 1,
    action: "lifecycle.intent.submit" as const,
    scope: "lifecycle:11111111-1111-4111-8111-111111111111",
    issued_to: "operator:holocene"
  },
  actor: { type: "operator", agent_id: "operator:holocene" },
  idempotencyKey: "holocene:transition:active:state:7",
  correlationId: "22222222-2222-4222-8222-222222222222",
  causationId: "33333333-3333-4333-8333-333333333333",
  requestedAt: "2026-07-18T12:00:00Z"
};

test("Lifecycle command has complete locked context and stable IDs", () => {
  const first = buildLifecycleIntentEnvelope(input);
  const second = buildLifecycleIntentEnvelope(input);
  assert.deepEqual(first, second);
  assert.equal(first.subject, "bloodbank.cmd.v1.lifecycle.intent.submit");
  assert.equal(first.kind, "command");
  assert.equal(first.delivery, "single_consumer");
  assert.equal(first.correlationid, input.correlationId);
  assert.equal(first.causationid, input.causationId);
  assert.equal(first.data.expected_state_version, 7);
  assert.deepEqual(first.data.capability, input.capability);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.match(first.command_id, /^[0-9a-f-]{36}$/);
});

test("command builder rejects mismatched capability scope and actor", () => {
  assert.throws(
    () =>
      buildLifecycleIntentEnvelope({
        ...input,
        capability: { ...input.capability, issued_to: "somebody-else" }
      }),
    /issued_to/
  );
  assert.throws(
    () =>
      buildLifecycleIntentEnvelope({
        ...input,
        capability: { ...input.capability, scope: "lifecycle:wrong" }
      }),
    /scope/
  );
});

test("NATS protocol frame uses byte length and canonical subject", () => {
  const envelope = buildLifecycleIntentEnvelope(input);
  const frame = encodeNatsPublish(envelope.subject, envelope);
  const [header, body] = frame.toString("utf8").split("\r\n");
  assert.match(header!, /^PUB bloodbank\.cmd\.v1\.lifecycle\.intent\.submit [0-9]+$/);
  assert.deepEqual(JSON.parse(body!), envelope);
  assert.throws(() => encodeNatsPublish("provider.direct.write", envelope), /invalid/);
});

test("NATS publisher requires an explicit server", () => {
  assert.throws(() => new NatsBloodbankPublisher(""), /at least one/);
});

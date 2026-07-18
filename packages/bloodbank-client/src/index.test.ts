import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  NatsBloodbankPublisher,
  buildLifecycleIntentEnvelope,
  encodeNatsPublish
} from "./index.js";

const input = {
  lifecycleId: "11111111-1111-4111-8111-111111111111",
  repo: "delorenj/33GOD",
  selectedFrontierId: "transition:planned:active",
  authoritySnapshotEventId: "33333333-3333-4333-8333-333333333333",
  authoritySnapshotEventTime: "2026-07-18T12:00:00Z",
  expectedStateVersion: 7,
  intent: {
    name: "transition",
    target: "active",
    parameters: { confirmed: true, evidence: { artifact_id: "review:42" } }
  },
  capability: {
    capability_id: "holocene-grant",
    capability_version: 7,
    action: "lifecycle.intent.submit" as const,
    scope: "lifecycle:11111111-1111-4111-8111-111111111111",
    issued_to: "operator:holocene"
  },
  actor: { type: "operator", agent_id: "operator:holocene" }
};

test("Lifecycle command derives complete immutable identity and retries exactly", () => {
  const first = buildLifecycleIntentEnvelope(input);
  const second = buildLifecycleIntentEnvelope(input);
  const reordered = buildLifecycleIntentEnvelope({
    ...input,
    intent: {
      ...input.intent,
      parameters: { evidence: { artifact_id: "review:42" }, confirmed: true }
    }
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first, reordered, "object key order is not semantic");
  assert.equal(first.subject, "bloodbank.cmd.v1.lifecycle.intent.submit");
  assert.equal(first.kind, "command");
  assert.equal(first.delivery, "single_consumer");
  assert.equal(first.time, "2026-07-18T12:00:00.000Z");
  assert.equal(first.data.requested_at, "2026-07-18T12:00:00.000Z");
  assert.equal(first.data.expected_state_version, 7);
  assert.deepEqual(first.data.capability, input.capability);
  assert.equal(first.data.intent.parameters.selected_frontier_id, input.selectedFrontierId);
  assert.equal(
    first.data.intent.parameters.authority_snapshot_event_id,
    input.authoritySnapshotEventId
  );
  assert.match(first.idempotency_key, /^holocene:lifecycle\.intent\.submit:semantic:[0-9a-f]{64}$/);
  for (const value of [first.id, first.command_id, first.correlationid, first.causationid]) {
    assert.match(value, /^[0-9a-f-]{36}$/);
  }
  validateWithBloodbank(first);
});

test("every material request change yields a new complete semantic identity", () => {
  const first = buildLifecycleIntentEnvelope(input);
  const variants = [
    { ...input, lifecycleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", capability: { ...input.capability, scope: "lifecycle:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
    { ...input, repo: "delorenj/other" },
    { ...input, selectedFrontierId: "transition:waiting:active" },
    { ...input, expectedStateVersion: 8 },
    { ...input, actor: { ...input.actor, agent_id: "operator:other" }, capability: { ...input.capability, issued_to: "operator:other" } },
    { ...input, capability: { ...input.capability, capability_id: "other-grant" } },
    { ...input, capability: { ...input.capability, capability_version: 8 } },
    { ...input, intent: { ...input.intent, target: "waiting" } },
    { ...input, intent: { ...input.intent, parameters: { confirmed: false } } }
  ];
  const identityFields = ["id", "command_id", "correlationid", "causationid", "idempotency_key"] as const;

  for (const variant of variants) {
    const envelope = buildLifecycleIntentEnvelope(variant);
    assert.ok(identityFields.every((field) => envelope[field] !== first[field]));
    validateWithBloodbank(envelope);
  }
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

test("exact local Bloodbank schema rejects required, const, subject, and version drift", () => {
  const command = buildLifecycleIntentEnvelope(input);
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => delete value.command_id,
    (value) => (value.kind = "event"),
    (value) => (value.subject = "bloodbank.cmd.v1.lifecycle.status.update"),
    (value) => (value.data.contract_version = 2)
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(command) as Record<string, any>;
    mutate(invalid);
    assert.throws(() => validateWithBloodbank(invalid));
  }
});

test("NATS protocol frame binds passed subject to envelope subject", () => {
  const envelope = buildLifecycleIntentEnvelope(input);
  const frame = encodeNatsPublish(envelope.subject, envelope);
  const [header, body] = frame.toString("utf8").split("\r\n");
  assert.match(header!, /^PUB bloodbank\.cmd\.v1\.lifecycle\.intent\.submit [0-9]+$/);
  assert.deepEqual(JSON.parse(body!), envelope);
  assert.throws(() => encodeNatsPublish("provider.direct.write", envelope), /invalid/);
  assert.throws(
    () => encodeNatsPublish("bloodbank.cmd.v1.lifecycle.status.update", envelope),
    /must equal envelope.subject/
  );
});

test("core NATS PING/PONG proves only server protocol processing", async () => {
  let received = "";
  const server = createServer((socket) => {
    socket.write('INFO {"server_id":"test","max_payload":1048576}\r\n');
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("PING\r\n")) socket.write("PONG\r\n");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const publisher = new NatsBloodbankPublisher(`nats://127.0.0.1:${address.port}`);
    const envelope = buildLifecycleIntentEnvelope(input);
    const receipt = await publisher.publish(envelope.subject, envelope);
    assert.deepEqual(receipt, {
      transport: "core_nats",
      acknowledgment: "server_processed",
      durable: false,
      server: `nats://127.0.0.1:${address.port}`
    });
    assert.match(received, /CONNECT /);
    assert.match(received, /PUB bloodbank\.cmd\.v1\.lifecycle\.intent\.submit/);
    assert.match(received, /PING\r\n/);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("publisher rejects a mismatched subject before opening transport", async () => {
  const publisher = new NatsBloodbankPublisher("nats://127.0.0.1:1");
  const envelope = buildLifecycleIntentEnvelope(input);
  await assert.rejects(
    publisher.publish("bloodbank.cmd.v1.lifecycle.status.update", envelope),
    /must equal envelope.subject/
  );
  assert.throws(() => new NatsBloodbankPublisher(""), /at least one/);
});

function validateWithBloodbank(envelope: Record<string, unknown>) {
  const schemasRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../bloodbank/schemas"
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const relative of readdirSync(schemasRoot, { recursive: true })) {
    if (typeof relative !== "string" || !relative.endsWith(".json")) continue;
    const schema = JSON.parse(readFileSync(join(schemasRoot, relative), "utf8"));
    if (schema.$id) ajv.addSchema(schema, schema.$id);
  }
  const schemaId = "https://33god.dev/schemas/bloodbank/v1/lifecycle/intent.submit.command.v1.json";
  const validate = ajv.getSchema(schemaId);
  assert.ok(validate, `schema ${schemaId} is registered`);
  assert.equal(validate(envelope), true, JSON.stringify(validate.errors));
}

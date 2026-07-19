import assert from "node:assert/strict";
import test from "node:test";
import type { LifecycleFrontierItem } from "@holocene/lifecycle-client";
import {
  buildLifecycleActionRequest,
  lifecycleActionRequiresConfirmation,
  lifecycleConfirmationMessage,
  parseLifecycleCommandReceipt
} from "./lifecycle-action-contract.js";

const confirmationFrontier: LifecycleFrontierItem = {
  id: "transition:waiting:canceled",
  kind: "state_transition",
  action: "transition",
  allowed: true,
  capability_required: "lifecycle.intent.submit",
  reason_code: "LEGAL_REQUIRES_CONFIRMATION",
  expected_state_version: 12
};

test("confirmation and request helpers preserve rendered frontier identity", () => {
  assert.equal(lifecycleActionRequiresConfirmation(confirmationFrontier), true);
  assert.equal(
    lifecycleConfirmationMessage(confirmationFrontier),
    "Submit confirmed Lifecycle action transition for frontier transition:waiting:canceled?"
  );
  assert.deepEqual(
    buildLifecycleActionRequest(
      confirmationFrontier,
      "operator:33god-bootstrap",
      "cap:33god-platform:lifecycle-command"
    ),
    {
      frontier_id: "transition:waiting:canceled",
      expected_state_version: 12,
      actor: { type: "operator", agent_id: "operator:33god-bootstrap" },
      capability_id: "cap:33god-platform:lifecycle-command",
      parameters: { confirmed: true }
    }
  );
});

test("non-confirmation actions do not fabricate confirmation parameters", () => {
  const frontier = {
    ...confirmationFrontier,
    id: "mode:manual",
    kind: "command" as const,
    action: "set_mode",
    reason_code: "MODE_CHANGE_LEGAL"
  };
  assert.equal(lifecycleActionRequiresConfirmation(frontier), false);
  assert.deepEqual(
    buildLifecycleActionRequest(frontier, "operator:33god-bootstrap", "grant"),
    {
      frontier_id: "mode:manual",
      expected_state_version: 12,
      actor: { type: "operator", agent_id: "operator:33god-bootstrap" },
      capability_id: "grant",
      parameters: {}
    }
  );
});

test("command receipt parser accepts only an explicit non-authoritative broker receipt", () => {
  const receipt = {
    broker_processed: true,
    transport: "nats-core",
    durable_jetstream_acknowledged: false,
    authority_accepted: false,
    lifecycle_id: "lc_browser",
    expected_state_version: 12,
    command_event_id: "event-1",
    command_id: "command-1",
    idempotency_key: "idempotency-1",
    correlation_id: "correlation-1",
    causation_id: "snapshot-1",
    message: "Broker processed the command."
  };
  assert.deepEqual(parseLifecycleCommandReceipt(receipt), receipt);
  assert.throws(
    () => parseLifecycleCommandReceipt({ ...receipt, authority_accepted: true }),
    /non-authoritative boundary/
  );
  assert.throws(
    () => parseLifecycleCommandReceipt({ ...receipt, command_event_id: "" }),
    /command_event_id/
  );
});

import type { LifecycleFrontierItem } from "@holocene/lifecycle-client";

export type LifecycleActionRequest = {
  frontier_id: string;
  expected_state_version: number;
  actor: { type: "operator"; agent_id: string };
  capability_id: string;
  parameters: Record<string, unknown>;
};

export type LifecycleCommandReceipt = {
  broker_processed: true;
  transport: string;
  durable_jetstream_acknowledged: false;
  authority_accepted: false;
  lifecycle_id: string;
  expected_state_version: number;
  command_event_id: string;
  command_id: string;
  idempotency_key: string;
  correlation_id: string;
  causation_id: string;
  message: string;
};

export function lifecycleActionRequiresConfirmation(frontier: LifecycleFrontierItem) {
  return frontier.reason_code === "LEGAL_REQUIRES_CONFIRMATION";
}

export function lifecycleConfirmationMessage(frontier: LifecycleFrontierItem) {
  return `Submit confirmed Lifecycle action ${frontier.action} for frontier ${frontier.id}?`;
}

export function buildLifecycleActionRequest(
  frontier: LifecycleFrontierItem,
  actorId: string,
  capabilityId: string
): LifecycleActionRequest {
  return {
    frontier_id: frontier.id,
    expected_state_version: frontier.expected_state_version,
    actor: { type: "operator", agent_id: actorId },
    capability_id: capabilityId,
    parameters: lifecycleActionRequiresConfirmation(frontier) ? { confirmed: true } : {}
  };
}

export function parseLifecycleCommandReceipt(value: unknown): LifecycleCommandReceipt {
  if (!isRecord(value)) throw new Error("Lifecycle command receipt is not an object");
  if (
    value.broker_processed !== true ||
    value.durable_jetstream_acknowledged !== false ||
    value.authority_accepted !== false
  ) {
    throw new Error("Lifecycle command receipt did not preserve the non-authoritative boundary");
  }
  for (const field of [
    "transport",
    "lifecycle_id",
    "command_event_id",
    "command_id",
    "idempotency_key",
    "correlation_id",
    "causation_id",
    "message"
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Lifecycle command receipt omitted ${field}`);
    }
  }
  if (!Number.isInteger(value.expected_state_version) || value.expected_state_version < 1) {
    throw new Error("Lifecycle command receipt omitted expected_state_version");
  }
  return value as LifecycleCommandReceipt;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

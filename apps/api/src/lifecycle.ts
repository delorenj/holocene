import {
  NatsBloodbankPublisher,
  buildLifecycleIntentEnvelope,
  type BloodbankActor,
  type BloodbankPublisher
} from "@holocene/bloodbank-client";
import {
  missingLifecycleProjection,
  normalizeLifecycleProjection,
  type LifecycleFrontierItem,
  type LifecycleProjection
} from "@holocene/lifecycle-client";
import type { FastifyInstance } from "fastify";

type JsonRecord = Record<string, unknown>;

export type LifecycleDependencies = {
  candystoreUrl: string;
  fetch: typeof fetch;
  publisher: BloodbankPublisher;
  now: () => Date;
};

export function defaultLifecycleDependencies(): LifecycleDependencies {
  return {
    candystoreUrl: (process.env.CANDYSTORE_URL ?? "http://127.0.0.1:8683").replace(/\/$/, ""),
    fetch: globalThis.fetch,
    publisher: new NatsBloodbankPublisher(
      process.env.BLOODBANK_NATS_URLS ?? "nats://127.0.0.1:4222"
    ),
    now: () => new Date()
  };
}

export async function readLifecycleProjection(
  lifecycleId: string,
  dependencies: LifecycleDependencies
): Promise<LifecycleProjection> {
  const asOf = dependencies.now().toISOString();
  try {
    const response = await dependencies.fetch(
      `${dependencies.candystoreUrl}/lifecycles/${encodeURIComponent(lifecycleId)}?as_of=${encodeURIComponent(asOf)}`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    if (!response.ok) {
      return missingLifecycleProjection(
        lifecycleId,
        asOf,
        `Candystore projection returned HTTP ${response.status}`
      );
    }
    return normalizeLifecycleProjection(await response.json(), lifecycleId, asOf);
  } catch (error) {
    return missingLifecycleProjection(
      lifecycleId,
      asOf,
      `Candystore projection unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function submitLifecycleAction(
  lifecycleId: string,
  body: unknown,
  dependencies: LifecycleDependencies
) {
  const projection = await readLifecycleProjection(lifecycleId, dependencies);
  if (projection.projection_status !== "current") {
    throw new LifecycleActionError(
      409,
      `Lifecycle projection is ${projection.projection_status}; no command was published`
    );
  }
  if (
    !projection.repo ||
    !projection.state_version ||
    !projection.source?.event_id ||
    !projection.source.event_time ||
    !projection.source.correlation_id
  ) {
    throw new LifecycleActionError(409, "Lifecycle projection lacks authoritative command context");
  }
  const value = record(body, "request body");
  for (const derived of [
    "capability_version",
    "idempotency_key",
    "correlation_id",
    "causation_id",
    "requested_at"
  ]) {
    if (value[derived] !== undefined) {
      throw new LifecycleActionError(400, `${derived} is derived from authoritative semantics`);
    }
  }
  const frontierId = text(value.frontier_id, "frontier_id");
  const expectedStateVersion = version(value.expected_state_version, "expected_state_version");
  if (expectedStateVersion !== projection.state_version) {
    throw new LifecycleActionError(409, "expected_state_version does not match the projection");
  }
  const frontier = projection.legal_frontier.find(
    (item) =>
      item.id === frontierId &&
      item.allowed === true &&
      item.expected_state_version === projection.state_version
  );
  if (!frontier) {
    throw new LifecycleActionError(409, "frontier item is not currently allowed by Lifecycle");
  }

  const actor = parseActor(record(value.actor, "actor"));
  const capabilityId = text(value.capability_id, "capability_id");
  const grant = projection.capabilities.find(
    (item) =>
      item.capability_id === capabilityId &&
      item.actor_id === actor.agent_id &&
      item.scope === `lifecycle:${lifecycleId}` &&
      item.state_version === projection.state_version &&
      (item.actions.includes("lifecycle.intent.submit") || item.actions.includes(frontier.action))
  );
  if (!grant) {
    throw new LifecycleActionError(403, "no current authoritative capability grant matches the action");
  }

  const parameters = value.parameters === undefined ? {} : record(value.parameters, "parameters");
  const [name, target] = frontierIntent(frontier);
  if (name === "resolve_gate") {
    const resolution = text(parameters.resolution, "parameters.resolution");
    if (
      !["approved", "rejected", "bypassed", "auto_resolved", "superseded"].includes(
        resolution
      )
    ) {
      throw new LifecycleActionError(400, "parameters.resolution is not canonical");
    }
  }
  const envelope = buildLifecycleIntentEnvelope({
    lifecycleId,
    repo: projection.repo,
    selectedFrontierId: frontier.id,
    authoritySnapshotEventId: projection.source.event_id,
    authoritySnapshotEventTime: projection.source.event_time,
    authoritySnapshotCorrelationId: projection.source.correlation_id,
    expectedStateVersion,
    intent: {
      name,
      target,
      parameters
    },
    capability: {
      capability_id: grant.capability_id,
      capability_version: grant.capability_version,
      action: "lifecycle.intent.submit",
      scope: grant.scope,
      issued_to: actor.agent_id
    },
    actor
  });

  const receipt = await dependencies.publisher.publish(envelope.subject, envelope);
  return {
    broker_processed: receipt.acknowledgment === "server_processed",
    transport: receipt.transport,
    durable_jetstream_acknowledged: receipt.durable,
    authority_accepted: false,
    lifecycle_id: lifecycleId,
    expected_state_version: expectedStateVersion,
    command_event_id: envelope.id,
    command_id: envelope.command_id,
    idempotency_key: envelope.idempotency_key,
    correlation_id: envelope.correlationid,
    causation_id: envelope.causationid,
    message: (
      "Core NATS processed the publish; this is not a durable JetStream acknowledgment " +
      "or Lifecycle acceptance. Rendered state is unchanged pending the authority verdict."
    )
  };
}

export function registerLifecycleRoutes(
  app: FastifyInstance,
  dependencies = defaultLifecycleDependencies()
) {
  app.get<{ Params: { lifecycleId: string } }>(
    "/api/modules/lifecycle/:lifecycleId",
    async (request) => readLifecycleProjection(request.params.lifecycleId, dependencies)
  );

  app.post<{ Params: { lifecycleId: string }; Body: unknown }>(
    "/api/modules/lifecycle/:lifecycleId/actions",
    async (request, reply) => {
      try {
        const result = await submitLifecycleAction(
          request.params.lifecycleId,
          request.body,
          dependencies
        );
        return reply.status(202).send(result);
      } catch (error) {
        if (error instanceof LifecycleActionError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        request.log.error(error);
        return reply.status(502).send({
          error: error instanceof Error ? error.message : "Bloodbank command publication failed"
        });
      }
    }
  );
}

export class LifecycleActionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function frontierIntent(frontier: LifecycleFrontierItem): [string, string] {
  if (frontier.action === "transition" && frontier.id.startsWith("transition:")) {
    return [frontier.action, frontier.id.split(":").at(-1)!];
  }
  if (
    frontier.action === "resolve_gate" &&
    frontier.id.startsWith("gate:") &&
    frontier.id.endsWith(":resolve")
  ) {
    return [frontier.action, frontier.id.slice("gate:".length, -":resolve".length)];
  }
  if (frontier.action === "set_mode" && frontier.id.startsWith("mode:")) {
    return [frontier.action, frontier.id.slice("mode:".length)];
  }
  throw new LifecycleActionError(409, "frontier item cannot be encoded as a Lifecycle intent");
}

function parseActor(value: JsonRecord): BloodbankActor {
  return {
    type: text(value.type, "actor.type"),
    agent_id: text(value.agent_id, "actor.agent_id"),
    ...(optionalText(value.cli) !== undefined ? { cli: optionalText(value.cli) } : {}),
    ...(optionalText(value.provider) !== undefined
      ? { provider: optionalText(value.provider) }
      : {}),
    ...(optionalText(value.model) !== undefined ? { model: optionalText(value.model) } : {})
  };
}

function record(value: unknown, name: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleActionError(400, `${name} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LifecycleActionError(400, `${name} must be non-empty text`);
  }
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function version(value: unknown, name: string) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new LifecycleActionError(400, `${name} must be an integer >= 1`);
  }
  return Number(value);
}

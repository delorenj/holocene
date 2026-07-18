import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import type { ModuleEvent } from "@holocene/module-sdk";

export type BloodbankSubscription = {
  subjects: string[];
  fromTime?: string;
};

export type BloodbankEvent = ModuleEvent;

export interface BloodbankClient {
  subscribe(
    subscription: BloodbankSubscription,
    onEvents: (events: BloodbankEvent[]) => void
  ): Promise<() => Promise<void>>;
}

export class StubBloodbankClient implements BloodbankClient {
  async subscribe(
    _subscription: BloodbankSubscription,
    _onEvents: (events: BloodbankEvent[]) => void
  ) {
    return async () => undefined;
  }
}

export type BloodbankActor = {
  type: string;
  agent_id: string;
  cli?: string | null;
  provider?: string | null;
  model?: string | null;
};

export type LifecycleCapabilityContext = {
  capability_id: string;
  capability_version: number;
  action: "lifecycle.intent.submit";
  scope: string;
  issued_to: string;
};

export type LifecycleIntentInput = {
  lifecycleId: string;
  repo: string;
  expectedStateVersion: number;
  intent: {
    name: string;
    target: string;
    parameters: Record<string, unknown>;
  };
  capability: LifecycleCapabilityContext;
  actor: BloodbankActor;
  idempotencyKey: string;
  correlationId: string;
  causationId: string;
  requestedAt: string;
};

export type LifecycleIntentEnvelope = ReturnType<typeof buildLifecycleIntentEnvelope>;

export interface BloodbankPublisher {
  publish(subject: string, envelope: Record<string, unknown>): Promise<void>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_NAMESPACE = "c447a74d-6a44-4f34-889c-706c51545729";

export function buildLifecycleIntentEnvelope(input: LifecycleIntentInput) {
  requireText(input.lifecycleId, "lifecycleId");
  requireText(input.repo, "repo");
  requireVersion(input.expectedStateVersion, "expectedStateVersion");
  requireText(input.intent.name, "intent.name");
  requireText(input.intent.target, "intent.target");
  requireText(input.capability.capability_id, "capability.capability_id");
  requireVersion(input.capability.capability_version, "capability.capability_version");
  requireText(input.capability.scope, "capability.scope");
  requireText(input.capability.issued_to, "capability.issued_to");
  requireText(input.actor.type, "actor.type");
  requireText(input.actor.agent_id, "actor.agent_id");
  requireText(input.idempotencyKey, "idempotencyKey");
  requireUuid(input.correlationId, "correlationId");
  requireUuid(input.causationId, "causationId");
  const requestedAt = new Date(input.requestedAt);
  if (!Number.isFinite(requestedAt.valueOf())) throw new Error("requestedAt must be RFC 3339");
  if (input.capability.action !== "lifecycle.intent.submit") {
    throw new Error("capability.action must be lifecycle.intent.submit");
  }
  if (input.capability.issued_to !== input.actor.agent_id) {
    throw new Error("capability.issued_to must match actor.agent_id");
  }
  if (input.capability.scope !== `lifecycle:${input.lifecycleId}`) {
    throw new Error("capability.scope must match lifecycle identity");
  }

  const eventId = uuidV5(`event:${input.idempotencyKey}`, COMMAND_NAMESPACE);
  const commandId = uuidV5(`command:${input.idempotencyKey}`, COMMAND_NAMESPACE);
  const timestamp = requestedAt.toISOString();
  return {
    specversion: "1.0" as const,
    id: eventId,
    source: `urn:33god:service:holocene:${input.actor.agent_id}`,
    type: "bloodbank.v1.lifecycle.intent.submit" as const,
    subject: "bloodbank.cmd.v1.lifecycle.intent.submit" as const,
    time: timestamp,
    datacontenttype: "application/json" as const,
    dataschema:
      "apicurio://holyfields/bloodbank.v1.lifecycle.intent.submit.command/versions/1" as const,
    correlationid: input.correlationId,
    causationid: input.causationId,
    producer: "holocene",
    service: "holocene",
    domain: "lifecycle" as const,
    schemaref: "bloodbank.v1.lifecycle.intent.submit.command.v1" as const,
    kind: "command" as const,
    actor: input.actor,
    command_id: commandId,
    idempotency_key: input.idempotencyKey,
    delivery: "single_consumer" as const,
    data: {
      contract_version: 1 as const,
      lifecycle_id: input.lifecycleId,
      repo: input.repo,
      expected_state_version: input.expectedStateVersion,
      intent: input.intent,
      capability: input.capability,
      requested_at: timestamp
    }
  };
}

export function encodeNatsPublish(subject: string, envelope: Record<string, unknown>) {
  if (!/^bloodbank\.(?:cmd|evt|rpy)\.v[0-9]+\.[a-z0-9_.]+$/.test(subject)) {
    throw new Error(`invalid Bloodbank subject: ${subject}`);
  }
  const payload = Buffer.from(JSON.stringify(envelope));
  return Buffer.concat([
    Buffer.from(`PUB ${subject} ${payload.byteLength}\r\n`),
    payload,
    Buffer.from("\r\n")
  ]);
}

export class NatsBloodbankPublisher implements BloodbankPublisher {
  readonly urls: string[];
  readonly timeoutMs: number;

  constructor(urls: string | string[], timeoutMs = 5_000) {
    this.urls = (Array.isArray(urls) ? urls : urls.split(/[\s,]+/))
      .map((url) => url.trim())
      .filter(Boolean);
    if (this.urls.length === 0) throw new Error("at least one NATS URL is required");
    this.timeoutMs = timeoutMs;
  }

  async publish(subject: string, envelope: Record<string, unknown>) {
    const frame = encodeNatsPublish(subject, envelope);
    const failures: string[] = [];
    for (const value of this.urls) {
      try {
        await publishOne(value, frame, this.timeoutMs);
        return;
      } catch (error) {
        failures.push(`${value}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Bloodbank NATS publish failed (${failures.join("; ")})`);
  }
}

function publishOne(value: string, frame: Buffer, timeoutMs: number) {
  const url = new URL(value);
  if (url.protocol !== "nats:") throw new Error(`unsupported NATS protocol ${url.protocol}`);
  const port = Number(url.port || 4222);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid NATS port");
  }
  const connectPayload: Record<string, unknown> = {
    verbose: false,
    pedantic: true,
    tls_required: false,
    name: "holocene-lifecycle-client",
    lang: "typescript",
    version: "1"
  };
  if (url.username) connectPayload.user = decodeURIComponent(url.username);
  if (url.password) connectPayload.pass = decodeURIComponent(url.password);

  return new Promise<void>((resolve, reject) => {
    let socket: Socket | undefined;
    let buffer = "";
    let sent = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket = createConnection({ host: url.hostname, port });
    socket.setTimeout(timeoutMs, () => finish(new Error("publish timeout")));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("-ERR")) {
        const line = buffer.split("\r\n").find((entry) => entry.startsWith("-ERR"));
        finish(new Error(line ?? "NATS server error"));
        return;
      }
      if (!sent && buffer.includes("INFO ")) {
        sent = true;
        socket?.write(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
        socket?.write(frame);
        socket?.write("PING\r\n");
        buffer = "";
        return;
      }
      if (sent && buffer.includes("PONG\r\n")) finish();
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("NATS connection ended before acknowledgment"));
    });
  });
}

function uuidV5(value: string, namespace: string) {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(value).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be non-empty text`);
  }
}

function requireVersion(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be an integer >= 1`);
  }
}

function requireUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
}

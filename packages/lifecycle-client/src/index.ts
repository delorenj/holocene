export type LifecycleFrontierItem = {
  id: string;
  kind: "state_transition" | "command" | "work_item" | "gate_resolution";
  action: string;
  allowed: boolean;
  capability_required: string | null;
  reason_code: string;
  expected_state_version: number;
};

export type LifecycleObligation = {
  id: string;
  obligation_instance_id: string;
  activated_at: string;
  kind: string;
  status: "pending" | "satisfied" | "waived" | "violated";
  description: string;
  skill_ref: { name: string; selector: string };
  owner_id: string | null;
  due_at: string | null;
  source_observation_ids: string[];
};

export type LifecycleCapability = {
  capability_id: string;
  capability_version: number;
  actor_id: string;
  actions: string[];
  scope: string;
  issued_at: string;
  expires_at: string | null;
  state_version: number;
};

export type LifecycleCommandVerdict = {
  reply_event_id: string;
  command_event_id: string;
  command_id: string;
  idempotency_key: string;
  expected_state_version: number;
  observed_state_version: number;
  verdict: "accepted" | "applied" | "idempotent" | "stale" | "unauthorized" | "malformed" | "illegal";
  mutated: boolean;
  resulting_state_version: number | null;
  applied_event_id: string | null;
  capability_id: string | null;
  reason_code: string;
  correlation_id: string | null;
  causation_id: string | null;
  responded_at: string;
};

export type LifecycleProjection = {
  lifecycle_id: string;
  repo: string | null;
  spec_version: number | null;
  state_version: number | null;
  previous_state_version: number | null;
  status: string;
  health: string;
  phase: string | null;
  progress_percent: number | null;
  fingerprint: string | null;
  projection_status: "current" | "stale" | "missing";
  authority_state: {
    status: string;
    health: string;
    phase: string | null;
    progress_percent: number;
    fingerprint: string | null;
  } | null;
  legal_frontier: LifecycleFrontierItem[];
  obligations: LifecycleObligation[];
  blockers: Array<Record<string, unknown>>;
  gates: Array<Record<string, unknown>>;
  capabilities: LifecycleCapability[];
  provenance: Record<string, unknown> | null;
  freshness: Record<string, unknown>;
  publication: Record<string, unknown> | null;
  source: {
    event_id: string;
    event_type: string;
    event_time: string;
    ordering_key: string;
    projected_at: string;
    subject: string;
    authority_source: string;
    producer: string;
    service: string;
    kind: string;
    domain: string;
    schema_ref: string;
    data_schema: string;
    actor: {
      type: string;
      agent_id: string;
      instance: string;
    };
    correlation_id: string;
    causation_id: string | null;
  } | null;
  command_verdicts: LifecycleCommandVerdict[];
  read_error?: string;
};

type JsonRecord = Record<string, unknown>;

export function normalizeLifecycleProjection(
  value: unknown,
  lifecycleId: string,
  asOf = new Date().toISOString()
): LifecycleProjection {
  if (!isRecord(value)) return missingLifecycleProjection(lifecycleId, asOf, "projection is not an object");
  if (value.lifecycle_id !== lifecycleId) {
    return missingLifecycleProjection(lifecycleId, asOf, "projection identity mismatch");
  }
  if (!isProjectionStatus(value.projection_status)) {
    return missingLifecycleProjection(lifecycleId, asOf, "projection status is invalid");
  }
  if (
    !Array.isArray(value.legal_frontier) ||
    !Array.isArray(value.obligations) ||
    !value.obligations.every(isLifecycleObligation)
  ) {
    return missingLifecycleProjection(lifecycleId, asOf, "projection work fields are invalid");
  }
  if (!Array.isArray(value.blockers) || !Array.isArray(value.gates)) {
    return missingLifecycleProjection(lifecycleId, asOf, "projection blocker fields are invalid");
  }
  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isLifecycleCapability) ||
    !Array.isArray(value.command_verdicts)
  ) {
    return missingLifecycleProjection(lifecycleId, asOf, "projection client fields are invalid");
  }

  const missing = value.projection_status === "missing";
  const stale = value.projection_status === "stale";
  if (!missing) {
    const authorityError = authorityProjectionError(value, lifecycleId);
    if (authorityError) {
      return missingLifecycleProjection(lifecycleId, asOf, authorityError);
    }
  }
  const source = value.source as JsonRecord | null;
  const sourceActor = source?.actor as JsonRecord | undefined;
  return {
    lifecycle_id: lifecycleId,
    repo: textOrNull(value.repo),
    spec_version: integerOrNull(value.spec_version),
    state_version: integerOrNull(value.state_version),
    previous_state_version: integerOrNull(value.previous_state_version),
    status: missing ? "unknown" : textOr(value.status, "unknown"),
    health: missing || stale ? "degraded" : textOr(value.health, "degraded"),
    phase: textOrNull(value.phase),
    progress_percent: numberOrNull(value.progress_percent),
    fingerprint: textOrNull(value.fingerprint),
    projection_status: value.projection_status,
    authority_state: isRecord(value.authority_state)
      ? {
          status: textOr(value.authority_state.status, "unknown"),
          health: textOr(value.authority_state.health, "degraded"),
          phase: textOrNull(value.authority_state.phase),
          progress_percent: numberOr(value.authority_state.progress_percent, 0),
          fingerprint: textOrNull(value.authority_state.fingerprint)
        }
      : null,
    legal_frontier: value.legal_frontier as LifecycleFrontierItem[],
    obligations: value.obligations as LifecycleObligation[],
    blockers: value.blockers as Array<Record<string, unknown>>,
    gates: value.gates as Array<Record<string, unknown>>,
    capabilities: value.capabilities as LifecycleCapability[],
    provenance: isRecord(value.provenance) ? value.provenance : null,
    freshness: isRecord(value.freshness) ? value.freshness : { status: "unknown", as_of: asOf },
    publication: isRecord(value.publication) ? value.publication : null,
    source: source && sourceActor
      ? {
          event_id: String(source.event_id),
          event_type: String(source.event_type),
          event_time: String(source.event_time),
          ordering_key: String(source.ordering_key),
          projected_at: String(source.projected_at),
          subject: String(source.subject),
          authority_source: String(source.authority_source),
          producer: String(source.producer),
          service: String(source.service),
          kind: String(source.kind),
          domain: String(source.domain),
          schema_ref: String(source.schema_ref),
          data_schema: String(source.data_schema),
          actor: {
            type: String(sourceActor.type),
            agent_id: String(sourceActor.agent_id),
            instance: String(sourceActor.instance)
          },
          correlation_id: String(source.correlation_id),
          causation_id: source.causation_id === null ? null : String(source.causation_id)
        }
      : null,
    command_verdicts: value.command_verdicts as LifecycleCommandVerdict[],
    ...(typeof value.read_error === "string" ? { read_error: value.read_error } : {})
  };
}

export function missingLifecycleProjection(
  lifecycleId: string,
  asOf = new Date().toISOString(),
  reason = "no authoritative projection observed"
): LifecycleProjection {
  return {
    lifecycle_id: lifecycleId,
    repo: null,
    spec_version: null,
    state_version: null,
    previous_state_version: null,
    status: "unknown",
    health: "degraded",
    phase: null,
    progress_percent: null,
    fingerprint: null,
    projection_status: "missing",
    authority_state: null,
    legal_frontier: [],
    obligations: [],
    blockers: [],
    gates: [],
    capabilities: [],
    provenance: null,
    freshness: { status: "unknown", as_of: asOf },
    publication: null,
    source: null,
    command_verdicts: [],
    read_error: reason
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProjectionStatus(value: unknown): value is LifecycleProjection["projection_status"] {
  return value === "current" || value === "stale" || value === "missing";
}

function isLifecycleCapability(value: unknown): value is LifecycleCapability {
  if (!isRecord(value)) return false;
  return (
    typeof value.capability_id === "string" &&
    Number.isInteger(value.capability_version) &&
    Number(value.capability_version) >= 1 &&
    typeof value.actor_id === "string" &&
    Array.isArray(value.actions) &&
    value.actions.every((action) => typeof action === "string") &&
    typeof value.scope === "string" &&
    typeof value.issued_at === "string" &&
    (value.expires_at === null || typeof value.expires_at === "string") &&
    Number.isInteger(value.state_version) &&
    Number(value.state_version) >= 1
  );
}

function isLifecycleObligation(value: unknown): value is LifecycleObligation {
  if (!isRecord(value) || !isRecord(value.skill_ref)) return false;
  return (
    isUuid(value.obligation_instance_id) &&
    isTimestamp(value.activated_at) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.kind === "string" &&
    value.kind.length > 0 &&
    ["pending", "satisfied", "waived", "violated"].includes(String(value.status)) &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    typeof value.skill_ref.name === "string" &&
    typeof value.skill_ref.selector === "string" &&
    (value.owner_id === null || typeof value.owner_id === "string") &&
    (value.due_at === null || isTimestamp(value.due_at)) &&
    Array.isArray(value.source_observation_ids) &&
    value.source_observation_ids.every(isUuid)
  );
}

function authorityProjectionError(value: JsonRecord, lifecycleId: string) {
  if (!isRecord(value.source)) return "projection authority source is missing";
  if (!isRecord(value.provenance)) return "projection authority provenance is missing";
  const source = value.source;
  const expected: Record<string, string> = {
    event_type: "bloodbank.v1.lifecycle.snapshot.updated",
    subject: "bloodbank.evt.v1.lifecycle.snapshot.updated",
    authority_source: "urn:33god:service:lifecycle",
    producer: "delorenj/lifecycle",
    service: "lifecycle",
    kind: "event",
    domain: "lifecycle",
    schema_ref: "bloodbank.v1.lifecycle.snapshot.updated.v3",
    data_schema: "apicurio://holyfields/bloodbank.v1.lifecycle.snapshot.updated/versions/3",
    ordering_key: `lifecycle:${lifecycleId}`
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (source[field] !== expectedValue) return `projection authority source ${field} is invalid`;
  }
  if (
    !isUuid(source.event_id) ||
    !isTimestamp(source.event_time) ||
    !isTimestamp(source.projected_at) ||
    !isUuid(source.correlation_id)
  ) {
    return "projection authority source causal metadata is invalid";
  }
  if (!("causation_id" in source) || (source.causation_id !== null && !isUuid(source.causation_id))) {
    return "projection authority source causation_id is invalid";
  }
  if (!isRecord(source.actor)) return "projection authority source actor is missing";
  if (
    source.actor.type !== "service" ||
    source.actor.agent_id !== "delorenj.lifecycle" ||
    typeof source.actor.instance !== "string" ||
    source.actor.instance.length === 0
  ) {
    return "projection authority source actor is invalid";
  }
  if (
    value.provenance.authority !== "delorenj/lifecycle" ||
    value.provenance.authority_instance !== source.actor.instance
  ) {
    return "projection authority provenance is invalid";
  }
  return null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function textOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function integerOrNull(value: unknown) {
  return Number.isInteger(value) ? (value as number) : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

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
  if (!Array.isArray(value.legal_frontier) || !Array.isArray(value.obligations)) {
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
    source: isRecord(value.source)
      ? {
          event_id: textOr(value.source.event_id, ""),
          event_type: textOr(value.source.event_type, ""),
          event_time: textOr(value.source.event_time, ""),
          ordering_key: textOr(value.source.ordering_key, ""),
          projected_at: textOr(value.source.projected_at, "")
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

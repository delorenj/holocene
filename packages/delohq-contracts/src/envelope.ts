// The versioned projection envelope every /hq/api/* read returns.
//
// State coherence is what keeps DeloHQ truthful (NFR-1):
//   ok       data, >=1 evidence, observed_at, known freshness, error null
//   degraded data, >=1 evidence, observed_at, known freshness, AND an error
//   unknown  error detail explaining why, data null, freshness "unknown"
//   error    error detail, data null, freshness never "fresh"
// A null observed_at always means freshness "unknown".
//
// Timestamps are cross-checked against generated_at (CLOCK_SKEW_TOLERANCE_SECONDS
// of slack): observed_at and every evidence observed_at may not postdate it, and
// a known freshness.age_seconds must equal max(0, generated_at - observed_at).
// A self-reported age can therefore never disguise old data as fresh.

import { type ErrorDetail, type ProjectionState, PROJECTION_STATES, isProjectionState, validateErrorDetail } from "./errors.js";
import { type EvidenceRef, type ProjectionSource, validateEvidenceRef, validateProjectionSource } from "./evidence.js";
import { CLOCK_SKEW_TOLERANCE_SECONDS, type Freshness, stateForAge, validateFreshness } from "./freshness.js";
import {
  type DeloHqSurface,
  DELOHQ_CONTRACT_REGISTRY,
  DELOHQ_SURFACES,
  isRegisteredSurface,
  isSupportedSchemaVersion
} from "./registry.js";
import {
  type ValidationResult,
  type Validator,
  checkKeys,
  describe,
  hasOwn,
  isIsoUtc,
  isRecord,
  prefixIssues
} from "./validation.js";

export const ENVELOPE_FIELDS = [
  "schema_version",
  "surface",
  "source",
  "generated_at",
  "observed_at",
  "freshness",
  "state",
  "evidence",
  "error",
  "data"
] as const;

interface EnvelopeBase {
  readonly schema_version: string;
  readonly surface: DeloHqSurface;
  readonly source: ProjectionSource;
  readonly generated_at: string;
  readonly freshness: Freshness;
  readonly evidence: readonly EvidenceRef[];
}

export interface OkProjection<T> extends EnvelopeBase {
  readonly state: "ok";
  readonly observed_at: string;
  readonly error: null;
  readonly data: T;
}

export interface DegradedProjection<T> extends EnvelopeBase {
  readonly state: "degraded";
  readonly observed_at: string;
  readonly error: ErrorDetail;
  readonly data: T;
}

export interface UnknownProjection extends EnvelopeBase {
  readonly state: "unknown";
  readonly observed_at: string | null;
  readonly error: ErrorDetail;
  readonly data: null;
}

export interface ErrorProjection extends EnvelopeBase {
  readonly state: "error";
  readonly observed_at: string | null;
  readonly error: ErrorDetail;
  readonly data: null;
}

export type ProjectionEnvelope<T> = OkProjection<T> | DegradedProjection<T> | UnknownProjection | ErrorProjection;

// True only for ok/degraded, the states that carry data.
export function hasProjectionData<T>(envelope: ProjectionEnvelope<T>): envelope is OkProjection<T> | DegradedProjection<T> {
  return envelope.state === "ok" || envelope.state === "degraded";
}

export function validateProjectionEnvelope<T = unknown>(
  value: unknown,
  validateData?: Validator<T>
): ValidationResult<ProjectionEnvelope<T>> {
  if (!isRecord(value)) return { ok: false, issues: [`envelope: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, "envelope", ENVELOPE_FIELDS);
  const has = (key: string) => hasOwn(value, key);

  const surfaceOk = has("surface") && isRegisteredSurface(value.surface);
  if (has("surface") && !surfaceOk) {
    issues.push(`envelope.surface: unregistered surface ${JSON.stringify(value.surface)} (expected one of ${DELOHQ_SURFACES.join(", ")})`);
  }
  if (has("schema_version")) {
    if (typeof value.schema_version !== "string") {
      issues.push("envelope.schema_version: expected a semver string");
    } else if (surfaceOk && !isSupportedSchemaVersion(value.surface as DeloHqSurface, value.schema_version)) {
      const wanted = DELOHQ_CONTRACT_REGISTRY[value.surface as DeloHqSurface].schema_version;
      issues.push(`envelope.schema_version: unsupported schema_version "${value.schema_version}" for surface "${String(value.surface)}" (registry: ${wanted})`);
    }
  }
  if (has("source")) {
    const result = validateProjectionSource(value.source, "envelope.source");
    if (!result.ok) issues.push(...result.issues);
  }
  if (has("generated_at") && !isIsoUtc(value.generated_at)) {
    issues.push("envelope.generated_at: expected an ISO-8601 UTC timestamp ending in Z");
  }
  if (has("observed_at") && value.observed_at !== null && !isIsoUtc(value.observed_at)) {
    issues.push("envelope.observed_at: expected null or an ISO-8601 UTC timestamp ending in Z");
  }
  let freshness: Freshness | undefined;
  if (has("freshness")) {
    const result = validateFreshness(value.freshness);
    if (result.ok) freshness = result.value;
    else issues.push(...prefixIssues(result.issues, "envelope"));
  }
  const stateOk = has("state") && isProjectionState(value.state);
  if (has("state") && !stateOk) {
    issues.push(`envelope.state: expected one of ${PROJECTION_STATES.join(", ")}, got ${JSON.stringify(value.state)}`);
  }
  let evidenceCount = 0;
  const evidenceObservedAt: Array<[number, string]> = [];
  if (has("evidence")) {
    if (!Array.isArray(value.evidence)) {
      issues.push(`envelope.evidence: expected array, got ${describe(value.evidence)}`);
    } else {
      evidenceCount = value.evidence.length;
      value.evidence.forEach((item, i) => {
        const result = validateEvidenceRef(item, `envelope.evidence[${i}]`);
        if (result.ok) evidenceObservedAt.push([i, result.value.observed_at]);
        else issues.push(...result.issues);
      });
    }
  }

  // Timestamp cross-checks against generated_at.
  if (has("generated_at") && isIsoUtc(value.generated_at)) {
    const generatedMs = Date.parse(value.generated_at);
    const skewMs = CLOCK_SKEW_TOLERANCE_SECONDS * 1000;
    const observedOk = has("observed_at") && isIsoUtc(value.observed_at);
    if (observedOk) {
      const observedMs = Date.parse(value.observed_at as string);
      if (observedMs > generatedMs + skewMs) {
        issues.push(`envelope.observed_at: later than generated_at by more than ${CLOCK_SKEW_TOLERANCE_SECONDS}s`);
      }
      if (freshness && freshness.age_seconds !== null) {
        const impliedAge = Math.max(0, (generatedMs - observedMs) / 1000);
        if (Math.abs(freshness.age_seconds - impliedAge) > CLOCK_SKEW_TOLERANCE_SECONDS) {
          issues.push(
            `envelope.freshness.age_seconds: ${freshness.age_seconds} disagrees with generated_at - observed_at (${impliedAge}s) by more than ${CLOCK_SKEW_TOLERANCE_SECONDS}s`
          );
        }
        // The skew tolerance must not let a producer cross a state boundary.
        const impliedState = stateForAge(impliedAge, freshness.max_age_seconds);
        if (freshness.state !== impliedState) {
          issues.push(
            `envelope.freshness.state: "${freshness.state}" contradicts generated_at - observed_at (${impliedAge}s implies "${impliedState}")`
          );
        }
      }
    }
    for (const [i, at] of evidenceObservedAt) {
      if (Date.parse(at) > generatedMs + skewMs) {
        issues.push(`envelope.evidence[${i}].observed_at: later than generated_at by more than ${CLOCK_SKEW_TOLERANCE_SECONDS}s`);
      }
    }
  }
  if (has("error") && value.error !== null) {
    const result = validateErrorDetail(value.error, "envelope.error");
    if (!result.ok) issues.push(...result.issues);
  }

  // Cross-field coherence, only once the state itself is known.
  let data: { value: T } | undefined;
  if (stateOk) {
    const state = value.state as ProjectionState;
    const carriesData = state === "ok" || state === "degraded";
    if (has("observed_at") && value.observed_at === null) {
      if (carriesData) issues.push(`envelope.observed_at: ${state} requires an observed_at`);
      if (freshness && freshness.state !== "unknown") {
        issues.push(`envelope.freshness.state: must be "unknown" when observed_at is null, got "${freshness.state}"`);
      }
    }
    if (has("evidence") && carriesData && Array.isArray(value.evidence) && evidenceCount === 0) {
      issues.push(`envelope.evidence: ${state} requires evidence`);
    }
    if (has("error")) {
      if (state === "ok" && value.error !== null) issues.push("envelope.error: ok must have error null");
      if (state !== "ok" && value.error === null) issues.push(`envelope.error: ${state} requires error detail`);
    }
    if (has("data")) {
      if (carriesData && (value.data === null || value.data === undefined)) {
        issues.push(`envelope.data: ${state} requires non-null data`);
      }
      if (!carriesData && value.data !== null) issues.push(`envelope.data: ${state} must have data null`);
    }
    if (freshness) {
      if (carriesData && freshness.state === "unknown") {
        issues.push(`envelope.freshness.state: ${state} requires a known freshness`);
      }
      if (state === "unknown" && freshness.state !== "unknown") {
        issues.push(`envelope.freshness.state: unknown projection must have freshness "unknown", got "${freshness.state}"`);
      }
      if (state === "error" && freshness.state === "fresh") {
        issues.push('envelope.freshness.state: error projection cannot claim "fresh"');
      }
    }
    if (carriesData && validateData && has("data") && value.data !== null && value.data !== undefined) {
      let result: ValidationResult<T>;
      try {
        result = validateData(value.data);
      } catch (err) {
        result = { ok: false, issues: [`validateData threw: ${err instanceof Error ? err.message : String(err)}`] };
      }
      if (result.ok && (result.value === null || result.value === undefined)) {
        issues.push(`envelope.data: validateData returned no value for ${state}`);
      } else if (result.ok) {
        data = { value: result.value };
      } else {
        issues.push(...prefixIssues(result.issues, "envelope.data"));
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  // Return the data validateData produced (it may normalize or narrow), not
  // the raw input.
  const envelope = data ? { ...value, data: data.value } : value;
  return { ok: true, value: envelope as unknown as ProjectionEnvelope<T> };
}

// ---- constructors ----------------------------------------------------------
// Constructors stamp the registry's schema_version and the state, then run the
// validator. They throw on incoherent input so an adapter can never emit a
// payload the browser would reject.

export class ContractViolationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: string[]) {
    super(`DeloHQ contract violation: ${issues.join("; ")}`);
    this.name = "ContractViolationError";
    this.issues = Object.freeze([...issues]);
  }
}

function assertValid<E>(candidate: E): E {
  const result = validateProjectionEnvelope(candidate);
  if (!result.ok) throw new ContractViolationError(result.issues);
  return candidate;
}

function versionFor(surface: DeloHqSurface): string {
  return DELOHQ_CONTRACT_REGISTRY[surface]?.schema_version ?? "";
}

interface ProjectionInput {
  readonly surface: DeloHqSurface;
  readonly source: ProjectionSource;
  readonly generated_at: string;
  readonly freshness: Freshness;
}

export interface OkProjectionInput<T> extends ProjectionInput {
  readonly observed_at: string;
  readonly evidence: readonly EvidenceRef[];
  readonly data: T;
}

export interface DegradedProjectionInput<T> extends OkProjectionInput<T> {
  readonly error: ErrorDetail;
}

export interface FailedProjectionInput extends ProjectionInput {
  readonly error: ErrorDetail;
  readonly observed_at?: string | null;
  readonly evidence?: readonly EvidenceRef[];
}

export function okProjection<T>(input: OkProjectionInput<T>): OkProjection<T> {
  return assertValid<OkProjection<T>>({
    schema_version: versionFor(input.surface),
    surface: input.surface,
    source: input.source,
    generated_at: input.generated_at,
    observed_at: input.observed_at,
    freshness: input.freshness,
    state: "ok",
    evidence: input.evidence,
    error: null,
    data: input.data
  });
}

export function degradedProjection<T>(input: DegradedProjectionInput<T>): DegradedProjection<T> {
  return assertValid<DegradedProjection<T>>({
    schema_version: versionFor(input.surface),
    surface: input.surface,
    source: input.source,
    generated_at: input.generated_at,
    observed_at: input.observed_at,
    freshness: input.freshness,
    state: "degraded",
    evidence: input.evidence,
    error: input.error,
    data: input.data
  });
}

export function errorProjection(input: FailedProjectionInput): ErrorProjection {
  return assertValid<ErrorProjection>({
    schema_version: versionFor(input.surface),
    surface: input.surface,
    source: input.source,
    generated_at: input.generated_at,
    observed_at: input.observed_at ?? null,
    freshness: input.freshness,
    state: "error",
    evidence: input.evidence ?? [],
    error: input.error,
    data: null
  });
}

export function unknownProjection(input: FailedProjectionInput): UnknownProjection {
  return assertValid<UnknownProjection>({
    schema_version: versionFor(input.surface),
    surface: input.surface,
    source: input.source,
    generated_at: input.generated_at,
    observed_at: input.observed_at ?? null,
    freshness: input.freshness,
    state: "unknown",
    evidence: input.evidence ?? [],
    error: input.error,
    data: null
  });
}

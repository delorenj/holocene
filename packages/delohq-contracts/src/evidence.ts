// Evidence metadata: where a projection came from and what backs its claims.
// DeloHQ only projects; each canonical system stays the authority for its data.

import { type CanonicalRef, validateCanonicalRef } from "./refs.js";
import {
  type ValidationResult,
  checkKeys,
  describe,
  isIsoUtc,
  isNonEmptyString,
  isRecord,
  prefixIssues
} from "./validation.js";

export const CANONICAL_SYSTEMS = [
  "flume",
  "pjangler",
  "krebs",
  "pilot",
  "bloodbank",
  "candystore",
  "hermes",
  "holocene"
] as const;

export type CanonicalSystem = (typeof CANONICAL_SYSTEMS)[number];

export interface ProjectionSource {
  readonly system: CanonicalSystem;
  // The Holocene adapter that read the system, e.g. "org.ts".
  readonly adapter: string;
}

export interface EvidenceRef {
  // Opaque, preserved byte-for-byte like a CanonicalRef id.
  readonly evidence_ref: string;
  readonly source: ProjectionSource;
  readonly observed_at: string;
  readonly subject?: CanonicalRef;
  readonly summary?: string;
}

export function isCanonicalSystem(value: unknown): value is CanonicalSystem {
  return typeof value === "string" && (CANONICAL_SYSTEMS as readonly string[]).includes(value);
}

export function validateProjectionSource(value: unknown, path = "source"): ValidationResult<ProjectionSource> {
  if (!isRecord(value)) return { ok: false, issues: [`${path}: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, path, ["system", "adapter"]);
  if ("system" in value && !isCanonicalSystem(value.system)) {
    issues.push(`${path}.system: expected one of ${CANONICAL_SYSTEMS.join(", ")}, got ${JSON.stringify(value.system)}`);
  }
  if ("adapter" in value && !isNonEmptyString(value.adapter)) {
    issues.push(`${path}.adapter: expected a non-empty string`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { system: value.system as CanonicalSystem, adapter: value.adapter as string } };
}

export function validateEvidenceRef(value: unknown, path = "evidence"): ValidationResult<EvidenceRef> {
  if (!isRecord(value)) return { ok: false, issues: [`${path}: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, path, ["evidence_ref", "source", "observed_at"], ["subject", "summary"]);
  if ("evidence_ref" in value && !isNonEmptyString(value.evidence_ref)) {
    issues.push(`${path}.evidence_ref: expected a non-empty opaque string`);
  }
  let source: ProjectionSource | undefined;
  if ("source" in value) {
    const result = validateProjectionSource(value.source, `${path}.source`);
    if (result.ok) source = result.value;
    else issues.push(...result.issues);
  }
  if ("observed_at" in value && !isIsoUtc(value.observed_at)) {
    issues.push(`${path}.observed_at: expected an ISO-8601 UTC timestamp ending in Z`);
  }
  let subject: CanonicalRef | undefined;
  if ("subject" in value) {
    const result = validateCanonicalRef(value.subject);
    if (result.ok) subject = result.value;
    else issues.push(...prefixIssues(result.issues, `${path}.subject`));
  }
  if ("summary" in value && typeof value.summary !== "string") {
    issues.push(`${path}.summary: expected a string`);
  }
  if (issues.length > 0 || !source) return { ok: false, issues };
  return {
    ok: true,
    value: {
      evidence_ref: value.evidence_ref as string,
      source,
      observed_at: value.observed_at as string,
      ...(subject ? { subject } : {}),
      ...("summary" in value ? { summary: value.summary as string } : {})
    }
  };
}

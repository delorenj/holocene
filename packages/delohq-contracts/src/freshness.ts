// Freshness vocabulary. This module picks no budgets: each surface's
// max_age_seconds is a caller-supplied policy owned by the Holocene API.
// Classification is pure and takes `now` as a parameter.

import { type ValidationResult, checkKeys, describe, isIsoUtc, isRecord } from "./validation.js";

export const FRESHNESS_STATES = ["fresh", "stale", "expired", "unknown"] as const;

export type FreshnessState = (typeof FRESHNESS_STATES)[number];

// Observations this far in the future are treated as clock skew and clamped to
// age 0; anything further ahead cannot be trusted and classifies as unknown.
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

export interface FreshnessPolicy {
  readonly max_age_seconds: number;
}

export interface Freshness {
  readonly state: FreshnessState;
  readonly max_age_seconds: number;
  // null exactly when state is "unknown".
  readonly age_seconds: number | null;
}

export function isFreshnessState(value: unknown): value is FreshnessState {
  return typeof value === "string" && (FRESHNESS_STATES as readonly string[]).includes(value);
}

function isValidMaxAge(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// fresh when age <= max, stale when age <= 2 * max, otherwise expired.
export function stateForAge(ageSeconds: number, maxAgeSeconds: number): Exclude<FreshnessState, "unknown"> {
  if (ageSeconds <= maxAgeSeconds) return "fresh";
  if (ageSeconds <= 2 * maxAgeSeconds) return "stale";
  return "expired";
}

export function unknownFreshness(policy: FreshnessPolicy): Freshness {
  assertPolicy(policy);
  return { state: "unknown", max_age_seconds: policy.max_age_seconds, age_seconds: null };
}

// Throws RangeError on an invalid policy or `now`: those are programmer
// errors, not untrusted input. A missing or unparseable observed_at is data,
// and yields "unknown".
export function classifyFreshness(observedAt: string | null | undefined, now: string | Date, policy: FreshnessPolicy): Freshness {
  assertPolicy(policy);
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError("classifyFreshness: now is not a valid time");
  if (observedAt == null || !isIsoUtc(observedAt)) return unknownFreshness(policy);
  const ageSeconds = (nowMs - Date.parse(observedAt)) / 1000;
  if (ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) return unknownFreshness(policy);
  const age = Math.max(0, ageSeconds);
  return { state: stateForAge(age, policy.max_age_seconds), max_age_seconds: policy.max_age_seconds, age_seconds: age };
}

function assertPolicy(policy: FreshnessPolicy): void {
  if (!isValidMaxAge(policy?.max_age_seconds)) {
    throw new RangeError("FreshnessPolicy.max_age_seconds must be a positive finite number");
  }
}

export function validateFreshnessPolicy(value: unknown): ValidationResult<FreshnessPolicy> {
  if (!isRecord(value)) return { ok: false, issues: [`policy: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, "policy", ["max_age_seconds"]);
  if ("max_age_seconds" in value && !isValidMaxAge(value.max_age_seconds)) {
    issues.push("policy.max_age_seconds: expected a positive finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { max_age_seconds: value.max_age_seconds as number } };
}

export function validateFreshness(value: unknown): ValidationResult<Freshness> {
  if (!isRecord(value)) return { ok: false, issues: [`freshness: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, "freshness", ["state", "max_age_seconds", "age_seconds"]);
  const { state, max_age_seconds: maxAge, age_seconds: age } = value;
  if ("state" in value && !isFreshnessState(state)) {
    issues.push(`freshness.state: expected one of ${FRESHNESS_STATES.join(", ")}, got ${JSON.stringify(state)}`);
  }
  if ("max_age_seconds" in value && !isValidMaxAge(maxAge)) {
    issues.push("freshness.max_age_seconds: expected a positive finite number");
  }
  if ("age_seconds" in value && age !== null && !(typeof age === "number" && Number.isFinite(age) && age >= 0)) {
    issues.push("freshness.age_seconds: expected null or a non-negative finite number");
  }
  if (issues.length > 0) return { ok: false, issues };

  // The state must be the one the age implies, so nobody can label an old
  // observation "fresh".
  if (state === "unknown") {
    if (age !== null) issues.push("freshness.age_seconds: must be null when state is unknown");
  } else if (age === null) {
    issues.push(`freshness.age_seconds: required when state is ${String(state)}`);
  } else {
    const implied = stateForAge(age as number, maxAge as number);
    if (implied !== state) issues.push(`freshness.state: "${String(state)}" contradicts age_seconds (implies "${implied}")`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { state: state as FreshnessState, max_age_seconds: maxAge as number, age_seconds: age as number | null } };
}

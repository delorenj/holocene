// Projection states and typed failure detail. Each failure mode has its own
// kind so the UI can tell "you are not signed in" from "Flume is down" from
// "the data contradicts itself" (NFR-7).

import { type ProjectionSource, validateProjectionSource } from "./evidence.js";
import { type ValidationResult, checkKeys, describe, hasOwn, isNonEmptyString, isRecord } from "./validation.js";

export const PROJECTION_STATES = ["ok", "degraded", "unknown", "error"] as const;

export type ProjectionState = (typeof PROJECTION_STATES)[number];

export const AUTH_ERROR_KINDS = ["auth_missing", "auth_invalid", "auth_expired", "auth_forbidden"] as const;

export const ERROR_KINDS = [
  ...AUTH_ERROR_KINDS,
  "not_configured",
  "proxy_unreachable",
  "source_unavailable",
  "source_timeout",
  "source_contradictory",
  "contract_violation",
  "command_rejected",
  "command_failed",
  "internal"
] as const;

export type AuthErrorKind = (typeof AUTH_ERROR_KINDS)[number];
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ErrorDetail {
  readonly kind: ErrorKind;
  readonly message: string;
  readonly retryable?: boolean;
  readonly source?: ProjectionSource;
}

export function isProjectionState(value: unknown): value is ProjectionState {
  return typeof value === "string" && (PROJECTION_STATES as readonly string[]).includes(value);
}

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

export function isAuthErrorKind(value: unknown): value is AuthErrorKind {
  return typeof value === "string" && (AUTH_ERROR_KINDS as readonly string[]).includes(value);
}

export function validateErrorDetail(value: unknown, path = "error"): ValidationResult<ErrorDetail> {
  if (!isRecord(value)) return { ok: false, issues: [`${path}: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, path, ["kind", "message"], ["retryable", "source"]);
  if (hasOwn(value, "kind") && !isErrorKind(value.kind)) {
    issues.push(`${path}.kind: expected one of ${ERROR_KINDS.join(", ")}, got ${JSON.stringify(value.kind)}`);
  }
  if (hasOwn(value, "message") && !isNonEmptyString(value.message)) {
    issues.push(`${path}.message: expected a non-empty string`);
  }
  if (hasOwn(value, "retryable") && typeof value.retryable !== "boolean") {
    issues.push(`${path}.retryable: expected a boolean`);
  }
  let source: ProjectionSource | undefined;
  if (hasOwn(value, "source")) {
    const result = validateProjectionSource(value.source, `${path}.source`);
    if (result.ok) source = result.value;
    else issues.push(...result.issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      kind: value.kind as ErrorKind,
      message: value.message as string,
      ...(hasOwn(value, "retryable") ? { retryable: value.retryable as boolean } : {}),
      ...(source ? { source } : {})
    }
  };
}

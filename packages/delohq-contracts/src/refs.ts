// Canonical references: the only join and routing keys in DeloHQ. A ref is
// { kind, id } where id is opaque and preserved byte-for-byte (no trim, no
// case-folding). Display names never go in a ref; pair one with a ref through
// Labeled<R> instead.

import { type ValidationResult, checkKeys, describe, hasOwn, isNonEmptyString, isRecord } from "./validation.js";

export const CANONICAL_REF_KINDS = [
  "employee",
  "project",
  "action",
  "receipt",
  "ticket",
  "event",
  "execution"
] as const;

export type CanonicalRefKind = (typeof CANONICAL_REF_KINDS)[number];

export interface CanonicalRef<K extends CanonicalRefKind = CanonicalRefKind> {
  readonly kind: K;
  readonly id: string;
}

export type EmployeeRef = CanonicalRef<"employee">;
export type ProjectRef = CanonicalRef<"project">;
export type ActionRef = CanonicalRef<"action">;
export type ReceiptRef = CanonicalRef<"receipt">;
export type TicketRef = CanonicalRef<"ticket">;
export type EventRef = CanonicalRef<"event">;
export type ExecutionRef = CanonicalRef<"execution">;

// A ref plus its human label. The label is presentation only and must never
// be used to join, route, or deduplicate.
export interface Labeled<R extends CanonicalRef = CanonicalRef> {
  readonly ref: R;
  readonly label: string;
}

export function isCanonicalRefKind(value: unknown): value is CanonicalRefKind {
  return typeof value === "string" && (CANONICAL_REF_KINDS as readonly string[]).includes(value);
}

// `path` names where the ref sits, so a nested failure reads
// `envelope.evidence[0].subject.kind` rather than `...subject.ref.kind`.
export function validateCanonicalRef(value: unknown, expectedKind?: undefined, path?: string): ValidationResult<CanonicalRef>;
export function validateCanonicalRef<K extends CanonicalRefKind>(
  value: unknown,
  expectedKind: K,
  path?: string
): ValidationResult<CanonicalRef<K>>;
export function validateCanonicalRef(value: unknown, expectedKind?: CanonicalRefKind, path = "ref"): ValidationResult<CanonicalRef> {
  if (!isRecord(value)) return { ok: false, issues: [`${path}: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, path, ["kind", "id"]);
  if (hasOwn(value, "kind") && !isCanonicalRefKind(value.kind)) {
    issues.push(`${path}.kind: expected one of ${CANONICAL_REF_KINDS.join(", ")}, got ${JSON.stringify(value.kind)}`);
  } else if (expectedKind !== undefined && hasOwn(value, "kind") && value.kind !== expectedKind) {
    issues.push(`${path}.kind: expected "${expectedKind}", got "${String(value.kind)}"`);
  }
  if (hasOwn(value, "id") && !isNonEmptyString(value.id)) {
    issues.push(`${path}.id: expected a non-empty opaque string`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { kind: value.kind as CanonicalRefKind, id: value.id as string } };
}

// The only sanctioned join key for a ref. The id is embedded verbatim.
export function refKey(ref: CanonicalRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function sameRef(a: CanonicalRef, b: CanonicalRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

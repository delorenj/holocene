// Canonical references: the only join and routing keys in DeloHQ. A ref is
// { kind, id } where id is opaque and preserved byte-for-byte (no trim, no
// case-folding). Display names never go in a ref; pair one with a ref through
// Labeled<R> instead.

import { type ValidationResult, checkKeys, describe, isNonEmptyString, isRecord } from "./validation.js";

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

export function validateCanonicalRef(value: unknown): ValidationResult<CanonicalRef>;
export function validateCanonicalRef<K extends CanonicalRefKind>(
  value: unknown,
  expectedKind: K
): ValidationResult<CanonicalRef<K>>;
export function validateCanonicalRef(value: unknown, expectedKind?: CanonicalRefKind): ValidationResult<CanonicalRef> {
  if (!isRecord(value)) return { ok: false, issues: [`ref: expected object, got ${describe(value)}`] };
  const issues = checkKeys(value, "ref", ["kind", "id"]);
  if ("kind" in value && !isCanonicalRefKind(value.kind)) {
    issues.push(`ref.kind: expected one of ${CANONICAL_REF_KINDS.join(", ")}, got ${JSON.stringify(value.kind)}`);
  } else if (expectedKind !== undefined && "kind" in value && value.kind !== expectedKind) {
    issues.push(`ref.kind: expected "${expectedKind}", got "${String(value.kind)}"`);
  }
  if ("id" in value && !isNonEmptyString(value.id)) {
    issues.push("ref.id: expected a non-empty opaque string");
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

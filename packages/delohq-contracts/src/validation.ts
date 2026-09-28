// Shared validator plumbing. Every validator in this package returns a
// ValidationResult and never throws on bad input: callers decide whether an
// invalid payload becomes a contract_violation error projection or a test
// failure.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export type Validator<T> = (value: unknown) => ValidationResult<T>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Own-property presence. Never use `in`: an inherited key (a polluted
// prototype, a class instance) must not satisfy a required field.
export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ISO-8601 UTC with a literal Z. Offsets like +00:00 are rejected so every
// *_at on the wire has one spelling.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  // Reject calendar rollovers such as 2026-02-30 that Date.parse accepts.
  return new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

// Report missing required keys and reject any key outside the allowed set.
export function checkKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): string[] {
  const issues: string[] = [];
  for (const key of required) {
    if (!hasOwn(value, key)) issues.push(`${path}: missing required field "${key}"`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}: unknown field "${key}"`);
  }
  return issues;
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Re-home a nested validator's issues under a parent path.
export function prefixIssues(issues: string[], path: string): string[] {
  return issues.map((issue) => `${path}.${issue}`);
}

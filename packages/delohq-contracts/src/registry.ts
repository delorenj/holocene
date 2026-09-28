// The one registry of browser-facing DeloHQ surfaces. A projection whose
// surface is not listed here, or whose schema_version major differs from the
// entry, is rejected. An incompatible change bumps that surface's major.

// Baseline contract version. Surfaces start here and version independently.
export const DELOHQ_SCHEMA_VERSION = "1.0.0";

export const DELOHQ_SURFACES = ["company", "employee", "now", "inbox", "office", "receipt"] as const;

export type DeloHqSurface = (typeof DELOHQ_SURFACES)[number];

export interface SurfaceContract {
  readonly schema_version: string;
}

export const DELOHQ_CONTRACT_REGISTRY: Readonly<Record<DeloHqSurface, SurfaceContract>> = Object.freeze({
  company: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION }),
  employee: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION }),
  now: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION }),
  inbox: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION }),
  office: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION }),
  receipt: Object.freeze({ schema_version: DELOHQ_SCHEMA_VERSION })
});

export function isRegisteredSurface(value: unknown): value is DeloHqSurface {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DELOHQ_CONTRACT_REGISTRY, value);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSchemaVersion(value: unknown): { major: number; minor: number; patch: number } | null {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// Same major as the registry entry. Minor and patch are additive and accepted.
export function isSupportedSchemaVersion(surface: DeloHqSurface, version: unknown): boolean {
  const wanted = parseSchemaVersion(DELOHQ_CONTRACT_REGISTRY[surface].schema_version);
  const got = parseSchemaVersion(version);
  return wanted !== null && got !== null && got.major === wanted.major;
}

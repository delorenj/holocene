// HOLOC-70: the project home's identity contract, agreed with PJAN-234 on 2026-11-26.
// https://holocene.delo.sh/projects/{encodeURIComponent(canonical_project_id)} — one path segment,
// encoded once, canonical lowercase PJangler identity. No aliases: the repo name and board key are
// different identities. Every failure is named, never guessed into another project.

export type RegistryProject = { id: string; name: string; repoPath: string; board?: string; status?: string };
export type IdentityResult =
  | { status: 200; project: RegistryProject }
  | { status: 400 | 404 | 409 | 503; error: string };

/** PJangler ids are lowercase; this is the shape a canonical id may take as one URL segment. */
export const CANONICAL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Validate a raw (still percent-encoded) path segment. Returns the decoded id or a 400 reason. */
export function parseProjectSegment(raw: string): { id: string } | { error: string } {
  if (!raw || raw.length > 300) return { error: "Malformed project id" };
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return { error: "Malformed project id encoding" }; }
  // Encoded once: a decoded value that still holds an escape was double-encoded.
  if (/%[0-9a-f]{2}/i.test(decoded)) return { error: "Project id is encoded more than once" };
  if (!CANONICAL_ID.test(decoded) || decoded === "." || decoded === "..") return { error: `Malformed project id: ${JSON.stringify(decoded.slice(0, 120))} is not a canonical lowercase PJangler id` };
  return { id: decoded };
}

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Resolve against the registry's raw rows. Unlike the hub's project map, duplicates are kept:
 * two rows claiming one canonical id are a conflict (409), never "the last one wins".
 */
export function resolveProject(segment: string, registry: unknown): IdentityResult {
  const parsed = parseProjectSegment(segment);
  if ("error" in parsed) return { status: 400, error: parsed.error };
  if (!record(registry) || !record(registry.projects)) return { status: 503, error: "Project registry answered with an invalid payload" };
  const matches: RegistryProject[] = [];
  for (const [key, snap] of Object.entries(registry.projects)) {
    if (!record(snap)) continue;
    const declared = text(snap.project_id) ?? text(snap.project_slug) ?? key;
    if (declared.toLowerCase() !== parsed.id) continue;
    const tp = record(snap.ticket_provider) ? snap.ticket_provider : {};
    matches.push({ id: parsed.id, name: text(snap.project_name) ?? text(snap.name) ?? declared, repoPath: text(snap.repo_path) ?? "", board: text(tp.identifier), status: text(snap.status) });
  }
  if (!matches.length) return { status: 404, error: `No PJangler project has the id ${parsed.id}` };
  if (matches.length > 1) return { status: 409, error: `${matches.length} registry entries claim the id ${parsed.id}; the identity is conflicting` };
  return { status: 200, project: matches[0] };
}

const PJ_REGISTRY_URL = (process.env.PJ_REGISTRY_URL ?? "http://127.0.0.1:8764").replace(/\/$/, "");

export async function fetchRegistry(fetcher: typeof fetch = fetch): Promise<unknown> {
  const res = await fetcher(`${PJ_REGISTRY_URL}/v1/registry`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  return res.json();
}

export async function lookupProject(segment: string, read: () => Promise<unknown> = fetchRegistry): Promise<IdentityResult> {
  const parsed = parseProjectSegment(segment);
  if ("error" in parsed) return { status: 400, error: parsed.error };
  let registry: unknown;
  try { registry = await read(); } catch { return { status: 503, error: "Project registry unavailable" }; }
  return resolveProject(segment, registry);
}

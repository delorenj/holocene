import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

// The Wax tab's one source: `wax catalog --json`, the safe discovery snapshot the
// Wax CLI itself allows (purposes, capabilities, availability, edges, bindings,
// bounded outcome counts — no env, no command bodies, no stderr). Holocene only
// reads it. This module is deliberately not a scheduler, not an editor and not
// an executor: nothing here can enable a pass, compile a pipeline or run one.

export type WaxSource = {
  name: string;
  value?: string;
  ageSeconds?: number;
  maxSeconds?: number;
  down?: boolean;
  detail?: string;
};

export type WaxPass = {
  slug: string;
  description?: string;
  version?: number;
  enabled?: boolean;
  auto?: boolean;
  kind?: string;
  capabilities?: string[];
  requires?: string[];
  after?: string[];
  emits?: string[];
  timeout_s?: number;
  conditions?: { when?: unknown; skip_when?: unknown } | null;
  availability: { state: string; reason: string };
  outcomes?: Record<string, number>;
};

export type WaxPipelineBinding = {
  binding_id?: string;
  folder?: string;
  enabled?: boolean;
  seeded_at?: string;
  last_scan_at?: string;
  folder_exists?: boolean;
  documents?: number;
  documents_unprocessed?: number;
};

export type WaxPipeline = {
  name: string;
  description?: string;
  authored_path?: string;
  authored_error?: string;
  drift?: { state?: string; detail?: string };
  version?: number;
  definition_id?: string;
  compiled_at?: string;
  trigger?: string;
  enabled?: boolean;
  failure_policy?: string;
  executed_by?: string;
  nodes?: { slug: string; availability?: { state?: string; reason?: string }; capabilities?: string[]; applicable?: boolean }[];
  edges?: { from: string; to: string; kind?: string }[];
  bindings?: WaxPipelineBinding[];
  documents_processed?: number;
  outcomes?: Record<string, Record<string, number>>;
};

export type WaxCatalog = {
  generated_at?: string;
  passes?: WaxPass[];
  counts?: { registered?: number; enabled?: number; automatic?: number; quarantined?: number; failing?: number };
  pipelines?: WaxPipeline[];
  document_status?: { bindings?: WaxPipelineBinding[]; documents_total?: number };
};

export type WaxCatalogPayload = {
  generated_at: string;
  source: WaxSource;
  catalog: WaxCatalog;
};

type Options = { executable?: string; root?: string; timeoutMs?: number; ttlMs?: number; now?: number };

const DEFAULT_EXECUTABLE = process.env.WAX_EXECUTABLE ?? "/home/delorenj/HeyMa/bin/wax";
const DEFAULT_ROOT = process.env.WAX_ROOT ?? "/home/delorenj/HeyMa";
const DEFAULT_TIMEOUT_MS = Number(process.env.WAX_CATALOG_TIMEOUT_MS ?? 10_000);
const DEFAULT_TTL_MS = Number(process.env.WAX_CATALOG_TTL_MS ?? 4_000);

// The allowlist is the policy: a key Wax's catalog grows later is invisible here
// until deliberately added, so a stray env/body/stderr field can never reach a
// hosted surface even if the CLI contract regresses.
const PASS_FIELDS = new Set([
  "slug", "description", "version", "enabled", "auto", "kind", "capabilities",
  "requires", "after", "emits", "timeout_s", "conditions", "availability", "outcomes"
]);

export function projectPass(raw: unknown): WaxPass | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PASS_FIELDS.has(key)) row[key] = value;
  }
  const availability = row.availability as { state?: unknown; reason?: unknown } | undefined;
  if (!availability || typeof availability.state !== "string") return undefined;
  row.availability = { state: availability.state, reason: typeof availability.reason === "string" ? availability.reason : "" };
  return row as unknown as WaxPass;
}

const PIPELINE_FIELDS = new Set([
  "name", "description", "authored_path", "authored_error", "drift", "version",
  "definition_id", "compiled_at", "trigger", "enabled", "failure_policy",
  "executed_by", "nodes", "edges", "bindings", "documents_processed", "outcomes"
]);

function projectPipeline(raw: unknown): WaxPipeline | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PIPELINE_FIELDS.has(key)) row[key] = value;
  }
  if (typeof row.name !== "string") return undefined;
  return row as unknown as WaxPipeline;
}

function projectCatalog(body: unknown): WaxCatalog {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("catalog snapshot is not a JSON object");
  const snapshot = body as Record<string, unknown>;
  // The CLI emits { passes: { passes, counts }, pipelines: { pipelines, document_status } }.
  const passView = snapshot.passes && typeof snapshot.passes === "object" && !Array.isArray(snapshot.passes)
    ? snapshot.passes as Record<string, unknown>
    : {};
  const pipelineView = snapshot.pipelines && typeof snapshot.pipelines === "object" && !Array.isArray(snapshot.pipelines)
    ? snapshot.pipelines as Record<string, unknown>
    : {};
  const passes = Array.isArray(passView.passes)
    ? passView.passes.map(projectPass).filter((p): p is WaxPass => p !== undefined)
    : [];
  const pipelines = Array.isArray(pipelineView.pipelines)
    ? pipelineView.pipelines.map(projectPipeline).filter((p): p is WaxPipeline => p !== undefined)
    : [];
  const counts = passView.counts && typeof passView.counts === "object" && !Array.isArray(passView.counts)
    ? passView.counts as WaxCatalog["counts"]
    : undefined;
  const documentStatus = pipelineView.document_status && typeof pipelineView.document_status === "object" && !Array.isArray(pipelineView.document_status)
    ? pipelineView.document_status as WaxCatalog["document_status"]
    : undefined;
  return {
    generated_at: typeof snapshot.generated_at === "string" ? snapshot.generated_at : undefined,
    passes,
    counts,
    pipelines,
    document_status: documentStatus
  };
}

let cache: { at: number; payload: WaxCatalog } | undefined;

/** Test seam: forget the cached snapshot so the next read hits the CLI. */
export function resetWaxCatalogCache() {
  cache = undefined;
}

/**
 * Read the safe discovery snapshot through the Wax CLI. A CLI failure is a DOWN
 * source — never healthy emptiness: the payload carries no passes unless the CLI
 * actually said so, and the last good read is labeled stale rather than fresh.
 */
export async function readWaxCatalog(options: Options = {}): Promise<WaxCatalogPayload> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && now - cache.at < ttl) {
    return { generated_at: new Date(cache.at).toISOString(), source: waxSource(cache.at, now, ttl), catalog: cache.payload };
  }

  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  const root = options.root ?? DEFAULT_ROOT;
  try {
    const { stdout } = await execFileAsync(executable, ["--json", "catalog"], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...process.env, WAX_ROOT: root },
      maxBuffer: 4 * 1024 * 1024
    });
    const payload = projectCatalog(JSON.parse(stdout));
    cache = { at: now, payload };
    return { generated_at: new Date(now).toISOString(), source: waxSource(now, now, ttl), catalog: payload };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (cache) {
      return { generated_at: new Date(cache.at).toISOString(), source: waxSource(cache.at, now, ttl, `last good read; the CLI now fails: ${detail}`), catalog: cache.payload };
    }
    return {
      generated_at: new Date(now).toISOString(),
      source: { name: "wax catalog", down: true, maxSeconds: ttl / 1000, detail },
      catalog: { passes: [], pipelines: [] }
    };
  }
}

function waxSource(readAt: number, now: number, ttlMs: number, detail?: string): WaxSource {
  const ageSeconds = Math.max(0, (now - readAt) / 1000);
  const stale = detail !== undefined || ageSeconds > ttlMs / 1000 * 4;
  return {
    name: "wax catalog",
    value: stale ? "stale" : "live",
    ageSeconds,
    maxSeconds: (ttlMs / 1000) * 4,
    ...(stale ? { down: true, ...(detail ? { detail } : { detail: "the catalog read is older than its freshness window" }) } : {})
  };
}

export function registerWaxRoutes(app: FastifyInstance) {
  app.get("/api/modules/wax/catalog", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readWaxCatalog();
  });
}

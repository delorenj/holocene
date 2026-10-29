import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

// The Transcripts tab's sources: `wax --json transcripts browse` (the listing and
// the one-transcript detail with its harvested tickets) and `wax --json
// transcripts search --lexical` (the search box). Wax owns the Postgres schema and
// the read-only role; Holocene never connects to the database, it execs the CLI and
// allowlist-projects the answer. Like wax.ts this module is read-only: nothing here
// can classify, harvest, sync or write a transcript.
//
// What never passes: the note body, the note path, the frontmatter block, the S3
// locations and any DSN. The allowlists below are the policy — a key the CLI grows
// later is invisible until it is deliberately added here.

export type TranscriptsSource = {
  name: string;
  value?: string;
  ageSeconds?: number;
  maxSeconds?: number;
  down?: boolean;
  detail?: string;
};

export const CLASSIFICATIONS = ["monolog", "meeting", "phone_call", "other"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const VIEWS = [...CLASSIFICATIONS, "unsorted", "all"] as const;
export type TranscriptView = (typeof VIEWS)[number];

export type HarvestSummary = {
  state: "none" | "harvested" | "no_items" | "unfiled";
  run_count: number;
  ticket_count: number;
  item_count: number;
  last_harvested_at: string | null;
};

export type TranscriptRow = {
  transcript_id: number;
  wax_item_id: string | null;
  classification: Classification | null;
  classification_detail: string | null;
  classification_confidence: number | null;
  classification_source: string | null;
  title: string;
  summary: string | null;
  effective_at: string | null;
  duration_s: number | null;
  word_count: number | null;
  speaker_count: number | null;
  origin: string | null;
  source_hint: string | null;
  tags: string[];
  project_ids: string[];
  projects: string[];
  language: string | null;
  diarized: boolean;
  audio_available: boolean;
  harvest: HarvestSummary;
};

export type TranscriptTicket = {
  harvest_id: string;
  harvested_at: string | null;
  item_id: string;
  title: string;
  category: string | null;
  item_status: string | null;
  gate_state: string | null;
  quote: string | null;
  provider: string | null;
  board_id: string | null;
  publish_status: string | null;
  ticket_ref: string | null;
  ticket_url: string | null;
  project_id: string | null;
  lane: string | null;
  published_at: string | null;
};

export type PassRun = { slug: string; pass_version: number | null; state: string | null; finished_at: string | null };

export type TranscriptProject = { project_id: string; name: string; count: number };

export type TranscriptCounts = Partial<Record<Classification | "unsorted" | "hidden_hermes", number>>;

export type TranscriptsPayload = {
  generated_at: string;
  source: TranscriptsSource;
  store?: { state: string; latest_migration?: string };
  counts: TranscriptCounts;
  rows: TranscriptRow[];
  projects: TranscriptProject[];
  truncated: boolean;
};

export type TranscriptDetailPayload = {
  generated_at: string;
  source: TranscriptsSource;
  row: TranscriptRow | null;
  tickets: TranscriptTicket[];
  pass_history: PassRun[];
};

export type SearchHit = {
  transcript_id: number;
  display_title: string;
  snippet: string | null;
  score: number | null;
  classification: Classification | null;
  effective_at: string | null;
  origin: string | null;
};

export type TranscriptSearchPayload = {
  generated_at: string;
  source: TranscriptsSource;
  query: string;
  results: SearchHit[];
};

type Options = { executable?: string; root?: string; timeoutMs?: number; ttlMs?: number; now?: number };

export type ListQuery = {
  view?: TranscriptView;
  includeHermes?: boolean;
  project?: string;
  since?: string;
  until?: string;
};

const SOURCE_NAME = "wax transcripts";
const DEFAULT_EXECUTABLE = process.env.WAX_EXECUTABLE ?? "/home/delorenj/HeyMa/bin/wax";
const DEFAULT_ROOT = process.env.WAX_ROOT ?? "/home/delorenj/HeyMa";
const DEFAULT_TIMEOUT_MS = Number(process.env.TRANSCRIPTS_TIMEOUT_MS ?? 15_000);
const DEFAULT_TTL_MS = Number(process.env.TRANSCRIPTS_TTL_MS ?? 5_000);
const LIST_LIMIT = 2000;
const SEARCH_LIMIT = 30;
const MAX_CACHE_ENTRIES = 48;

// ---------- allowlist projection ----------

type Kind = "str" | "num" | "bool" | "strs";
type FieldSpec = Record<string, { kind: Kind; cap?: number }>;

const ROW_FIELDS: FieldSpec = {
  transcript_id: { kind: "num" },
  wax_item_id: { kind: "str", cap: 64 },
  classification_detail: { kind: "str", cap: 40 },
  classification_confidence: { kind: "num" },
  classification_source: { kind: "str", cap: 60 },
  title: { kind: "str", cap: 300 },
  summary: { kind: "str", cap: 1200 },
  effective_at: { kind: "str", cap: 40 },
  duration_s: { kind: "num" },
  word_count: { kind: "num" },
  speaker_count: { kind: "num" },
  origin: { kind: "str", cap: 40 },
  source_hint: { kind: "str", cap: 40 },
  tags: { kind: "strs", cap: 60 },
  project_ids: { kind: "strs", cap: 80 },
  projects: { kind: "strs", cap: 120 },
  language: { kind: "str", cap: 16 },
  diarized: { kind: "bool" },
  audio_available: { kind: "bool" }
};

const TICKET_FIELDS: FieldSpec = {
  harvest_id: { kind: "str", cap: 80 },
  harvested_at: { kind: "str", cap: 40 },
  item_id: { kind: "str", cap: 40 },
  title: { kind: "str", cap: 300 },
  category: { kind: "str", cap: 60 },
  item_status: { kind: "str", cap: 20 },
  gate_state: { kind: "str", cap: 20 },
  quote: { kind: "str", cap: 400 },
  provider: { kind: "str", cap: 20 },
  board_id: { kind: "str", cap: 80 },
  publish_status: { kind: "str", cap: 20 },
  ticket_ref: { kind: "str", cap: 60 },
  ticket_url: { kind: "str", cap: 400 },
  project_id: { kind: "str", cap: 80 },
  lane: { kind: "str", cap: 80 },
  published_at: { kind: "str", cap: 40 }
};

const PASS_FIELDS: FieldSpec = {
  slug: { kind: "str", cap: 60 },
  pass_version: { kind: "num" },
  state: { kind: "str", cap: 30 },
  finished_at: { kind: "str", cap: 40 }
};

const HIT_FIELDS: FieldSpec = {
  transcript_id: { kind: "num" },
  display_title: { kind: "str", cap: 300 },
  snippet: { kind: "str", cap: 400 },
  score: { kind: "num" },
  effective_at: { kind: "str", cap: 40 },
  origin: { kind: "str", cap: 40 }
};

const COUNT_KEYS = ["monolog", "meeting", "phone_call", "other", "unsorted", "hidden_hermes"] as const;
const HARVEST_STATES = new Set(["none", "harvested", "no_items", "unfiled"]);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function pick(raw: Record<string, unknown>, spec: FieldSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, { kind, cap: n }] of Object.entries(spec)) {
    const v = raw[key];
    switch (kind) {
      case "str": out[key] = typeof v === "string" ? cap(v, n ?? 300) : null; break;
      case "num": out[key] = typeof v === "number" && Number.isFinite(v) ? v : null; break;
      case "bool": out[key] = v === true; break;
      case "strs":
        out[key] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 24).map((x) => cap(x, n ?? 80)) : [];
        break;
    }
  }
  return out;
}

const asClassification = (v: unknown): Classification | null =>
  typeof v === "string" && (CLASSIFICATIONS as readonly string[]).includes(v) ? (v as Classification) : null;

function projectHarvest(raw: unknown): HarvestSummary {
  const h = isRecord(raw) ? raw : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    state: typeof h.state === "string" && HARVEST_STATES.has(h.state) ? (h.state as HarvestSummary["state"]) : "none",
    run_count: num(h.run_count),
    ticket_count: num(h.ticket_count),
    item_count: num(h.item_count),
    last_harvested_at: typeof h.last_harvested_at === "string" ? cap(h.last_harvested_at, 40) : null
  };
}

export function projectRow(raw: unknown): TranscriptRow | undefined {
  if (!isRecord(raw) || typeof raw.transcript_id !== "number") return undefined;
  const row = pick(raw, ROW_FIELDS);
  // A value outside the four known kinds is not a category: the row counts as unsorted.
  row.classification = asClassification(raw.classification);
  if (typeof row.title !== "string" || !row.title) row.title = `Recording #${raw.transcript_id}`;
  row.harvest = projectHarvest(raw.harvest);
  return row as unknown as TranscriptRow;
}

export function projectTicket(raw: unknown): TranscriptTicket | undefined {
  if (!isRecord(raw)) return undefined;
  const t = pick(raw, TICKET_FIELDS);
  if (typeof t.item_id !== "string" || typeof t.harvest_id !== "string") return undefined;
  // Only an https link is ever offered as a link.
  if (typeof t.ticket_url === "string" && !t.ticket_url.startsWith("https://")) t.ticket_url = null;
  if (typeof t.title !== "string" || !t.title) t.title = "(untitled item)";
  return t as unknown as TranscriptTicket;
}

function projectPass(raw: unknown): PassRun | undefined {
  if (!isRecord(raw)) return undefined;
  const p = pick(raw, PASS_FIELDS);
  return typeof p.slug === "string" ? (p as unknown as PassRun) : undefined;
}

function projectCounts(raw: unknown): TranscriptCounts {
  const out: TranscriptCounts = {};
  if (!isRecord(raw)) return out;
  for (const key of COUNT_KEYS) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function projectStore(raw: unknown): { state: string; latest_migration?: string } | undefined {
  if (!isRecord(raw) || typeof raw.state !== "string") return undefined;
  return {
    state: cap(raw.state, 30),
    ...(typeof raw.latest_migration === "string" ? { latest_migration: cap(raw.latest_migration, 8) } : {})
  };
}

type ListSnapshot = Pick<TranscriptsPayload, "store" | "counts" | "rows" | "projects" | "truncated">;
type DetailSnapshot = Pick<TranscriptDetailPayload, "row" | "tickets" | "pass_history">;
type SearchSnapshot = { query: string; results: SearchHit[] };

export function projectList(body: unknown): ListSnapshot {
  if (!isRecord(body)) throw new Error("transcripts browse is not a JSON object");
  const store = projectStore(body.store);
  if (store && store.state !== "ok") throw new Error(`the transcript store is ${store.state}`);
  if (!Array.isArray(body.rows)) throw new Error("transcripts browse carries no rows array");
  const rows = body.rows.map(projectRow).filter((r): r is TranscriptRow => r !== undefined);
  const projects = Array.isArray(body.projects)
    ? body.projects
        .filter(isRecord)
        .filter((p) => typeof p.project_id === "string")
        .map((p) => ({
          project_id: cap(p.project_id as string, 80),
          name: typeof p.name === "string" ? cap(p.name, 120) : (p.project_id as string),
          count: typeof p.count === "number" && Number.isFinite(p.count) ? p.count : 0
        }))
    : [];
  return { store, counts: projectCounts(body.counts), rows, projects, truncated: body.truncated === true };
}

export function projectDetail(body: unknown): DetailSnapshot {
  if (!isRecord(body)) throw new Error("transcripts detail is not a JSON object");
  const store = projectStore(body.store);
  if (store && store.state !== "ok") throw new Error(`the transcript store is ${store.state}`);
  const row = projectRow(body.row);
  if (!row) throw new Error("transcripts detail carries no row");
  return {
    row,
    tickets: Array.isArray(body.tickets) ? body.tickets.map(projectTicket).filter((t): t is TranscriptTicket => t !== undefined) : [],
    pass_history: Array.isArray(body.pass_history) ? body.pass_history.map(projectPass).filter((p): p is PassRun => p !== undefined) : []
  };
}

export function projectSearch(body: unknown, query: string): SearchSnapshot {
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error("transcripts search carries no results array");
  const results = body.results
    .filter(isRecord)
    .filter((r) => typeof r.transcript_id === "number")
    .map((r) => {
      const hit = pick(r, HIT_FIELDS);
      hit.classification = asClassification(r.classification);
      return hit as unknown as SearchHit;
    });
  return { query, results };
}

// ---------- argument validation (argv only, never a shell) ----------

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isView(v: string): v is TranscriptView {
  return (VIEWS as readonly string[]).includes(v);
}

export function listArgs(q: ListQuery): string[] {
  const args = ["--json", "transcripts", "browse", "--limit", String(LIST_LIMIT)];
  if (q.view && q.view !== "all") args.push("--view", q.view);
  if (q.includeHermes) args.push("--include-hermes");
  if (q.project) {
    if (!PROJECT_ID.test(q.project)) throw new RangeError("project must be a project id");
    args.push("--project", q.project);
  }
  for (const [flag, value] of [["--since", q.since], ["--until", q.until]] as const) {
    if (value === undefined || value === "") continue;
    if (!ISO.test(value)) throw new RangeError(`${flag.slice(2)} must be an ISO date or datetime`);
    args.push(flag, value);
  }
  return args;
}

export function searchArgs(query: string, view?: string): string[] {
  const args = ["--json", "transcripts", "search", "--lexical", "-n", String(SEARCH_LIMIT)];
  if (view && view !== "all" && view !== "unsorted") {
    if (!asClassification(view)) throw new RangeError("view is not a kind");
    args.push("--classification", view);
  }
  // "--" ends the options, so a query that starts with a dash is still a query.
  args.push("--", ...query.split(/\s+/u).filter(Boolean));
  return args;
}

// ---------- cache + failure contract ----------

type CacheEntry<T> = { at: number; value: T };
const caches = {
  list: new Map<string, CacheEntry<ListSnapshot>>(),
  detail: new Map<string, CacheEntry<DetailSnapshot>>(),
  search: new Map<string, CacheEntry<SearchSnapshot>>()
};
const inflight = new Map<string, Promise<unknown>>();

/** Test seam: forget every cached read so the next one hits the CLI. */
export function resetTranscriptsCache() {
  for (const c of Object.values(caches)) c.clear();
  inflight.clear();
}

function remember<T>(map: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>) {
  map.delete(key);
  map.set(key, entry);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function transcriptsSource(readAt: number, now: number, ttlMs: number, detail?: string): TranscriptsSource {
  const ageSeconds = Math.max(0, (now - readAt) / 1000);
  const stale = detail !== undefined || ageSeconds > (ttlMs / 1000) * 4;
  return {
    name: SOURCE_NAME,
    value: stale ? "stale" : "live",
    ageSeconds,
    maxSeconds: (ttlMs / 1000) * 4,
    ...(stale ? { down: true, detail: detail ?? "the transcript read is older than its freshness window" } : {})
  };
}

/** First line of stderr (or the message), capped: raw CLI noise never reaches a hosted page. */
function failureDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const line = (stderr.split("\n").find((l) => l.trim()) ?? (typeof e?.message === "string" ? e.message : String(err))).trim();
  return cap(line, 300);
}

class NotFoundError extends Error {}

type Read<T> = { map: Map<string, CacheEntry<T>>; key: string; args: string[]; project: (body: unknown) => T };

async function cached<T>(read: Read<T>, options: Options): Promise<{ value?: T; source: TranscriptsSource; at: number }> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const hit = read.map.get(read.key);
  if (hit && now - hit.at < ttl) return { value: hit.value, source: transcriptsSource(hit.at, now, ttl), at: hit.at };

  const flightKey = `${read.args.join("\u0000")}`;
  let flight = inflight.get(flightKey) as Promise<T> | undefined;
  if (!flight) {
    flight = (async () => {
      const { stdout } = await execFileAsync(options.executable ?? DEFAULT_EXECUTABLE, read.args, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, WAX_ROOT: options.root ?? DEFAULT_ROOT },
        maxBuffer: 8 * 1024 * 1024
      });
      return read.project(JSON.parse(stdout));
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, flight);
  }
  try {
    const value = await flight;
    remember(read.map, read.key, { at: now, value });
    return { value, source: transcriptsSource(now, now, ttl), at: now };
  } catch (err) {
    const detail = failureDetail(err);
    if (/no transcript #\d+/u.test(detail)) throw new NotFoundError(detail);
    if (hit) {
      return { value: hit.value, source: transcriptsSource(hit.at, now, ttl, `last good read; the CLI now fails: ${detail}`), at: hit.at };
    }
    return { source: { name: SOURCE_NAME, down: true, maxSeconds: ttl / 1000, detail }, at: now };
  }
}

/**
 * The listing. A CLI failure is a DOWN source, never healthy emptiness: without a
 * prior read the payload carries no rows and no counts, and with one it carries the
 * last good read labeled stale.
 */
export async function readTranscripts(query: ListQuery = {}, options: Options = {}): Promise<TranscriptsPayload> {
  const args = listArgs(query);
  const out = await cached<ListSnapshot>({ map: caches.list, key: args.join(" "), args, project: projectList }, options);
  return {
    generated_at: new Date(out.at).toISOString(),
    source: out.source,
    ...(out.value ?? { counts: {}, rows: [], projects: [], truncated: false })
  };
}

export async function readTranscriptDetail(id: number, options: Options = {}): Promise<TranscriptDetailPayload | undefined> {
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("transcript id must be a positive integer");
  const args = ["--json", "transcripts", "browse", "--id", String(id)];
  try {
    const out = await cached<DetailSnapshot>({ map: caches.detail, key: String(id), args, project: projectDetail }, options);
    return {
      generated_at: new Date(out.at).toISOString(),
      source: out.source,
      ...(out.value ?? { row: null, tickets: [], pass_history: [] })
    };
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

/** Lexical search (no embedding call per keystroke). Hits are mapped onto the loaded rows by the page. */
export async function readTranscriptSearch(query: string, view: string | undefined, options: Options = {}): Promise<TranscriptSearchPayload> {
  const q = query.trim();
  if (!q) throw new RangeError("q must not be empty");
  if (q.length > 200) throw new RangeError("q must be at most 200 characters");
  const args = searchArgs(q, view);
  const out = await cached<SearchSnapshot>({ map: caches.search, key: args.join(" "), args, project: (b) => projectSearch(b, q) }, options);
  return {
    generated_at: new Date(out.at).toISOString(),
    source: out.source,
    query: q,
    results: out.value?.results ?? []
  };
}

// ---------- routes ----------

type ListRouteQuery = { view?: string; include_hermes?: string; project?: string; since?: string; until?: string };

export function registerTranscriptRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListRouteQuery }>("/api/modules/transcripts/list", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { view, include_hermes, project, since, until } = req.query;
    if (view !== undefined && !isView(view)) {
      return reply.status(400).send({ error: `Invalid view '${view}'. Use ${VIEWS.join(", ")}.` });
    }
    try {
      return await readTranscripts({ view, includeHermes: include_hermes === "1", project, since, until });
    } catch (err) {
      if (err instanceof RangeError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Querystring: { q?: string; view?: string } }>("/api/modules/transcripts/search", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { q, view } = req.query;
    if (view !== undefined && !isView(view)) {
      return reply.status(400).send({ error: `Invalid view '${view}'. Use ${VIEWS.join(", ")}.` });
    }
    try {
      return await readTranscriptSearch(q ?? "", view);
    } catch (err) {
      if (err instanceof RangeError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/modules/transcripts/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!/^\d{1,12}$/u.test(req.params.id)) return reply.status(400).send({ error: "transcript id must be a positive integer" });
    try {
      const detail = await readTranscriptDetail(Number(req.params.id));
      if (!detail) return reply.status(404).send({ error: `no transcript #${req.params.id}` });
      return detail;
    } catch (err) {
      if (err instanceof RangeError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  });
}

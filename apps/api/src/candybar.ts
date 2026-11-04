import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { streamHeaders } from "./event-stream.js";

// Projection of Candybar, the host's single clock for recurring work (HOLOC-24: Definitions and Schedule), plus the
// row actions. Upstream contracts: candybar/_bmad-output/specs/spec-cron-framework/holocene-view-contract.md (reads)
// and steward-contract.md (archive, profile, steward tasks). The Candybar API sends no CORS headers, so only this
// process talks to it; the browser reads the composed list and writes through the POST-only proxies below, which
// validate every field and forward one narrow call each. Holocene never registers, edits or runs a candybar: that
// stays with the `candybar` CLI.
const CANDYBAR_API_URL = (process.env.CANDYBAR_API_URL ?? "https://candybar.delo.sh").replace(/\/$/, "");
const SOURCE_TIMEOUT_MS = 4_000;
const SCHEDULE_TIMEOUT_MS = 10_000;
const LIST_TTL_MS = 10_000;
const LAST_RUN_TTL_MS = 30_000;
// The 25 h window is ~2.3 MB (minute-cadence jobs dominate), so it is read rarely. The next fire is picked from it at
// request time (first row after now), which stays exact for every fire the window still covers. A window is only
// served while it still reaches 24 h ahead, so "no fire in it" always means "none within 24 h".
const SCHEDULE_TTL_MS = 120_000;
const SCHEDULE_WINDOW_MS = 25 * 3_600_000;
const SCHEDULE_HORIZON_MS = 24 * 3_600_000;
// Candybar refuses a window over 20,000 rows (422); five 5 h slices keep each read far under that as jobs are added.
const SCHEDULE_SLICES = 5;
const LAST_RUN_CONCURRENCY = 8;
const ERROR_MESSAGE_MAX = 240;
const TASKS_LIMIT = 200;

export type LastRun = {
  result: "success" | "fail" | "running";
  trigger?: string;
  startedAt: string;
  finishedAt?: string;
  runtimeMs?: number;
  errorMessage?: string;
};

export type RunResult = LastRun["result"];

export type TaskAction = "enrich" | "fix" | "evaluate" | "refactor";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
export type Task = {
  id: string;
  candybarId: string;
  action: TaskAction;
  status: TaskStatus;
  model?: string;
  parentTaskId?: string;
  sessionId?: string;
  outcome?: string;
  summary?: string;
  reportKey?: string;
  invocationId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type Overview = {
  summary: string;
  purpose: string;
  behavior: string[];
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  dependencies: string[];
  failureModes: string[];
  verification: string[];
  runbook: string[];
  source: { repo: string | null; paths: string[]; runner: string };
  cadenceNote: string;
};
export type EvaluationOutcome = "Nominal" | "Suboptimal" | "Drifted" | "Orphaned";
export type AxisName = "efficacy" | "cost" | "value" | "usage" | "alternatives";
export type Evaluation = {
  outcome: EvaluationOutcome;
  summary: string;
  axes: Partial<Record<AxisName, { rating: "good" | "fair" | "poor"; finding: string }>>;
  recommendation: string;
  followUp: "none" | "refactor" | "fix" | "archive";
  reportKey: string;
  evaluatedAt?: string;
  taskId?: string;
};
export type Profile = {
  overview: Overview | null;
  templateVersion: number | null;
  project: { id: string; name: string; confidence: number; method: "ledger" | "jev" | "manual" } | null;
  enrichedAt: string | null;
  evaluation: Evaluation | null;
};
export type RowTasks = { active: Task[]; latest: Partial<Record<TaskAction, Task>> };

export type CandybarRow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  schedule: string;
  timezone: string;
  noise: boolean;
  enabled: boolean;
  /** Hidden from the lists and the schedule; shown only in the Archived view. */
  archived: boolean;
  createdAt: string;
  /** The next fire within the schedule window; null when none falls inside it (or the candybar is disabled). */
  nextFire: string | null;
  /** The newest invocation; null when it has never run. Absent when it could not be read. */
  lastRun?: LastRun | null;
  /** The last (up to) 30 invocation results, oldest first. Absent when they could not be read. */
  history?: RunResult[];
  /** Overview, project and evaluation; null when the candybar has none yet. Absent when profiles could not be read. */
  profile?: Profile | null;
  /** Steward tasks: those still queued or running, and the newest of each action. Absent when they could not be read. */
  tasks?: RowTasks;
};

export type CandybarSource = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

export type CandybarPayload = {
  generated_at: string;
  source: CandybarSource;
  /** Archived rows are counted only in `archived`, never in the others. */
  counts: { total: number; active: number; inactive: number; failing: number; archived: number };
  /** Whether nextFire is known, and how far ahead it looks. */
  window: { known: boolean; to?: string };
  /** Partial reads that did not fail the list (schedule window, last runs). */
  warnings: string[];
  candybars: CandybarRow[];
};

type Fetch = typeof fetch;
type Raw = { ok: true; body: unknown } | { ok: false; error: string };

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out after ${timeoutMs}ms`;
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

async function getJson(fetchImpl: Fetch, baseUrl: string, path: string, timeoutMs = SOURCE_TIMEOUT_MS): Promise<Raw> {
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      // Errors are application/problem+json, but a proxy in front may answer bare text: never assume JSON.
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
      return { ok: false, error: snippet ? `HTTP ${response.status}: ${snippet}` : `HTTP ${response.status}` };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, error: "response was not JSON" };
    }
  } catch (err) {
    return { ok: false, error: describeError(err, timeoutMs) };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A timestamp the browser can format; anything else is dropped rather than passed on to throw in Intl. */
const stamp = (v: unknown): string | undefined => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined);

// ---------------------------------------------------------------------------------------------------------------------
// Projection (pure). Allowlists only: nothing the contract does not name reaches the browser.

export type Definition = Omit<CandybarRow, "nextFire" | "lastRun">;

export function projectDefinition(raw: unknown): Definition | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const name = str(raw.name);
  const schedule = str(raw.schedule);
  if (!id || !name || !schedule || typeof raw.enabled !== "boolean") return undefined;
  return {
    id,
    name,
    description: str(raw.description) ?? "",
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    schedule,
    timezone: str(raw.timezone) ?? "UTC",
    noise: raw.noise === true,
    enabled: raw.enabled,
    archived: raw.archived === true,
    createdAt: stamp(raw.createdAt) ?? ""
  };
}

export function projectLastRun(raw: unknown): LastRun | null | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.invocations)) return undefined;
  const inv = raw.invocations[0];
  if (inv === undefined) return null;
  if (!isRecord(inv)) return undefined;
  const startedAt = stamp(inv.startedAt);
  if (!startedAt) return undefined;
  const result = inv.result === "success" || inv.result === "fail" ? inv.result : inv.result == null ? "running" : undefined;
  if (!result) return undefined;
  const message = str(inv.errorMessage)?.replace(/\s+/g, " ").trim();
  return {
    result,
    trigger: str(inv.trigger),
    startedAt,
    finishedAt: stamp(inv.finishedAt),
    runtimeMs: num(inv.runtimeMs),
    ...(message ? { errorMessage: message.length > ERROR_MESSAGE_MAX ? `${message.slice(0, ERROR_MESSAGE_MAX - 1)}…` : message } : {})
  };
}

const HISTORY_LIMIT = 30;

/** The newest (up to) 30 invocation results, oldest first. Undefined when the body is not an invocation list. */
export function projectHistory(raw: unknown): RunResult[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.invocations)) return undefined;
  const out: RunResult[] = [];
  // Candybar answers newest first.
  for (const inv of raw.invocations.slice(0, HISTORY_LIMIT)) {
    if (!isRecord(inv)) continue;
    const result = inv.result === "success" || inv.result === "fail" ? inv.result : inv.result == null ? "running" : undefined;
    if (result) out.push(result);
  }
  return out.reverse();
}

const TEXT_MAX = 4_000;
const clip = (v: unknown, max = TEXT_MAX): string | undefined => {
  const s = str(v);
  return s === undefined ? undefined : s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const strings = (v: unknown, max = 40): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => clip(x, 1_000) ?? "") : [];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);

const TASK_ACTIONS = ["enrich", "fix", "evaluate", "refactor"] as const;
const TASK_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export function projectTask(raw: unknown): Task | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const candybarId = str(raw.candybarId);
  const action = oneOf(raw.action, TASK_ACTIONS);
  const status = oneOf(raw.status, TASK_STATUSES);
  const createdAt = stamp(raw.createdAt);
  if (!id || !candybarId || !action || !status || !createdAt) return undefined;
  const opt = <K extends string, V>(key: K, value: V | undefined | null): Partial<Record<K, V>> =>
    value === undefined || value === null || value === "" ? {} : ({ [key]: value } as Record<K, V>);
  return {
    id,
    candybarId,
    action,
    status,
    createdAt,
    ...opt("model", str(raw.model)),
    ...opt("parentTaskId", str(raw.parentTaskId)),
    ...opt("sessionId", str(raw.sessionId)),
    ...opt("outcome", str(raw.outcome)),
    ...opt("summary", clip(raw.summary)),
    ...opt("reportKey", str(raw.reportKey)),
    ...opt("invocationId", str(raw.invocationId)),
    ...opt("error", clip(raw.error)),
    ...opt("startedAt", stamp(raw.startedAt)),
    ...opt("finishedAt", stamp(raw.finishedAt))
  };
}

function projectOverview(raw: unknown): Overview | null {
  if (!isRecord(raw)) return null;
  const source = isRecord(raw.source) ? raw.source : {};
  return {
    summary: clip(raw.summary, 600) ?? "",
    purpose: clip(raw.purpose) ?? "",
    behavior: strings(raw.behavior),
    inputs: strings(raw.inputs),
    outputs: strings(raw.outputs),
    sideEffects: strings(raw.sideEffects),
    dependencies: strings(raw.dependencies),
    failureModes: strings(raw.failureModes),
    verification: strings(raw.verification),
    runbook: strings(raw.runbook),
    source: { repo: str(source.repo) ?? null, paths: strings(source.paths), runner: str(source.runner) ?? "" },
    cadenceNote: clip(raw.cadenceNote) ?? ""
  };
}

const OUTCOMES = ["Nominal", "Suboptimal", "Drifted", "Orphaned"] as const;
const AXES = ["efficacy", "cost", "value", "usage", "alternatives"] as const;
const FOLLOW_UPS = ["none", "refactor", "fix", "archive"] as const;

function projectEvaluation(raw: unknown): Evaluation | null {
  if (!isRecord(raw)) return null;
  const outcome = oneOf(raw.outcome, OUTCOMES);
  if (!outcome) return null;
  const axes: Evaluation["axes"] = {};
  const rawAxes = isRecord(raw.axes) ? raw.axes : {};
  for (const name of AXES) {
    const a = rawAxes[name];
    const rating = isRecord(a) ? oneOf(a.rating, ["good", "fair", "poor"] as const) : undefined;
    if (isRecord(a) && rating) axes[name] = { rating, finding: clip(a.finding) ?? "" };
  }
  return {
    outcome,
    summary: clip(raw.summary) ?? "",
    axes,
    recommendation: clip(raw.recommendation) ?? "",
    followUp: oneOf(raw.followUp, FOLLOW_UPS) ?? "none",
    reportKey: str(raw.reportKey) ?? "",
    ...(stamp(raw.evaluatedAt) ? { evaluatedAt: stamp(raw.evaluatedAt) } : {}),
    ...(str(raw.taskId) ? { taskId: str(raw.taskId) } : {})
  };
}

export function projectProfile(raw: unknown): (Profile & { candybarId: string }) | undefined {
  if (!isRecord(raw)) return undefined;
  const candybarId = str(raw.candybarId);
  if (!candybarId) return undefined;
  const p = isRecord(raw.project) ? raw.project : undefined;
  const method = p ? oneOf(p.method, ["ledger", "jev", "manual"] as const) : undefined;
  return {
    candybarId,
    overview: projectOverview(raw.overview),
    templateVersion: num(raw.templateVersion) ?? null,
    project: p && str(p.id) && str(p.name) && method ? { id: str(p.id)!, name: str(p.name)!, confidence: num(p.confidence) ?? 0, method } : null,
    enrichedAt: stamp(raw.enrichedAt) ?? null,
    evaluation: projectEvaluation(raw.evaluation)
  };
}

/** Each candybar's not-skipped fire times inside the window, ascending. */
export function indexFires(raw: unknown): Map<string, number[]> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fires = new Map<string, number[]>();
  for (const row of raw) {
    if (!isRecord(row) || row.skipped === true) continue;
    const id = str(row.candybarId);
    const t = Date.parse(str(row.fireTime) ?? "");
    if (!id || !Number.isFinite(t)) continue;
    const list = fires.get(id);
    if (list) list.push(t);
    else fires.set(id, [t]);
  }
  for (const list of fires.values()) list.sort((a, b) => a - b);
  return fires;
}

export function nextFireAfter(fires: number[] | undefined, now: number): string | null {
  const t = fires?.find((f) => f > now);
  return t === undefined ? null : new Date(t).toISOString();
}

const byName = (a: Definition, b: Definition) => a.name.localeCompare(b.name);

/** Steward tasks for one candybar: those still in flight, and the newest of each action. */
export function summarizeTasks(tasks: Task[], candybarId: string): RowTasks {
  const mine = tasks.filter((t) => t.candybarId === candybarId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latest: RowTasks["latest"] = {};
  for (const t of mine) latest[t.action] ??= t;
  return { active: mine.filter((t) => t.status === "queued" || t.status === "running"), latest };
}

export function composePayload(input: {
  now: number;
  definitions: Definition[];
  /** When the served list was read; absent when it never loaded. */
  listAt?: number;
  listDown?: string;
  fires?: Map<string, number[]>;
  windowTo?: number;
  scheduleError?: string;
  lastRuns: Map<string, LastRun | null | undefined>;
  histories?: Map<string, RunResult[] | undefined>;
  lastRunErrors: number;
  /** Absent when profiles could not be read. */
  profiles?: Map<string, Profile>;
  profilesError?: string;
  /** Absent when steward tasks could not be read. */
  tasks?: Task[];
  tasksError?: string;
}): CandybarPayload {
  const { now, definitions, fires, lastRuns, histories, profiles, tasks } = input;
  const candybars: CandybarRow[] = [...definitions].sort(byName).map((d) => {
    const lastRun = lastRuns.get(d.id);
    const history = histories?.get(d.id);
    return {
      ...d,
      nextFire: d.enabled && !d.archived && fires ? nextFireAfter(fires.get(d.id), now) : null,
      ...(lastRun !== undefined ? { lastRun } : {}),
      ...(history !== undefined ? { history } : {}),
      ...(profiles ? { profile: profiles.get(d.id) ?? null } : {}),
      ...(tasks ? { tasks: summarizeTasks(tasks, d.id) } : {})
    };
  });
  // Archived candybars are counted on their own and never in the other totals.
  const live = candybars.filter((c) => !c.archived);
  const active = live.filter((c) => c.enabled).length;
  const warnings: string[] = [];
  if (input.scheduleError) warnings.push(`next fires ${fires ? "from an older read" : "unavailable"}: ${input.scheduleError}`);
  if (input.lastRunErrors) warnings.push(`last run could not be refreshed for ${input.lastRunErrors} of ${candybars.length} candybars`);
  if (input.profilesError) warnings.push(`profiles unavailable: ${input.profilesError}`);
  if (input.tasksError) warnings.push(`steward tasks unavailable: ${input.tasksError}`);
  return {
    generated_at: new Date(now).toISOString(),
    source: {
      name: "candybar",
      value: input.listDown ? "stale" : "live",
      ...(input.listAt !== undefined ? { ageSeconds: Math.max(0, Math.round((now - input.listAt) / 1000)) } : {}),
      maxSeconds: LIST_TTL_MS / 1000,
      ...(input.listDown ? { down: true, detail: `${CANDYBAR_API_URL}: ${input.listDown}` } : {})
    },
    counts: {
      total: live.length,
      active,
      inactive: live.length - active,
      failing: live.filter((c) => c.enabled && c.lastRun?.result === "fail").length,
      archived: candybars.length - live.length
    },
    window: fires ? { known: true, ...(input.windowTo ? { to: new Date(input.windowTo).toISOString() } : {}) } : { known: false },
    warnings,
    candybars
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading, with caches. Every upstream failure degrades one part; only a list that never loaded is an empty page.

type Cached<T> = { at: number; value: T };
type ListRead = { definitions: Definition[]; at?: number; down?: string };
type ScheduleRead = { fires?: Map<string, number[]>; to?: number; error?: string; fingerprint: string };
type LastRunEntry = { at: number; value: LastRun | null | undefined; history: RunResult[] | undefined; failed: boolean };
type ProfilesRead = { profiles?: Map<string, Profile>; error?: string };
type TasksRead = { tasks?: Task[]; error?: string };

let lastGoodList: Cached<Definition[]> | undefined;
let listCache: Cached<ListRead> | undefined;
let scheduleCache: Cached<ScheduleRead> | undefined;
const lastRunCache = new Map<string, LastRunEntry>();
let profilesCache: Cached<ProfilesRead> | undefined;
let tasksCache: Cached<TasksRead> | undefined;
let inflight: Promise<CandybarPayload> | undefined;
/** Bumped by every write; a read that began before one does not repopulate the caches it just invalidated. */
let generation = 0;

export function resetCandybarCache() {
  lastGoodList = undefined;
  listCache = undefined;
  scheduleCache = undefined;
  lastRunCache.clear();
  profilesCache = undefined;
  tasksCache = undefined;
  inflight = undefined;
}

/**
 * A successful write makes the next list read go back to Candybar for what the write can have changed (the definitions,
 * profiles and tasks; the schedule window too when fires move), instead of serving the TTL'd copy. Last runs are kept.
 */
function invalidateAfterWrite(opts: { schedule?: boolean } = {}) {
  generation += 1;
  listCache = undefined;
  profilesCache = undefined;
  tasksCache = undefined;
  if (opts.schedule) scheduleCache = undefined;
  inflight = undefined;
}

/** What the schedule window depends on: a new, re-enabled or rescheduled candybar invalidates the cached window. */
export function scheduleFingerprint(definitions: Definition[]): string {
  return definitions
    .filter((d) => d.enabled)
    .map((d) => `${d.id} ${d.schedule} ${d.timezone}`)
    .sort()
    .join("\n");
}

async function readList(fetchImpl: Fetch, baseUrl: string, now: number): Promise<ListRead> {
  if (listCache && now - listCache.at < LIST_TTL_MS) return listCache.value;
  const gen = generation;
  const raw = await getJson(fetchImpl, baseUrl, "/candybars");
  let read: ListRead;
  if (raw.ok && Array.isArray(raw.body)) {
    const definitions = raw.body.map(projectDefinition).filter((d): d is Definition => d !== undefined);
    lastGoodList = { at: now, value: definitions };
    read = { definitions, at: now };
    const ids = new Set(definitions.map((d) => d.id));
    for (const id of lastRunCache.keys()) if (!ids.has(id)) lastRunCache.delete(id);
  } else {
    const error = raw.ok ? "GET /candybars did not return a list" : raw.error;
    read = { definitions: lastGoodList?.value ?? [], at: lastGoodList?.at, down: error };
  }
  if (gen === generation) listCache = { at: now, value: read };
  return read;
}

async function readProfiles(fetchImpl: Fetch, baseUrl: string, now: number): Promise<ProfilesRead> {
  if (profilesCache && now - profilesCache.at < LIST_TTL_MS) return profilesCache.value;
  const gen = generation;
  const raw = await getJson(fetchImpl, baseUrl, "/profiles");
  let read: ProfilesRead;
  if (raw.ok && isRecord(raw.body) && Array.isArray(raw.body.profiles)) {
    const profiles = new Map<string, Profile>();
    for (const p of raw.body.profiles) {
      const projected = projectProfile(p);
      if (projected) profiles.set(projected.candybarId, (({ candybarId: _id, ...profile }) => profile)(projected));
    }
    read = { profiles };
  } else read = { error: raw.ok ? "GET /profiles did not return { profiles }" : raw.error };
  if (gen === generation) profilesCache = { at: now, value: read };
  return read;
}

async function readTasks(fetchImpl: Fetch, baseUrl: string, now: number): Promise<TasksRead> {
  if (tasksCache && now - tasksCache.at < LIST_TTL_MS) return tasksCache.value;
  const gen = generation;
  const raw = await getJson(fetchImpl, baseUrl, `/steward/tasks?limit=${TASKS_LIMIT}`);
  let read: TasksRead;
  if (raw.ok && isRecord(raw.body) && Array.isArray(raw.body.tasks)) {
    read = { tasks: raw.body.tasks.map(projectTask).filter((t): t is Task => t !== undefined) };
  } else read = { error: raw.ok ? "GET /steward/tasks did not return { tasks }" : raw.error };
  if (gen === generation) tasksCache = { at: now, value: read };
  return read;
}

async function readSchedule(fetchImpl: Fetch, baseUrl: string, now: number, fingerprint: string): Promise<ScheduleRead> {
  const hit = scheduleCache;
  if (hit && hit.value.fingerprint === fingerprint && now - hit.at < (hit.value.error ? LIST_TTL_MS : SCHEDULE_TTL_MS)) {
    return hit.value;
  }
  const to = now + SCHEDULE_WINDOW_MS;
  const slice = SCHEDULE_WINDOW_MS / SCHEDULE_SLICES;
  const reads = await Promise.all(
    Array.from({ length: SCHEDULE_SLICES }, (_, i) => {
      const params = new URLSearchParams({ from: new Date(now + i * slice).toISOString(), to: new Date(now + (i + 1) * slice).toISOString() });
      return getJson(fetchImpl, baseUrl, `/schedule?${params}`, SCHEDULE_TIMEOUT_MS);
    })
  );
  const failed = reads.find((r) => !r.ok || !Array.isArray(r.body));
  let read: ScheduleRead;
  if (!failed) read = { fires: indexFires(reads.flatMap((r) => (r.ok ? (r.body as unknown[]) : []))), to, fingerprint };
  else {
    const error = failed.ok ? "GET /schedule did not return a list" : failed.error;
    // Keep serving the previous window only for the same definitions and while it still reaches 24 h ahead, so an
    // empty answer from it still means "nothing within 24 h".
    const prev = hit?.value;
    read = prev?.fires && prev.to && prev.fingerprint === fingerprint && prev.to - now >= SCHEDULE_HORIZON_MS
      ? { ...prev, error }
      : { error, fingerprint };
  }
  scheduleCache = { at: now, value: read };
  return read;
}

async function readLastRuns(fetchImpl: Fetch, baseUrl: string, ids: string[], now: number) {
  const out = new Map<string, LastRun | null | undefined>();
  const histories = new Map<string, RunResult[] | undefined>();
  let errors = 0;
  const due = ids.filter((id) => {
    const hit = lastRunCache.get(id);
    if (hit && now - hit.at < LAST_RUN_TTL_MS) {
      out.set(id, hit.value);
      histories.set(id, hit.history);
      if (hit.failed) errors += 1;
      return false;
    }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const id = due[next++];
      const raw = await getJson(fetchImpl, baseUrl, `/candybars/${encodeURIComponent(id)}/invocations?limit=${HISTORY_LIMIT}`);
      const run = raw.ok ? projectLastRun(raw.body) : undefined;
      const history = raw.ok ? projectHistory(raw.body) : undefined;
      const failed = run === undefined;
      // A failed read keeps the previous answer rather than blanking a row that was readable a moment ago, and is
      // still counted in the warning.
      const value = failed ? lastRunCache.get(id)?.value : run;
      const kept = failed ? lastRunCache.get(id)?.history : history;
      if (failed) errors += 1;
      lastRunCache.set(id, { at: now, value, history: kept, failed });
      out.set(id, value);
      histories.set(id, kept);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LAST_RUN_CONCURRENCY, due.length) }, worker));
  return { lastRuns: out, histories, errors };
}

export async function readCandybars(opts: { fetchImpl?: Fetch; baseUrl?: string; now?: () => number } = {}): Promise<CandybarPayload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? CANDYBAR_API_URL;
  const clock = opts.now ?? Date.now;
  const now = clock();
  const list = await readList(fetchImpl, baseUrl, now);
  // The window, the last runs, the profiles and the steward tasks read side by side, so one slow read never holds up
  // the others' columns.
  const [schedule, runs, profiles, tasks] = await Promise.all([
    readSchedule(fetchImpl, baseUrl, now, scheduleFingerprint(list.definitions)),
    list.down
      ? {
          lastRuns: new Map(list.definitions.map((d) => [d.id, lastRunCache.get(d.id)?.value] as const)),
          histories: new Map(list.definitions.map((d) => [d.id, lastRunCache.get(d.id)?.history] as const)),
          errors: 0
        }
      : readLastRuns(fetchImpl, baseUrl, list.definitions.map((d) => d.id), now),
    // With Candybar down, whatever was last read stands in; no further reads that would only time out.
    list.down ? (profilesCache?.value ?? {}) : readProfiles(fetchImpl, baseUrl, now),
    list.down ? (tasksCache?.value ?? {}) : readTasks(fetchImpl, baseUrl, now)
  ]);
  return composePayload({
    now: clock(),
    definitions: list.definitions,
    listAt: list.at,
    listDown: list.down,
    fires: schedule.fires,
    windowTo: schedule.to,
    scheduleError: schedule.error,
    lastRuns: runs.lastRuns,
    histories: runs.histories,
    lastRunErrors: runs.errors,
    profiles: profiles.profiles,
    profilesError: profiles.error,
    tasks: tasks.tasks,
    tasksError: tasks.error
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Schedule view: a day's fires as one compact snapshot, then Candybar's own SSE stream, piped through unchanged.

// A local day is 23-25 h; anything longer is not a view this tab asks for (Candybar itself allows 31 days).
const DAY_WINDOW_MAX_MS = 26 * 3_600_000;
// Each /schedule read stays far under Candybar's 20,000-row refusal (a 5 h slice is ~2,400 rows today).
const DAY_SLICE_MS = 5 * 3_600_000;
const STREAM_CONNECT_TIMEOUT_MS = 10_000;
// Candybar's own keepalive is once a minute, but the Next.js rewrite drops a proxied response after 30 s without
// bytes, silently: the browser sees neither an error nor an end. A ping every 15 s keeps the path open and gives the
// page something to watch.
const STREAM_PING_MS = 15_000;
const PING_FRAME = "event: ping\ndata: {}\n\n";

/**
 * Candybar's SSE frames, unchanged and whole, with a `ping` event between frames whenever the line has been quiet
 * for `intervalMs`. A ping carries no id, so it never moves the browser's Last-Event-ID.
 */
export function withPings(source: Readable, intervalMs = STREAM_PING_MS): PassThrough {
  const out = new PassThrough();
  let partial = "";
  let quietSince = Date.now();
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    partial += chunk;
    const end = partial.lastIndexOf("\n\n");
    if (end < 0) return;
    out.write(partial.slice(0, end + 2));
    partial = partial.slice(end + 2);
    quietSince = Date.now();
  });
  const timer = setInterval(() => {
    // Only between frames: a ping inside a half-received frame would corrupt it.
    if (partial || Date.now() - quietSince < intervalMs) return;
    out.write(PING_FRAME);
    quietSince = Date.now();
  }, Math.max(10, Math.floor(intervalMs / 3)));
  const stop = () => clearInterval(timer);
  source.on("end", () => {
    stop();
    out.end(partial);
  });
  // An aborted upstream (viewer gone, shutdown) ends with an AbortError; the viewer then reconnects on its own.
  source.on("error", () => {
    stop();
    out.end();
  });
  out.on("close", () => {
    stop();
    source.destroy();
  });
  return out;
}

export type ScheduleCandybar = { id: string; name: string; schedule: string; noise: boolean };
/** [candybar index, fireTime as Candybar wrote it, state, lastResult, skipped]. */
export type ScheduleTuple = [number, string, "past" | "current" | "upcoming", "success" | "fail" | null, 0 | 1];
export type SchedulePayload = {
  generated_at: string;
  from: string;
  to: string;
  candybars: ScheduleCandybar[];
  rows: ScheduleTuple[];
};

/** A UTC-offset ISO window no longer than a long local day, or an error message. */
export function parseWindow(query: Record<string, unknown>): { from: string; to: string } | { error: string } {
  const from = typeof query.from === "string" ? query.from : "";
  const to = typeof query.to === "string" ? query.to : "";
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return { error: "from and to must be ISO timestamps" };
  if (t <= f) return { error: "to must be after from" };
  if (t - f > DAY_WINDOW_MAX_MS) return { error: "the window is longer than a day" };
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString() };
}

const STATES = new Set(["past", "current", "upcoming"]);

/** Allowlisted, deduplicated rows; fireTime stays verbatim, because the stream's patch keys use Candybar's spelling. */
export function compactSchedule(raws: unknown[], window: { from: string; to: string }, now: number, hide?: ReadonlySet<string>): SchedulePayload {
  const index = new Map<string, number>();
  const candybars: ScheduleCandybar[] = [];
  const rows: ScheduleTuple[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!isRecord(raw)) continue;
    const id = str(raw.candybarId);
    const fireTime = stamp(raw.fireTime);
    const state = str(raw.state);
    if (!id || !fireTime || !state || !STATES.has(state) || hide?.has(id)) continue;
    const key = `${id}@${fireTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let i = index.get(id);
    if (i === undefined) {
      i = candybars.length;
      index.set(id, i);
      candybars.push({ id, name: str(raw.name) ?? id, schedule: str(raw.schedule) ?? "", noise: raw.noise === true });
    }
    const result = raw.lastResult === "success" || raw.lastResult === "fail" ? raw.lastResult : null;
    rows.push([i, fireTime, state as ScheduleTuple[2], result, raw.skipped === true ? 1 : 0]);
  }
  rows.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]) || candybars[a[0]].name.localeCompare(candybars[b[0]].name));
  return { generated_at: new Date(now).toISOString(), ...window, candybars, rows };
}

export async function readDaySchedule(
  window: { from: string; to: string },
  opts: { fetchImpl?: Fetch; baseUrl?: string; now?: () => number; /** Candybars whose fires never show (archived). */ hide?: ReadonlySet<string> } = {}
): Promise<SchedulePayload | { error: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? CANDYBAR_API_URL;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const bounds: Array<[number, number]> = [];
  for (let at = from; at < to; at += DAY_SLICE_MS) bounds.push([at, Math.min(at + DAY_SLICE_MS, to)]);
  const reads = await Promise.all(
    bounds.map(([a, b]) => {
      const params = new URLSearchParams({ from: new Date(a).toISOString(), to: new Date(b).toISOString() });
      return getJson(fetchImpl, baseUrl, `/schedule?${params}`, SCHEDULE_TIMEOUT_MS);
    })
  );
  const failed = reads.find((r) => !r.ok || !Array.isArray(r.body));
  if (failed) return { error: failed.ok ? "GET /schedule did not return a list" : failed.error };
  return compactSchedule(reads.flatMap((r) => (r.ok ? (r.body as unknown[]) : [])), window, (opts.now ?? Date.now)(), opts.hide);
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes: POST-only proxies, one narrow upstream call each. Every id and body field is validated here, Candybar's own
// refusal (application/problem+json) comes back as { error } with its status, and an unreachable Candybar is a 502.

const WRITE_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEWARD_ACTIONS = ["enrich", "fix", "evaluate"] as const;

type Sent = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; body?: unknown };

/** Candybar's reason for a refusal: a problem+json `detail`, else its `title`, else a snippet of whatever came back. */
export function problemMessage(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (isRecord(body)) {
      const message = str(body.detail) ?? str(body.title);
      if (message) return message.replace(/\s+/g, " ").trim().slice(0, 300);
    }
  } catch {
    // not JSON: a proxy in front may answer bare text
  }
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 160);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

async function sendJson(fetchImpl: Fetch, baseUrl: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown): Promise<Sent> {
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) return { ok: false, status: response.status, error: problemMessage(text, response.status), body };
    return { ok: true, status: response.status, body };
  } catch (err) {
    return { ok: false, status: 502, error: `${baseUrl}: ${describeError(err, WRITE_TIMEOUT_MS)}` };
  }
}

const bodyOf = (request: { body?: unknown }): Record<string, unknown> => (isRecord(request.body) ? request.body : {});

/** The `YYYY-MM-DD` of an instant in a time zone: the candybar's own day, which is what skip-rest-of-day takes. */
export function localDate(t: number, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const [y, m, d] = [get("year"), get("month"), get("day")];
    return y && m && d ? `${y}-${m}-${d}` : undefined;
  } catch {
    return undefined; // an unknown zone name
  }
}

/** A fire time as Candybar wants it: a whole-minute UTC instant. */
export function parseFireTime(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t % 60_000 !== 0) return undefined;
  return new Date(t).toISOString().replace(".000Z", "Z");
}

export function registerCandybarRoutes(app: FastifyInstance, opts: { fetchImpl?: Fetch; baseUrl?: string; pingMs?: number } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? CANDYBAR_API_URL;
  const pingMs = opts.pingMs ?? STREAM_PING_MS;

  app.get("/api/modules/candybar/list", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Concurrent callers share one upstream read.
    const read: Promise<CandybarPayload> = (inflight ??= readCandybars(opts).finally(() => {
      if (inflight === read) inflight = undefined;
    }));
    return read;
  });

  app.get("/api/modules/candybar/schedule", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const window = parseWindow(request.query as Record<string, unknown>);
    if ("error" in window) return reply.status(400).send({ error: window.error });
    // Archived candybars never show. Their ids come from the (cached) list; if it cannot be read, nothing is hidden.
    const list = await readList(fetchImpl, baseUrl, Date.now());
    const hide = new Set(list.definitions.filter((d) => d.archived).map((d) => d.id));
    const day = await readDaySchedule(window, { ...opts, hide });
    if ("error" in day) return reply.status(502).send({ error: `${baseUrl}: ${day.error}` });
    return day;
  });

  // ---- writes ----

  const bad = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, error: string, status = 400) => reply.status(status).send({ error });
  const refused = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, r: Extract<Sent, { ok: false }>) => {
    const taskId = isRecord(r.body) ? str(r.body.taskId) : undefined;
    return reply.status(r.status).send({ error: r.error, ...(taskId ? { taskId } : {}) });
  };
  const idOf = (request: { params: unknown }): string | undefined => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : undefined;
  };
  const write = (path: string, handler: (id: string, body: Record<string, unknown>, reply: Parameters<typeof bad>[0]) => Promise<unknown>) => {
    app.post(`/api/modules/candybar/:id${path}`, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const id = idOf(request);
      if (!id) return bad(reply, "the candybar id must be a UUID");
      if (request.body !== undefined && request.body !== null && !isRecord(request.body)) return bad(reply, "the body must be a JSON object");
      return handler(id, bodyOf(request), reply);
    });
  };

  write("/skip", async (id, body, reply) => {
    const fireTime = parseFireTime(body.fireTime);
    if (!fireTime) return bad(reply, "fireTime must be a whole-minute ISO timestamp");
    const r = await sendJson(fetchImpl, baseUrl, "POST", `/candybars/${id}/skip`, { fireTime });
    if (!r.ok) return refused(reply, r);
    invalidateAfterWrite({ schedule: true });
    return { ok: true, skipped: true, fireTime };
  });

  write("/skip-rest-of-day", async (id, body, reply) => {
    const fireTime = parseFireTime(body.fireTime);
    if (!fireTime) return bad(reply, "fireTime must be a whole-minute ISO timestamp");
    // The day is the candybar's own: a 9 PM New York fire is already tomorrow in UTC.
    const list = await readList(fetchImpl, baseUrl, Date.now());
    const def = list.definitions.find((d) => d.id === id);
    if (!def) return reply.status(list.down ? 502 : 404).send({ error: list.down ? `${baseUrl}: ${list.down}` : "no candybar with that id" });
    const date = localDate(Date.parse(fireTime), def.timezone);
    if (!date) return bad(reply, `cannot compute the date in the time zone ${def.timezone}`, 422);
    const r = await sendJson(fetchImpl, baseUrl, "POST", `/candybars/${id}/skip-rest-of-day`, { date });
    if (!r.ok) return refused(reply, r);
    invalidateAfterWrite({ schedule: true });
    return { ok: true, skipped: true, date };
  });

  write("/noise", async (id, body, reply) => {
    if (typeof body.noise !== "boolean") return bad(reply, "noise must be true or false");
    const r = await sendJson(fetchImpl, baseUrl, body.noise ? "PUT" : "DELETE", `/candybars/${id}/noise`);
    if (!r.ok) return refused(reply, r);
    invalidateAfterWrite();
    return { ok: true, noise: body.noise };
  });

  write("/enabled", async (id, body, reply) => {
    if (typeof body.enabled !== "boolean") return bad(reply, "enabled must be true or false");
    const r = await sendJson(fetchImpl, baseUrl, "POST", `/candybars/${id}/enabled`, { enabled: body.enabled });
    if (!r.ok) return refused(reply, r);
    invalidateAfterWrite({ schedule: true });
    return { ok: true, enabled: body.enabled };
  });

  write("/archived", async (id, body, reply) => {
    if (typeof body.archived !== "boolean") return bad(reply, "archived must be true or false");
    const r = await sendJson(fetchImpl, baseUrl, "POST", `/candybars/${id}/archived`, { archived: body.archived });
    if (!r.ok) return refused(reply, r);
    invalidateAfterWrite({ schedule: true });
    const detail = isRecord(r.body) ? r.body : {};
    // Archiving also disables; unarchiving leaves it disabled until it is enabled on purpose.
    return { ok: true, archived: body.archived, enabled: typeof detail.enabled === "boolean" ? detail.enabled : body.archived ? false : undefined };
  });

  write("/steward", async (id, body, reply) => {
    const action = STEWARD_ACTIONS.find((a) => a === body.action);
    if (!action) return bad(reply, `action must be one of ${STEWARD_ACTIONS.join(", ")}`);
    const r = await sendJson(fetchImpl, baseUrl, "POST", `/candybars/${id}/steward`, { action });
    if (!r.ok) {
      // A twin already queued or running is not a failure of this click: the list will show it.
      if (r.status === 409) invalidateAfterWrite();
      return refused(reply, r);
    }
    invalidateAfterWrite();
    const task = projectTask(r.body);
    return reply.status(r.status === 200 ? 200 : 202).send({ ok: true, ...(task ? { task } : {}) });
  });

  app.get("/api/modules/candybar/:id/tasks", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = idOf(request);
    if (!id) return bad(reply, "the candybar id must be a UUID");
    const raw = (request.query as Record<string, unknown>).limit;
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return bad(reply, "limit must be an integer from 1 to 200");
    const r = await sendJson(fetchImpl, baseUrl, "GET", `/candybars/${id}/steward/tasks?limit=${limit}`);
    if (!r.ok) return refused(reply, r);
    const tasks = isRecord(r.body) && Array.isArray(r.body.tasks) ? r.body.tasks.map(projectTask).filter((t): t is Task => t !== undefined) : [];
    return { candybarId: id, tasks };
  });

  // Candybar's SSE, frame for frame: its ids (<boot>-<seq>), `retry`, keepalives and id-only out-of-window frames all
  // reach the browser unchanged (plus id-less pings), so EventSource resume works end to end. One upstream
  // connection per viewer.
  const open = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const ctl of open) ctl.abort();
  });
  app.get("/api/modules/candybar/schedule/stream", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const window = parseWindow(query);
    if ("error" in window) return reply.status(400).send({ error: window.error });
    const header = request.headers["last-event-id"];
    // EventSource sends Last-Event-ID on its own retries; `after` carries it when the page reconnects by hand.
    const lastEventId = typeof header === "string" && header ? header : typeof query.after === "string" ? query.after : "";
    const ctl = new AbortController();
    open.add(ctl);
    reply.raw.on("close", () => {
      ctl.abort();
      open.delete(ctl);
    });
    const connect = setTimeout(() => ctl.abort(), STREAM_CONNECT_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${baseUrl}/schedule/stream?${new URLSearchParams(window)}`, {
        method: "GET",
        headers: { accept: "text/event-stream", ...(/^[\w-]{1,64}$/.test(lastEventId) ? { "last-event-id": lastEventId } : {}) },
        signal: ctl.signal
      });
    } catch (err) {
      open.delete(ctl);
      return reply.status(502).send({ error: `${baseUrl}: ${describeError(err, STREAM_CONNECT_TIMEOUT_MS)}` });
    } finally {
      clearTimeout(connect);
    }
    if (!upstream.ok || !upstream.body) {
      // Read Candybar's reason before aborting: an aborted signal fails the body read too.
      const text = (await upstream.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
      ctl.abort();
      open.delete(ctl);
      return reply.status(502).send({ error: `${baseUrl}: HTTP ${upstream.status}${text ? `: ${text}` : ""}` });
    }
    streamHeaders(reply);
    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    return reply.send(withPings(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), pingMs));
  });
}

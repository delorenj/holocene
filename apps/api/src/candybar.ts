import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { streamHeaders } from "./event-stream.js";

// Read-only projection of Candybar, the host's single clock for recurring work (HOLOC-24: Definitions and Schedule).
// Upstream contract: candybar/_bmad-output/specs/spec-cron-framework/holocene-view-contract.md. The Candybar API
// sends no CORS headers, so only this process talks to it, GET only; the browser reads the composed list.
// Holocene never registers, edits, pauses or runs a candybar: that stays with the `candybar` CLI.
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

export type LastRun = {
  result: "success" | "fail" | "running";
  trigger?: string;
  startedAt: string;
  finishedAt?: string;
  runtimeMs?: number;
  errorMessage?: string;
};

export type CandybarRow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  schedule: string;
  timezone: string;
  noise: boolean;
  enabled: boolean;
  createdAt: string;
  /** The next fire within the schedule window; null when none falls inside it (or the candybar is disabled). */
  nextFire: string | null;
  /** The newest invocation; null when it has never run. Absent when it could not be read. */
  lastRun?: LastRun | null;
};

export type CandybarSource = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

export type CandybarPayload = {
  generated_at: string;
  source: CandybarSource;
  counts: { total: number; active: number; inactive: number; failing: number };
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
  lastRunErrors: number;
}): CandybarPayload {
  const { now, definitions, fires, lastRuns } = input;
  const candybars: CandybarRow[] = [...definitions].sort(byName).map((d) => {
    const lastRun = lastRuns.get(d.id);
    return {
      ...d,
      nextFire: d.enabled && fires ? nextFireAfter(fires.get(d.id), now) : null,
      ...(lastRun !== undefined ? { lastRun } : {})
    };
  });
  const active = candybars.filter((c) => c.enabled).length;
  const warnings: string[] = [];
  if (input.scheduleError) warnings.push(`next fires ${fires ? "from an older read" : "unavailable"}: ${input.scheduleError}`);
  if (input.lastRunErrors) warnings.push(`last run could not be refreshed for ${input.lastRunErrors} of ${candybars.length} candybars`);
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
      total: candybars.length,
      active,
      inactive: candybars.length - active,
      failing: candybars.filter((c) => c.enabled && c.lastRun?.result === "fail").length
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
type LastRunEntry = { at: number; value: LastRun | null | undefined; failed: boolean };

let lastGoodList: Cached<Definition[]> | undefined;
let listCache: Cached<ListRead> | undefined;
let scheduleCache: Cached<ScheduleRead> | undefined;
const lastRunCache = new Map<string, LastRunEntry>();
let inflight: Promise<CandybarPayload> | undefined;

export function resetCandybarCache() {
  lastGoodList = undefined;
  listCache = undefined;
  scheduleCache = undefined;
  lastRunCache.clear();
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
  listCache = { at: now, value: read };
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
  let errors = 0;
  const due = ids.filter((id) => {
    const hit = lastRunCache.get(id);
    if (hit && now - hit.at < LAST_RUN_TTL_MS) {
      out.set(id, hit.value);
      if (hit.failed) errors += 1;
      return false;
    }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const id = due[next++];
      const raw = await getJson(fetchImpl, baseUrl, `/candybars/${encodeURIComponent(id)}/invocations?limit=1`);
      const run = raw.ok ? projectLastRun(raw.body) : undefined;
      const failed = run === undefined;
      // A failed read keeps the previous answer rather than blanking a row that was readable a moment ago, and is
      // still counted in the warning.
      const value = failed ? lastRunCache.get(id)?.value : run;
      if (failed) errors += 1;
      lastRunCache.set(id, { at: now, value, failed });
      out.set(id, value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LAST_RUN_CONCURRENCY, due.length) }, worker));
  return { lastRuns: out, errors };
}

export async function readCandybars(opts: { fetchImpl?: Fetch; baseUrl?: string; now?: () => number } = {}): Promise<CandybarPayload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? CANDYBAR_API_URL;
  const clock = opts.now ?? Date.now;
  const now = clock();
  const list = await readList(fetchImpl, baseUrl, now);
  // The window and the last runs read side by side, so a slow /schedule never holds up the last-run column.
  const [schedule, { lastRuns, errors }] = await Promise.all([
    readSchedule(fetchImpl, baseUrl, now, scheduleFingerprint(list.definitions)),
    list.down
      ? { lastRuns: new Map(list.definitions.map((d) => [d.id, lastRunCache.get(d.id)?.value] as const)), errors: 0 }
      : readLastRuns(fetchImpl, baseUrl, list.definitions.map((d) => d.id), now)
  ]);
  return composePayload({
    now: clock(),
    definitions: list.definitions,
    listAt: list.at,
    listDown: list.down,
    fires: schedule.fires,
    windowTo: schedule.to,
    scheduleError: schedule.error,
    lastRuns,
    lastRunErrors: errors
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
export function compactSchedule(raws: unknown[], window: { from: string; to: string }, now: number): SchedulePayload {
  const index = new Map<string, number>();
  const candybars: ScheduleCandybar[] = [];
  const rows: ScheduleTuple[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!isRecord(raw)) continue;
    const id = str(raw.candybarId);
    const fireTime = stamp(raw.fireTime);
    const state = str(raw.state);
    if (!id || !fireTime || !state || !STATES.has(state)) continue;
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
  opts: { fetchImpl?: Fetch; baseUrl?: string; now?: () => number } = {}
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
  return compactSchedule(reads.flatMap((r) => (r.ok ? (r.body as unknown[]) : [])), window, (opts.now ?? Date.now)());
}

export function registerCandybarRoutes(app: FastifyInstance, opts: { fetchImpl?: Fetch; baseUrl?: string; pingMs?: number } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? CANDYBAR_API_URL;
  const pingMs = opts.pingMs ?? STREAM_PING_MS;

  app.get("/api/modules/candybar/list", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Concurrent callers share one upstream read.
    inflight ??= readCandybars(opts).finally(() => {
      inflight = undefined;
    });
    return inflight;
  });

  app.get("/api/modules/candybar/schedule", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const window = parseWindow(request.query as Record<string, unknown>);
    if ("error" in window) return reply.status(400).send({ error: window.error });
    const day = await readDaySchedule(window, opts);
    if ("error" in day) return reply.status(502).send({ error: `${baseUrl}: ${day.error}` });
    return day;
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

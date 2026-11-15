import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CollectedEvent } from "./event-store.js";

const execFileAsync = promisify(execFile);

// The Transcripts tab's Harvest button. Holocene is a sink for Bloodbank events and publishes exactly one
// command type, bloodbank.audio.harvest.start, on an operator click; it never publishes a domain event.
// The pilot-owned worker (`px harvest worker`) consumes the command, waits for wax's enrichment passes,
// runs `px harvest`, and answers with the bloodbank.audio.harvest.* events that harvestJobs() projects.

export const HARVEST_START_TYPE = "bloodbank.cmd.audio.harvest.start";
export const HARVEST_EVENT_TYPES = [
  "bloodbank.audio.harvest.queued",
  "bloodbank.audio.harvest.started",
  "bloodbank.audio.harvest.completed",
  "bloodbank.audio.harvest.failed",
  "bloodbank.audio.harvest.published"
] as const;

const DEFAULT_BB_EMIT = "/home/delorenj/.local/bin/bb-emit";
const EMIT_TIMEOUT_MS = 10_000;
/** A queued or running job older than this is presumed lost (worker down); the button re-arms. */
const STALE_MS = Number(process.env.HARVEST_STALE_MS ?? 3 * 60 * 60 * 1000);
const HARVEST_ID = /^[A-Za-z0-9._~-]{1,80}$/u;
const WAX_ITEM_ID = /^[0-9a-f]{16}$/u;

export type HarvestJobState = "queued" | "running" | "review_ready" | "failed" | "published";

export type HarvestJob = {
  state: HarvestJobState;
  at: string;
  harvest_id: string | null;
  /** Relative, so the link works through Holocene's /harvest/review rewrite. */
  review_url: string | null;
  reason: string | null;
  stage: "enrichment" | "harvest" | "publish" | null;
  waiting_for: string | null;
  items: { total: number; clear: number; held: number; rejected: number } | null;
  tickets: { created: number; adopted: number; failed: number } | null;
  /** queued/running for longer than the stale window: the worker likely lost it. */
  stale: boolean;
};

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n = 300) => (typeof v === "string" && v ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const STATE_BY_TYPE: Record<string, HarvestJobState> = {
  "bloodbank.audio.harvest.queued": "queued",
  "bloodbank.audio.harvest.started": "running",
  "bloodbank.audio.harvest.completed": "review_ready",
  "bloodbank.audio.harvest.failed": "failed",
  "bloodbank.audio.harvest.published": "published"
};

/** The review page's path only: never an absolute URL, never another host's path. */
export function reviewPath(reviewUrl: unknown, harvestId: string | null): string | null {
  if (typeof reviewUrl === "string") {
    let path = reviewUrl;
    try { path = new URL(reviewUrl, "https://holocene.delo.sh").pathname; } catch { /* use as is */ }
    const m = /^\/harvest\/review\/([A-Za-z0-9._~-]{1,80})\/?$/u.exec(path);
    if (m) return `/harvest/review/${m[1]}/`;
  }
  return harvestId ? `/harvest/review/${harvestId}/` : null;
}

function toJob(event: CollectedEvent, state: HarvestJobState, now: number): HarvestJob {
  const data = isRecord(event.envelope.data) ? event.envelope.data : {};
  const at = typeof event.envelope.time === "string" && Number.isFinite(Date.parse(event.envelope.time)) ? event.envelope.time : event.collected_at;
  const rawId = typeof data.harvest_id === "string" ? data.harvest_id : null;
  const harvestId = rawId && HARVEST_ID.test(rawId) ? rawId : null;
  const stage = data.stage === "enrichment" || data.stage === "harvest" || data.stage === "publish" ? data.stage : null;
  const pending = state === "queued" || state === "running";
  const age = now - Date.parse(at);
  return {
    state,
    at,
    harvest_id: harvestId,
    review_url: state === "review_ready" || state === "published" ? reviewPath(data.review_url, harvestId) : null,
    reason: state === "failed" ? str(data.reason) ?? "the harvest failed" : null,
    stage: state === "failed" ? stage : null,
    waiting_for: state === "queued" ? str(data.waiting_for, 40) : null,
    items: state === "review_ready"
      ? { total: int(data.items), clear: int(data.clear), held: int(data.held), rejected: int(data.rejected) }
      : null,
    tickets: state === "published" ? { created: int(data.created), adopted: int(data.adopted), failed: int(data.failed) } : null,
    stale: pending && Number.isFinite(age) && age > STALE_MS
  };
}

export type HarvestJobLookup = (row: { transcript_id: number; wax_item_id: string | null }) => HarvestJob | null;

/** Latest harvest event per transcript (by transcript_id, else wax_item_id). `events` is newest first. */
export function harvestJobs(events: CollectedEvent[], now = Date.now()): HarvestJobLookup {
  const byTranscript = new Map<number, { cursor: number; job: HarvestJob }>();
  const byItem = new Map<string, { cursor: number; job: HarvestJob }>();
  for (const event of [...events].reverse()) {
    const state = STATE_BY_TYPE[event.envelope.type];
    if (!state || !isRecord(event.envelope.data)) continue;
    const entry = { cursor: event.cursor, job: toJob(event, state, now) };
    const t = event.envelope.data.transcript_id;
    const w = event.envelope.data.wax_item_id;
    if (typeof t === "number" && Number.isSafeInteger(t)) byTranscript.set(t, entry);
    if (typeof w === "string" && w) byItem.set(w, entry);
  }
  return (row) => {
    const a = byTranscript.get(row.transcript_id);
    const b = row.wax_item_id ? byItem.get(row.wax_item_id) : undefined;
    const best = a && b ? (b.cursor > a.cursor ? b : a) : (a ?? b);
    return best?.job ?? null;
  };
}

export type JobSource = { cursor: number; recent(types: string[], limit?: number): CollectedEvent[] };

/** Reads the shared Bloodbank collection; re-parses only when the store moved. */
export function jobReader(store: JobSource | undefined): () => HarvestJobLookup {
  let memo: { cursor: number; at: number; lookup: HarvestJobLookup } | undefined;
  return () => {
    if (!store) return () => null;
    const cursor = store.cursor;
    const now = Date.now();
    // The stale flag depends on the clock, so a memo older than a minute is rebuilt too.
    if (!memo || memo.cursor !== cursor || now - memo.at > 60_000) {
      memo = { cursor, at: now, lookup: harvestJobs(store.recent([...HARVEST_EVENT_TYPES], 3000), now) };
    }
    return memo.lookup;
  };
}

export class HarvestEmitError extends Error {}

export type HarvestRequest = { transcriptId: number; waxItemId: string | null; force: boolean };
export type EmitOptions = { executable?: string; timeoutMs?: number };
export type EmitReceipt = { command_id: string; correlation_id: string };

/** The one thing Holocene publishes. Argv only, never a shell. */
export async function emitHarvestStart(req: HarvestRequest, options: EmitOptions = {}): Promise<EmitReceipt> {
  const correlation = randomUUID();
  const commandId = randomUUID();
  const data = {
    transcript_id: req.transcriptId,
    wax_item_id: req.waxItemId && WAX_ITEM_ID.test(req.waxItemId) ? req.waxItemId : null,
    requested_by: "holocene",
    force: req.force
  };
  const args = [
    "--strict", "--kind", "command", "--type", HARVEST_START_TYPE,
    "--source", "urn:33god:service:holocene-api", "--producer", "holocene", "--service", "holocene-api",
    "--actor-id", "holocene", "--correlation", correlation, "--command-id", commandId,
    "--print-ids", "--data", JSON.stringify(data)
  ];
  try {
    const { stdout } = await execFileAsync(options.executable ?? process.env.BB_EMIT_EXECUTABLE ?? DEFAULT_BB_EMIT, args, {
      timeout: options.timeoutMs ?? EMIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    // --print-ids prints one JSON line; read it back so the receipt is what the bus saw.
    const line = stdout.split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
    let printed: Json = {};
    try { printed = line ? (JSON.parse(line) as Json) : {}; } catch { /* keep the ids we sent */ }
    return {
      command_id: typeof printed.command_id === "string" ? printed.command_id : commandId,
      correlation_id: typeof printed.correlationid === "string" ? printed.correlationid : correlation
    };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown; killed?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const line = (stderr.split("\n").find((l) => l.trim()) ?? (typeof e.message === "string" ? e.message : String(err))).trim();
    throw new HarvestEmitError(e.killed ? "bb-emit timed out publishing the harvest command" : `bb-emit failed: ${line.slice(0, 300)}`);
  }
}

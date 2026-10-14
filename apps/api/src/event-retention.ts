import { setImmediate as yieldEventLoop } from "node:timers/promises";
import type { EventStore } from "./event-store.js";

/**
 * Retention for the collected-event read model.
 *
 * The store kept every envelope forever and grew ~0.9 GiB/day (26.6 GiB by 2026-10-14), most of it
 * hook receipts, hook snapshots (~36 KB each) and per-tool telemetry. Nothing reads those raw rows
 * after the moment they arrive:
 *   - hook receipts/snapshots are projected into hook_invocations / hook_snapshot at ingest;
 *   - tool + conversation activity is read only inside ACTIVITY_WINDOW_MS (2h, hub.ts);
 *   - invocations are read as "newest 2000", tickets as "newest 3000" regardless of age.
 * So telemetry keeps a few days for replay/debugging, everything else a month, and repo facts
 * (tickets, decisions — read by count, not age, and tiny) a year so the ticket projection never
 * loses a ticket that simply went quiet.
 *
 * Deletes run in short batches by cursor so the collector (same process) and any concurrent
 * CLI writer interleave; freed pages go to the freelist and are reused by new events, so the
 * file stops growing once retention reaches steady state. Shrinking the file itself is a
 * separate, explicit step (see maintenance.ts).
 */
export type RetentionPolicy = {
  /** High-volume telemetry types kept only `telemetryDays`. */
  telemetryTypes: string[];
  telemetryDays: number;
  /** Type prefixes kept `durableDays` instead of `defaultDays`. */
  durablePrefixes: string[];
  durableDays: number;
  /** Everything else. */
  defaultDays: number;
  /** hook_invocations projection rows (the hook-hub history), by received_at. */
  hookInvocationDays: number;
  /** rejected_events diagnostics, by collected_at. */
  rejectedDays: number;
  /** Rows per delete transaction. */
  batchSize: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = {
  telemetryTypes: [
    "bloodbank.agent.hook.updated",
    "bloodbank.system.hook.updated",
    "bloodbank.agent.tool.requested",
    "bloodbank.agent.tool.invoked",
    "bloodbank.agent.tool.completed",
    "bloodbank.llm.allowance.observed",
  ],
  telemetryDays: 3,
  durablePrefixes: ["bloodbank.repo."],
  durableDays: 365,
  defaultDays: 30,
  hookInvocationDays: 7,
  rejectedDays: 30,
  batchSize: 2000,
};

export const RETENTION_INTERVAL_MS = 3600_000;
const DAY_MS = 86_400_000;

export type PruneResult = { telemetry: number; expired: number; durable: number; hookInvocations: number; rejected: number; ms: number };
export type PruneOptions = { now?: number; dryRun?: boolean; yieldBetweenBatches?: boolean };

function days(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number of days`);
  return value;
}

/** Policy from HOLOCENE_RETENTION_* overrides; null when HOLOCENE_RETENTION=off. */
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy | null {
  if (["off", "0", "false", "disabled"].includes(String(env.HOLOCENE_RETENTION ?? "").toLowerCase())) return null;
  const extra = (env.HOLOCENE_RETENTION_TELEMETRY_TYPES ?? "").split(",").map(t => t.trim()).filter(Boolean);
  return {
    ...DEFAULT_RETENTION,
    telemetryTypes: [...new Set([...DEFAULT_RETENTION.telemetryTypes, ...extra])],
    telemetryDays: days(env, "HOLOCENE_RETENTION_TELEMETRY_DAYS", DEFAULT_RETENTION.telemetryDays),
    defaultDays: days(env, "HOLOCENE_RETENTION_DAYS", DEFAULT_RETENTION.defaultDays),
    durableDays: days(env, "HOLOCENE_RETENTION_DURABLE_DAYS", DEFAULT_RETENTION.durableDays),
    hookInvocationDays: days(env, "HOLOCENE_RETENTION_HOOK_DAYS", DEFAULT_RETENTION.hookInvocationDays),
  };
}

const iso = (now: number, keepDays: number) => new Date(now - keepDays * DAY_MS).toISOString();

/** Repeatedly runs `select` (returning ≤ batch keys) + delete in one short transaction until nothing is left. */
async function drain(store: EventStore, count: string, select: string, del: string, args: unknown[], opts: Required<Pick<PruneOptions, "dryRun" | "yieldBetweenBatches">>, batch: number): Promise<number> {
  const db = store.db;
  if (opts.dryRun) return Number(db.prepare(count).get(...(args as never[]))!.n);
  const pick = db.prepare(select);
  const remove = db.prepare(del);
  let total = 0;
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    let removed = 0;
    try {
      const keys = pick.all(...(args as never[]), batch).map(row => row.k);
      for (const key of keys) removed += Number(remove.run(key as never).changes);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    total += removed;
    if (removed < batch) return total;
    if (opts.yieldBetweenBatches) await yieldEventLoop();
  }
}

export async function pruneEvents(store: EventStore, policy: RetentionPolicy = DEFAULT_RETENTION, options: PruneOptions = {}): Promise<PruneResult> {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const opts = { dryRun: options.dryRun ?? false, yieldBetweenBatches: options.yieldBetweenBatches ?? true };
  const batch = Math.max(1, policy.batchSize);
  const delEvent = "DELETE FROM events WHERE cursor=?";

  // Cursors rise with collected_at, so an age cutoff becomes a primary-key bound.
  const telemetryBound = store.cursorAtOrAfter(iso(now, policy.telemetryDays));
  const defaultBound = store.cursorAtOrAfter(iso(now, policy.defaultDays));
  const durableBound = store.cursorAtOrAfter(iso(now, policy.durableDays));

  const types = policy.telemetryTypes;
  const typeList = types.map(() => "?").join(",");
  const telemetry = types.length ? await drain(store,
    `SELECT COUNT(*) AS n FROM events WHERE type IN (${typeList}) AND cursor<?`,
    // No ORDER BY: across several types it would sort every match per batch; the (type,cursor)
    // index already yields each type's oldest rows first.
    `SELECT cursor AS k FROM events WHERE type IN (${typeList}) AND cursor<? LIMIT ?`,
    delEvent, [...types, telemetryBound], opts, batch) : 0;

  const prefixes = policy.durablePrefixes.map(p => `${p.replace(/[\\%_]/g, c => `\\${c}`)}%`);
  const notDurable = prefixes.map(() => "type NOT LIKE ? ESCAPE '\\'").join(" AND ") || "1";
  const isDurable = prefixes.map(() => "type LIKE ? ESCAPE '\\'").join(" OR ") || "0";
  // The dry-run count excludes telemetry the first pass would already have removed.
  const quoted = types.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
  const telemetryOlder = types.length ? ` AND NOT (type IN (${quoted}) AND cursor<${Number(telemetryBound)})` : "";
  const expired = await drain(store,
    `SELECT COUNT(*) AS n FROM events WHERE cursor<? AND ${notDurable}${telemetryOlder}`,
    `SELECT cursor AS k FROM events WHERE cursor<? AND ${notDurable} ORDER BY cursor LIMIT ?`,
    delEvent, [defaultBound, ...prefixes], opts, batch);
  const durable = prefixes.length ? await drain(store,
    `SELECT COUNT(*) AS n FROM events WHERE cursor<? AND (${isDurable})`,
    `SELECT cursor AS k FROM events WHERE cursor<? AND (${isDurable}) ORDER BY cursor LIMIT ?`,
    delEvent, [durableBound, ...prefixes], opts, batch) : 0;

  const hookCutoff = iso(now, policy.hookInvocationDays);
  const hookInvocations = await drain(store,
    "SELECT COUNT(*) AS n FROM hook_invocations WHERE received_at<?",
    "SELECT invocation_id AS k FROM hook_invocations WHERE received_at<? LIMIT ?",
    "DELETE FROM hook_invocations WHERE invocation_id=?", [hookCutoff], opts, batch);

  const rejectedCutoff = iso(now, policy.rejectedDays);
  const rejected = opts.dryRun
    ? Number(store.db.prepare("SELECT COUNT(*) AS n FROM rejected_events WHERE collected_at<?").get(rejectedCutoff)!.n)
    : Number(store.db.prepare("DELETE FROM rejected_events WHERE collected_at<?").run(rejectedCutoff).changes);

  return { telemetry, expired, durable, hookInvocations, rejected, ms: Math.round(performance.now() - started) };
}

type Logger = { info: (details: object, message: string) => void; warn: (details: object, message: string) => void };

/** In-process retention: one pass shortly after start, then hourly. Returns a stop function. */
export function startRetention(store: EventStore, policy: RetentionPolicy | null, log: Logger, intervalMs = RETENTION_INTERVAL_MS): () => void {
  if (!policy) { log.info({}, "event retention disabled (HOLOCENE_RETENTION=off)"); return () => undefined; }
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await pruneEvents(store, policy);
      const removed = result.telemetry + result.expired + result.durable + result.hookInvocations + result.rejected;
      if (removed) log.info({ retention: result }, "pruned expired events");
    } catch (error) {
      log.warn({ retention_error: error instanceof Error ? error.message : String(error) }, "event retention pass failed; will retry");
    } finally { running = false; }
  };
  const first = setTimeout(run, 60_000);
  const interval = setInterval(run, intervalMs);
  first.unref(); interval.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
}

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { safeSnapshot, validHeartbeat, validInvocation } from "./hook-validation.js";
import type { BloodbankDelivery, BloodbankEvent, StreamPosition } from "@holocene/bloodbank-client";

export const HOOK_RECEIPT_TYPE = "bloodbank.agent.hook.updated";
export const HOOK_SNAPSHOT_TYPE = "bloodbank.system.hook.updated";
type Json = Record<string, unknown>;
export type HookFilter = Partial<Record<"cli" | "native" | "role" | "handler" | "status", string>> & { limit?: number; offset?: number };
export type EventFilter = { type?: string; subject?: string; source?: string; limit?: number; after?: number };
export type CollectedEvent = { cursor: number; stream: string; sequence: number; subject: string; collected_at: string; envelope: BloodbankEvent };
export type StoreChange = { cursor: number; kind: "event" | "receipt" | "snapshot"; invocation_id?: string };
class InvalidProjection extends Error {}
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Rebuildable read model. Events, projection and transport checkpoint commit together. */
export class EventStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        stream TEXT NOT NULL, sequence INTEGER NOT NULL, subject TEXT NOT NULL,
        type TEXT NOT NULL, source TEXT, collected_at TEXT NOT NULL, envelope TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_type_cursor ON events(type,cursor);
      CREATE INDEX IF NOT EXISTS events_subject_cursor ON events(subject,cursor);
      CREATE TABLE IF NOT EXISTS checkpoints (stream TEXT PRIMARY KEY, created TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rejected_events (
        stream TEXT NOT NULL, sequence INTEGER NOT NULL, reason TEXT NOT NULL, collected_at TEXT NOT NULL,
        PRIMARY KEY(stream,sequence));
      CREATE TABLE IF NOT EXISTS hook_invocations (
        invocation_id TEXT PRIMARY KEY, hub_id TEXT NOT NULL, revision INTEGER NOT NULL,
        cli TEXT NOT NULL, native TEXT NOT NULL, role TEXT, status TEXT NOT NULL,
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hook_received ON hook_invocations(received_at DESC,invocation_id);
      CREATE INDEX IF NOT EXISTS hook_native ON hook_invocations(cli,native,received_at DESC);
      CREATE TABLE IF NOT EXISTS hook_snapshot (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), hub_id TEXT NOT NULL, revision INTEGER NOT NULL,
        generated_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  meta(key: string): string | null {
    return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value as string | undefined) ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  checkpoint(stream: StreamPosition): number {
    const prior = this.db.prepare("SELECT created,sequence FROM checkpoints WHERE stream=?").get(stream.name);
    const sameGeneration = prior?.created === stream.created;
    const after = sameGeneration ? Number(prior.sequence) : 0;
    if ((prior && !sameGeneration) || (stream.first > after + 1) || (after > stream.last)) {
      this.setMeta("history_gap", JSON.stringify({ stream: stream.name, after, first_available: stream.first, detected_at: new Date().toISOString() }));
    }
    const next = after <= stream.last ? after : 0;
    this.db.prepare("INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(stream) DO UPDATE SET created=excluded.created,sequence=excluded.sequence").run(stream.name, stream.created, next);
    this.setMeta("stream_tail", String(stream.last));
    return next;
  }
  get cursor(): number { return Number(this.db.prepare("SELECT COALESCE(MAX(cursor),0) AS n FROM events").get()!.n); }
  get oldestCursor(): number { return Number(this.db.prepare("SELECT COALESCE(MIN(cursor),0) AS n FROM events").get()!.n); }
  get count(): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n); }
  get checkpointSequence(): number { return Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM checkpoints").get()!.n); }
  get lastEventAt(): string | null { return this.db.prepare("SELECT collected_at FROM events ORDER BY cursor DESC LIMIT 1").get()?.collected_at as string | undefined ?? null; }
  get rejectedCount(): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM rejected_events").get()!.n); }

  ingest(delivery: BloodbankDelivery): StoreChange | null {
    const at = new Date().toISOString();
    let event: BloodbankEvent | null = null;
    let rejection: string | null = null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(delivery.data));
      if (!record(parsed) || typeof parsed.id !== "string" || !parsed.id || typeof parsed.type !== "string") throw new Error("invalid_envelope");
      event = parsed as BloodbankEvent;
    } catch { rejection = "invalid_envelope"; }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let change: StoreChange | null = null;
      if (event) {
        const inserted = this.db.prepare("INSERT INTO events(event_id,stream,sequence,subject,type,source,collected_at,envelope) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING")
          .run(event.id, delivery.stream, delivery.sequence, delivery.subject, event.type,
            typeof event.source === "string" ? event.source : null, at, JSON.stringify(event));
        if (inserted.changes) {
          change = { cursor: Number(inserted.lastInsertRowid), kind: "event" };
          if (event.type === HOOK_RECEIPT_TYPE || event.type === HOOK_SNAPSHOT_TYPE) {
            try { change = this.project(event, change); } catch (error) { if (!(error instanceof InvalidProjection)) throw error; rejection = "invalid_hook_projection"; }
          }
        }
      }
      if (rejection) {
        this.db.prepare("INSERT OR IGNORE INTO rejected_events VALUES (?,?,?,?)").run(delivery.stream, delivery.sequence, rejection, at);
      }
      this.db.prepare("UPDATE checkpoints SET sequence=MAX(sequence,?) WHERE stream=?").run(delivery.sequence, delivery.stream);
      this.db.exec("COMMIT");
      return change;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private project(event: BloodbankEvent, change: StoreChange): StoreChange {
    const data = event.data;
    if (!record(data) || data.schema_version !== 1 || typeof data.hub_id !== "string" || !integer(data.revision)) throw new InvalidProjection("invalid_hook_fact");
    if (event.type === HOOK_RECEIPT_TYPE) {
      const row = data.invocation as Json & { invocation_id: string; cli: string; native: string; status: string; received_at: string; updated_at: string };
      if (!record(row) || !validInvocation(row)) throw new InvalidProjection("invalid_receipt");
      const current = this.db.prepare("SELECT hub_id,revision,updated_at FROM hook_invocations WHERE invocation_id=?").get(row.invocation_id);
      if (current && (current.hub_id === data.hub_id ? Number(current.revision) >= data.revision : Date.parse(String(current.updated_at)) >= Date.parse(row.updated_at))) return change;
      const projection = { ...row, revision: data.revision };
      this.db.prepare(`INSERT INTO hook_invocations VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(invocation_id) DO UPDATE SET hub_id=excluded.hub_id,revision=excluded.revision,cli=excluded.cli,native=excluded.native,
        role=excluded.role,status=excluded.status,received_at=excluded.received_at,updated_at=excluded.updated_at,data=excluded.data`)
        .run(row.invocation_id, data.hub_id, data.revision, row.cli, row.native, typeof row.role === "string" ? row.role : null,
          row.status, row.received_at, row.updated_at, JSON.stringify(projection));
      return { ...change, kind: "receipt", invocation_id: row.invocation_id };
    }
    if ((data.snapshot !== undefined) === (data.heartbeat !== undefined)) throw new InvalidProjection("invalid_snapshot_union");
    let snapshot = data.snapshot;
    if (data.heartbeat !== undefined) {
      if (!record(data.heartbeat) || !validHeartbeat(data.heartbeat)) throw new InvalidProjection("invalid_heartbeat");
      const prior = this.db.prepare("SELECT hub_id,data FROM hook_snapshot WHERE singleton=1").get();
      if (!prior || prior.hub_id !== data.hub_id) return change;
      // A heartbeat can refresh observed facts but can never introduce configuration.
      const base = safeSnapshot(JSON.parse(String(prior.data)));
      if (!base) throw new InvalidProjection("invalid_prior_snapshot");
      const heartbeat = data.heartbeat;
      const allowed = ["schema_version", "generated_at", "hub", "totals", "native_activity", "handler_activity", "observed_since"];
      snapshot = { ...base, ...Object.fromEntries(allowed.filter(key => key in heartbeat).map(key => [key, heartbeat[key]])) };
      if (Array.isArray(heartbeat.native_activity)) {
        const activity = new Map(heartbeat.native_activity.filter(record).map(row => [`${row.cli}:${row.native}`, row]));
        (snapshot as Json).bindings = (base.bindings as Json[]).map(binding => {
          const observed = activity.get(`${binding.cli}:${binding.native}`);
          if (!observed) return binding;
          const observedState = Date.now() - Date.parse(String(observed.last_received_at)) > 3600000 ? "idle" : "active";
          return { ...binding, activity: observed, observed_state: observedState,
            state: ["missing", "failed", "unsupported"].includes(String(binding.state)) ? binding.state : observedState };
        });
      }
    }
    const checked = safeSnapshot(snapshot);
    if (!checked || !timestamp(data.expires_at)) throw new InvalidProjection("invalid_snapshot");
    snapshot = checked as Json & { generated_at: string };
    const current = this.db.prepare("SELECT hub_id,revision,generated_at FROM hook_snapshot WHERE singleton=1").get();
    if (current && (current.hub_id === data.hub_id ? Number(current.revision) >= data.revision : Date.parse(String(current.generated_at)) >= Date.parse(String(checked.generated_at)))) return change;
    this.db.prepare(`INSERT INTO hook_snapshot VALUES (1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      hub_id=excluded.hub_id,revision=excluded.revision,generated_at=excluded.generated_at,expires_at=excluded.expires_at,data=excluded.data`)
      .run(data.hub_id, data.revision, String(checked.generated_at), data.expires_at, JSON.stringify(checked));
    return { ...change, kind: "snapshot" };
  }

  hookSnapshot(): { snapshot: Json; expiresAt: string | null } {
    const row = this.db.prepare("SELECT data,expires_at FROM hook_snapshot WHERE singleton=1").get();
    if (row) return { snapshot: JSON.parse(String(row.data)), expiresAt: String(row.expires_at) };
    return { expiresAt: null, snapshot: {
      schema_version: 1, generated_at: new Date().toISOString(), observed_since: null,
      hub: { state: "waiting", started_at: "", pid: 0, publish_enabled: false, async_running: 0 },
      bindings: [], handlers: [], totals: {}, handler_activity: [],
    } };
  }
  hookDetail(id: string): Json | null {
    const row = this.db.prepare("SELECT data FROM hook_invocations WHERE invocation_id=?").get(id);
    return row ? JSON.parse(String(row.data)) : null;
  }
  hookHistory(filter: HookFilter = {}) {
    const terms: string[] = []; const args: SQLInputValue[] = [];
    for (const key of ["cli", "native", "role"] as const) if (filter[key]) { terms.push(`i.${key}=?`); args.push(filter[key]!); }
    const execution: string[] = [];
    if (filter.handler) { execution.push("json_extract(e.value,'$.handler_id')=?"); args.push(filter.handler); }
    if (filter.status && filter.status !== "deduplicated") {
      // A handler + outcome must match the same execution, not two different handlers.
      if (filter.handler) { execution.push("json_extract(e.value,'$.status')=?"); args.push(filter.status); }
      else {
        terms.push("(i.status=? OR EXISTS (SELECT 1 FROM json_each(i.data,'$.executions') e WHERE json_extract(e.value,'$.status')=?))");
        args.push(filter.status, filter.status);
      }
    }
    if (filter.status === "deduplicated") terms.push("COALESCE(json_extract(i.data,'$.deduplicated'),0)>0");
    if (execution.length) terms.push(`EXISTS (SELECT 1 FROM json_each(i.data,'$.executions') e WHERE ${execution.join(" AND ")})`);
    const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200)); const offset = Math.max(0, filter.offset ?? 0);
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM hook_invocations i ${where}`).get(...args)!.n);
    const items = this.db.prepare(`SELECT json_remove(i.data,'$.timeline') AS data FROM hook_invocations i ${where} ORDER BY received_at DESC,invocation_id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map(row => { const value = JSON.parse(String(row.data)); delete value.timeline; return value; });
    return { items, total, limit, offset, next_offset: offset + items.length < total ? offset + items.length : null };
  }
  events(filter: EventFilter = {}): CollectedEvent[] {
    const terms = ["cursor>?"]; const args: SQLInputValue[] = [filter.after ?? 0];
    for (const key of ["type", "subject", "source"] as const) if (filter[key]) { terms.push(`${key}=?`); args.push(filter[key]!); }
    const result: CollectedEvent[] = []; let bytes = 0;
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${terms.join(" AND ")} ORDER BY cursor LIMIT ?`).iterate(...args, Math.min(filter.limit ?? 100, 500));
    for (const row of rows) {
      const raw = String(row.envelope); bytes += Buffer.byteLength(raw);
      if (result.length && bytes > 4 * 1024 * 1024) break;
      result.push({ cursor: Number(row.cursor), stream: String(row.stream), sequence: Number(row.sequence), subject: String(row.subject), collected_at: String(row.collected_at), envelope: JSON.parse(raw) });
    }
    return result;
  }
}

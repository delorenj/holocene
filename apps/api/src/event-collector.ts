import { setImmediate as yieldEventLoop, setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NatsBloodbankClient, type BloodbankClient, type BloodbankConnection, type BloodbankDelivery } from "@holocene/bloodbank-client";
import { EventStore, type StoreChange } from "./event-store.js";

type CollectionFailure = { name: string; code: string | number | null; phase: "connect" | "consume" };
function safeFailure(error: unknown, phase: CollectionFailure["phase"]): CollectionFailure {
  const failure = error !== null && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
  return {
    name: typeof failure.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(failure.name) ? failure.name : "Error",
    code: typeof failure.code === "number" && Number.isFinite(failure.code) ? failure.code :
      typeof failure.code === "string" && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : null,
    phase,
  };
}

type State = "starting" | "connecting" | "live" | "reconnecting" | "stopped" | "error";
export type CollectionChange = StoreChange | { kind: "status"; cursor: number };

export class EventCollector {
  private listeners = new Set<(change: CollectionChange) => void>();
  private state: State = "starting";
  private error: string | null = null;
  private lastEventAt: string | null = null;
  private connection?: BloodbankConnection;
  private task?: Promise<void>;
  private abort = new AbortController();
  private staleTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly store: EventStore, private source?: BloodbankClient, private reportError?: (failure: CollectionFailure) => void) {}

  subscribe(listener: (change: CollectionChange) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get subscriberCount() { return this.listeners.size; }
  private notify(change: CollectionChange) { for (const listener of this.listeners) listener(change); }
  private setState(state: State, error: string | null = null) {
    if (state === this.state && error === this.error) return;
    this.state = state; this.error = error;
    this.notify({ kind: "status", cursor: this.store.cursor });
  }
  status() {
    const { snapshot, expiresAt } = this.store.hookSnapshot();
    return {
      state: this.state, cursor: this.store.cursor, oldest_cursor: this.store.oldestCursor,
      event_count: this.store.count, rejected_count: this.store.rejectedCount,
      last_event_at: this.lastEventAt ?? this.store.lastEventAt, error: this.error,
      checkpoint: this.store.checkpointSequence,
      catching_up: this.store.catchingUp,
      pending: this.store.pendingCount,
      hook_snapshot_state: expiresAt ? (Date.parse(expiresAt) > Date.now() ? "fresh" : "stale") : "waiting",
      hook_snapshot_at: expiresAt ? String(snapshot.generated_at) : null,
      history_gap: this.store.meta("history_gap") !== null,
      history_gap_detail: this.store.meta("history_gap") ? JSON.parse(this.store.meta("history_gap")!) : null,
    };
  }
  hookSnapshot() { return { ...this.store.hookSnapshot().snapshot, collection: this.status() }; }
  ingest(delivery: BloodbankDelivery) {
    const wasCatchingUp = this.store.catchingUp;
    const change = this.store.ingest(delivery);
    if (wasCatchingUp !== this.store.catchingUp) {
      this.notify({ kind: "status", cursor: this.store.cursor });
    }
    if (!change) return;
    this.lastEventAt = new Date().toISOString();
    if (change.kind === "snapshot") this.scheduleStale();
    this.notify(change);
  }
  private scheduleStale() {
    clearTimeout(this.staleTimer);
    const expiresAt = this.store.hookSnapshot().expiresAt;
    if (expiresAt && Date.parse(expiresAt) > Date.now()) {
      this.staleTimer = setTimeout(() => this.notify({ kind: "status", cursor: this.store.cursor }), Date.parse(expiresAt) - Date.now() + 1);
      this.staleTimer.unref();
    }
  }
  start() {
    if (this.task || !this.source) return;
    this.scheduleStale();
    this.task = this.run();
  }
  private async run() {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.setState(attempt ? "reconnecting" : "connecting");
      let phase: CollectionFailure["phase"] = "connect";
      try {
        this.connection = await this.source!.connect({
          checkpoint: stream => this.store.checkpoint(stream),
          onStatus: state => { if (!this.abort.signal.aborted) this.setState(state); },
        });
        if (this.abort.signal.aborted) { await this.connection.close(); break; }
        attempt = 0;
        phase = "consume";
        let sinceYield = 0;
        let yieldedAt = performance.now();
        for await (const delivery of this.connection.messages) {
          if (this.abort.signal.aborted) break;
          this.ingest(delivery);
          // A buffered async iterator can keep resolving in microtasks forever.
          // Yield to HTTP/SSE and timers while preserving ordered atomic commits.
          if (++sinceYield >= 25 || performance.now() - yieldedAt >= 20) {
            await yieldEventLoop();
            sinceYield = 0;
            yieldedAt = performance.now();
          }
        }
        if (!this.abort.signal.aborted) this.setState("reconnecting", "Bloodbank stream disconnected; replay will resume from the committed checkpoint.");
      } catch (error) {
        // Report a stable classification, never transport messages that may contain credentials.
        if (!this.abort.signal.aborted) {
          const failure = safeFailure(error, phase);
          this.reportError?.(failure);
          this.setState("error", `Bloodbank ${phase} interrupted (${failure.name}${failure.code === null ? "" : ` ${failure.code}`}); retrying from the committed checkpoint.`);
        }
      } finally { await this.connection?.close().catch(() => undefined); this.connection = undefined; }
      if (!this.abort.signal.aborted) await delay(Math.min(1000 * 2 ** attempt++, 30000), undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
  }
  async stop() {
    this.abort.abort(); clearTimeout(this.staleTimer);
    await this.connection?.close().catch(() => undefined);
    await this.task;
    this.setState("stopped");
  }
}

export function createEventCollector(logger?: { warn: (details: object, message: string) => void }) {
  const path = process.env.HOLOCENE_EVENT_DB ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "holocene/events.sqlite3");
  return new EventCollector(new EventStore(path), new NatsBloodbankClient({
    servers: process.env.BLOODBANK_NATS_URL ?? process.env.NATS_URL ?? "nats://localhost:4222",
    stream: process.env.BLOODBANK_NATS_STREAM ?? "BLOODBANK_EVENTS",
  }), failure => logger?.warn({ collection_failure: failure }, "Bloodbank collector will retry"));
}

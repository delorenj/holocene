import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import type { BloodbankClient, BloodbankDelivery, BloodbankConnection } from "@holocene/bloodbank-client";
import { EventStore, HOOK_RECEIPT_TYPE, HOOK_SNAPSHOT_TYPE } from "./event-store.js";
import { EventCollector } from "./event-collector.js";
import { registerEventRoutes } from "./event-routes.js";
import { registerHookHubRoutes } from "./hook-hub.js";

const created = "2026-09-13T12:00:00Z";
const position = { name: "BLOODBANK_EVENTS", created, first: 1, last: 10000 };
function delivery(sequence: number, type = "bloodbank.test.item.created", data: unknown = {}, id = `event-${sequence}`): BloodbankDelivery {
  return { stream: position.name, sequence, subject: type.replace("bloodbank.", "bloodbank.evt."), data: new TextEncoder().encode(JSON.stringify({ specversion: "1.0", id, type, source: "/test", time: created, data })) };
}
function receipt(sequence: number, id = "invocation-1", status = "started", cli = "codex") {
  return delivery(sequence, HOOK_RECEIPT_TYPE, { schema_version: 1, hub_id: "hub-1", revision: sequence, sequence, invocation: {
    invocation_id: id, cli, native: "PreCompact", role: "pre_compact", status: "completed", received_at: created, updated_at: created,
    deduplicated: status === "deduplicated" ? 1 : 0,
    executions: [{ handler_id: "first", mode: "async", status, selected_at: created }, { handler_id: "second", mode: "sync", status: "succeeded", selected_at: created }],
    timeline: [{ sequence, handler_id: "first", status, at: created }],
  } });
}
function snapshot(sequence: number, expiresAt = new Date(Date.now() + 90000).toISOString()) {
  return delivery(sequence, HOOK_SNAPSHOT_TYPE, { schema_version: 1, hub_id: "hub-1", revision: sequence, sequence, expires_at: expiresAt, snapshot: {
    schema_version: 1, generated_at: new Date().toISOString(), hub: { state: "running", started_at: created, pid: 1, publish_enabled: true, async_running: 0 },
    bindings: [{ cli: "codex", native: "PreCompact", role: "pre_compact", configured: true, handler_ids: ["first"] }], handlers: [], totals: { invocations: 1 }, handler_activity: [],
  } });
}
function store(path = ":memory:") { const value = new EventStore(path); value.checkpoint(position); return value; }
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(10); }
  assert.fail("condition did not become true");
}
async function fixture(source?: BloodbankClient) {
  const collector = new EventCollector(store(), source); const app = Fastify();
  await registerEventRoutes(app, collector); registerHookHubRoutes(app, collector);
  return { app, collector };
}
class ReplaySource implements BloodbankClient {
  checkpoints: number[] = [];
  constructor(private deliveries: BloodbankDelivery[]) {}
  async connect(options: Parameters<BloodbankClient["connect"]>[0]): Promise<BloodbankConnection> {
    const after = options.checkpoint(position); this.checkpoints.push(after); options.onStatus("live");
    let release!: () => void; const closed = new Promise<void>(resolve => { release = resolve; });
    const deliveries = this.deliveries;
    return { messages: (async function* () { for (const row of deliveries) if (row.sequence > after) yield row; await closed; })(), close: async () => { release(); } };
  }
}

async function openStream(base: string, path: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const response = await fetch(`${base}${path}`, { headers: { Accept: "text/event-stream", ...headers }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(); let buffer = "";
  return {
    close: () => abort.abort(),
    async next(event: string): Promise<{ id?: string; data: any }> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const fields = Object.fromEntries(frame.split("\n").filter(line => !line.startsWith(":"))
            .map(line => { const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 1).trimStart()]; }));
          if (fields.event === event) return { id: fields.id, data: JSON.parse(fields.data) };
          continue;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000); })]).finally(() => clearTimeout(timeout));
        if (result.done) throw new Error(`Stream ended before ${event}`);
        buffer += new TextDecoder().decode(result.value);
      }
    },
  };
}

test("Bloodbank source ingestion commits event, hook projection and checkpoint; restart resumes and deduplicates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "holocene-collection-"));
  const path = join(directory, "events.sqlite3");
  try {
    const firstStore = store(path); const source = new ReplaySource([delivery(1), receipt(2)]); const first = new EventCollector(firstStore, source);
    first.start(); await until(() => firstStore.count === 2); await first.stop();
    assert.deepEqual(source.checkpoints, [0]); assert.equal(firstStore.hookDetail("invocation-1")?.revision, 2); firstStore.close();
    const secondStore = new EventStore(path);
    const duplicate = receipt(3); duplicate.data = receipt(2).data;
    const secondSource = new ReplaySource([delivery(1), receipt(2), duplicate, receipt(4, "invocation-1", "succeeded")]);
    const second = new EventCollector(secondStore, secondSource); second.start(); await until(() => secondStore.hookDetail("invocation-1")?.revision === 4); await second.stop();
    assert.deepEqual(secondSource.checkpoints, [2]); assert.equal(secondStore.count, 3); assert.equal(secondStore.hookHistory().total, 1);
    assert.equal(secondStore.checkpoint(position), 4); secondStore.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("receipt revisions prevent old/out-of-order facts from replacing new outcomes", () => {
  const value = store();
  try { value.ingest(receipt(9, "one", "succeeded")); value.ingest(receipt(3, "one", "started"));
    assert.equal(value.hookDetail("one")?.revision, 9); assert.equal(value.count, 2);
  } finally { value.close(); }
});

test("hook filters match handler/outcome together, role, duplicates and bounded stable ordering", () => {
  const value = store();
  try {
    value.ingest(receipt(1, "one", "failed")); value.ingest(receipt(2, "two", "deduplicated", "claude"));
    assert.equal(value.hookHistory({ handler: "second", status: "failed" }).total, 0);
    assert.equal(value.hookHistory({ handler: "first", status: "failed", role: "pre_compact", cli: "codex" }).total, 1);
    assert.equal(value.hookHistory({ status: "deduplicated" }).total, 1);
    assert.equal(value.hookHistory({ limit: 1 }).next_offset, 1);
    assert.equal(value.hookHistory({ limit: 1, offset: 1 }).next_offset, null);
  } finally { value.close(); }
});

test("invalid input is observable and cannot block subsequent valid events", () => {
  const value = store();
  try {
    value.ingest({ ...delivery(1), data: new TextEncoder().encode("not json") });
    value.ingest(delivery(2, HOOK_RECEIPT_TYPE, {})); value.ingest(receipt(3));
    assert.equal(value.rejectedCount, 2); assert.equal(value.count, 2); assert.equal(value.checkpoint(position), 3);
  } finally { value.close(); }
});

test("transaction failure rolls back event, projection and checkpoint together", () => {
  const value = store();
  try {
    value.db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON hook_invocations BEGIN SELECT RAISE(ABORT, 'disk fixture'); END;");
    assert.throws(() => value.ingest(receipt(1)), /disk fixture/);
    assert.equal(value.count, 0); assert.equal(value.checkpoint(position), 0);
  } finally { value.close(); }
});

test("retention gaps and stream replacement are explicitly marked", () => {
  const value = store();
  try { value.ingest(delivery(4)); assert.equal(value.checkpoint({ ...position, first: 10 }), 4);
    assert.equal(JSON.parse(value.meta("history_gap")!).first_available, 10);
    assert.equal(value.checkpoint({ ...position, created: "2026-09-14T00:00:00Z" }), 0);
  } finally { value.close(); }
});

test("snapshot heartbeats merge only onto the same hub's known configuration", () => {
  const value = store();
  const heartbeat = delivery(3, HOOK_SNAPSHOT_TYPE, { schema_version: 1, hub_id: "hub-1", revision: 3, expires_at: new Date(Date.now() + 90000).toISOString(), heartbeat: { schema_version: 1, generated_at: created, hub: { state: "running", started_at: created, publish_enabled: true }, totals: { invocations: 2 }, handler_activity: [] } });
  try {
    value.ingest(heartbeat); assert.equal(value.hookSnapshot().expiresAt, null);
    value.ingest(snapshot(1));
    value.ingest({ ...heartbeat, data: new TextEncoder().encode(new TextDecoder().decode(heartbeat.data).replace('"event-3"', '"heartbeat-again"')) });
    assert.equal((value.hookSnapshot().snapshot.bindings as unknown[]).length, 1);
    assert.equal((value.hookSnapshot().snapshot.totals as { invocations: number }).invocations, 2);
  } finally { value.close(); }
});

test("hook API reads only local collected facts and exposes bootstrap explicitly", async () => {
  const { app, collector } = await fixture();
  try {
    const before = (await app.inject("/api/modules/hooks/status")).json();
    assert.equal(before.hub.state, "waiting"); assert.equal(before.collection.hook_snapshot_state, "waiting");
    collector.ingest(receipt(1, "one", "timed_out"));
    const response = await app.inject("/api/modules/hooks/invocations?cli=codex&native=PreCompact&status=timed_out&limit=20");
    assert.equal(response.statusCode, 200); assert.equal(response.json().items[0].executions[0].status, "timed_out");
    assert.equal((await app.inject("/api/modules/hooks/invocations?limit=10000")).statusCode, 400);
    assert.equal((await app.inject("/api/modules/hooks/invocations/missing-id")).statusCode, 404);
    assert.equal((await app.inject("/api/modules/hooks/invocations/a%2Fb")).statusCode, 400);
  } finally { await app.close(); }
});

test("SSE sends arrival-driven filtered rows and reconnects with a fresh projection", async () => {
  const { app, collector } = await fixture(); const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const stream = await openStream(base, "/api/modules/hooks/stream?cli=codex&status=started");
  try {
    await stream.next("hooks-status"); assert.equal((await stream.next("hooks-history")).data.total, 0);
    collector.ingest(receipt(1));
    const arrived = await stream.next("hooks-history"); assert.equal(arrived.data.items[0].invocation_id, "invocation-1");
    collector.ingest(receipt(2, "invocation-1", "succeeded"));
    assert.equal((await stream.next("hooks-history")).data.total, 0);
    stream.close(); await until(() => collector.subscriberCount === 0);
    const replay = await openStream(base, "/api/modules/hooks/stream?cli=codex", { "Last-Event-ID": arrived.id! });
    try { await replay.next("hooks-status"); assert.equal((await replay.next("hooks-history")).data.items[0].revision, 2); } finally { replay.close(); }
  } finally { stream.close(); await app.close(); }
});

test("generic SSE tails without archive flood, then replays exact missed envelopes by cursor", async () => {
  const { app, collector } = await fixture(); collector.ingest(delivery(1));
  const base = await app.listen({ port: 0, host: "127.0.0.1" }); const stream = await openStream(base, "/api/events/stream");
  try {
    assert.equal((await stream.next("ready")).data.cursor, 1); collector.ingest(delivery(2));
    const arrived = await stream.next("bloodbank-event"); assert.equal(arrived.data.envelope.id, "event-2"); stream.close();
    await until(() => collector.subscriberCount === 0); collector.ingest(delivery(3));
    const replay = await openStream(base, "/api/events/stream", { "Last-Event-ID": arrived.id! });
    try { await replay.next("ready"); assert.equal((await replay.next("bloodbank-event")).data.envelope.id, "event-3"); } finally { replay.close(); }
    assert.equal((await app.inject("/api/events?after=1&source=%2Ftest&limit=1")).json().items[0].envelope.id, "event-2");
  } finally { stream.close(); await app.close(); }
});

test("snapshot expiry changes collection health without periodic snapshot polling", async () => {
  const { app, collector } = await fixture(); collector.ingest(snapshot(1, new Date(Date.now() + 150).toISOString()));
  const base = await app.listen({ port: 0, host: "127.0.0.1" }); const stream = await openStream(base, "/api/modules/hooks/stream");
  try {
    assert.equal((await stream.next("hooks-status")).data.collection.hook_snapshot_state, "fresh");
    assert.equal((await stream.next("hooks-status")).data.collection.hook_snapshot_state, "stale");
  } finally { stream.close(); await app.close(); }
});


test("malformed nested hook facts are rejected without poisoning later valid snapshots or heartbeats", () => {
  const value = store();
  function malformed(row: BloodbankDelivery, mutate: (data: any) => void) {
    const parsed = JSON.parse(new TextDecoder().decode(row.data)); mutate(parsed.data);
    return { ...row, data: new TextEncoder().encode(JSON.stringify(parsed)) };
  }
  try {
    value.ingest(snapshot(1));
    const mutations: ((data: any) => void)[] = [
      data => { data.snapshot.bindings = [null]; },
      data => { data.snapshot.bindings[0].handler_ids = [null]; },
      data => { data.snapshot.handlers = [null]; },
      data => { data.snapshot.handler_activity = [null]; },
      data => { data.snapshot.totals = { invocations: {} }; },
      data => { data.snapshot.installed_inventory = { generated_at: created, status: "ok", clis: [null] }; },
      data => { data.snapshot.installed_inventory = { generated_at: created, status: "ok", clis: [{ cli: "codex", support_status: "supported", status: "ok", configs: [{ source: "settings", status: "ok", errors: [null] }], natives: [] }] }; },
      data => { data.snapshot.installed_inventory = { generated_at: created, status: "ok", clis: [{ cli: "codex", support_status: "supported", status: "ok", configs: [], natives: [{ native: "PreCompact", status: "ok", sources: [null] }] }] }; },
    ];
    mutations.forEach((mutate, index) => value.ingest(malformed(snapshot(index + 2), mutate)));
    value.ingest(malformed(receipt(20), data => { data.invocation.executions = [null]; }));
    value.ingest(malformed(receipt(21), data => { data.invocation.timeline = [null]; }));
    value.ingest(malformed(snapshot(22), data => {
      const heartbeat = { ...data.snapshot, native_activity: [null] }; delete heartbeat.bindings; delete heartbeat.handlers;
      delete data.snapshot; data.heartbeat = heartbeat;
    }));
    assert.equal(value.rejectedCount, 11);
    assert.equal((value.hookSnapshot().snapshot.bindings as any[])[0].cli, "codex");
    assert.equal(value.hookHistory().total, 0);
    value.ingest(snapshot(23)); value.ingest(receipt(24));
    assert.equal(value.checkpoint(position), 24); assert.equal(value.hookHistory().total, 1);
    assert.equal(value.count, 14);
  } finally { value.close(); }
});


test("buffered archive replay yields to I/O before exhausting its backlog", async () => {
  const value = store();
  const source = new ReplaySource(Array.from({ length: 1000 }, (_, index) => delivery(index + 1)));
  const collector = new EventCollector(value, source);
  try {
    collector.start();
    const ingestedAtFirstIo = await new Promise<number>(resolve => setImmediate(() => resolve(value.count)));
    assert.ok(ingestedAtFirstIo > 0, "replay should make progress");
    assert.ok(ingestedAtFirstIo <= 25, "HTTP/SSE I/O gets a turn within one bounded batch");
    await until(() => value.count === 1000);
    assert.equal(value.checkpoint(position), 1000);
  } finally { await collector.stop(); value.close(); }
});


test("collector reports safe transport error class/code without leaking error text", async () => {
  const value = store(); const reported: unknown[] = [];
  const source: BloodbankClient = { async connect() {
    throw Object.assign(new Error("credential-bearing transport URL must stay private"), { name: "JetStreamApiError", code: 10148 });
  } };
  const collector = new EventCollector(value, source, failure => reported.push(failure));
  try {
    collector.start(); await until(() => collector.status().state === "error");
    assert.match(collector.status().error!, /JetStreamApiError 10148/);
    assert.doesNotMatch(JSON.stringify({ status: collector.status(), reported }), /credential-bearing/);
    assert.deepEqual(reported, [{ name: "JetStreamApiError", code: 10148, phase: "connect" }]);
  } finally { await collector.stop(); value.close(); }
});

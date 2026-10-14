import assert from "node:assert/strict";
import { test } from "node:test";
import { EventStore } from "./event-store.js";
import { DEFAULT_RETENTION, pruneEvents, retentionFromEnv, type RetentionPolicy } from "./event-retention.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

/** Rows go in oldest-first, as the collector writes them, so cursors rise with collected_at. */
function seed(rows: Array<[type: string, daysAgo: number]>): EventStore {
  const store = new EventStore(":memory:");
  const insert = store.db.prepare("INSERT INTO events(event_id,stream,sequence,subject,type,source,collected_at,envelope) VALUES (?,?,?,?,?,?,?,?)");
  [...rows].sort((a, b) => b[1] - a[1]).forEach(([type, daysAgo], i) =>
    insert.run(`e-${i}`, "BLOODBANK_EVENTS", i + 1, type, type, "/test", at(daysAgo), JSON.stringify({ id: `e-${i}`, type })));
  return store;
}
const types = (store: EventStore) => store.db.prepare("SELECT type, collected_at FROM events ORDER BY cursor").all()
  .map(row => `${row.type}@${Math.round((NOW - Date.parse(String(row.collected_at))) / DAY)}d`);

test("telemetry ages out after telemetryDays, everything else after defaultDays, repo facts after durableDays", async () => {
  const store = seed([
    ["bloodbank.agent.hook.updated", 10], ["bloodbank.agent.hook.updated", 4], ["bloodbank.agent.hook.updated", 1],
    ["bloodbank.system.hook.updated", 5], ["bloodbank.agent.tool.completed", 3.5], ["bloodbank.agent.tool.requested", 0.1],
    ["bloodbank.agent.invocation.completed", 40], ["bloodbank.agent.invocation.completed", 20],
    ["bloodbank.llm.usage.recorded", 31], ["bloodbank.repo.task.updated", 200], ["bloodbank.repo.task.updated", 400],
  ]);
  const result = await pruneEvents(store, DEFAULT_RETENTION, { now: NOW, yieldBetweenBatches: false });
  assert.deepEqual({ telemetry: result.telemetry, expired: result.expired, durable: result.durable }, { telemetry: 4, expired: 2, durable: 1 });
  assert.deepEqual(types(store), [
    "bloodbank.repo.task.updated@200d", "bloodbank.agent.invocation.completed@20d",
    "bloodbank.agent.hook.updated@1d", "bloodbank.agent.tool.requested@0d",
  ]);
  // The newest cursor survives, so the replay head (and the SSE cursor contract) is untouched.
  assert.equal(store.cursor, 11);
});

test("deletes in batches until done, and dry-run counts without deleting", async () => {
  const rows: Array<[string, number]> = Array.from({ length: 25 }, (_, i) => ["bloodbank.agent.hook.updated", 5 + i / 100]);
  rows.push(["bloodbank.agent.hook.updated", 0]);
  const store = seed(rows);
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION, batchSize: 4 };
  const dry = await pruneEvents(store, policy, { now: NOW, dryRun: true });
  assert.equal(dry.telemetry, 25);
  assert.equal(store.count, 26);
  const real = await pruneEvents(store, policy, { now: NOW });
  assert.equal(real.telemetry, 25);
  assert.equal(store.count, 1);
  const again = await pruneEvents(store, policy, { now: NOW });
  assert.equal(again.telemetry + again.expired + again.durable, 0);
});

test("hook-hub history and rejected diagnostics are pruned by their own clocks", async () => {
  const store = seed([["bloodbank.agent.invocation.started", 0]]);
  const hook = store.db.prepare("INSERT INTO hook_invocations VALUES (?,?,?,?,?,?,?,?,?,?)");
  hook.run("old", "hub", 1, "codex", "Stop", "invocation_start", "completed", at(8), at(8), "{}");
  hook.run("new", "hub", 2, "codex", "Stop", "invocation_start", "completed", at(6), at(6), "{}");
  store.db.prepare("INSERT INTO rejected_events VALUES (?,?,?,?)").run("BLOODBANK_EVENTS", 1, "invalid_envelope", at(45));
  store.db.prepare("INSERT INTO rejected_events VALUES (?,?,?,?)").run("BLOODBANK_EVENTS", 2, "invalid_envelope", at(2));
  const result = await pruneEvents(store, DEFAULT_RETENTION, { now: NOW });
  assert.equal(result.hookInvocations, 1);
  assert.equal(result.rejected, 1);
  assert.deepEqual(store.db.prepare("SELECT invocation_id FROM hook_invocations").all().map(r => r.invocation_id), ["new"]);
  assert.equal(store.rejectedCount, 1);
});

test("env overrides and the off switch", () => {
  assert.equal(retentionFromEnv({ HOLOCENE_RETENTION: "off" }), null);
  const policy = retentionFromEnv({ HOLOCENE_RETENTION_TELEMETRY_DAYS: "1", HOLOCENE_RETENTION_DAYS: "14", HOLOCENE_RETENTION_TELEMETRY_TYPES: "bloodbank.llm.usage.recorded" })!;
  assert.equal(policy.telemetryDays, 1);
  assert.equal(policy.defaultDays, 14);
  assert.ok(policy.telemetryTypes.includes("bloodbank.llm.usage.recorded"));
  assert.ok(policy.telemetryTypes.includes("bloodbank.agent.hook.updated"));
  assert.throws(() => retentionFromEnv({ HOLOCENE_RETENTION_DAYS: "-3" }));
});

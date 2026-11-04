import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyModel, fireKey, type Model } from "./schedule-model";
import { createScheduleSync, type SyncLoad } from "./schedule-sync";
import type { SchedulePayload } from "./types";

// The Schedule view's snapshot/stream ordering (HOLOC-24 round 3, N3): nothing heard while a snapshot is on its way is
// lost into a model that is about to be replaced.

const ID = "01a1794f-e281-7276-ba6a-cd58a1050dd5";
const T1 = "2026-11-03T21:30:00+00:00";
const T2 = "2026-11-03T21:40:00+00:00";
const snapshot = (...times: string[]): SchedulePayload => ({
  generated_at: "2026-11-03T21:28:30.000Z",
  from: "2026-11-03T05:00:00.000Z",
  to: "2026-11-04T05:00:00.000Z",
  candybars: [{ id: ID, name: "sync-jim-dropbox", schedule: "*/10 * * * *", noise: false }],
  rows: times.map((t) => [0, t, "upcoming", null, 0] as SchedulePayload["rows"][number])
});
const completed = (fireTime: string, result: "success" | "fail") => ({
  candybarId: ID,
  invocationId: "i1",
  result,
  row: { candybarId: ID, name: "sync-jim-dropbox", schedule: "*/10 * * * *", fireTime, state: "past", skipped: false, noise: false }
});

type Deferred = { resolve: (p: SchedulePayload) => void; reject: (e: Error) => void };
function harness() {
  let model: Model = emptyModel();
  const reads: Deferred[] = [];
  const loads: SyncLoad[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const sync = createScheduleSync({
    fetchSnapshot: () => new Promise<SchedulePayload>((resolve, reject) => void reads.push({ resolve, reject })),
    getModel: () => model,
    setModel: (m) => void (model = m),
    onLoad: (l) => void loads.push(l),
    bump: () => undefined,
    retryMs: 5_000,
    after: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancelAfter: (h) => void ((h as { cancelled: boolean }).cancelled = true)
  });
  const settle = () => new Promise<void>((r) => setImmediate(r));
  return { sync, reads, loads, timers, settle, model: () => model };
}

test("events heard while the first snapshot is read are applied on top of it", async () => {
  const h = harness();
  void h.sync.read();
  h.sync.event("invocation.completed", completed(T1, "fail"));
  assert.equal(h.sync.loaded, false);
  h.reads[0].resolve(snapshot(T1, T2));
  await h.settle();
  assert.equal(h.sync.loaded, true);
  assert.equal(h.model().fires.get(fireKey(ID, T1))?.lastResult, "fail");
});

test("N3: loaded stays false until the LAST queued snapshot read completes, so no event is lost into a model about to be replaced", async () => {
  const h = harness();
  void h.sync.read(); // a stream-triggered read is in flight
  h.sync.refetch(); // a rest-of-day skip asks for another while it runs
  assert.equal(h.sync.loaded, false);
  h.reads[0].resolve(snapshot(T1, T2));
  await h.settle();
  assert.equal(h.reads.length, 2, "the queued read started");
  assert.equal(h.sync.loaded, false, "still buffering: the model shown is about to be replaced");
  // An event heard while the second read is on its way.
  h.sync.event("invocation.completed", completed(T1, "success"));
  assert.equal(h.model().fires.get(fireKey(ID, T1))?.lastResult, undefined, "not applied to the model that is about to be replaced");
  // The second snapshot was generated before that event happened, so it does not carry the result.
  h.reads[1].resolve(snapshot(T1, T2));
  await h.settle();
  assert.equal(h.sync.loaded, true);
  assert.equal(h.model().fires.get(fireKey(ID, T1))?.lastResult, "success", "the buffered event landed on the new snapshot");
});

test("a reset buffered during a read clears the buffer; a reset on a current model asks for a new snapshot", async () => {
  const h = harness();
  void h.sync.read();
  h.sync.event("invocation.completed", completed(T1, "fail"));
  h.sync.event("reset", { type: "reset" });
  h.reads[0].resolve(snapshot(T1));
  await h.settle();
  assert.equal(h.model().fires.get(fireKey(ID, T1))?.lastResult, undefined, "older than the snapshot: dropped by the reset");
  h.sync.event("reset", { type: "reset" });
  assert.equal(h.sync.loaded, false);
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve(snapshot(T1));
  await h.settle();
  assert.equal(h.sync.loaded, true);
});

test("a rest-of-day skip event heard during a read refetches once more, still buffering until that lands", async () => {
  const h = harness();
  void h.sync.read();
  h.sync.event("skip.applied", { reason: "rest_of_day", row: null });
  h.reads[0].resolve(snapshot(T1));
  await h.settle();
  assert.equal(h.reads.length, 2);
  assert.equal(h.sync.loaded, false);
  h.reads[1].resolve(snapshot(T1));
  await h.settle();
  assert.equal(h.sync.loaded, true);
});

test("a failed read reports the error and retries on its own timer; dispose cancels it", async () => {
  const h = harness();
  void h.sync.read();
  h.reads[0].reject(new Error("502 bad gateway"));
  await h.settle();
  assert.deepEqual(h.loads.at(-1), { status: "error", error: "502 bad gateway" });
  assert.equal(h.sync.loaded, false);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 5_000);
  h.timers[0].fn();
  assert.equal(h.reads.length, 2, "the retry reads again");
  h.reads[1].resolve(snapshot(T1));
  await h.settle();
  assert.deepEqual(h.loads.at(-1), { status: "ok" });
  h.sync.dispose();
  void h.sync.read();
  h.reads[2].resolve(snapshot(T1));
  await h.settle();
  assert.equal(h.loads.length, 2, "after dispose nothing is reported");
});

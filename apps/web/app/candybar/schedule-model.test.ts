import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, byTime, fireKey, fromSnapshot, markSkipped, setNoise } from "./schedule-model";
import type { SchedulePayload, WireRow } from "./types";

// Frames as the live stream sent them on 2026-11-03 (holocene-view-contract.md, "Wire format").
const SYNC = "01a1794f-e281-7276-ba6a-cd58a1050dd5";
const HOOKS = "01a17aaa-0000-7000-8000-00000000aaaa";
const SNAP: SchedulePayload = {
  generated_at: "2026-11-03T21:28:30.000Z",
  from: "2026-11-03T05:00:00.000Z",
  to: "2026-11-04T05:00:00.000Z",
  candybars: [
    { id: SYNC, name: "sync-jim-dropbox", schedule: "*/10 * * * *", noise: false },
    { id: HOOKS, name: "bloodbank-agent-hooks-health", schedule: "*/5 * * * *", noise: false }
  ],
  rows: [
    [0, "2026-11-03T21:20:00+00:00", "past", "fail", 0],
    [1, "2026-11-03T21:25:00+00:00", "past", "success", 0],
    [1, "2026-11-03T21:30:00+00:00", "current", null, 0],
    [0, "2026-11-03T21:30:00+00:00", "upcoming", null, 0],
    [1, "2026-11-03T21:35:00+00:00", "upcoming", null, 0]
  ]
};
const row = (over: Partial<WireRow>): WireRow => ({ candybarId: SYNC, name: "sync-jim-dropbox", schedule: "*/10 * * * *", fireTime: "2026-11-03T21:30:00+00:00", state: "past", skipped: false, noise: false, ...over });
const states = (m: ReturnType<typeof fromSnapshot>) => [...m.fires.values()].sort(byTime).map((f) => `${f.name.slice(0, 4)}@${f.fireTime.slice(11, 16)}:${f.state}${f.lastResult ? `:${f.lastResult}` : ""}${f.running ? ":running" : ""}`);

test("fromSnapshot keys rows exactly as the stream does", () => {
  const m = fromSnapshot(SNAP);
  assert.equal(m.fires.size, 5);
  assert.ok(m.fires.has(`${SYNC}@2026-11-03T21:20:00+00:00`));
  assert.equal(m.fires.get(fireKey(SYNC, "2026-11-03T21:20:00+00:00"))?.lastResult, "fail");
});

test("current.advanced moves the cut: earlier rows go past, the named row is current, the rest upcoming", () => {
  const m = fromSnapshot(SNAP);
  const r = applyEvent(m, "current.advanced", { type: "current.advanced", seq: 1, key: "current", at: "x", cut: "2026-11-03T21:31:00+00:00", current: row({ candybarId: HOOKS, name: "bloodbank-agent-hooks-health", fireTime: "2026-11-03T21:35:00+00:00", state: "current" }) });
  assert.equal(r, "ok");
  assert.deepEqual(states(m), [
    "sync@21:20:past:fail",
    "bloo@21:25:past:success",
    "bloo@21:30:past",
    "sync@21:30:past",
    "bloo@21:35:current"
  ]);
});

test("a fire runs, then completes; replaying the frames changes nothing", () => {
  const m = fromSnapshot(SNAP);
  const started = { candybarId: SYNC, invocationId: "i1", trigger: "scheduled", row: row({}) };
  const completed = { ...started, result: "success", row: row({ lastResult: "success" }) };
  applyEvent(m, "invocation.started", started);
  assert.equal(m.fires.get(fireKey(SYNC, "2026-11-03T21:30:00+00:00"))?.running, true);
  applyEvent(m, "invocation.completed", completed);
  const once = states(m);
  applyEvent(m, "invocation.completed", completed);
  assert.deepEqual(states(m), once);
  assert.ok(once.includes("sync@21:30:past:success"));
});

test("a late `invocation.started` replayed over a newer snapshot keeps the recorded result and is not running", () => {
  const m = fromSnapshot(SNAP);
  applyEvent(m, "invocation.started", { candybarId: SYNC, row: row({ fireTime: "2026-11-03T21:20:00+00:00" }) });
  const f = m.fires.get(fireKey(SYNC, "2026-11-03T21:20:00+00:00"));
  assert.equal(f?.lastResult, "fail");
  assert.equal(f?.running, undefined);
});

test("skip.applied replaces the row; a manual run with no schedule row is ignored", () => {
  const m = fromSnapshot(SNAP);
  applyEvent(m, "skip.applied", { candybarId: SYNC, reason: "occurrence", row: row({ state: "upcoming", skipped: true }) });
  assert.equal(m.fires.get(fireKey(SYNC, "2026-11-03T21:30:00+00:00"))?.skipped, true);
  assert.equal(applyEvent(m, "invocation.started", { candybarId: SYNC, row: null }), "ignored");
});

test("a windowed definition.changed replaces that candybar's rows", () => {
  const m = fromSnapshot(SNAP);
  applyEvent(m, "definition.changed", {
    candybarId: SYNC,
    change: "updated",
    definition: { id: SYNC, name: "sync-jim", schedule: "*/15 * * * *", noise: true },
    changes: { schedule: "*/15 * * * *" },
    rows: [row({ name: "sync-jim", schedule: "*/15 * * * *", fireTime: "2026-11-03T21:45:00+00:00", state: "upcoming", noise: true })]
  });
  const sync = [...m.fires.values()].filter((f) => f.candybarId === SYNC);
  assert.deepEqual(sync.map((f) => `${f.name}@${f.fireTime.slice(11, 16)}`), ["sync-jim@21:45"]);
});

test("reset, and a windowless enable/schedule change, ask for a refetch", () => {
  const m = fromSnapshot(SNAP);
  assert.equal(applyEvent(m, "reset", { reason: "unresumable", cut: "x", current: null }), "refetch");
  assert.equal(applyEvent(m, "definition.changed", { candybarId: SYNC, definition: { enabled: false }, changes: { enabled: false } }), "refetch");
  assert.equal(applyEvent(m, "definition.changed", { candybarId: SYNC, definition: { name: "renamed" }, changes: { name: "renamed" } }), "ok");
  assert.equal(m.fires.get(fireKey(SYNC, "2026-11-03T21:20:00+00:00"))?.name, "renamed");
});

test("unknown events and junk payloads are ignored", () => {
  const m = fromSnapshot(SNAP);
  const before = m.version;
  assert.equal(applyEvent(m, "something.new", {}), "ignored");
  assert.equal(applyEvent(m, "invocation.completed", "nope"), "ignored");
  assert.equal(applyEvent(m, "invocation.completed", { row: { candybarId: SYNC, fireTime: "soon", state: "past" } }), "ignored");
  assert.equal(m.version, before);
});

test("a skip recorded against a fire that already ran does not mark it skipped (Candybar's own rule)", () => {
  const m = fromSnapshot(SNAP);
  applyEvent(m, "skip.applied", { candybarId: SYNC, reason: "occurrence", row: row({ fireTime: "2026-11-03T21:20:00+00:00", skipped: true }) });
  const f = m.fires.get(fireKey(SYNC, "2026-11-03T21:20:00+00:00"));
  assert.equal(f?.skipped, false);
  assert.equal(f?.lastResult, "fail");
});

test("a rest-of-day skip asks for a refetch: the stream carries only its first row", () => {
  const m = fromSnapshot(SNAP);
  assert.equal(applyEvent(m, "skip.applied", { candybarId: SYNC, reason: "rest_of_day", row: row({ skipped: true }) }), "refetch");
});

test("a malformed snapshot is refused rather than rendered empty", () => {
  assert.throws(() => fromSnapshot({ rows: null } as unknown as SchedulePayload), /malformed/);
});

test("markSkipped and setNoise update the local rows ahead of the stream", () => {
  const m = fromSnapshot(SNAP);
  const key = fireKey(SYNC, "2026-11-03T21:30:00+00:00");
  assert.equal(markSkipped(m, key), true);
  assert.equal(m.fires.get(key)?.skipped, true);
  assert.equal(markSkipped(m, key), false, "already skipped");
  assert.equal(markSkipped(m, "nope"), false);
  setNoise(m, SYNC, true);
  assert.deepEqual([...m.fires.values()].filter((f) => f.candybarId === SYNC).map((f) => f.noise), [true, true]);
  assert.equal([...m.fires.values()].filter((f) => f.candybarId === HOOKS).some((f) => f.noise), false);
});

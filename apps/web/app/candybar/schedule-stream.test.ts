import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeSchedule, type StreamStatus } from "./schedule-stream";

class FakeSource extends EventTarget {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown, id = "") {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id }));
  }
}

const WINDOW = { from: "2026-11-03T05:00:00.000Z", to: "2026-11-04T05:00:00.000Z" };

test("events reach the view, and a reconnect resumes after the last id with backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources: FakeSource[] = [];
  const events: string[] = [];
  const statuses: StreamStatus[] = [];
  const close = subscribeSchedule({
    ...WINDOW,
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s as unknown as EventSource;
    },
    onEvent: (name) => events.push(name),
    onStatus: (s) => statuses.push(s)
  });
  assert.equal(sources.length, 1);
  assert.equal(new URL(sources[0].url, "http://x").searchParams.get("after"), null);
  sources[0].dispatchEvent(new Event("open"));
  sources[0].emit("ready", { type: "ready" }, "8aac3316ea92-156396");
  sources[0].emit("invocation.completed", { type: "invocation.completed" }, "8aac3316ea92-156399");
  assert.deepEqual(events, ["ready", "invocation.completed"]);

  sources[0].dispatchEvent(new Event("error"));
  assert.equal(sources[0].closed, true);
  assert.equal(statuses.at(-1), "reconnecting");
  t.mock.timers.tick(999);
  assert.equal(sources.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 2);
  assert.equal(new URL(sources[1].url, "http://x").searchParams.get("after"), "8aac3316ea92-156399");

  // A stale source's late frames are dropped.
  sources[0].emit("invocation.started", {}, "8aac3316ea92-156400");
  assert.equal(events.length, 2);

  // Failing again before any frame doubles the wait.
  sources[1].dispatchEvent(new Event("error"));
  t.mock.timers.tick(1999);
  assert.equal(sources.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 3);

  close();
  assert.equal(sources[2].closed, true);
  sources[2].dispatchEvent(new Event("error"));
  t.mock.timers.tick(60_000);
  assert.equal(sources.length, 3, "no reconnect after close");
});

test("an unreadable frame is skipped without breaking the stream", () => {
  const sources: FakeSource[] = [];
  const events: unknown[] = [];
  subscribeSchedule({
    ...WINDOW,
    createSource: (url) => (sources.push(new FakeSource(url)), sources.at(-1)! as unknown as EventSource),
    onEvent: (_n, d) => events.push(d),
    onStatus: () => undefined
  });
  sources[0].dispatchEvent(new MessageEvent("current.advanced", { data: "{not json" }));
  sources[0].emit("current.advanced", { cut: "x" });
  assert.deepEqual(events, [{ cut: "x" }]);
});

test("a line that goes silent is replaced; pings keep it alive", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources: FakeSource[] = [];
  const statuses: string[] = [];
  subscribeSchedule({
    ...WINDOW,
    createSource: (url) => (sources.push(new FakeSource(url)), sources.at(-1)! as unknown as EventSource),
    onEvent: () => undefined,
    onStatus: (s, d) => statuses.push(`${s}${d ? `: ${d}` : ""}`)
  });
  sources[0].dispatchEvent(new Event("open"));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(15_000);
    sources[0].dispatchEvent(new MessageEvent("ping", { data: "{}" }));
  }
  assert.equal(sources.length, 1, "pings every 15 s keep the line");
  t.mock.timers.tick(45_000);
  assert.equal(sources[0].closed, true);
  assert.match(statuses.at(-1) ?? "", /went silent/);
  t.mock.timers.tick(1_000);
  assert.equal(sources.length, 2);
});

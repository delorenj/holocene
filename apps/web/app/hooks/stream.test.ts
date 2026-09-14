import assert from "node:assert/strict";
import test from "node:test";
import type { HookHistory, HookInvocation, HookSnapshot } from "./model";
import { hookFeedLabel, hookQuery, subscribeToHooks, type HookConnection } from "./stream";

class FakeSource extends EventTarget {
  readyState = 0;
  closes = 0;
  queued: EventListener[] = [];

  override addEventListener(name: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (name === "hooks-history" && typeof callback === "function") this.queued.push(callback);
    super.addEventListener(name, callback, options);
  }

  close() { this.readyState = 2; this.closes++; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  error(terminal = false) { this.readyState = terminal ? 2 : 0; this.dispatchEvent(new Event("error")); }
  send(name: string, value: unknown, cursor: number) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(value), lastEventId: String(cursor) }));
  }
}

const snapshot: HookSnapshot = {
  schema_version: 1,
  generated_at: "2026-09-13T20:00:00Z",
  hub: { state: "waiting", started_at: "", pid: 0, publish_enabled: true, async_running: 0 },
  bindings: [], handlers: [], totals: {}, handler_activity: [],
  collection: { state: "live", cursor: 0, last_event_at: null, error: null, hook_snapshot_state: "waiting", hook_snapshot_at: null, history_gap: false },
};

function invocation(id: string, revision: number, status = "started"): HookInvocation {
  return { invocation_id: id, revision, cli: "claude", native: "UserPromptSubmit", received_at: "2026-09-13T20:00:00Z", updated_at: "2026-09-13T20:00:01Z", status, executions: [] };
}

function history(items: HookInvocation[], offset = 0): HookHistory {
  return { items, total: items.length, limit: 25, offset, next_offset: null };
}

function connect(once = false) {
  const source = new FakeSource();
  const pages: HookHistory[] = [];
  const snapshots: HookSnapshot[] = [];
  const states: HookConnection[] = [];
  const errors: string[] = [];
  const urls: string[] = [];
  const close = subscribeToHooks({
    query: hookQuery({ limit: 25, offset: 0, cli: "claude", status: "started" }), once,
    onHistory: (value) => pages.push(value), onSnapshot: (value) => snapshots.push(value),
    onConnection: (state) => states.push(state), onError: (error) => errors.push(error),
    createSource: (url) => { urls.push(url); return source as unknown as EventSource; },
  });
  return { source, pages, snapshots, states, errors, urls, close };
}

test("filters select the projection and each committed page replaces previous matching rows", () => {
  const feed = connect();
  assert.equal(feed.urls[0], "/api/modules/hooks/stream?limit=25&offset=0&cli=claude&status=started");
  feed.source.open();
  feed.source.send("hooks-status", snapshot, 4);
  assert.deepEqual(feed.states, ["connecting"]);
  feed.source.send("hooks-history", history([invocation("first", 4)]), 4);
  assert.equal(feed.states.at(-1), "live");

  // A completed invocation leaves the 'started' results. A new arrival takes
  // its place without retaining the old row or appending a duplicate.
  feed.source.send("hooks-history", history([invocation("next", 6)]), 6);
  assert.deepEqual(feed.pages.at(-1)?.items.map((row) => row.invocation_id), ["next"]);
  feed.source.send("hooks-history", history([]), 7);
  assert.equal(feed.pages.at(-1)?.items.length, 0);
  feed.close();
});

test("reconnect retains the previous page and becomes live after a complete current view", () => {
  const feed = connect();
  feed.source.open();
  feed.source.send("hooks-status", snapshot, 10);
  feed.source.send("hooks-history", history([invocation("one", 10)]), 10);
  feed.source.error();
  assert.equal(feed.states.at(-1), "reconnecting");
  assert.equal(feed.pages.at(-1)?.items[0].revision, 10);
  feed.source.open();
  feed.source.send("hooks-status", snapshot, 12);
  assert.equal(feed.states.at(-1), "reconnecting");
  feed.source.send("hooks-history", history([invocation("one", 12, "succeeded")]), 12);
  assert.equal(feed.states.at(-1), "live");
  assert.equal(feed.pages.at(-1)?.items[0].status, "succeeded");
  assert.equal(feed.pages.at(-1)?.items.length, 1);
  feed.close();
});

test("late updates from a paused, unmounted, or superseded subscription cannot change the view", () => {
  const old = connect();
  old.source.send("hooks-status", snapshot, 1);
  old.source.send("hooks-history", history([invocation("old-filter", 1)]), 1);
  old.close();
  // Simulate an already queued browser callback, even after listener removal.
  old.source.queued[0](new MessageEvent("hooks-history", { data: JSON.stringify(history([invocation("late", 2)])), lastEventId: "2" }));
  old.source.error();
  assert.equal(old.pages.length, 1);
  assert.equal(old.errors.length, 0);
  assert.equal(old.source.closes, 1);

  const resumed = connect();
  resumed.source.send("hooks-status", snapshot, 8);
  resumed.source.send("hooks-history", history([invocation("current", 8)]), 8);
  assert.equal(resumed.pages.at(-1)?.items[0].invocation_id, "current");
  resumed.close();
});

test("reconnect accepts an authoritative bootstrap after the collector cursor restarts", () => {
  const feed = connect();
  feed.source.open();
  feed.source.send("hooks-status", { ...snapshot, collection: { ...snapshot.collection, cursor: 20 } }, 20);
  feed.source.send("hooks-history", history([invocation("before-rebuild", 20)]), 20);
  feed.source.error();
  feed.source.open();
  feed.source.send("hooks-status", { ...snapshot, collection: { ...snapshot.collection, cursor: 2 } }, 2);
  assert.equal(feed.states.at(-1), "reconnecting");
  feed.source.send("hooks-history", history([invocation("after-rebuild", 2)]), 2);
  assert.equal(feed.states.at(-1), "live");
  assert.equal(feed.snapshots.at(-1)?.collection?.cursor, 2);
  assert.equal(feed.pages.at(-1)?.items[0].invocation_id, "after-rebuild");
  feed.source.send("hooks-history", history([invocation("out-of-order", 1)]), 1);
  assert.equal(feed.pages.at(-1)?.items[0].invocation_id, "after-rebuild");
  feed.close();
});

test("a connected feed is catching up until the collection finishes retained event replay", () => {
  const presentation = { paused: false, browsingHistory: false, connection: "live" as const, error: false, hubIssue: false };
  const collection = { ...snapshot.collection!, hook_snapshot_state: "fresh" as const, catching_up: true };
  assert.equal(hookFeedLabel({ ...presentation, collection }), "Catching up");
  assert.equal(hookFeedLabel({ ...presentation, collection: { ...collection, catching_up: false } }), "Live");
  assert.equal(hookFeedLabel({ ...presentation, collection: { ...collection, state: "connecting" } }), "Connecting");
  assert.equal(hookFeedLabel({ ...presentation, paused: true, collection }), "Paused");
});

test("historical and manually refreshed paused pages close after both projections arrive", () => {
  const feed = connect(true);
  feed.source.send("hooks-history", history([invocation("archived", 10)], 25), 10);
  assert.equal(feed.source.closes, 0);
  feed.source.send("hooks-status", snapshot, 10);
  assert.equal(feed.source.closes, 1);
  feed.source.send("hooks-history", history([invocation("new", 11)], 25), 11);
  assert.equal(feed.pages.length, 1);
  assert.equal(feed.pages[0].offset, 25);
});

test("cursor replay cannot regress a row, and repeated invocation ids keep the newest revision", () => {
  const feed = connect();
  feed.source.send("hooks-status", snapshot, 20);
  feed.source.send("hooks-history", history([invocation("one", 20, "failed"), invocation("one", 19)]), 20);
  assert.equal(feed.pages[0].items.length, 1);
  assert.equal(feed.pages[0].items[0].status, "failed");
  feed.source.send("hooks-history", history([invocation("one", 18)]), 18);
  assert.equal(feed.pages.length, 1);
  // A status frame shares its cursor with history and remains independently valid.
  feed.source.send("hooks-status", { ...snapshot, hub: { ...snapshot.hub, state: "healthy" } }, 20);
  assert.equal(feed.snapshots.at(-1)?.hub.state, "healthy");
  feed.close();
});

test("invalid data preserves the last projection and a terminal disconnect offers refresh", () => {
  const feed = connect();
  feed.source.send("hooks-status", snapshot, 1);
  feed.source.send("hooks-history", history([invocation("safe", 1)]), 1);
  feed.source.send("hooks-history", { items: [null], total: 1, offset: 0 }, 2);
  assert.equal(feed.pages.length, 1);
  assert.match(feed.errors.at(-1) ?? "", /execution history could not be read/);
  feed.source.send("hooks-history", history([invocation("safe", 2, "succeeded")]), 2);
  assert.equal(feed.pages.at(-1)?.items[0].status, "succeeded");
  feed.source.error(true);
  assert.equal(feed.states.at(-1), "offline");
  assert.match(feed.errors.at(-1) ?? "", /Refresh to reconnect/);
  feed.close();
});

test("query changes preserve encoded native names and remove filters that were cleared", () => {
  const selected = new URLSearchParams(hookQuery({ limit: 25, offset: 50, cli: "custom", native: "Tool&A", handler: "mcp:read/file", status: "failed" }));
  assert.equal(selected.get("native"), "Tool&A");
  assert.equal(selected.get("handler"), "mcp:read/file");
  const cleared = new URLSearchParams(hookQuery({ limit: 25, offset: 0, handler: "", status: "" }));
  assert.deepEqual([...cleared.keys()], ["limit", "offset"]);
});

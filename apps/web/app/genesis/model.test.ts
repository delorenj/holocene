import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decidedText,
  emailAction,
  expiryText,
  filterTimeline,
  liveState,
  needsYou,
  newerOverview,
  otherFields,
  reasonWord,
  shortDuration,
  statement,
  timelineKind
} from "./model";
import { subscribeGenesis, type StreamStatus } from "./stream";
import type { Approval, GenesisEvent, GenesisOverview } from "./types";

// Generic fixtures only: a placeholder client, never a real one.
const T0 = Date.parse("2026-11-16T12:00:00Z");
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

const approval = (over: Partial<Approval> = {}): Approval => ({
  approval_id: "prop-1", client_id: "client-a", client_name: "Test client", bot_id: "client-a:assistant", kind: "email.send",
  summary: "Send the update", question: "May I send this?", channel: "web", expires_at: iso(30),
  action: { to: ["someone@example.com"], subject: "Update", body_preview: "Hi" }, operator_url: "https://genesis.delo.sh/operator?client=client-a",
  test: false, requested: true, requested_at: iso(0), requested_cursor: 1, state: "pending", status: null, decided_via: null,
  resolved_at: null, resolution_type: null, last_cursor: 1, steps: [], ...over
});
const event = (type: string, over: Partial<GenesisEvent> = {}): GenesisEvent => {
  const [, , entity, action] = type.split(".");
  return {
    cursor: 1, id: `e-${type}`, type, entity, action, time: iso(0), collected_at: iso(0), subject: type, producer: "genesis", source: null,
    correlationid: null, causationid: null, actor: null, summary: null, client_id: "client-a", client_name: "Test client", bot_id: null,
    operator_url: null, test: false, data: {}, ...over
  };
};
const overview = (over: Partial<GenesisOverview> = {}): GenesisOverview => ({
  generated_at: iso(0), cursor: 10, needs_you: { approvals: [], alerts: [] }, approvals: [], alerts: [], timeline: [],
  counts: { events: 0, by_type: {}, pending: 0, lapsed: 0, unacknowledged: 0 },
  source: { state: "live", lastEventAt: null, catchingUp: false, error: null }, ...over
});

test("a pending approval lapses on screen when its expiry passes; resolved ones keep their state", () => {
  assert.equal(liveState(approval(), T0 + 29 * 60_000), "pending");
  assert.equal(liveState(approval(), T0 + 30 * 60_000), "lapsed");
  assert.equal(liveState(approval({ state: "approved" }), T0 + 60 * 60_000), "approved");
  assert.equal(liveState(approval({ expires_at: null }), T0 + 1e9), "pending");
});

test("expiry and durations read as a countdown, then as time since", () => {
  assert.equal(expiryText(iso(42), T0), "expires in 42m");
  assert.equal(expiryText(iso(-3), T0), "lapsed 3m ago");
  assert.equal(expiryText("not a date", T0), undefined);
  assert.equal(shortDuration(14), "14s");
  assert.equal(shortDuration(3960), "1h 06m");
  assert.equal(shortDuration(2 * 86400 + 3 * 3600), "2d 03h");
});

test("an email.send action yields recipients, subject and preview; other kinds list their fields", () => {
  assert.deepEqual(emailAction({ to: ["a@example.com"], cc: ["b@example.com"], subject: "Hi", body_preview: "Body", attachments: 2 }), {
    to: ["a@example.com"], cc: ["b@example.com"], subject: "Hi", bodyPreview: "Body", extra: [["attachments", "2"]]
  });
  assert.equal(emailAction({ event_title: "Call" }), null);
  assert.deepEqual(otherFields({ event_title: "Call", attendees: ["x@example.com", "y@example.com"], when: { start: "10:00" }, empty: "" }), [
    ["event_title", "Call"], ["attendees", "x@example.com, y@example.com"], ["when", "{\"start\":\"10:00\"}"]
  ]);
});

test("timeline kinds, reasons and decided text", () => {
  assert.equal(timelineKind(event("bloodbank.genesis.approval.requested")), "approval");
  assert.equal(timelineKind(event("bloodbank.genesis.approval.denied")), "resolution");
  assert.equal(timelineKind(event("bloodbank.genesis.alert.raised")), "alert");
  assert.equal(timelineKind(event("bloodbank.genesis.desk.restarted")), "generic");
  assert.equal(reasonWord("operator_requested"), "The assistant asked for you");
  assert.equal(reasonWord("desk_quota_exceeded"), "Desk quota exceeded");
  assert.equal(decidedText(approval({ state: "approved", decided_via: "telegram", resolved_at: iso(-4), status: "sent" }), T0), "Approved via telegram 4m ago (status sent)");
  assert.equal(decidedText(approval({ state: "expired", decided_via: "expiry", resolved_at: iso(-1) }), T0), "Expired 1m ago");
  assert.equal(decidedText(approval(), T0), undefined);
});

test("filters and test events", () => {
  const events = [
    event("bloodbank.genesis.approval.requested"), event("bloodbank.genesis.alert.raised", { test: true }), event("bloodbank.genesis.desk.restarted")
  ];
  assert.equal(filterTimeline(events, "all", false).length, 3);
  assert.equal(filterTimeline(events, "all", true).length, 2);
  assert.deepEqual(filterTimeline(events, "other", false).map((e) => e.entity), ["desk"]);
  assert.deepEqual(filterTimeline(events, "alerts", true), []);
});

test("Needs you drops an approval that lapsed since the server's read; the statement counts what is left", () => {
  const o = overview({
    needs_you: {
      approvals: [approval({ approval_id: "prop-soon", expires_at: iso(1) }), approval({ approval_id: "prop-test", test: true })],
      alerts: [{
        alert_id: "al-1", client_id: "client-a", client_name: "Test client", bot_id: null, reason: "operator_requested", severity: "warning",
        summary: "Help", detail: null, operator_url: null, test: false, raised_at: iso(0), cursor: 2, event_id: "e", acknowledged: false,
        acknowledged_at: null, acknowledged_via: null
      }]
    },
    counts: { events: 4, by_type: {}, pending: 2, lapsed: 0, unacknowledged: 1 }
  });
  assert.equal(needsYou(o, T0).approvals.length, 2);
  assert.deepEqual(needsYou(o, T0 + 2 * 60_000).approvals.map((a) => a.approval_id), ["prop-test"]);
  assert.deepEqual(needsYou(o, T0 + 2 * 60_000, true).approvals, []);
  assert.equal(statement(o, T0), "2 approvals waiting on a client and 1 open alert.");
  assert.equal(statement(overview(), T0), "No Genesis events yet. Approval requests and alerts from client assistants land here as they happen.");
  assert.equal(statement(overview({ counts: { events: 3, by_type: {}, pending: 0, lapsed: 0, unacknowledged: 0 }, timeline: [event("bloodbank.genesis.desk.restarted", { time: iso(-5) })] }), T0),
    "Nothing needs you. 3 Genesis events in the collection, newest 5m ago.");
});

test("the fresher of the stream and the poll wins", () => {
  const a = overview({ cursor: 10, generated_at: iso(1) });
  const b = overview({ cursor: 11, generated_at: iso(0) });
  assert.equal(newerOverview(a, b), b);
  assert.equal(newerOverview(a, overview({ cursor: 10, generated_at: iso(2) }))?.generated_at, iso(2));
  assert.equal(newerOverview(undefined, a), a);
});

class FakeSource extends EventTarget {
  closed = false;
  constructor(readonly url: string) { super(); }
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: typeof data === "string" ? data : JSON.stringify(data) })); }
}

test("the stream delivers overviews, skips an unreadable frame, and reconnects with backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources: FakeSource[] = [];
  const got: unknown[] = [];
  const statuses: StreamStatus[] = [];
  const close = subscribeGenesis({
    createSource: (url) => (sources.push(new FakeSource(url)), sources.at(-1)! as unknown as EventSource),
    onOverview: (d) => got.push(d),
    onStatus: (s) => statuses.push(s)
  });
  assert.equal(sources[0].url, "/api/modules/genesis/stream");
  sources[0].dispatchEvent(new Event("open"));
  sources[0].emit("overview", { cursor: 1 });
  sources[0].emit("overview", "{not json");
  assert.deepEqual(got, [{ cursor: 1 }]);
  sources[0].dispatchEvent(new Event("error"));
  assert.equal(sources[0].closed, true);
  assert.equal(statuses.at(-1), "reconnecting");
  t.mock.timers.tick(1000);
  assert.equal(sources.length, 2);
  sources[0].emit("overview", { cursor: 99 }); // a stale source's late frame is dropped
  assert.equal(got.length, 1);
  sources[1].dispatchEvent(new Event("error"));
  t.mock.timers.tick(1999);
  assert.equal(sources.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 3);
  close();
  assert.equal(sources[2].closed, true);
});

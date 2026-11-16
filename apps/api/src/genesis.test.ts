import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { BloodbankDelivery } from "@holocene/bloodbank-client";
import { EventStore, typeRange } from "./event-store.js";
import { EventCollector } from "./event-collector.js";
import { registerEventRoutes } from "./event-routes.js";
import { deriveAlerts, deriveApprovals, genesisOverview, toGenesisEvents, GENESIS_PREFIX } from "./genesis.js";
import { projectProposals, registerGenesisRoutes } from "./genesis-routes.js";

// Fixtures are generic on purpose: client names in tests are placeholders, never a real client's.
const created = "2026-11-16T12:00:00Z";
const position = { name: "BLOODBANK_EVENTS", created, first: 1, last: 100000 };
const T0 = Date.parse("2026-11-16T12:00:00Z");
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();
const CLIENT = "11111111-2222-4333-8444-555555555555";
let seq = 0;

function envelope(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const [, , entity, action] = type.split(".");
  const id = `evt-${++seq}`;
  return {
    specversion: "1.0", id, type, source: "urn:33god:service:genesis", producer: "genesis", time: (data.occurred_at as string) ?? created,
    subject: `bloodbank.evt.genesis.${entity}.${action}`, actor: { type: "agent", agent_id: `${CLIENT}:assistant` },
    data: { schema_version: 1, client_id: CLIENT, client_name: "Test client", bot_id: `${CLIENT}:assistant`,
      operator_url: `https://genesis.delo.sh/operator?client=${CLIENT}`, occurred_at: created, ...data },
    ...extra,
  };
}
function delivery(env: { id: string; type: string }): BloodbankDelivery {
  seq++;
  return { stream: position.name, sequence: seq, subject: env.type.replace("bloodbank.", "bloodbank.evt."), data: new TextEncoder().encode(JSON.stringify(env)) };
}
const plain = (type: string) => ({ specversion: "1.0", id: `evt-${++seq}`, type, source: "/test", data: {} });
const requested = (id: string, mins: number, expiresIn = 60, extra: Record<string, unknown> = {}) => envelope("bloodbank.genesis.approval.requested", {
  approval_id: id, kind: "email.send", summary: `Send the update (${id})`, question: "May I send this?", channel: "web",
  expires_at: iso(mins + expiresIn), occurred_at: iso(mins),
  action: { to: ["someone@example.com"], subject: "Weekly update", body_preview: "Hi, here is the update." }, ...extra,
}, { correlationid: id, causationid: id });
const resolved = (action: "granted" | "denied" | "expired", id: string, mins: number, via = "web") => envelope(`bloodbank.genesis.approval.${action}`, {
  approval_id: id, kind: "email.send", summary: `Resolved ${id}`, status: action === "granted" ? "sent" : action === "denied" ? "rejected" : "expired",
  decided_via: via, occurred_at: iso(mins),
}, { correlationid: id });
const alert = (id: string, mins: number, severity = "warning", reason = "operator_requested") => envelope("bloodbank.genesis.alert.raised", {
  alert_id: id, reason, severity, summary: `Alert ${id}`, detail: "The desk asked for help.", occurred_at: iso(mins),
}, { correlationid: id });

function seeded(envelopes: Array<{ id: string; type: string }>) {
  const store = new EventStore(":memory:");
  store.checkpoint(position);
  for (const env of envelopes) store.ingest(delivery(env));
  return store;
}

test("typeRange covers exactly the strings under a prefix", () => {
  assert.deepEqual(typeRange("bloodbank.genesis."), ["bloodbank.genesis.", "bloodbank.genesis/"]);
  assert.equal(typeRange(""), null);
});

test("the prefix query returns every Genesis type, newest first, and nothing outside the prefix", () => {
  const store = seeded([
    plain("bloodbank.agent.invocation.completed"),
    requested("prop-a", 0),
    plain("bloodbank.genesisx.thing.happened"),
    plain("bloodbank.genesis.desk.restarted"), // a type no code knows about yet
    alert("al-1", 2),
    plain("bloodbank.gateway.turn.completed"),
  ]);
  const rows = store.byTypePrefix(GENESIS_PREFIX, { limit: 10 });
  assert.deepEqual(rows.map((r) => r.envelope.type), [
    "bloodbank.genesis.alert.raised", "bloodbank.genesis.desk.restarted", "bloodbank.genesis.approval.requested",
  ]);
  assert.ok(rows[0].cursor > rows[1].cursor && rows[1].cursor > rows[2].cursor);
  // Paging by cursor and narrowing the prefix both stay on the index range.
  assert.deepEqual(store.byTypePrefix(GENESIS_PREFIX, { limit: 10, before: rows[0].cursor }).map((r) => r.envelope.type),
    ["bloodbank.genesis.desk.restarted", "bloodbank.genesis.approval.requested"]);
  assert.deepEqual(store.byTypePrefix("bloodbank.genesis.approval.").map((r) => r.envelope.type), ["bloodbank.genesis.approval.requested"]);
  assert.equal(store.latestCursorWithPrefix(GENESIS_PREFIX), rows[0].cursor);
  assert.equal(store.latestCursorWithPrefix("bloodbank.nothing."), 0);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events INDEXED BY events_type_cursor WHERE type>=? AND type<? AND cursor>? AND cursor<? ORDER BY cursor DESC LIMIT ?")
    .all("bloodbank.genesis.", "bloodbank.genesis/", 0, 1e15, 10).map((r) => String(r.detail));
  assert.ok(plan.some((d) => d.includes("events_type_cursor")), plan.join(" | "));
});

test("approvals join each request with its latest resolution; an unresolved one past expiry is lapsed", () => {
  const store = seeded([
    requested("prop-pending", 0, 120),
    requested("prop-ok", 1), resolved("granted", "prop-ok", 5, "telegram"),
    requested("prop-no", 2), resolved("denied", "prop-no", 6),
    requested("prop-exp", 3), resolved("expired", "prop-exp", 70, "expiry"),
    requested("prop-lapsed", -100, 30),
    resolved("granted", "prop-orphan", 8), // the request aged out of the collection
  ]);
  const events = toGenesisEvents(store.byTypePrefix(GENESIS_PREFIX, { limit: 100 }));
  const byId = new Map(deriveApprovals(events, T0 + 10 * 60_000).map((a) => [a.approval_id, a]));
  assert.equal(byId.get("prop-pending")!.state, "pending");
  assert.equal(byId.get("prop-pending")!.question, "May I send this?");
  assert.deepEqual(byId.get("prop-pending")!.action, { to: ["someone@example.com"], subject: "Weekly update", body_preview: "Hi, here is the update." });
  assert.equal(byId.get("prop-ok")!.state, "approved");
  assert.equal(byId.get("prop-ok")!.decided_via, "telegram");
  assert.equal(byId.get("prop-ok")!.status, "sent");
  assert.equal(byId.get("prop-ok")!.summary, "Send the update (prop-ok)", "the card keeps the request's summary");
  assert.equal(byId.get("prop-no")!.state, "declined");
  assert.equal(byId.get("prop-exp")!.state, "expired");
  assert.equal(byId.get("prop-lapsed")!.state, "lapsed");
  assert.equal(byId.get("prop-orphan")!.state, "approved");
  assert.equal(byId.get("prop-orphan")!.requested, false);
  assert.deepEqual(byId.get("prop-ok")!.steps.map((s) => s.action), ["requested", "granted"]);

  // A later resolution wins over an earlier one for the same id.
  const twice = seeded([requested("prop-x", 0), resolved("denied", "prop-x", 1), resolved("expired", "prop-x", 2, "expiry")]);
  assert.equal(deriveApprovals(toGenesisEvents(twice.byTypePrefix(GENESIS_PREFIX)), T0)[0].state, "expired");
});

test("the overview puts pending approvals (soonest expiry first) and open alerts (most severe first) under Needs you", () => {
  const store = seeded([
    requested("prop-late", 0, 120), requested("prop-soon", 1, 10), requested("prop-done", 2), resolved("granted", "prop-done", 3),
    alert("al-info", 4, "info"), alert("al-crit", 5, "critical"), alert("al-acked", 6, "critical"),
    alert("al-upstream", 7, "warning"),
    envelope("bloodbank.genesis.alert.resolved", { alert_id: "al-upstream" }, { correlationid: "al-upstream" }),
    requested("prop-test", 8, 30, { test: true }),
  ]);
  const events = toGenesisEvents(store.byTypePrefix(GENESIS_PREFIX, { limit: 100 }));
  const view = genesisOverview(events, new Map([["al-acked", { at: iso(9), via: "holocene" as const }]]), T0 + 5 * 60_000);
  assert.deepEqual(view.needs_you.approvals.map((a) => a.approval_id), ["prop-soon", "prop-test", "prop-late"]);
  assert.equal(view.needs_you.approvals[1].test, true);
  assert.deepEqual(view.needs_you.alerts.map((a) => a.alert_id), ["al-crit", "al-info"]);
  const alerts = new Map(view.alerts.map((a) => [a.alert_id, a]));
  assert.equal(alerts.get("al-acked")!.acknowledged_via, "holocene");
  assert.equal(alerts.get("al-upstream")!.acknowledged_via, "genesis", "a closing alert.* fact from Genesis acknowledges it");
  assert.equal(view.timeline.length, events.length);
  assert.equal(view.timeline[0].type, "bloodbank.genesis.approval.requested");
  assert.equal(view.counts.pending, 3);
  assert.equal(view.counts.unacknowledged, 2);
});

test("an operator_url that is not https falls back to the client's console link", () => {
  const store = seeded([envelope("bloodbank.genesis.alert.raised", { alert_id: "al-js", reason: "gateway_failure", severity: "bogus", operator_url: "javascript:alert(1)" })]);
  const [a] = deriveAlerts(toGenesisEvents(store.byTypePrefix(GENESIS_PREFIX)));
  assert.equal(a.operator_url, `https://genesis.delo.sh/operator?client=${CLIENT}`);
  assert.equal(a.severity, "warning");
});

test("proposals are passed on without digests or signature hashes", () => {
  assert.deepEqual(projectProposals({ proposals: [{ id: "prop-1", status: "proposed", digest: "abc", signature_sha256: "def", to: ["a@example.com"] }] }),
    [{ id: "prop-1", status: "proposed", to: ["a@example.com"] }]);
  assert.deepEqual(projectProposals({}), []);
});

// ---------------------------------------------------------------- routes

type Call = { url: string; method: string; auth: string | null; body: unknown };
function fakeGenesis(handler: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { http, calls };
}

async function fixture(envelopes: Array<{ id: string; type: string }>, handler: Parameters<typeof fakeGenesis>[0], tokens = ["token-1"]) {
  const store = seeded(envelopes);
  const collector = new EventCollector(store);
  const app = Fastify();
  await registerEventRoutes(app, collector);
  const genesis = fakeGenesis(handler);
  const reads: string[] = [];
  registerGenesisRoutes(app, collector, {
    http: genesis.http, baseUrl: "https://genesis.test", now: () => T0 + 5 * 60_000, coalesceMs: 5,
    secrets: async (ref) => { reads.push(ref); return tokens[Math.min(reads.length - 1, tokens.length - 1)]; },
  });
  return { app, store, collector, calls: genesis.calls, reads };
}

test("GET events, overview, approvals and alerts read the collection", async (t) => {
  const { app } = await fixture([requested("prop-a", 0), plain("bloodbank.genesis.desk.restarted"), alert("al-1", 1)], () => ({ status: 500 }));
  t.after(() => app.close());
  const events = (await app.inject("/api/modules/genesis/events?limit=2")).json();
  assert.deepEqual(events.items.map((e: { type: string }) => e.type), ["bloodbank.genesis.alert.raised", "bloodbank.genesis.desk.restarted"]);
  assert.equal(typeof events.next_before, "number");
  const older = (await app.inject(`/api/modules/genesis/events?limit=2&before=${events.next_before}`)).json();
  assert.deepEqual(older.items.map((e: { type: string }) => e.type), ["bloodbank.genesis.approval.requested"]);
  assert.equal(older.next_before, null);
  assert.equal(older.items[0].data.approval_id, "prop-a", "events carry parsed data");
  const overview = (await app.inject("/api/modules/genesis/overview")).json();
  assert.equal(overview.needs_you.approvals[0].approval_id, "prop-a");
  assert.equal(overview.needs_you.alerts[0].alert_id, "al-1");
  assert.equal((await app.inject("/api/modules/genesis/approvals?state=pending")).json().approvals.length, 1);
  assert.equal((await app.inject("/api/modules/genesis/alerts?open=true")).json().alerts.length, 1);
  assert.equal((await app.inject("/api/modules/genesis/events?type=bloodbank.other.x")).statusCode, 400);
});

test("Reply posts to the operator say route with the bearer token, and only when confirmed", async (t) => {
  const { app, calls } = await fixture([], (call) => ({
    status: 200,
    body: { messages: [{ id: "m1", source: "gateway", content: "hi" }, { id: "m2", source: "operator", content: (call.body as { message: string }).message, created: iso(5) }] },
  }));
  t.after(() => app.close());
  const unconfirmed = await app.inject({ method: "POST", url: `/api/modules/genesis/clients/${CLIENT}/reply`, payload: { message: "On it." } });
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(calls.length, 0, "nothing reaches Genesis without confirmation");
  const res = await app.inject({ method: "POST", url: `/api/modules/genesis/clients/${CLIENT}/reply`, payload: { message: "  On it.  ", confirmed: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, client_id: CLIENT, message_id: "m2", sent_at: iso(5) });
  assert.deepEqual(calls, [{ url: `https://genesis.test/api/operator/clients/${CLIENT}/chat`, method: "POST", auth: "Bearer token-1", body: { message: "On it." } }]);
  for (const id of ["..", "..%2F..%2Fx", "a%2Fb"]) {
    const bad = await app.inject({ method: "POST", url: `/api/modules/genesis/clients/${id}/reply`, payload: { message: "x", confirmed: true } });
    assert.ok([400, 404].includes(bad.statusCode), `${id}: ${bad.statusCode}`);
  }
  assert.equal(calls.length, 1, "a dot segment or a slash never reaches Genesis");
});

test("a 401 rereads the token once; Genesis refusals pass through with their code", async (t) => {
  let n = 0;
  const { app, calls, reads } = await fixture([], () => (++n === 1 ? { status: 401, body: { error: "operator_required" } } : { status: 404, body: { error: "not_found" } }), ["stale", "fresh"]);
  t.after(() => app.close());
  const res = await app.inject(`/api/modules/genesis/clients/${CLIENT}/proposals`);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "not_found" });
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer stale", "Bearer fresh"]);
  assert.equal(reads.length, 2);
});

test("acknowledging an alert is kept in Holocene when Genesis has no acknowledgement route", async (t) => {
  const { app, calls } = await fixture([alert("al-1", 0)], () => ({ status: 404, body: { error: "Route not found" } }));
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/modules/genesis/alerts/al-missing/ack" })).statusCode, 404);
  const res = await app.inject({ method: "POST", url: "/api/modules/genesis/alerts/al-1/ack" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().upstream, "not_available");
  assert.match(res.json().note, /Holocene only/);
  assert.equal(calls.at(-1)!.url, "https://genesis.test/api/operator/escalations/al-1/ack");
  const view = (await app.inject("/api/modules/genesis/overview")).json();
  assert.equal(view.needs_you.alerts.length, 0);
  assert.equal(view.alerts[0].acknowledged_via, "holocene");
});

test("the stream sends the overview on connect and again, coalesced, when a Genesis fact or an acknowledgement lands", async (t) => {
  const { app, collector } = await fixture([alert("al-1", 0)], () => ({ status: 200, body: {} }));
  t.after(() => app.close());
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(`${base}/api/modules/genesis/stream`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
  const reader = res.body!.getReader();
  let buffer = "";
  const next = async () => {
    for (;;) {
      const at = buffer.indexOf("\n\n");
      if (at >= 0) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const fields = Object.fromEntries(frame.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trimStart()]));
        if (fields.event === "overview") return JSON.parse(fields.data);
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 2000); })])
        .finally(() => clearTimeout(timer));
      if (r.done) throw new Error("stream ended");
      buffer += new TextDecoder().decode(r.value);
    }
  };
  assert.equal((await next()).needs_you.alerts.length, 1);
  // Unrelated traffic does not resend; a burst of Genesis facts arrives as one frame.
  collector.ingest(delivery(plain("bloodbank.agent.tool.invoked")));
  collector.ingest(delivery(requested("prop-a", 1)));
  collector.ingest(delivery(requested("prop-b", 1)));
  const second = await next();
  assert.equal(second.needs_you.approvals.length, 2);
  await app.inject({ method: "POST", url: "/api/modules/genesis/alerts/al-1/ack" });
  assert.equal((await next()).needs_you.alerts.length, 0);
});


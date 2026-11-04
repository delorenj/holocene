import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Fastify from "fastify";
import {
  localDate,
  parseFireTime,
  problemMessage,
  projectHistory,
  projectProfile,
  projectTask,
  readCandybars,
  registerCandybarRoutes,
  resetCandybarCache,
  summarizeTasks,
  type CandybarPayload,
  type SchedulePayload
} from "./candybar.js";

// Row actions, history, profiles, tasks and archive (HOLOC-24, steward-contract.md).
const NOW = Date.parse("2026-11-03T17:45:30Z");
const NY = "01a17938-961c-7581-b9c2-ec6f9e3a708a";
const UTC_ID = "01a176ae-bd0a-7b8f-8e20-08665b8beb9a";
const OLD = "01a17a00-0000-7000-8000-000000000009";
const def = (over: Record<string, unknown>) => ({
  id: UTC_ID, name: "deploy-smoke", description: "", tags: [], schedule: "0 9 * * *", timezone: "UTC", noise: false, enabled: true, archived: false,
  createdAt: "2026-10-26T05:28:45.578875+00:00", ...over
});
const DEFS = [
  def({}),
  def({ id: NY, name: "honda-hunt", timezone: "America/New_York" }),
  def({ id: OLD, name: "old-job", enabled: false, archived: true })
];

const inv = (result: string | null, i: number) => ({
  id: `i${i}`, candybarId: UTC_ID, trigger: "scheduled", result, errorMessage: result === "fail" ? "boom" : null, runtimeMs: 5,
  startedAt: new Date(NOW - i * 60_000).toISOString(), finishedAt: result ? new Date(NOW - i * 60_000 + 1000).toISOString() : null,
  stderrTail: "planted"
});
const task = (over: Record<string, unknown> = {}) => ({
  id: "t1", candybarId: UTC_ID, action: "enrich", status: "running", model: "automaticai/auto/fast", parentTaskId: null, sessionId: "ses_abc",
  outcome: null, summary: null, reportKey: null, invocationId: null, error: null, createdAt: "2026-11-03T17:40:00Z", startedAt: "2026-11-03T17:40:01Z", finishedAt: null, ...over
});
const PROFILE = {
  candybarId: UTC_ID,
  overview: {
    summary: "Smoke.", purpose: "p", behavior: ["a", "b"], inputs: [], outputs: [], sideEffects: [], dependencies: [], failureModes: [], verification: [], runbook: ["candybar show x"],
    source: { repo: "candybar", paths: ["deploy/smoke"], runner: "exec" }, cadenceNote: "fine"
  },
  templateVersion: 1,
  project: { id: "p1", name: "Candybar", confidence: 1, method: "ledger" },
  enrichedAt: "2026-11-03T17:00:00Z",
  evaluation: {
    outcome: "Drifted", summary: "s", axes: { efficacy: { rating: "poor", finding: "f" }, cost: { rating: "good", finding: "c" }, bogus: { rating: "good", finding: "x" } },
    recommendation: "r", followUp: "fix", reportKey: "2026-11-03/candybar-evaluate-x.md", evaluatedAt: "2026-11-03T17:10:00Z", taskId: "t2"
  },
  updatedAt: "2026-11-03T17:10:00Z"
};

type Call = { method: string; path: string; search: string; body?: unknown };
type Handler = (call: Call) => Response | Promise<Response>;
function fake(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, search: url.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    return handler ? handler(call) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });
const healthy = (): Record<string, Handler> => ({
  "GET /candybars": () => json(DEFS),
  "GET /schedule": () => json([]),
  [`GET /candybars/${UTC_ID}/invocations`]: () => json({ invocations: [inv("fail", 0), inv(null, 1), inv("success", 2)] }),
  [`GET /candybars/${NY}/invocations`]: () => json({ invocations: [] }),
  [`GET /candybars/${OLD}/invocations`]: () => json({ invocations: [] }),
  "GET /profiles": () => json({ profiles: [PROFILE] }),
  "GET /steward/tasks": () => json({ tasks: [task({ id: "t3", action: "evaluate", status: "succeeded", createdAt: "2026-11-03T17:20:00Z" }), task(), task({ id: "t0", createdAt: "2026-11-03T10:00:00Z", status: "failed", error: "x" })] })
});

beforeEach(() => resetCandybarCache());
const BASE = "http://candybar.test";

test("history is the last 30 results oldest first, with running for an unfinished one", () => {
  const many = Array.from({ length: 40 }, (_, i) => inv(i === 0 ? "fail" : "success", i));
  const h = projectHistory({ invocations: many });
  assert.equal(h?.length, 30);
  assert.equal(h?.at(-1), "fail", "the newest result is last");
  assert.equal(projectHistory({ invocations: [inv("fail", 0), inv(null, 1), inv("success", 2)] })?.join(), "success,running,fail");
  assert.deepEqual(projectHistory({ invocations: [] }), []);
  assert.equal(projectHistory({ nope: 1 }), undefined);
});

test("the list reads 30 invocations per candybar, keeps lastRun as the newest, and merges profile and tasks", async () => {
  const { impl, calls } = fake(healthy());
  const p = await readCandybars({ fetchImpl: impl, baseUrl: BASE, now: () => NOW });
  assert.ok(calls.some((c) => c.path === `/candybars/${UTC_ID}/invocations` && c.search === "?limit=30"));
  assert.equal(calls.filter((c) => c.path === "/profiles").length, 1, "one profiles call per refresh");
  assert.equal(calls.filter((c) => c.path === "/steward/tasks").length, 1);
  assert.equal(calls.find((c) => c.path === "/steward/tasks")?.search, "?limit=200");
  const row = p.candybars.find((c) => c.id === UTC_ID)!;
  assert.equal(row.lastRun?.result, "fail");
  assert.deepEqual(row.history, ["success", "running", "fail"]);
  assert.equal(row.profile?.project?.name, "Candybar");
  assert.equal(row.profile?.overview?.runbook[0], "candybar show x");
  assert.deepEqual(Object.keys(row.profile?.evaluation?.axes ?? {}).sort(), ["cost", "efficacy"], "an unknown axis is dropped");
  assert.equal("candybarId" in (row.profile ?? {}), false);
  assert.deepEqual(row.tasks?.active.map((t) => t.id), ["t1"]);
  assert.deepEqual(Object.fromEntries(Object.entries(row.tasks?.latest ?? {}).map(([k, t]) => [k, t.id])), { enrich: "t1", evaluate: "t3" });
  assert.equal(p.candybars.find((c) => c.id === NY)?.profile, null, "readable profiles, none for this candybar");
  assert.deepEqual(p.candybars.find((c) => c.id === NY)?.tasks, { active: [], latest: {} });
  assert.equal(JSON.stringify(p).includes("planted"), false);
});

test("archived candybars are counted on their own and left out of every other total", async () => {
  const { impl } = fake(healthy());
  const p = await readCandybars({ fetchImpl: impl, baseUrl: BASE, now: () => NOW });
  assert.deepEqual(p.counts, { total: 2, active: 2, inactive: 0, failing: 1, archived: 1 });
  const old = p.candybars.find((c) => c.id === OLD)!;
  assert.equal(old.archived, true);
  assert.equal(old.nextFire, null);
});

test("profiles or tasks that cannot be read leave the field absent and warn; the list still loads", async () => {
  const routes = healthy();
  delete routes["GET /profiles"];
  routes["GET /steward/tasks"] = () => new Response("bad gateway", { status: 502 });
  const { impl } = fake(routes);
  const p = await readCandybars({ fetchImpl: impl, baseUrl: BASE, now: () => NOW });
  assert.equal(p.source.down, undefined);
  assert.equal(p.candybars.length, 3);
  for (const c of p.candybars) {
    assert.equal("profile" in c, false);
    assert.equal("tasks" in c, false);
  }
  assert.ok(p.warnings.some((w) => /profiles unavailable: HTTP 404/.test(w)));
  assert.ok(p.warnings.some((w) => /steward tasks unavailable: HTTP 502/.test(w)));
});

test("profiles and tasks are cached like the list, and a write invalidates them", async () => {
  const routes = healthy();
  routes[`POST /candybars/${UTC_ID}/noise`] = () => json({}, 200);
  routes[`PUT /candybars/${UTC_ID}/noise`] = () => json({}, 200);
  const { impl, calls } = fake(routes);
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  const count = () => calls.filter((c) => c.path === "/profiles").length;
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  assert.equal(count(), 1);
  const w = await app.inject({ method: "POST", url: `/api/modules/candybar/${UTC_ID}/noise`, payload: { noise: true } });
  assert.equal(w.statusCode, 200);
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  assert.equal(count(), 2, "the next list read goes back to Candybar");
  assert.equal(calls.filter((c) => c.path === "/candybars" && c.method === "GET").length, 2);
  await app.close();
});

test("a failed write does not invalidate the caches", async () => {
  const routes = healthy();
  routes[`PUT /candybars/${UTC_ID}/noise`] = () => json({ title: "Candybar not found", detail: "no candybar" }, 404);
  const { impl, calls } = fake(routes);
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  const w = await app.inject({ method: "POST", url: `/api/modules/candybar/${UTC_ID}/noise`, payload: { noise: true } });
  assert.equal(w.statusCode, 404);
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  assert.equal(calls.filter((c) => c.path === "/profiles").length, 1);
  await app.close();
});

async function post(routes: Record<string, Handler>, path: string, payload?: unknown, id = UTC_ID) {
  const { impl, calls } = fake(routes);
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  const res = await app.inject({ method: "POST", url: `/api/modules/candybar/${id}${path}`, ...(payload === undefined ? {} : { payload: payload as object }) });
  await app.close();
  return { res, calls, body: res.json() as Record<string, unknown> };
}

test("every write validates the id and its body before anything is forwarded", async () => {
  const cases: Array<[string, unknown]> = [
    ["/skip", {}], ["/skip", { fireTime: "tomorrow" }], ["/skip", { fireTime: "2026-11-04T09:00:30Z" }],
    ["/skip-rest-of-day", { fireTime: 5 }], ["/noise", { noise: "yes" }], ["/noise", {}], ["/enabled", { enabled: 1 }],
    ["/archived", {}], ["/steward", { action: "refactor" }], ["/steward", { action: "rm -rf" }], ["/steward", {}]
  ];
  for (const [path, payload] of cases) {
    const { res, calls } = await post(healthy(), path, payload);
    assert.equal(res.statusCode, 400, `${path} ${JSON.stringify(payload)}`);
    assert.equal(calls.length, 0);
  }
  const badId = await post(healthy(), "/noise", { noise: true }, "not-a-uuid");
  assert.equal(badId.res.statusCode, 400);
  assert.match(String(badId.body.error), /UUID/);
  assert.equal(badId.calls.length, 0);
  const notObject = await post(healthy(), "/noise", ["x"]);
  assert.equal(notObject.res.statusCode, 400);
});

test("skip forwards the whole-minute UTC fire time", async () => {
  const routes = { ...healthy(), [`POST /candybars/${UTC_ID}/skip`]: () => json({ skipped: true, fireTime: "x" }) };
  const { res, calls, body } = await post(routes, "/skip", { fireTime: "2026-11-04T09:00:00+00:00" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], { method: "POST", path: `/candybars/${UTC_ID}/skip`, search: "", body: { fireTime: "2026-11-04T09:00:00Z" } });
  assert.deepEqual(body, { ok: true, skipped: true, fireTime: "2026-11-04T09:00:00Z" });
});

test("skip-rest-of-day computes the date in the candybar's own time zone", async () => {
  // 02:30 UTC on 2026-11-04 is still 9:30 PM on 2026-11-03 in New York.
  const routes = { ...healthy(), [`POST /candybars/${NY}/skip-rest-of-day`]: () => json({ skipped: true, date: "2026-11-03" }) };
  const ny = await post(routes, "/skip-rest-of-day", { fireTime: "2026-11-04T02:30:00Z" }, NY);
  assert.equal(ny.res.statusCode, 200);
  assert.deepEqual(ny.calls.find((c) => c.method === "POST")?.body, { date: "2026-11-03" });
  assert.deepEqual(ny.body, { ok: true, skipped: true, date: "2026-11-03" });

  const routes2 = { ...healthy(), [`POST /candybars/${UTC_ID}/skip-rest-of-day`]: () => json({ skipped: true }) };
  const utc = await post(routes2, "/skip-rest-of-day", { fireTime: "2026-11-04T02:30:00Z" });
  assert.deepEqual(utc.calls.find((c) => c.method === "POST")?.body, { date: "2026-11-04" });
});

test("skip-rest-of-day for an unknown candybar is 404, and 502 when the list cannot be read", async () => {
  const unknown = await post(healthy(), "/skip-rest-of-day", { fireTime: "2026-11-04T02:30:00Z" }, "01a17a00-0000-7000-8000-0000000000ff");
  assert.equal(unknown.res.statusCode, 404);
  resetCandybarCache();
  const down = await post({}, "/skip-rest-of-day", { fireTime: "2026-11-04T02:30:00Z" });
  assert.equal(down.res.statusCode, 502);
});

test("noise is PUT to mark and DELETE to unmark", async () => {
  const routes = { ...healthy(), [`PUT /candybars/${UTC_ID}/noise`]: () => json({}), [`DELETE /candybars/${UTC_ID}/noise`]: () => json({}) };
  const on = await post(routes, "/noise", { noise: true });
  const off = await post(routes, "/noise", { noise: false });
  assert.equal(on.calls[0].method, "PUT");
  assert.equal(off.calls[0].method, "DELETE");
  assert.deepEqual(off.body, { ok: true, noise: false });
});

test("enabled and archived forward their flag, and the response never carries the detail shape", async () => {
  const routes = {
    ...healthy(),
    [`POST /candybars/${UTC_ID}/enabled`]: () => json({ id: UTC_ID, enabled: true, runner: { argv: ["/planted"] } }),
    [`POST /candybars/${UTC_ID}/archived`]: () => json({ id: UTC_ID, archived: true, enabled: false, runner: { argv: ["/planted"] } })
  };
  const en = await post(routes, "/enabled", { enabled: true });
  assert.deepEqual(en.calls[0].body, { enabled: true });
  assert.deepEqual(en.body, { ok: true, enabled: true });
  const ar = await post(routes, "/archived", { archived: true });
  assert.deepEqual(ar.calls[0].body, { archived: true });
  assert.deepEqual(ar.body, { ok: true, archived: true, enabled: false });
  assert.equal(JSON.stringify(ar.body).includes("planted"), false);
});

test("steward returns the queued task with 202, and a duplicate maps to 409 with the task id", async () => {
  const routes = { ...healthy(), [`POST /candybars/${UTC_ID}/steward`]: () => json(task({ id: "t9", status: "queued", action: "evaluate" }), 202) };
  const ok = await post(routes, "/steward", { action: "evaluate" });
  assert.equal(ok.res.statusCode, 202);
  assert.deepEqual(ok.calls[0].body, { action: "evaluate" });
  assert.equal((ok.body.task as { id: string }).id, "t9");

  const dup = { ...healthy(), [`POST /candybars/${UTC_ID}/steward`]: () => json({ title: "Task already active", detail: "enrich is already running", taskId: "t1" }, 409) };
  const conflict = await post(dup, "/steward", { action: "enrich" });
  assert.equal(conflict.res.statusCode, 409);
  assert.deepEqual(conflict.body, { error: "enrich is already running", taskId: "t1" });
});

test("upstream problem+json detail becomes { error } with the upstream status; unreachable is 502", async () => {
  const refuse = { ...healthy(), [`POST /candybars/${UTC_ID}/enabled`]: () => json({ title: "Archived", detail: "unarchive it first" }, 409) };
  const r = await post(refuse, "/enabled", { enabled: true });
  assert.equal(r.res.statusCode, 409);
  assert.deepEqual(r.body, { error: "unarchive it first" });

  const text = { ...healthy(), [`POST /candybars/${UTC_ID}/archived`]: () => new Response("upstream sad", { status: 503 }) };
  const t = await post(text, "/archived", { archived: true });
  assert.equal(t.res.statusCode, 503);
  assert.match(String(t.body.error), /HTTP 503: upstream sad/);

  const gone = Fastify();
  registerCandybarRoutes(gone, { fetchImpl: (async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch, baseUrl: BASE });
  const res = await gone.inject({ method: "POST", url: `/api/modules/candybar/${UTC_ID}/archived`, payload: { archived: true } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /ECONNREFUSED/);
  await gone.close();
});

test("GET tasks proxies with limit 20 by default, validates the limit, and allowlists the shape", async () => {
  const routes = { ...healthy(), [`GET /candybars/${UTC_ID}/steward/tasks`]: () => json({ candybarId: UTC_ID, tasks: [{ ...task(), planted: "x" }, { junk: true }] }) };
  const { impl, calls } = fake(routes);
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  const res = await app.inject({ method: "GET", url: `/api/modules/candybar/${UTC_ID}/tasks` });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].search, "?limit=20");
  const body = res.json() as { tasks: Array<Record<string, unknown>> };
  assert.equal(body.tasks.length, 1);
  assert.equal("planted" in body.tasks[0], false);
  assert.equal(body.tasks[0].sessionId, "ses_abc");
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/candybar/${UTC_ID}/tasks?limit=500` })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/modules/candybar/nope/tasks" })).statusCode, 400);
  const missing = Fastify();
  registerCandybarRoutes(missing, { fetchImpl: fake({}).impl, baseUrl: BASE });
  assert.equal((await missing.inject({ method: "GET", url: `/api/modules/candybar/${UTC_ID}/tasks` })).statusCode, 404);
  await app.close();
  await missing.close();
});

test("the schedule snapshot drops fires of archived candybars", async () => {
  const rows = [
    { candybarId: UTC_ID, name: "deploy-smoke", schedule: "0 9 * * *", fireTime: "2026-11-03T21:30:00+00:00", state: "upcoming", skipped: false, noise: false },
    { candybarId: OLD, name: "old-job", schedule: "0 9 * * *", fireTime: "2026-11-03T21:31:00+00:00", state: "upcoming", skipped: false, noise: false }
  ];
  const { impl } = fake({ ...healthy(), "GET /schedule": () => json(rows) });
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  const q = new URLSearchParams({ from: "2026-11-03T05:00:00Z", to: "2026-11-04T05:00:00Z" });
  const res = await app.inject({ method: "GET", url: `/api/modules/candybar/schedule?${q}` });
  const body = res.json() as SchedulePayload;
  assert.deepEqual(body.candybars.map((c) => c.id), [UTC_ID]);
  assert.equal(body.rows.length, 1);
  await app.close();
});

test("pure helpers: local date, fire time, problem message, task summary, profile projection", () => {
  assert.equal(localDate(Date.parse("2026-11-04T02:30:00Z"), "America/New_York"), "2026-11-03");
  assert.equal(localDate(Date.parse("2026-11-04T02:30:00Z"), "Asia/Tokyo"), "2026-11-04");
  assert.equal(localDate(Date.parse("2026-11-04T02:30:00Z"), "Not/AZone"), undefined);
  assert.equal(parseFireTime("2026-11-04T09:00:00-05:00"), "2026-11-04T14:00:00Z");
  assert.equal(parseFireTime("2026-11-04T09:00:01Z"), undefined);
  assert.equal(parseFireTime(undefined), undefined);
  assert.equal(problemMessage(JSON.stringify({ title: "T", detail: "D" }), 409), "D");
  assert.equal(problemMessage(JSON.stringify({ title: "T" }), 409), "T");
  assert.equal(problemMessage("", 500), "HTTP 500");
  const tasks = [projectTask(task({ id: "a", createdAt: "2026-11-03T01:00:00Z", status: "succeeded" }))!, projectTask(task({ id: "b", createdAt: "2026-11-03T02:00:00Z", status: "queued", action: "fix" }))!, projectTask(task({ id: "c", candybarId: NY }))!];
  const s = summarizeTasks(tasks, UTC_ID);
  assert.deepEqual(s.active.map((t) => t.id), ["b"]);
  assert.deepEqual({ enrich: s.latest.enrich?.id, fix: s.latest.fix?.id }, { enrich: "a", fix: "b" });
  assert.equal(projectTask({ id: "x" }), undefined);
  assert.equal(projectProfile({ nope: 1 }), undefined);
  assert.equal(projectProfile({ candybarId: UTC_ID })?.overview, null);
  assert.equal(projectProfile({ candybarId: UTC_ID, evaluation: { outcome: "Great" } })?.evaluation, null, "an unknown outcome is not rendered");
});

test("a profile read begun before a write does not repopulate the caches the write invalidated", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let slow = true;
  const routes = healthy();
  const profiles = routes["GET /profiles"];
  routes["GET /profiles"] = async (c) => {
    if (slow) {
      slow = false;
      await gate;
    }
    return profiles(c);
  };
  routes[`PUT /candybars/${UTC_ID}/noise`] = () => json({});
  const { impl, calls } = fake(routes);
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: BASE });
  const first = app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  await new Promise((r) => setTimeout(r, 30));
  await app.inject({ method: "POST", url: `/api/modules/candybar/${UTC_ID}/noise`, payload: { noise: true } });
  release();
  await first;
  await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  assert.equal(calls.filter((c) => c.path === "/profiles").length, 2, "the stale read was not cached");
  await app.close();
  void ({} as CandybarPayload);
});

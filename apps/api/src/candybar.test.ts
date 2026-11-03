import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Fastify from "fastify";
import {
  composePayload,
  indexFires,
  nextFireAfter,
  projectDefinition,
  projectLastRun,
  readCandybars,
  registerCandybarRoutes,
  resetCandybarCache,
  type CandybarPayload
} from "./candybar.js";

// Shapes trimmed from the live https://candybar.delo.sh on 2026-11-03.
const NOW = Date.parse("2026-11-03T17:45:30Z");
const SMOKE = {
  id: "01a176ae-bd0a-7b8f-8e20-08665b8beb9a",
  name: "deploy-smoke",
  description: "story 1.9 deployment smoke",
  tags: ["smoke"],
  schedule: "* * * * *",
  timezone: "UTC",
  noise: true,
  enabled: true,
  createdAt: "2026-10-26T05:28:45.578875+00:00"
};
const HONDA = {
  id: "01a17938-961c-7581-b9c2-ec6f9e3a708a",
  name: "honda-hunt-daily-check",
  description: "Daily Civic Si negotiation inbox check",
  tags: ["migrated", "llm"],
  schedule: "0 9 * * *",
  timezone: "America/New_York",
  noise: false,
  enabled: false,
  createdAt: "2026-10-26T17:18:34.013518+00:00"
};
const BACKUP = { ...SMOKE, id: "01a17a00-0000-7000-8000-000000000003", name: "backup-drill", schedule: "30 4 * * *", noise: false, tags: ["backups"] };

const invocation = (over: Record<string, unknown> = {}) => ({
  id: "2ea57741-2051-5152-b83c-d1ba1c537a49",
  candybarId: SMOKE.id,
  trigger: "scheduled",
  tickId: "tick:29895466",
  idempotencyKey: "secret-ish",
  result: "success",
  exitCode: 0,
  errorMessage: null,
  stderrTail: "planted stderr",
  runtimeMs: 24,
  memoryPeakBytes: 524288,
  startedAt: "2026-11-03T17:45:00.039092+00:00",
  finishedAt: "2026-11-03T17:45:00.063509+00:00",
  ...over
});

const SCHEDULE = [
  { candybarId: SMOKE.id, name: "deploy-smoke", schedule: "* * * * *", fireTime: "2026-11-03T17:46:00+00:00", state: "current", skipped: false, noise: true },
  { candybarId: SMOKE.id, name: "deploy-smoke", schedule: "* * * * *", fireTime: "2026-11-03T17:47:00+00:00", state: "upcoming", skipped: false, noise: true },
  { candybarId: BACKUP.id, name: "backup-drill", schedule: "30 4 * * *", fireTime: "2026-11-04T04:30:00+00:00", state: "upcoming", skipped: true, noise: false }
];

type Routes = Record<string, () => Response | Promise<Response>>;
function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = url.pathname;
    calls.push(`${url.pathname}${url.search}`);
    const handler = routes[key];
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const healthy = (): Routes => ({
  "/candybars": () => json([{ ...SMOKE, runner: { kind: "exec", argv: ["/planted"] } }, HONDA, BACKUP]),
  "/schedule": () => json(SCHEDULE),
  [`/candybars/${SMOKE.id}/invocations`]: () => json({ candybarId: SMOKE.id, invocations: [invocation()] }),
  [`/candybars/${HONDA.id}/invocations`]: () => json({ candybarId: HONDA.id, invocations: [] }),
  [`/candybars/${BACKUP.id}/invocations`]: () => json({ candybarId: BACKUP.id, invocations: [invocation({ candybarId: BACKUP.id, result: "fail", exitCode: 1, errorMessage: "restic:\n  repository locked" })] })
});

beforeEach(() => resetCandybarCache());

test("projectDefinition keeps only contract fields and rejects rows without identity", () => {
  const d = projectDefinition({ ...SMOKE, runner: { kind: "exec" }, entrypoint: "/x" });
  assert.deepEqual(Object.keys(d ?? {}).sort(), ["createdAt", "description", "enabled", "id", "name", "noise", "schedule", "tags", "timezone"]);
  assert.equal(projectDefinition({ ...SMOKE, enabled: "yes" }), undefined);
  assert.equal(projectDefinition({ name: "x", schedule: "* * * * *", enabled: true }), undefined);
  assert.equal(projectDefinition({ ...SMOKE, timezone: undefined })?.timezone, "UTC");
});

test("projectLastRun maps never-run, running, and failed invocations", () => {
  assert.equal(projectLastRun({ invocations: [] }), null);
  assert.equal(projectLastRun({ nope: true }), undefined);
  assert.equal(projectLastRun({ invocations: [invocation({ result: null, finishedAt: null })] })?.result, "running");
  const failed = projectLastRun({ invocations: [invocation({ result: "fail", errorMessage: "a\n\n b" })] });
  assert.equal(failed?.result, "fail");
  assert.equal(failed?.errorMessage, "a b");
  assert.equal("stderrTail" in (failed ?? {}), false);
  assert.equal("idempotencyKey" in (failed ?? {}), false);
});

test("next fire is the first not-skipped fire after now", () => {
  const fires = indexFires(SCHEDULE);
  assert.ok(fires);
  assert.equal(nextFireAfter(fires.get(SMOKE.id), NOW), "2026-11-03T17:46:00.000Z");
  assert.equal(nextFireAfter(fires.get(SMOKE.id), Date.parse("2026-11-03T17:46:00Z")), "2026-11-03T17:47:00.000Z");
  assert.equal(fires.has(BACKUP.id), false, "a skipped occurrence is not a next fire");
  assert.equal(indexFires({ not: "a list" }), undefined);
});

test("composePayload counts active, inactive and failing; disabled candybars never get a next fire", () => {
  const p = composePayload({
    now: NOW,
    definitions: [SMOKE, HONDA, BACKUP].map((d) => projectDefinition(d)!),
    listAt: NOW,
    fires: new Map([[HONDA.id, [NOW + 60_000]]]),
    lastRuns: new Map([[BACKUP.id, { result: "fail", startedAt: "2026-11-03T04:30:00Z" }]]),
    lastRunErrors: 0
  });
  assert.deepEqual(p.counts, { total: 3, active: 2, inactive: 1, failing: 1 });
  assert.deepEqual(p.candybars.map((c) => c.name), ["backup-drill", "deploy-smoke", "honda-hunt-daily-check"]);
  assert.equal(p.candybars.find((c) => c.id === HONDA.id)?.nextFire, null);
  assert.equal("lastRun" in p.candybars.find((c) => c.id === SMOKE.id)!, false, "an unread last run is absent, not null");
});

test("readCandybars composes list, next fire and last run from the live shapes", async () => {
  const { impl, calls } = fakeFetch(healthy());
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  assert.equal(p.source.down, undefined);
  assert.deepEqual(p.counts, { total: 3, active: 2, inactive: 1, failing: 1 });
  assert.equal(p.window.known, true);
  assert.deepEqual(p.warnings, []);
  const smoke = p.candybars.find((c) => c.id === SMOKE.id)!;
  assert.equal(smoke.nextFire, "2026-11-03T17:46:00.000Z");
  assert.equal(smoke.lastRun?.result, "success");
  assert.equal(p.candybars.find((c) => c.id === HONDA.id)?.lastRun, null);
  assert.equal(p.candybars.find((c) => c.id === BACKUP.id)?.lastRun?.errorMessage, "restic: repository locked");
  assert.equal(JSON.stringify(p).includes("planted"), false, "runner and stderr never leave the API");
  const schedule = calls.find((c) => c.startsWith("/schedule?"));
  assert.ok(schedule?.includes("from=2026-11-03T17%3A45%3A30.000Z"));
});

test("a Candybar outage serves the last good list, marked down", async () => {
  let up = true;
  const routes = healthy();
  const list = routes["/candybars"];
  routes["/candybars"] = () => (up ? list() : new Response("bad gateway", { status: 502 }));
  const { impl } = fakeFetch(routes);
  let now = NOW;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  up = false;
  now += 60_000;
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(p.source.down, true);
  assert.equal(p.source.value, "stale");
  assert.match(p.source.detail ?? "", /HTTP 502: bad gateway/);
  assert.equal(p.counts.total, 3);
  assert.equal(p.source.ageSeconds, 60);
});

test("a Candybar that never answered is an empty list marked down, not a healthy zero", async () => {
  const { impl } = fakeFetch({});
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  assert.equal(p.source.down, true);
  assert.equal(p.candybars.length, 0);
  assert.equal(p.window.known, false);
});

test("schedule and last-run failures degrade their columns without failing the list", async () => {
  const routes = healthy();
  routes["/schedule"] = () => new Response("boom", { status: 500 });
  delete routes[`/candybars/${SMOKE.id}/invocations`];
  const { impl } = fakeFetch(routes);
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  assert.equal(p.source.down, undefined);
  assert.equal(p.window.known, false);
  assert.equal(p.candybars.every((c) => c.nextFire === null), true);
  assert.equal("lastRun" in p.candybars.find((c) => c.id === SMOKE.id)!, false);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /next fires unavailable: HTTP 500/);
  assert.match(p.warnings[1], /1 of 3/);
});

test("reads are cached: a second call inside the TTLs makes no upstream request", async () => {
  const { impl, calls } = fakeFetch(healthy());
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  const first = calls.length;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW + 5_000 });
  assert.equal(calls.length, first);
});

test("GET /api/modules/candybar/list serves the payload with no-store", async () => {
  const { impl } = fakeFetch(healthy());
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  const res = await app.inject({ method: "GET", url: "/api/modules/candybar/list" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.json() as CandybarPayload;
  assert.equal(body.counts.total, 3);
  await app.close();
});

test("unparseable timestamps are dropped in the projection, never passed to the browser", () => {
  assert.equal(projectDefinition({ ...SMOKE, createdAt: "yesterday" })?.createdAt, "");
  assert.equal(projectLastRun({ invocations: [invocation({ startedAt: "soon" })] }), undefined);
  assert.equal(projectLastRun({ invocations: [invocation({ finishedAt: "later" })] })?.finishedAt, undefined);
});

test("the window is read in slices that together cover 25 h", async () => {
  const { impl, calls } = fakeFetch(healthy());
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  const slices = calls.filter((c) => c.startsWith("/schedule?")).map((c) => new URLSearchParams(c.split("?")[1]));
  assert.equal(slices.length, 5);
  assert.equal(slices[0].get("from"), new Date(NOW).toISOString());
  assert.equal(slices[4].get("to"), new Date(NOW + 25 * 3_600_000).toISOString());
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i].get("from"), slices[i - 1].get("to"));
});

test("a changed definition list rereads the window instead of reporting no next fire", async () => {
  const routes = healthy();
  let defs: unknown[] = [SMOKE, HONDA, BACKUP];
  routes["/candybars"] = () => json(defs);
  const { impl, calls } = fakeFetch(routes);
  let now = NOW;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  const reads = () => calls.filter((c) => c.startsWith("/schedule?")).length;
  const before = reads();
  now += 11_000; // past the list TTL, well inside the window TTL
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(reads(), before, "same definitions: the cached window is reused");
  defs = [SMOKE, { ...HONDA, enabled: true }, BACKUP];
  now += 11_000;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(reads(), before * 2, "a re-enabled candybar rereads the window");
});

test("a failed window refresh keeps the older window, flags it, and retries on the short TTL", async () => {
  let up = true;
  const routes = healthy();
  routes["/schedule"] = () => (up ? json(SCHEDULE) : new Response("boom", { status: 500 }));
  const { impl, calls } = fakeFetch(routes);
  let now = NOW;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  up = false;
  now += 121_000;
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(p.window.known, true);
  assert.match(p.warnings[0], /from an older read: HTTP 500/);
  const reads = () => calls.filter((c) => c.startsWith("/schedule?")).length;
  const afterFailure = reads();
  now += 11_000;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.ok(reads() > afterFailure, "a failed refresh retries after 10 s, not 2 min");
});

test("an older window that no longer reaches 24 h ahead is dropped rather than served", async () => {
  let up = true;
  const routes = healthy();
  routes["/schedule"] = () => (up ? json(SCHEDULE) : new Response("boom", { status: 500 }));
  const { impl } = fakeFetch(routes);
  let now = NOW;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  up = false;
  now += 61 * 60_000; // the 25 h window now reaches only 23 h 59 m ahead
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(p.window.known, false);
});

test("a last run that cannot be refreshed keeps its older value and is still counted in the warning", async () => {
  let up = true;
  const routes = healthy();
  const smoke = routes[`/candybars/${SMOKE.id}/invocations`];
  routes[`/candybars/${SMOKE.id}/invocations`] = () => (up ? smoke() : new Response("nope", { status: 503 }));
  const { impl } = fakeFetch(routes);
  let now = NOW;
  await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  up = false;
  now += 31_000;
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => now });
  assert.equal(p.candybars.find((c) => c.id === SMOKE.id)?.lastRun?.result, "success");
  assert.ok(p.warnings.some((w) => /could not be refreshed for 1 of 3/.test(w)));
});

test("a never-loaded list reports no age", async () => {
  const { impl } = fakeFetch({});
  const p = await readCandybars({ fetchImpl: impl, baseUrl: "http://candybar.test", now: () => NOW });
  assert.equal(p.source.ageSeconds, undefined);
});

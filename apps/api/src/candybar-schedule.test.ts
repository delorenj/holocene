import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";
import Fastify from "fastify";
import { compactSchedule, parseWindow, readDaySchedule, registerCandybarRoutes, withPings, type SchedulePayload } from "./candybar.js";

// Row shapes as the live /schedule wrote them on 2026-11-03.
const SYNC = "01a1794f-e281-7276-ba6a-cd58a1050dd5";
const SMOKE = "01a176ae-bd0a-7b8f-8e20-08665b8beb9a";
const ROWS = [
  { candybarId: SYNC, name: "sync-jim-dropbox", schedule: "*/10 * * * *", fireTime: "2026-11-03T21:20:00+00:00", state: "past", lastResult: "fail", skipped: false, noise: false, extra: "planted" },
  { candybarId: SMOKE, name: "deploy-smoke", schedule: "* * * * *", fireTime: "2026-11-03T21:29:00+00:00", state: "current", skipped: false, noise: true },
  { candybarId: SYNC, name: "sync-jim-dropbox", schedule: "*/10 * * * *", fireTime: "2026-11-03T21:30:00+00:00", state: "upcoming", skipped: true, noise: false },
  { candybarId: SMOKE, name: "deploy-smoke", schedule: "* * * * *", fireTime: "2026-11-03T21:29:00+00:00", state: "current", skipped: false, noise: true },
  { candybarId: SMOKE, fireTime: "not a time", state: "past" },
  { candybarId: SMOKE, fireTime: "2026-11-03T21:31:00+00:00", state: "weird" }
];
const DAY = { from: "2026-11-03T05:00:00.000Z", to: "2026-11-04T05:00:00.000Z" };
const NOW = Date.parse("2026-11-03T21:28:30Z");

test("parseWindow accepts a local day and refuses junk, inverted or over-long windows", () => {
  assert.deepEqual(parseWindow({ from: "2026-11-03T00:00:00-05:00", to: "2026-11-04T00:00:00-05:00" }), DAY);
  assert.ok("error" in parseWindow({ from: "yesterday", to: DAY.to }));
  assert.ok("error" in parseWindow({ from: DAY.to, to: DAY.from }));
  assert.ok("error" in parseWindow({ from: DAY.from, to: "2026-11-05T05:00:00Z" }));
  assert.ok("error" in parseWindow({}));
});

test("compactSchedule allowlists, dedupes by key, keeps fireTime verbatim and sorts by time", () => {
  const p = compactSchedule(ROWS, DAY, NOW);
  assert.deepEqual(p.candybars, [
    { id: SYNC, name: "sync-jim-dropbox", schedule: "*/10 * * * *", noise: false },
    { id: SMOKE, name: "deploy-smoke", schedule: "* * * * *", noise: true }
  ]);
  assert.deepEqual(p.rows, [
    [0, "2026-11-03T21:20:00+00:00", "past", "fail", 0],
    [1, "2026-11-03T21:29:00+00:00", "current", null, 0],
    [0, "2026-11-03T21:30:00+00:00", "upcoming", null, 1]
  ]);
  assert.equal(JSON.stringify(p).includes("planted"), false);
});

function fake(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("readDaySchedule reads a 25 h DST day in five contiguous slices", async () => {
  const window = { from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" };
  const { impl, calls } = fake(() => json([]));
  const p = await readDaySchedule(window, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  assert.ok(!("error" in p));
  const slices = calls.map((c) => c.url.searchParams);
  assert.equal(slices.length, 5);
  assert.equal(slices[0].get("from"), window.from);
  assert.equal(slices[4].get("to"), window.to);
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i].get("from"), slices[i - 1].get("to"));
});

test("one failed slice fails the whole snapshot rather than serving a day with a hole", async () => {
  let n = 0;
  const { impl } = fake(() => (n++ === 2 ? new Response("too many", { status: 422 }) : json(ROWS)));
  const p = await readDaySchedule(DAY, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  assert.ok("error" in p);
  assert.match(p.error, /HTTP 422: too many/);
});

test("GET /api/modules/candybar/schedule validates the window and maps upstream failure to 502", async () => {
  const { impl } = fake((url) => (url.pathname === "/schedule" ? json(ROWS) : json({}, 404)));
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  const bad = await app.inject({ method: "GET", url: "/api/modules/candybar/schedule?from=x&to=y" });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "GET", url: `/api/modules/candybar/schedule?${new URLSearchParams(DAY)}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal((ok.json() as SchedulePayload).rows.length, 3);
  await app.close();

  const down = Fastify();
  registerCandybarRoutes(down, { fetchImpl: fake(() => new Response("bad gateway", { status: 502 })).impl, baseUrl: "http://candybar.test" });
  const res = await down.inject({ method: "GET", url: `/api/modules/candybar/schedule?${new URLSearchParams(DAY)}` });
  assert.equal(res.statusCode, 502);
  await down.close();
});

const FRAMES = "retry: 3000\n\nid: 8aac3316ea92-156396\nevent: ready\ndata: {\"type\":\"ready\"}\n\nid: 8aac3316ea92-156397\n\n: keepalive\n\n";

test("the stream route pipes Candybar's SSE bytes through unchanged with streaming headers", async () => {
  const { impl, calls } = fake(() => new Response(FRAMES, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }));
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  const res = await app.inject({ method: "GET", url: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, FRAMES);
  assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(res.headers["x-accel-buffering"], "no");
  assert.equal(calls[0].url.pathname, "/schedule/stream");
  assert.equal(calls[0].url.searchParams.get("from"), DAY.from);
  assert.equal(new Headers(calls[0].init?.headers).get("last-event-id"), null);
  await app.close();
});

test("the stream route forwards Last-Event-ID, or `after` when the page reconnects by hand", async () => {
  const { impl, calls } = fake(() => new Response(FRAMES, { status: 200 }));
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  const base = `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}`;
  await app.inject({ method: "GET", url: base, headers: { "last-event-id": "8aac3316ea92-156396" } });
  await app.inject({ method: "GET", url: `${base}&after=8aac3316ea92-156400` });
  await app.inject({ method: "GET", url: `${base}&after=${encodeURIComponent("x\r\nInjected: 1")}` });
  const sent = calls.map((c) => new Headers(c.init?.headers).get("last-event-id"));
  assert.deepEqual(sent, ["8aac3316ea92-156396", "8aac3316ea92-156400", null]);
  await app.close();
});

test("the stream route answers 502 when Candybar refuses or cannot be reached, and 400 for a bad window", async () => {
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: fake(() => new Response("the window spans more than 31 days", { status: 422 })).impl, baseUrl: "http://candybar.test" });
  const refused = await app.inject({ method: "GET", url: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` });
  assert.equal(refused.statusCode, 502);
  assert.match(refused.json().error, /HTTP 422: the window spans/);
  const bad = await app.inject({ method: "GET", url: "/api/modules/candybar/schedule/stream?from=a" });
  assert.equal(bad.statusCode, 400);
  await app.close();

  const unreachable = Fastify();
  registerCandybarRoutes(unreachable, { fetchImpl: (async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch, baseUrl: "http://candybar.test" });
  const res = await unreachable.inject({ method: "GET", url: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /ECONNREFUSED/);
  await unreachable.close();
});

test("withPings forwards whole frames and pings only between them while the line is quiet", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function* upstream() {
    yield "retry: 3000\n\nid: b-1\nevent: ready\ndata: {}\n\n";
    await sleep(120);
    yield "id: b-2\nevent: current.adv"; // half a frame, then quiet: no ping may land inside it
    await sleep(120);
    yield "anced\ndata: {}\n\n";
  }
  let out = "";
  for await (const chunk of withPings(Readable.from(upstream()), 40)) out += chunk;
  const frames = out.split("\n\n").filter(Boolean);
  assert.equal(frames[0], "retry: 3000");
  assert.equal(frames[1], "id: b-1\nevent: ready\ndata: {}");
  assert.ok(frames.includes("event: ping\ndata: {}"), "a quiet line gets a ping");
  assert.equal(frames.at(-1), "id: b-2\nevent: current.advanced\ndata: {}", "the split frame arrives whole and last");
});

test("the upstream stream is aborted when the viewer disconnects mid-stream", async () => {
  let signal: AbortSignal | undefined;
  const { impl } = fake((_url, init) => {
    signal = init?.signal ?? undefined;
    // An endless stream: one frame, then nothing until the reader goes away.
    const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(FRAMES)) });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` }, (res) => {
      res.once("data", () => {
        assert.equal(signal?.aborted, false, "the upstream stays open while the viewer reads");
        req.destroy();
        resolve();
      });
    });
    req.on("error", () => undefined);
    req.on("timeout", reject);
    req.end();
  });
  for (let i = 0; i < 50 && !signal?.aborted; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal?.aborted, true);
  await app.close();
});

test("closing the API aborts every open upstream stream", async () => {
  let signal: AbortSignal | undefined;
  const { impl } = fake((_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(FRAMES)) }), { status: 200 });
  });
  const app = Fastify({ forceCloseConnections: true });
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` }, (res) => {
      res.once("data", () => resolve());
      res.on("error", () => undefined);
    });
    req.on("error", () => undefined);
    req.end();
  });
  await app.close();
  assert.equal(signal?.aborted, true);
});

test("a refused stream reports Candybar's own reason, read before the abort", async () => {
  const { impl } = fake((_url, init) => {
    const signal = init?.signal;
    // A body that refuses to be read once its signal is aborted, like a real fetch.
    const body = new ReadableStream({
      pull: (c) => {
        if (signal?.aborted) c.error(new Error("aborted"));
        else (c.enqueue(new TextEncoder().encode("the window spans more than 31 days")), c.close());
      }
    });
    return new Response(body, { status: 422 });
  });
  const app = Fastify();
  registerCandybarRoutes(app, { fetchImpl: impl, baseUrl: "http://candybar.test" });
  const res = await app.inject({ method: "GET", url: `/api/modules/candybar/schedule/stream?${new URLSearchParams(DAY)}` });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /HTTP 422: the window spans more than 31 days/);
  await app.close();
});

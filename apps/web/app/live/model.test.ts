import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  celebrationKey, chipFor, chipState, chips, confettiPieces, duration, keysMetric, metrics, money, overallState, promotedBadge,
  salesMetric, saleTimes, shouldCelebrate, statement, storefrontMetric, versionMetric
} from "./model";
import type { LiveApp, LivePayload, LiveSource } from "./types";

// Generic fixtures only (a placeholder app), shaped like the API's answer.
const NOW = Date.parse("2026-11-20T15:00:00Z");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const src = (data: unknown, over: Partial<LiveSource<any>> = {}): LiveSource<any> => ({ status: "ok", ageSeconds: 4, maxSeconds: 90, ...(data !== undefined ? { data } : {}), ...over });

const app = (over: Partial<LiveApp> = {}, sources: Partial<LiveApp["sources"]> = {}): LiveApp => ({
  id: "demo", name: "Demo", tagline: "A demo app.", platform: "android", package: "io.example.demo", offer: "$4.99 one-time",
  board: "DEMO", liveSince: "2026-11-20", daysLive: 1, firstPromoted: true, storeUrl: "https://store.example.io/demo/",
  links: { store: "https://store.example.io/demo/", release: "https://s3.example.io/latest.json", evidence: [] },
  sources: {
    release: src({ version: "0.1.12", code: 1012, sha256: "a".repeat(64), url: "https://x/a.apk", updatedAt: "2026-11-20T13:00:00Z", apk: { reachable: true, sizeMatches: true }, packageMatches: true }),
    storefront: src({ status: 200, hasBuyButton: true, apkLinks: [], apkMatchesRelease: true }),
    sales: src({ count: 0, gross: {}, grossMinor: 0, refunds: { count: 0, amountMinor: 0 }, disputes: { count: 0 }, truncated: false }),
    fulfilment: src({ due: 0, overdue: 0, clear: 0, blocked: 0, other: 0, blockedReasons: [], promiseHours: 24, urgency: "clear" }),
    reminder: src({ name: "reminder", enabled: true, schedule: "*/30 * * * *", lastRun: { result: "success", startedAt: "2026-11-20T14:30:00Z" } }),
    activity: src({ recent: [] }, { maxSeconds: 3600 }),
    ...sources
  },
  ...over
});

test("money reads cents as a currency and survives an unknown code", () => {
  assert.equal(money(499, "usd"), "$4.99");
  assert.equal(money(0, "usd"), "$0.00");
  assert.equal(money(1499), "$14.99");
  assert.match(money(500, "zzzz"), /5\.00 ZZZZ/);
});

test("durations are short and human", () => {
  assert.equal(duration(14), "14s");
  assert.equal(duration(12 * 60), "12m");
  assert.equal(duration(3600 + 6 * 60), "1h 06m");
  assert.equal(duration(2 * 3600), "2h");
  assert.equal(duration(3 * 86400 + 4 * 3600), "3d 04h");
});

test("the promotion badge names the date and the day count", () => {
  assert.equal(promotedBadge({ liveSince: "2026-11-20", daysLive: 1 }), "Promoted 2026-11-20 · Day 1 live");
  assert.equal(promotedBadge({ liveSince: "2026-11-20", daysLive: 31 }), "Promoted 2026-11-20 · Day 31 live");
});

test("a chip is stale once its read outlives its own limit, but a down source stays down", () => {
  assert.equal(chipState("ok", 10, 90), "ok");
  assert.equal(chipState("ok", 200, 90), "stale");
  assert.equal(chipState("warn", 200, 90), "stale");
  assert.equal(chipState("down", 200, 90), "down");
  assert.equal(chipState("unavailable", undefined, 90), "unavailable");
  assert.equal(chipState("pending", undefined, 90), "pending");
  const c = chipFor("activity", src({ recent: [] }, { ageSeconds: 125, detail: "no board events collected yet" }));
  assert.equal(c.label, "board");
  assert.equal(c.fresh, "2m");
  assert.match(c.title, /no board events collected yet/);
  assert.deepEqual(chips(app()).map((c) => c.key), ["release", "storefront", "sales", "fulfilment", "reminder", "activity"]);
});

test("overall state is the worst chip", () => {
  assert.equal(overallState(app()), "ok");
  assert.equal(overallState(app({}, { reminder: src(undefined, { status: "warn", detail: "disabled" }) })), "attention");
  assert.equal(overallState(app({}, { storefront: src(undefined, { status: "down" }) })), "down");
  assert.equal(overallState(app({}, { sales: src(undefined, { status: "unavailable", detail: "no key" }) })), "ok");
});

test("sales: no data says why, zero says waiting, a sale shows the gross, disputes warn", () => {
  assert.deepEqual(salesMetric(app({}, { sales: src(undefined, { status: "unavailable", detail: "key unreadable" }) })), { label: "Sales", value: "–", note: "key unreadable", tone: "muted" });
  assert.equal(salesMetric(app()).value, "0");
  assert.match(salesMetric(app()).note ?? "", /waiting for the first one/);
  const sold = app({}, { sales: src({ count: 3, gross: { usd: 1497 }, currency: "usd", grossMinor: 1497, firstSaleAt: "2026-11-21T10:00:00Z", lastSaleAt: "2026-11-23T10:00:00Z", refunds: { count: 1, amountMinor: 499 }, disputes: { count: 0 }, truncated: false }) });
  const m = salesMetric(sold);
  assert.equal(m.value, "3");
  assert.equal(m.note, "$14.97 gross · 1 refunded");
  assert.equal(m.tone, "good");
  assert.equal(saleTimes(sold), "first 2026-11-21 · last 2026-11-23");
  const disputed = app({}, { sales: src({ count: 1, gross: { usd: 499 }, currency: "usd", grossMinor: 499, refunds: { count: 0, amountMinor: 0 }, disputes: { count: 1 }, truncated: false }) });
  assert.equal(salesMetric(disputed).tone, "warn");
  assert.equal(saleTimes(app()), undefined);
});

test("keys owed: clear is calm, due shows the countdown, overdue shows the overrun and is loud", () => {
  const f = (over: object) => app({}, { fulfilment: src({ due: 0, overdue: 0, clear: 0, blocked: 0, other: 0, blockedReasons: [], promiseHours: 24, urgency: "clear", ...over }) });
  const clear = keysMetric(f({}), NOW);
  assert.deepEqual([clear.value, clear.tone, clear.note], ["0", "good", "all clear · 24 h promise"]);
  const due = keysMetric(f({ due: 2, urgency: "owed", soonestDueAt: new Date(NOW + 29 * 60_000).toISOString() }), NOW);
  assert.deepEqual([due.value, due.tone, due.note], ["2", "warn", "next due in 29m"]);
  const boundary = f({ due: 1, urgency: "owed", soonestDueAt: new Date(NOW).toISOString() });
  assert.equal(keysMetric(boundary, NOW).note, "next due in 0s");
  assert.match(keysMetric(boundary, NOW + 1000).note ?? "", /refresh snapshot/);
  const late = keysMetric(f({ due: 1, overdue: 1, urgency: "overdue", worstOverdueSeconds: 3 * 3600 }), NOW);
  assert.deepEqual([late.value, late.tone, late.note], ["2", "bad", "1 overdue by 3h"]);
  const blocked = keysMetric(f({ blocked: 1, blockedReasons: ["refunded"], urgency: "owed" }), NOW);
  assert.equal(blocked.tone, "warn");
  assert.match(blocked.note ?? "", /refunded/);
  const unknown = keysMetric(f({ other: 1, due: 2, urgency: "unknown" }), NOW);
  assert.deepEqual([unknown.value, unknown.tone], ["–", "muted"]);
  assert.match(unknown.note ?? "", /totals cannot be trusted/);
  const stale = f({ due: 1, urgency: "owed" });
  stale.sources.fulfilment.ageSeconds = 91;
  assert.deepEqual([keysMetric(stale, NOW).value, keysMetric(stale, NOW).note], ["–", "snapshot stale; obligations unknown"]);
  assert.ok(!statement(payload([stale]), undefined, NOW).includes("key owed"));
  const failed = f({ due: 1, urgency: "owed" });
  failed.sources.fulfilment.status = "down";
  assert.equal(keysMetric(failed, NOW).value, "–");
  assert.ok(!statement(payload([failed]), undefined, NOW).includes("key owed"));
  assert.equal(keysMetric(app({}, { fulfilment: src(undefined, { status: "down", detail: "snapshot failed" }) }), NOW).tone, "muted");
});

test("version and storefront metrics read the release and the page", () => {
  const v = versionMetric(app(), NOW);
  assert.equal(v.value, "v0.1.12");
  assert.equal(v.note, "build 1012 · shipped 2h ago");
  assert.equal(v.tone, "plain");
  const gone = versionMetric(app({}, { release: src({ version: "0.1.12", code: 1012, sha256: "a".repeat(64), url: "u", apk: { reachable: false, sizeMatches: null }, packageMatches: true }) }), NOW);
  assert.equal(gone.tone, "bad");
  assert.match(gone.note ?? "", /APK unreachable/);

  assert.equal(storefrontMetric(app()).value, "Up");
  assert.equal(storefrontMetric(app()).tone, "good");
  const down = storefrontMetric(app({}, { storefront: src({ status: 503, hasBuyButton: false, apkLinks: [], apkMatchesRelease: null }, { status: "down" }) }));
  assert.equal(down.value, "HTTP 503");
  assert.equal(down.tone, "bad");
  const stale = storefrontMetric(app({}, { storefront: src({ status: 200, hasBuyButton: true, apkLinks: [], apkMatchesRelease: false }) }));
  assert.equal(stale.tone, "warn");
  assert.equal(metrics(app(), NOW).map((m) => m.label).join(), "Sales,Keys owed,Current version,Storefront");
});

const payload = (apps: LiveApp[], over: Partial<LivePayload> = {}): LivePayload => ({ generatedAt: "2026-11-20T15:00:00Z", today: "2026-11-20", source: { name: "pjangler" }, apps, skipped: [], ...over });

test("the page sentence: loading, API down, empty, invalid, healthy, owing", () => {
  assert.equal(statement(undefined, undefined, NOW), "Reading the live apps…");
  assert.equal(statement(undefined, "502", NOW), "The Holocene API is not answering.");
  assert.equal(statement(payload([]), undefined, NOW), "No app has been promoted to live yet.");
  assert.match(statement(payload([], { skipped: [{ id: "x", name: "X", problems: ["a"] }] }), undefined, NOW), /invalid live block/);
  assert.match(statement(payload([], { source: { name: "pjangler", down: true } }), undefined, NOW), /pjangler is not answering/);
  assert.equal(statement(payload([app()]), undefined, NOW), "1 app live. Everything reads well; no keys owed.");
  const owing = app({}, { fulfilment: src({ due: 1, overdue: 0, clear: 0, blocked: 0, other: 0, blockedReasons: [], urgency: "owed", soonestDueAt: new Date(NOW + 600_000).toISOString() }) });
  assert.equal(statement(payload([owing]), undefined, NOW), "1 app live. Demo: 1 key owed, next due in 10m.");
  const unknown = app({}, { fulfilment: src({ due: 1, overdue: 0, clear: 0, blocked: 0, other: 1, blockedReasons: [], urgency: "unknown" }, { status: "warn" }) });
  assert.match(statement(payload([unknown]), undefined, NOW), /unknown order states/);
  assert.ok(!statement(payload([unknown]), undefined, NOW).includes("1 key owed"));
});

test("source freshness advances from checkedAt or generatedAt plus age", () => {
  const fresh = app();
  fresh.sources.fulfilment.checkedAt = new Date(NOW).toISOString();
  fresh.sources.fulfilment.ageSeconds = 0;
  assert.equal(keysMetric(fresh, NOW + 90_000).value, "0");
  assert.equal(keysMetric(fresh, NOW + 91_000).value, "–");
  assert.equal(chipFor("fulfilment", fresh.sources.fulfilment, NOW + 600_000).fresh, "10m");
  delete fresh.sources.fulfilment.checkedAt;
  fresh.sources.fulfilment.ageSeconds = 30;
  assert.equal(keysMetric(fresh, NOW + 61_000, new Date(NOW).toISOString()).value, "–");
  delete fresh.sources.fulfilment.ageSeconds;
  assert.equal(keysMetric(fresh, NOW).value, "–");
  assert.doesNotMatch(statement(payload([fresh]), undefined, NOW), /Everything reads well; no keys owed/);
});

test("retained payload after a failed poll renders stale keys, chips and hero in the real LiveApp", () => {
  const require = createRequire(import.meta.url);
  const React = require("react") as typeof import("react");
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { LiveApp: Component } = require("./live-app.tsx") as typeof import("./live-app");
  const data = payload([app()]);
  for (const source of Object.values(data.apps[0].sources)) {
    source.checkedAt = new Date(NOW).toISOString();
    source.ageSeconds = 0;
  }
  const original = React.useState;
  let index = 0;
  (React as { useState: typeof React.useState }).useState = ((initial: unknown) => {
    const current = index++;
    if (current === 1) initial = data;
    if (current === 2) initial = "503 Service Unavailable";
    if (current === 4) initial = NOW + 600_000;
    return original(initial);
  }) as typeof React.useState;
  try {
    const html = renderToStaticMarkup(React.createElement(Component));
    assert.match(html, /snapshot stale; obligations unknown/);
    assert.match(html, /live-hero is-attention/);
    assert.match(html, /live-chip is-stale[^>]*title="fulfilment: stale[^"]*read 10m ago/);
    assert.match(html, /Showing the last good read/);
    assert.doesNotMatch(html, /Everything reads well; no keys owed|all clear · 24 h promise|live-metric is-good[^>]*>.*Keys owed/);
  } finally {
    (React as { useState: typeof React.useState }).useState = original;
  }
});

test("the celebration is for the first live app, once per browser", () => {
  assert.equal(shouldCelebrate({ firstPromoted: true }, false), true);
  assert.equal(shouldCelebrate({ firstPromoted: true }, true), false);
  assert.equal(shouldCelebrate({ firstPromoted: false }, false), false);
  assert.equal(celebrationKey({ id: "demo", liveSince: "2026-11-20" }), "holocene.live.celebrated.demo.2026-11-20");
  assert.deepEqual(confettiPieces(), confettiPieces(), "deterministic, so server and client markup agree");
  assert.equal(confettiPieces(10).length, 10);
  assert.ok(confettiPieces().every((p) => p.left >= 0 && p.left < 100 && p.tone < 4));
});

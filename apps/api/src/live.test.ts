import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { ProjectRecord } from "./hub-model.js";
import { createLiveHub, registerLiveRoutes, type LiveDeps, type LivePayload } from "./live.js";

// The hub's IO, with the world replaced by fakes: the same code path the live service runs, no network.

const SNAPSHOT = ["uv", "run", "scripts/licensing/issuer.py", "--stripe-mode", "live", "--ledger", "~/.local/share/earshot/licenses/ledger.json", "--approved-catalog", "~/.local/share/earshot/licenses/approved-catalog.json", "--stripe-key-ref", "op://Vault/restricted/credential", "snapshot"];
const envelope = (orders: Record<string, string> = {}) => JSON.stringify({ status: "ok", orders });

const LAUNCH = (extra = "") => `
mode: live
declared: 2026-11-17
live_since: 2026-11-20
epic: EARS-1
contract: [docs/launch/brief.md]
live:
  name: Earshot
  tagline: "Let your agents speak."
  store_url: https://store.example.io/earshot/
  offer: "$4.99 one-time after a 30-day trial"
  platform: android
  package: io.example.earshot
  release: https://s3.example.io/builds/earshot/latest.json
  board: EARS
  support: support@example.io
  checkout: { provider: stripe, payment_link: plink_AAA111, key_ref: "op://Vault/item/API Secret" }
  fulfilment:
    kind: manual-license-key
    promise_hours: 24
    outstanding_argv: [${SNAPSHOT.map((a) => JSON.stringify(a)).join(", ")}]
    reminder_candybar: earshot-paid-key-reminder
${extra}`;

const APK = "https://s3.example.io/builds/earshot/0.1.12/earshot.apk";
const LATEST = {
  package: "io.example.earshot", version: "0.1.12", code: 1012, bytes: 1000, url: APK,
  sha256: "a".repeat(64), updated_at: "2026-11-20T13:43:45Z"
};
const PAGE = `<a href="https://buy.stripe.com/abc">Buy</a><a href="${APK}">APK</a>`;
const SECRET = "sk_live_SUPERSECRETKEYVALUE";
const T0 = Date.parse("2026-11-20T15:00:00Z");

const project = (id: string, repoPath: string): ProjectRecord => ({ id, name: id, repoPath, board: "EARS", boardId: "board-uuid", workspace: "33god", indexed: true });

type Calls = { fetch: Array<{ url: string; method: string; auth?: string }>; run: Array<{ file: string; args: string[]; cwd?: string; env?: string }> };

function setup(over: {
  files?: Record<string, string>;
  fetch?: (url: string, method: string) => Response | undefined | Promise<Response | undefined>;
  run?: (file: string, args: string[]) => { stdout: string } | Error;
  projects?: LiveDeps["projects"];
  now?: { t: number };
  waitMs?: number;
} = {}) {
  const calls: Calls = { fetch: [], run: [] };
  const clock = over.now ?? { t: T0 };
  const files: Record<string, string> = {
    "/repos/earshot/.launch.yaml": LAUNCH(),
    "/repos/earshot/.git/config": '[remote "origin"]\n\turl = git@github.com:delorenj/earshot.git\n',
    "/repos/earshot/docs/runbook.md": "# runbook",
    "/repos/earshot/docs/launch/brief.md": "# brief",
    "/repos/other/.launch.yaml": "mode: launch\nfinish_line: x\n",
    ...over.files
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const defaultFetch = (url: string, method: string): Response => {
    if (url === "https://s3.example.io/builds/earshot/latest.json") return json(LATEST);
    if (url === APK && method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "1000" } });
    if (url === "https://store.example.io/earshot/") return new Response(PAGE, { status: 200 });
    if (url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
      return json({
        data: [{ id: "cs_live_1", status: "complete", payment_status: "paid", amount_total: 499, currency: "usd", created: 1_795_000_000, payment_intent: "pi_1", customer_details: { email: "buyer@example.com", name: "Pat" } }],
        has_more: false
      });
    }
    if (url.startsWith("https://api.stripe.com/v1/refunds")) return json({ data: [{ id: "re_1", payment_intent: "pi_1", amount: 499, status: "succeeded" }], has_more: false });
    if (url.startsWith("https://api.stripe.com/v1/disputes")) return json({ data: [], has_more: false });
    if (url === "https://candybar.example.io/candybars") {
      return json([{ id: "11111111-1111-7111-8111-111111111111", name: "earshot-paid-key-reminder", enabled: true, schedule: "*/30 * * * *", createdAt: "2026-11-20T00:00:00Z" }]);
    }
    if (url.startsWith("https://candybar.example.io/candybars/11111111-1111-7111-8111-111111111111/invocations")) {
      return json({ invocations: [{ startedAt: "2026-11-20T14:30:00Z", finishedAt: "2026-11-20T14:30:02Z", result: "success", trigger: "schedule", runtimeMs: 2000 }] });
    }
    return new Response("nope", { status: 404 });
  };
  const deps: LiveDeps = {
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = init?.headers as Record<string, string> | undefined;
      calls.fetch.push({ url, method, auth: headers?.authorization });
      const custom = await over.fetch?.(url, method);
      return custom ?? defaultFetch(url, method);
    }) as typeof fetch,
    run: async (file, args, opts) => {
      calls.run.push({ file, args, cwd: opts.cwd, env: opts.env?.TMPDIR });
      const custom = over.run?.(file, args);
      if (custom instanceof Error) throw custom;
      if (custom) return custom;
      if (file === "op") return { stdout: SECRET };
      return { stdout: envelope() };
    },
    now: () => clock.t,
    readText: (p) => files[p],
    exists: (p) => p in files,
    projects: over.projects ?? (async () => ({ projects: [project("earshot", "/repos/earshot"), project("other", "/repos/other")] })),
    tickets: () => [
      { key: "EARS-11", title: "Go live", state: "Done", updatedAt: "2026-11-20T12:00:00Z" },
      { key: "EARS-9", title: "Reminder", state: "Done", updatedAt: "2026-11-20T13:00:00Z" },
      { key: "HOLOC-1", title: "Not mine", state: "Done", updatedAt: "2026-11-20T14:00:00Z" }
    ],
    candybarUrl: "https://candybar.example.io",
    planeUrl: "https://plane.example.io",
    home: "/home/me",
    today: () => "2026-11-20",
    opBin: "op",
    fulfilmentKeyRef: "op://Vault/restricted/credential",
    waitMs: over.waitMs ?? 2_000
  };
  return { hub: createLiveHub(deps), calls, deps, clock };
}

const read = (h: ReturnType<typeof setup>, force = false): Promise<LivePayload> => h.hub.read({ force });

test("discovery: only a registered project whose .launch.yaml says live, with its identity, is a live app", async () => {
  const h = setup();
  const p = await read(h);
  assert.equal(p.apps.length, 1);
  assert.deepEqual(p.skipped, []);
  const a = p.apps[0];
  assert.equal(a.id, "earshot");
  assert.equal(a.name, "Earshot");
  assert.equal(a.liveSince, "2026-11-20");
  assert.equal(a.daysLive, 1);
  assert.equal(a.firstPromoted, true);
  assert.equal(a.offer, "$4.99 one-time after a 30-day trial");
  assert.equal(a.support, "support@example.io");
  assert.equal(a.links.board, "https://plane.example.io/33god/projects/board-uuid/issues/");
  assert.equal(a.links.checkout, "https://buy.stripe.com/abc");
  assert.equal(a.links.apk, APK);
  assert.deepEqual(a.links.evidence.map((e) => e.href), [
    "https://github.com/delorenj/earshot/blob/main/docs/runbook.md",
    "https://github.com/delorenj/earshot/blob/main/docs/launch/brief.md"
  ]);
});

test("every source reports its own data and freshness on the happy path", async () => {
  const h = setup();
  const { apps } = await read(h);
  const s = apps[0].sources;
  assert.equal(s.release.status, "ok");
  assert.equal(s.release.data?.version, "0.1.12");
  assert.equal(s.release.data?.apk.reachable, true);
  assert.equal(s.release.data?.apk.sizeMatches, true);
  assert.equal(s.storefront.status, "ok");
  assert.equal(s.storefront.data?.apkMatchesRelease, true);
  assert.equal(s.sales.status, "ok");
  assert.equal(s.sales.data?.count, 1);
  assert.equal(s.sales.data?.grossMinor, 499);
  assert.deepEqual(s.sales.data?.refunds, { count: 1, amountMinor: 499 });
  assert.equal(s.fulfilment.status, "ok");
  assert.equal(s.fulfilment.data?.urgency, "clear");
  assert.equal(s.reminder.status, "ok");
  assert.equal(s.reminder.data?.lastRun?.result, "success");
  assert.equal(s.activity.data?.recent.map((t) => t.key).join(), "EARS-9,EARS-11");
  for (const src of Object.values(s)) {
    assert.equal(src.ageSeconds, 0);
    assert.ok(src.checkedAt && src.maxSeconds > 0);
  }
});

test("Stripe is only ever read: GET, with the key from op at runtime, and the key never reaches the payload", async () => {
  const h = setup();
  const payload = await read(h);
  const stripe = h.calls.fetch.filter((c) => c.url.startsWith("https://api.stripe.com"));
  assert.ok(stripe.length >= 3);
  assert.ok(stripe.every((c) => c.method === "GET"));
  assert.ok(stripe.every((c) => c.auth === `Basic ${Buffer.from(`${SECRET}:`).toString("base64")}`));
  assert.ok(stripe[0].url.includes("payment_link=plink_AAA111"));
  assert.deepEqual(h.calls.run.find((r) => r.file === "op")?.args, ["read", "--no-newline", "op://Vault/item/API Secret"]);
  const out = JSON.stringify(payload);
  assert.ok(!out.includes(SECRET) && !out.includes("SUPERSECRET"));
  assert.ok(!out.includes("buyer@example.com") && !out.includes("Pat") && !out.includes("cs_live_1") && !out.includes("pi_1"));
});

test("fulfilment executes only the approved snapshot in the repo root and counts issued-undelivered", async () => {
  const h = setup({ run: (file) => (file === "uv" ? { stdout: envelope({ cs_live_1: "issued_undelivered:due_in=1800s", cs_live_2: "issued_undelivered:overdue_by=60s", cs_live_3: "delivered" }) } : undefined) as never });
  const { apps } = await read(h);
  const call = h.calls.run.find((r) => r.file === "uv")!;
  assert.deepEqual(call.args, SNAPSHOT.slice(1).map((a) => a.startsWith("~/") ? `/home/me/${a.slice(2)}` : a));
  assert.equal(call.cwd, "/repos/earshot");
  assert.notEqual(call.env, "/tmp");
  const f = apps[0].sources.fulfilment.data!;
  assert.deepEqual([f.due, f.overdue, f.clear, f.urgency], [1, 1, 1, "overdue"]);
  assert.equal(f.soonestDueAt, new Date(T0 + 1_800_000).toISOString());
});

test("legacy and injected declarations are unavailable without ever invoking the issuer", async () => {
  for (const candidate of [
    SNAPSHOT.slice(0, -1).concat("outstanding"),
    SNAPSHOT.concat("issue"),
    ["uv", "run", "--with", "danger", ...SNAPSHOT.slice(2)],
    SNAPSHOT.map((s) => s === "op://Vault/restricted/credential" ? "op://Vault/checkout/credential" : s)
  ]) {
    const h = setup({ files: { "/repos/earshot/.launch.yaml": LAUNCH().replace(/outstanding_argv: \[.*\]/, `outstanding_argv: [${candidate.map((s) => JSON.stringify(s)).join(", ")}]`) } });
    const p = await read(h);
    assert.equal(p.apps[0].sources.fulfilment.status, "unavailable");
    assert.equal(p.apps[0].sources.fulfilment.data, undefined);
    assert.equal(h.calls.run.filter((c) => c.file === "uv").length, 0);
  }
});


test("invalid live blocks are listed as skipped with the reasons, not silently dropped", async () => {
  const h = setup({
    files: { "/repos/half/.launch.yaml": "mode: live\nlive_since: 2026-11-21\nlive:\n  name: Half\n" },
    projects: async () => ({ projects: [project("earshot", "/repos/earshot"), project("half", "/repos/half")] })
  });
  const p = await read(h);
  assert.equal(p.apps.length, 1);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].id, "half");
  assert.ok(p.skipped[0].problems.some((x) => x.includes("live.store_url")));
});

test("with no live app the page gets an empty list, not an error; the first promotion is the earliest live_since", async () => {
  const none = setup({ files: { "/repos/earshot/.launch.yaml": "mode: launch\n" } });
  const p = await read(none);
  assert.deepEqual(p.apps, []);
  assert.equal(p.source.down, undefined);

  const two = setup({
    files: { "/repos/second/.launch.yaml": LAUNCH().replace("live_since: 2026-11-20", "live_since: 2026-12-01").replace("name: Earshot", "name: Second") },
    projects: async () => ({ projects: [project("second", "/repos/second"), project("earshot", "/repos/earshot")] })
  });
  const q = await read(two);
  assert.deepEqual(q.apps.map((a) => [a.name, a.firstPromoted]), [["Earshot", true], ["Second", false]]);
});

test("pjangler down is reported on the source, and the request still answers", async () => {
  const h = setup({ projects: async () => ({ projects: [], down: "connection refused" }) });
  const p = await read(h);
  assert.deepEqual(p.apps, []);
  assert.equal(p.source.down, true);
  assert.match(p.source.detail ?? "", /connection refused/);
});

test("a pjangler outage after a good read keeps the live app on the hub (it is reported down, not gone)", async () => {
  let down = false;
  const h = setup({ projects: async () => (down ? { projects: [], down: "connection refused" } : { projects: [project("earshot", "/repos/earshot")] }) });
  assert.equal((await read(h)).apps.length, 1);
  down = true;
  h.clock.t += 16_000; // discovery TTL (15 s)
  await read(h); // stale answer served, refresh runs behind it
  await new Promise((r) => setTimeout(r, 20));
  const p = await read(h);
  assert.equal(p.source.down, true);
  assert.match(p.source.detail ?? "", /connection refused/);
  assert.equal(p.apps.length, 1, "the app does not vanish while pjangler is down");
  assert.equal(p.apps[0].id, "earshot");
});

test("a throwing board source is one down chip; the request still answers", async () => {
  const h = setup();
  h.deps.tickets = () => {
    throw new Error("event store closed for owner buyer@example.com");
  };
  const p = await createLiveHub(h.deps).read();
  const a = p.apps[0];
  assert.equal(a.sources.activity.status, "down");
  assert.ok(!/@/.test(a.sources.activity.detail ?? ""));
  assert.equal(a.sources.release.status, "ok");
});

// ---------------------------------------------------------------- failure modes, one source at a time

test("release down: latest.json 500 is a down chip; the other sources are untouched", async () => {
  const h = setup({ fetch: (url) => (url.endsWith("latest.json") ? new Response("boom", { status: 500 }) : undefined) });
  const { apps } = await read(h);
  const s = apps[0].sources;
  assert.equal(s.release.status, "down");
  assert.match(s.release.detail ?? "", /HTTP 500/);
  assert.equal(s.storefront.status, "ok");
  assert.equal(s.storefront.data?.apkMatchesRelease, null);
  assert.equal(s.sales.status, "ok");
});

test("release: an unreachable APK is down (keeping the version), a size drift or other package is a warning", async () => {
  const gone = await read(setup({ fetch: (url, m) => (m === "HEAD" ? new Response(null, { status: 404 }) : undefined) }));
  assert.equal(gone.apps[0].sources.release.status, "down");
  assert.equal(gone.apps[0].sources.release.data?.version, "0.1.12");

  const drift = await read(setup({ fetch: (url, m) => (m === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "7" } }) : undefined) }));
  assert.equal(drift.apps[0].sources.release.status, "warn");

  const other = await read(setup({ fetch: (url) => (url.endsWith("latest.json") ? new Response(JSON.stringify({ ...LATEST, package: "io.other.app" })) : undefined) }));
  assert.equal(other.apps[0].sources.release.status, "warn");
  assert.equal(other.apps[0].sources.release.data?.packageMatches, false);

  const bad = await read(setup({ fetch: (url) => (url.endsWith("latest.json") ? new Response("<html>") : undefined) }));
  assert.equal(bad.apps[0].sources.release.status, "down");
});

test("storefront: HTTP 503 is down, a page without a buy link or with a stale APK link is a warning", async () => {
  const down = await read(setup({ fetch: (url) => (url === "https://store.example.io/earshot/" ? new Response("x", { status: 503 }) : undefined) }));
  assert.equal(down.apps[0].sources.storefront.status, "down");
  assert.equal(down.apps[0].sources.storefront.data?.status, 503);

  const nobuy = await read(setup({ fetch: (url) => (url === "https://store.example.io/earshot/" ? new Response(`<a href="${APK}">APK</a>`) : undefined) }));
  assert.equal(nobuy.apps[0].sources.storefront.status, "warn");
  assert.equal(nobuy.apps[0].sources.storefront.data?.hasBuyButton, false);

  const stale = await read(setup({ fetch: (url) => (url === "https://store.example.io/earshot/" ? new Response('<a href="https://buy.stripe.com/x">b</a><a href="https://s3.example.io/old/0.1.11.apk">a</a>') : undefined) }));
  assert.equal(stale.apps[0].sources.storefront.status, "warn");
  assert.equal(stale.apps[0].sources.storefront.data?.apkMatchesRelease, false);

  const refused = await read(setup({ fetch: (url) => { if (url === "https://store.example.io/earshot/") throw new Error("connect ECONNREFUSED"); return undefined; } }));
  assert.equal(refused.apps[0].sources.storefront.status, "down");
});

test("sales: when op cannot give the key the source is unavailable with the reason, and nothing is invented", async () => {
  const h = setup({ run: (file) => (file === "op" ? new Error("op: canonical service-account token unavailable") : (undefined as never)) });
  const { apps } = await read(h);
  const sales = apps[0].sources.sales;
  assert.equal(sales.status, "unavailable");
  assert.match(sales.detail ?? "", /1Password/);
  assert.equal(sales.data, undefined);
  assert.equal(h.calls.fetch.filter((c) => c.url.includes("stripe.com")).length, 0);
});

test("sales: a Stripe error is a down chip with the key scrubbed out of the message", async () => {
  const h = setup({
    fetch: (url) => (url.startsWith("https://api.stripe.com") ? new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${SECRET}` } }), { status: 401 }) : undefined)
  });
  const { apps } = await read(h);
  assert.equal(apps[0].sources.sales.status, "down");
  assert.match(apps[0].sources.sales.detail ?? "", /HTTP 401/);
  assert.ok(!JSON.stringify(apps).includes("SUPERSECRET"));
});

test("sales: a dispute raises a warning, and zero sales makes no refund or dispute calls", async () => {
  const dispute = setup({ fetch: (url) => (url.startsWith("https://api.stripe.com/v1/disputes") ? new Response(JSON.stringify({ data: [{ id: "dp_1", payment_intent: "pi_1" }], has_more: false })) : undefined) });
  const d = await read(dispute);
  assert.equal(d.apps[0].sources.sales.status, "warn");
  assert.equal(d.apps[0].sources.sales.data?.disputes.count, 1);

  const none = setup({ fetch: (url) => (url.startsWith("https://api.stripe.com/v1/checkout/sessions") ? new Response(JSON.stringify({ data: [], has_more: false })) : undefined) });
  const n = await read(none);
  assert.equal(n.apps[0].sources.sales.data?.count, 0);
  assert.equal(none.calls.fetch.filter((c) => /refunds|disputes/.test(c.url)).length, 0);
});

test("sales: more than one page is paged through with starting_after, GET only", async () => {
  let page = 0;
  const row = (id: string) => ({ id, status: "complete", payment_status: "paid", amount_total: 100, currency: "usd", created: 1_795_000_000 + page, payment_intent: `pi_${id}` });
  const h = setup({
    fetch: (url) => {
      if (!url.startsWith("https://api.stripe.com/v1/checkout/sessions")) return undefined;
      page += 1;
      return new Response(JSON.stringify(page === 1 ? { data: [row("a"), row("b")], has_more: true } : { data: [row("c")], has_more: false }));
    }
  });
  const { apps } = await read(h);
  assert.equal(apps[0].sources.sales.data?.count, 3);
  assert.ok(h.calls.fetch.some((c) => c.url.includes("starting_after=b")));
});

test("fulfilment: failure or malformed snapshot is unknown without leaking provider details", async () => {
  const secret = "buyer@example.com cs_live_a1B2c3D4e5F6g7H8i9 op://Vault/restricted/credential";
  const failing = await read(setup({ run: (file) => (file === "uv" ? Object.assign(new Error(secret), { stderr: secret, killed: true }) : undefined) as never }));
  assert.equal(failing.apps[0].sources.fulfilment.status, "down");
  assert.equal(failing.apps[0].sources.fulfilment.data, undefined);
  assert.ok(!JSON.stringify(failing).includes(secret));
  for (const stdout of ["not json", "{}", envelope({ cs_live_1: "clear:pending" }) + "\n" + secret, JSON.stringify({ status: "error", orders: {} })]) {
    const h = setup({ run: (file) => (file === "uv" ? { stdout } : undefined) as never });
    const p = await read(h);
    assert.equal(p.apps[0].sources.fulfilment.status, "down");
    assert.equal(p.apps[0].sources.fulfilment.data, undefined);
    assert.ok(!JSON.stringify(p).includes(secret));
    assert.equal(p.apps[0].sources.release.status, "ok");
  }
  const unknown = await read(setup({ run: (file) => (file === "uv" ? { stdout: envelope({ cs_live_1: "future_state", cs_live_2: "blocked:refunded" }) } : undefined) as never }));
  assert.equal(unknown.apps[0].sources.fulfilment.status, "warn");
  assert.deepEqual([unknown.apps[0].sources.fulfilment.data?.other, unknown.apps[0].sources.fulfilment.data?.blocked], [1, 1]);
});

test("reminder: unregistered is down, disabled or last-run-failed is a warning, Candybar down is down", async () => {
  const missing = await read(setup({ fetch: (url) => (url === "https://candybar.example.io/candybars" ? new Response("[]") : undefined) }));
  assert.equal(missing.apps[0].sources.reminder.status, "down");
  assert.match(missing.apps[0].sources.reminder.detail ?? "", /not registered/);

  const disabled = await read(setup({ fetch: (url) => (url === "https://candybar.example.io/candybars" ? new Response(JSON.stringify([{ id: "11111111-1111-7111-8111-111111111111", name: "earshot-paid-key-reminder", enabled: false, schedule: "* * * * *" }])) : undefined) }));
  assert.equal(disabled.apps[0].sources.reminder.status, "warn");

  const failed = await read(setup({ fetch: (url) => (url.includes("/invocations") ? new Response(JSON.stringify({ invocations: [{ startedAt: "2026-11-20T14:30:00Z", result: "fail", errorMessage: "x" }] })) : undefined) }));
  assert.equal(failed.apps[0].sources.reminder.status, "warn");

  const down = await read(setup({ fetch: (url) => (url.startsWith("https://candybar.example.io") ? new Response("no", { status: 502 }) : undefined) }));
  assert.equal(down.apps[0].sources.reminder.status, "down");
  assert.equal(down.apps[0].sources.release.status, "ok");
});

test("a block without checkout or fulfilment reports those sources unavailable, not broken", async () => {
  const minimal = LAUNCH().replace(/  checkout:[^\n]*\n/, "").replace(/  fulfilment:[\s\S]*$/, "");
  const h = setup({ files: { "/repos/earshot/.launch.yaml": minimal } });
  const { apps } = await read(h);
  assert.equal(apps.length, 1);
  for (const k of ["sales", "fulfilment", "reminder"] as const) assert.equal(apps[0].sources[k].status, "unavailable", k);
});

// ---------------------------------------------------------------- cache

test("reads are cached per source for a short TTL, refreshed on request (stale-while-revalidate), and force bypasses it", async () => {
  const h = setup();
  await read(h);
  const first = h.calls.fetch.length;
  await read(h);
  assert.equal(h.calls.fetch.length, first, "a second read inside the TTL reads nothing");

  h.clock.t += 31_000; // release/fulfilment/reminder TTL (30 s) passed, storefront (60 s) and sales (120 s) not
  const stale = await read(h);
  assert.equal(stale.apps[0].sources.release.ageSeconds, 31, "the stale answer is served at once, with its true age");
  await new Promise((r) => setTimeout(r, 20));
  const urls = h.calls.fetch.slice(first).map((c) => c.url);
  assert.ok(urls.some((u) => u.endsWith("latest.json")), "the refresh ran behind the request");
  assert.ok(!urls.some((u) => u.startsWith("https://api.stripe.com")), "sales were still fresh");
  const refreshed = await read(h);
  assert.equal(refreshed.apps[0].sources.release.ageSeconds, 0);

  const before = h.calls.fetch.length;
  h.clock.t += 5_000;
  await read(h, true);
  assert.ok(h.calls.fetch.length > before, "force reads again once the minimum age passed");
  const again = h.calls.fetch.length;
  await read(h, true);
  assert.equal(h.calls.fetch.length, again, "but force cannot hammer a source inside 3 s");
});

test("an idle hub does not show a read older than its freshness window as current: it waits for the refresh", async () => {
  const h = setup();
  await read(h);
  h.clock.t += 10 * 60_000; // ten minutes idle: every hit is past 3 TTLs
  const p = await read(h);
  const s = p.apps[0].sources;
  assert.equal(s.release.ageSeconds, 0, "release was re-read, not served 10 minutes old");
  assert.equal(s.sales.ageSeconds, 0);
  assert.equal(s.fulfilment.ageSeconds, 0);
  assert.ok(Object.values(s).every((x) => x.status === "ok"));
});

test("a cold source that is slow answers `pending` instead of hanging the request", async () => {
  const h = setup({ waitMs: 30, fetch: async (url) => { if (url.startsWith("https://store.example.io")) await new Promise((r) => setTimeout(r, 200)); return undefined; } });
  const { apps } = await read(h);
  assert.equal(apps[0].sources.storefront.status, "pending");
  assert.equal(apps[0].sources.release.status, "ok");
  await new Promise((r) => setTimeout(r, 250));
  const later = await read(h);
  assert.equal(later.apps[0].sources.storefront.status, "ok");
});

// ---------------------------------------------------------------- the route

test("route snapshot consumer invokes no issue, sign, email, or notify action and hides purchase IDs", async () => {
  const h = setup({ run: (file, args) => {
    if (file !== "uv") return undefined as never;
    assert.equal(args.at(-1), "snapshot");
    assert.equal(args.includes("outstanding"), false);
    assert.equal(args.some((a) => /^(issue|sign|email|notify|mark-delivered|resend)$/.test(a)), false);
    return { stdout: envelope({ cs_live_secret123: "issued_undelivered:due_in=0s", cs_live_delivered123: "delivered" }) };
  } });
  const app = Fastify();
  registerLiveRoutes(app, h.hub);
  const response = await app.inject({ method: "GET", url: "/api/modules/live/apps" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const view = (response.json() as LivePayload).apps[0].sources.fulfilment;
  assert.deepEqual([view.data?.due, view.data?.clear, view.data?.urgency], [1, 1, "owed"]);
  assert.ok(!/cs_live_secret123|cs_live_delivered123|op:\/\//.test(response.body));
  await app.close();
});

test("private fixture ledger bytes, mode and timestamps survive the API read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holoc58-ledger-"));
  const file = join(dir, "ledger.json");
  writeFileSync(file, '{"fixture":"unchanged"}', { mode: 0o600 });
  const before = statSync(file);
  const h = setup({ run: (exe, args) => {
    if (exe !== "uv") return undefined as never;
    assert.equal(args.at(-1), "snapshot");
    assert.equal(readFileSync(file, "utf8"), '{"fixture":"unchanged"}');
    return { stdout: envelope({ cs_live_1: "issued_undelivered:due_in=0s" }) };
  } });
  const app = Fastify();
  registerLiveRoutes(app, h.hub);
  assert.equal((await app.inject({ method: "GET", url: "/api/modules/live/apps" })).statusCode, 200);
  assert.equal(readFileSync(file, "utf8"), '{"fixture":"unchanged"}');
  const after = statSync(file);
  assert.deepEqual([after.mode, after.mtimeMs, after.ctimeMs], [before.mode, before.mtimeMs, before.ctimeMs]);
  await app.close();
});

test("GET /api/modules/live/apps serves the payload uncached, and ?force=1 refreshes", async () => {
  const h = setup();
  const app = Fastify();
  registerLiveRoutes(app, h.hub);
  const res = await app.inject({ method: "GET", url: "/api/modules/live/apps" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.json() as LivePayload;
  assert.equal(body.apps[0].name, "Earshot");
  assert.equal(body.today, "2026-11-20");
  h.clock.t += 5_000;
  const before = h.calls.fetch.length;
  await app.inject({ method: "GET", url: "/api/modules/live/apps?force=1" });
  assert.ok(h.calls.fetch.length > before);
  await app.close();
});

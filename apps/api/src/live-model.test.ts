import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeStorefront,
  apkLinkMatches,
  daysLive,
  disputeRow,
  expandArgv,
  fulfilmentUrgency,
  githubWebUrl,
  judgeApk,
  paidSession,
  parseLaunchFile,
  projectRelease,
  refundRow,
  safeRelPath,
  scrubSecrets,
  summarizeOutstanding,
  summarizeSales
} from "./live-model.js";

// The contract, as the shared brief fixes it (Earshot, promoted 2026-11-20).
const EARSHOT_LAUNCH = `
mode: live
declared: 2026-11-17
live_since: 2026-11-20
finish_line: "A signed APK is downloadable with Stripe checkout on."
epic: EARS-1
contract: [docs/launch/paid-launch-brief.md, ../escape.md]
live:
  name: Earshot
  tagline: "Let your agents and automations speak through your phone, without pressing play."
  store_url: https://store.automaticai.io/earshot/
  offer: "$4.99 one-time after a 30-day trial"
  platform: android
  package: io.automaticai.earshot
  release: https://s3.delo.sh/builds/earshot/editions/beta/latest.json
  board: EARS
  support: support@automaticai.io
  checkout:
    provider: stripe
    payment_link: plink_1UcrsBFb6MyEY1wppwmX0Gzz
    key_ref: "op://DeLoSecrets/a66hlehbsvi4xmf7nm2izkmhuy/API Secret"
  fulfilment:
    kind: manual-license-key
    promise_hours: 24
    outstanding_argv: ["uv", "run", "scripts/licensing/issuer.py", "outstanding"]
    reminder_candybar: earshot-paid-key-reminder
`;

test("a complete live block parses, and an unquoted YAML date stays a calendar day", () => {
  const read = parseLaunchFile(EARSHOT_LAUNCH);
  assert.equal(read.kind, "live");
  if (read.kind !== "live") return;
  assert.equal(read.decl.liveSince, "2026-11-20");
  assert.equal(read.decl.declared, "2026-11-17");
  assert.equal(read.decl.name, "Earshot");
  assert.equal(read.decl.board, "EARS");
  assert.equal(read.decl.checkout?.paymentLink, "plink_1UcrsBFb6MyEY1wppwmX0Gzz");
  assert.equal(read.decl.fulfilment?.promiseHours, 24);
  assert.deepEqual(read.decl.fulfilment?.outstandingArgv.slice(0, 2), ["uv", "run"]);
});

test("launch and steady (and no file, and no mode) are not for this hub", () => {
  assert.deepEqual(parseLaunchFile("mode: launch\nfinish_line: x\n"), { kind: "not-live", mode: "launch" });
  assert.deepEqual(parseLaunchFile("mode: steady\n"), { kind: "not-live", mode: "steady" });
  assert.deepEqual(parseLaunchFile("finish_line: x\n"), { kind: "not-live", mode: "steady" });
  assert.deepEqual(parseLaunchFile(undefined), { kind: "absent" });
  assert.deepEqual(parseLaunchFile("- a\n- b\n"), { kind: "absent" });
});

test("mode: live without a valid block is invalid with every problem named, never silently dropped", () => {
  const bare = parseLaunchFile("mode: live\nlive_since: 2026-11-20\n");
  assert.equal(bare.kind, "invalid");
  if (bare.kind === "invalid") {
    assert.ok(bare.problems.includes("live: block is missing"));
    assert.ok(bare.problems.some((p) => p.startsWith("live.store_url")));
  }

  const bad = parseLaunchFile(
    EARSHOT_LAUNCH.replace("store_url: https://store.automaticai.io/earshot/", "store_url: http://insecure.example/")
      .replace("payment_link: plink_1UcrsBFb6MyEY1wppwmX0Gzz", "payment_link: pi_123")
      .replace('key_ref: "op://DeLoSecrets/a66hlehbsvi4xmf7nm2izkmhuy/API Secret"', "key_ref: sk_live_abc123")
      .replace("live_since: 2026-11-20", "live_since: yesterday")
  );
  assert.equal(bad.kind, "invalid");
  if (bad.kind === "invalid") {
    assert.ok(bad.problems.some((p) => p.includes("live_since")));
    assert.ok(bad.problems.some((p) => p.includes("store_url")));
    assert.ok(bad.problems.some((p) => p.includes("plink_")));
    assert.ok(bad.problems.some((p) => p.includes("op://")));
    // The bad key itself is never echoed back.
    assert.ok(!JSON.stringify(bad).includes("sk_live_abc123"));
  }
});

test("outstanding_argv must be a list of strings (no shell string)", () => {
  const bad = parseLaunchFile(EARSHOT_LAUNCH.replace(/outstanding_argv: \[.*\]/, 'outstanding_argv: "uv run issuer.py outstanding"'));
  assert.equal(bad.kind, "invalid");
});

test("a half-written file that says live is reported, one that does not is just not live", () => {
  const broken = parseLaunchFile("mode: live\nlive: [unclosed\n");
  assert.equal(broken.kind, "invalid");
  assert.deepEqual(parseLaunchFile("mode: launch\nlive: [unclosed\n"), { kind: "not-live", mode: "unparseable" });
});

test("day 1 is the day it went live", () => {
  assert.equal(daysLive("2026-11-20", "2026-11-20"), 1);
  assert.equal(daysLive("2026-11-20", "2026-11-21"), 2);
  assert.equal(daysLive("2026-11-20", "2026-12-20"), 31);
  assert.equal(daysLive("2026-11-20", "2026-11-19"), 1);
});

test("only repo-relative paths and github remotes become links", () => {
  assert.equal(safeRelPath("docs/runbook.md"), "docs/runbook.md");
  for (const bad of ["../x.md", "/etc/passwd", "~/x", "a//b", "a/./b", "a\\b", ""]) assert.equal(safeRelPath(bad), undefined, bad);
  assert.equal(githubWebUrl("git@github.com:delorenj/earshot.git"), "https://github.com/delorenj/earshot");
  assert.equal(githubWebUrl("https://github.com/delorenj/earshot"), "https://github.com/delorenj/earshot");
  assert.equal(githubWebUrl("https://token@github.com/delorenj/earshot.git"), "https://github.com/delorenj/earshot");
  assert.equal(githubWebUrl("git@gitlab.com:a/b.git"), undefined);
  assert.equal(githubWebUrl(undefined), undefined);
});

// ---------------------------------------------------------------- release

const LATEST = {
  schema: 1, app: "Earshot", package: "io.automaticai.earshot", version: "0.1.12", code: 1012, bytes: 1991768,
  url: "https://s3.delo.sh/builds/earshot/editions/beta/0.1.12/earshot-beta-0.1.12-1012.apk",
  sha256: "ad49f3171d1171714a62633ce46e66fa645e8f945b13d6a555fc72e0acf8ca22",
  commit: "c4e1953796ef6a838ba40bac2abcbcc19213235f", updated_at: "2026-11-20T13:43:45Z"
};

test("latest.json projects to version, code, sha256 and url; anything short of that is not a release", () => {
  const r = projectRelease(LATEST);
  assert.equal(r?.version, "0.1.12");
  assert.equal(r?.code, 1012);
  assert.equal(r?.commit, "c4e1953796ef");
  assert.equal(r?.bytes, 1991768);
  for (const drop of ["version", "code", "sha256", "url"]) {
    assert.equal(projectRelease({ ...LATEST, [drop]: undefined }), undefined, drop);
  }
  assert.equal(projectRelease({ ...LATEST, sha256: "nope" }), undefined);
  assert.equal(projectRelease({ ...LATEST, url: "http://s3.delo.sh/a.apk" }), undefined);
  assert.equal(projectRelease("not an object"), undefined);
});

test("an APK HEAD is judged on reachability and the promised size", () => {
  assert.deepEqual(judgeApk({ status: 200, contentLength: 1991768 }, { bytes: 1991768 }), { reachable: true, sizeMatches: true });
  assert.deepEqual(judgeApk({ status: 200, contentLength: 5 }, { bytes: 1991768 }), { reachable: true, sizeMatches: false });
  assert.deepEqual(judgeApk({ status: 200 }, { bytes: 1991768 }), { reachable: true, sizeMatches: null });
  assert.deepEqual(judgeApk({ status: 404 }, { bytes: 1991768 }), { reachable: false, sizeMatches: null });
});

// ---------------------------------------------------------------- storefront

const PAGE = `<html><body>
<a href="https://buy.stripe.com/14AeVd9ZV1UngTWfpb43S01">Buy</a>
<a href="https://s3.delo.sh/builds/earshot/editions/beta/0.1.12/earshot-beta-0.1.12-1012.apk">Download</a>
<a href='obtainium://app/x'>Obtainium</a><a href="/guide/">Guide</a></body></html>`;

test("the storefront is read for a buy link and the APK links it offers", () => {
  const sf = analyzeStorefront(200, PAGE);
  assert.equal(sf.hasBuyButton, true);
  assert.equal(sf.checkoutUrl, "https://buy.stripe.com/14AeVd9ZV1UngTWfpb43S01");
  assert.deepEqual(sf.apkLinks, [LATEST.url]);
  const release = projectRelease(LATEST);
  assert.equal(apkLinkMatches(sf, release), true);
  assert.equal(apkLinkMatches(sf, { ...release!, url: "https://s3.delo.sh/builds/earshot/editions/beta/0.1.13/x.apk" }), false);
  assert.equal(apkLinkMatches(sf, undefined), null);
  assert.equal(apkLinkMatches(undefined, release), null);
});

test("a page with no checkout link reports none, and HTML entities in the href are decoded", () => {
  const none = analyzeStorefront(200, "<a href=\"/guide/\">g</a>");
  assert.equal(none.hasBuyButton, false);
  assert.equal(none.checkoutUrl, undefined);
  assert.equal(analyzeStorefront(200, '<a href="https://checkout.stripe.com/c/pay/x?a=1&amp;b=2">p</a>').checkoutUrl, "https://checkout.stripe.com/c/pay/x?a=1&b=2");
});

// ---------------------------------------------------------------- sales (and the privacy line)

const SESSION = (over: Record<string, unknown> = {}) => ({
  id: "cs_live_abc", object: "checkout.session", status: "complete", payment_status: "paid",
  amount_total: 499, currency: "usd", created: 1_795_000_000, payment_intent: "pi_1",
  customer_details: { email: "buyer@example.com", name: "Pat Buyer", address: { line1: "1 Main St" } },
  customer_email: "buyer@example.com", ...over
});

test("sales count only completed, paid sessions; unpaid and expired ones are not sales", () => {
  assert.ok(paidSession(SESSION()));
  assert.equal(paidSession(SESSION({ status: "expired", payment_status: "unpaid" })), undefined);
  assert.equal(paidSession(SESSION({ status: "open" })), undefined);
  assert.equal(paidSession(SESSION({ payment_status: "unpaid" })), undefined);
  assert.equal(paidSession(null), undefined);
});

test("the sales summary carries counts, amounts and times, refunds and disputes matched to this link's payments", () => {
  const sessions = [
    paidSession(SESSION({ created: 1_795_000_200, payment_intent: "pi_2" }))!,
    paidSession(SESSION({ created: 1_795_000_000, payment_intent: "pi_1" }))!,
    paidSession(SESSION({ created: 1_795_000_500, payment_intent: "pi_3", amount_total: 999 }))!
  ];
  const refunds = [
    refundRow({ payment_intent: "pi_1", amount: 499, status: "succeeded" })!,
    refundRow({ payment_intent: "pi_other", amount: 100, status: "succeeded" })!, // another product
    refundRow({ payment_intent: "pi_2", amount: 499, status: "failed" })!
  ];
  const disputes = [disputeRow({ payment_intent: "pi_3" })!, disputeRow({ payment_intent: "pi_other" })!];
  const s = summarizeSales(sessions, refunds, disputes);
  assert.equal(s.count, 3);
  assert.equal(s.grossMinor, 499 + 499 + 999);
  assert.equal(s.currency, "usd");
  assert.equal(s.firstSaleAt, new Date(1_795_000_000_000).toISOString());
  assert.equal(s.lastSaleAt, new Date(1_795_000_500_000).toISOString());
  assert.deepEqual(s.refunds, { count: 1, amountMinor: 499 });
  assert.deepEqual(s.disputes, { count: 1 });
});

test("zero sales is a real answer: zeros and no timestamps", () => {
  const s = summarizeSales([], [], []);
  assert.equal(s.count, 0);
  assert.equal(s.grossMinor, 0);
  assert.equal(s.firstSaleAt, undefined);
  assert.equal(s.lastSaleAt, undefined);
});

test("no buyer data survives the projection, whatever Stripe sends", () => {
  const raw = [SESSION({ client_secret: "cs_secret_x", shipping_details: { name: "Pat" }, metadata: { who: "pat@example.com" } })];
  const sessions = raw.map(paidSession).filter((x): x is NonNullable<typeof x> => !!x);
  const out = JSON.stringify({ sessions, summary: summarizeSales(sessions, [], []) });
  for (const leak of ["buyer@example.com", "pat@example.com", "Pat", "Main St", "cs_live_abc", "cs_secret_x", "customer"]) {
    assert.ok(!out.includes(leak), `${leak} must not appear`);
  }
});

test("key-shaped strings are scrubbed from error text", () => {
  const dirty = "Invalid API Key provided: sk_live_51Habc****xyz; rk_test_zzz; ops_AbCdEf12345678; Bearer abc.def-ghi";
  const clean = scrubSecrets(dirty);
  assert.ok(!/sk_live|rk_test|ops_Ab|abc\.def/.test(clean), clean);
});

test("buyer emails and Stripe object ids are scrubbed from error text, plain words are not", () => {
  const dirty = "issuer refused: session cs_live_a1B2c3D4e5F6g7H8i9 for pat.buyer+x@example.co.uk (pi_3Qabcdefghijklmnop, cus_Rabcdefghijklmn) in_progress, re_read";
  const clean = scrubSecrets(dirty);
  assert.ok(!/cs_live_a1|pat\.buyer|example\.co|pi_3Q|cus_R|@/.test(clean), clean);
  assert.match(clean, /in_progress, re_read/);
});

// ---------------------------------------------------------------- fulfilment

test("outstanding is folded into due, overdue, clear and blocked counts with the urgency deadlines", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const f = summarizeOutstanding(
    {
      cs_live_a: "paid_unissued:due_in=3600s",
      cs_live_b: "paid_unissued:due_in=600s",
      cs_live_c: "paid_unissued:overdue_by=120s",
      cs_live_d: "paid_unissued:overdue_by=7200s",
      cs_live_e: "clear:pending",
      cs_live_f: "blocked:email bounced for pat@example.com",
      cs_live_g: "something-new"
    },
    now,
    24
  )!;
  assert.equal(f.due, 2);
  assert.equal(f.overdue, 2);
  assert.equal(f.clear, 1);
  assert.equal(f.blocked, 1);
  assert.equal(f.other, 1);
  assert.equal(f.soonestDueAt, "2026-11-20T12:10:00.000Z");
  assert.equal(f.worstOverdueSeconds, 7200);
  assert.deepEqual(f.blockedReasons, ["email"]);
  assert.equal(f.promiseHours, 24);
  assert.equal(fulfilmentUrgency(f), "overdue");
  // Stripe session ids and the free text after the reason code are never returned.
  const out = JSON.stringify(f);
  assert.ok(!out.includes("cs_live") && !out.includes("pat@example.com"));
});

test("urgency: nothing owed is clear, due or blocked is owed, overdue wins", () => {
  const now = Date.now();
  assert.equal(fulfilmentUrgency(summarizeOutstanding({}, now)!), "clear");
  assert.equal(fulfilmentUrgency(summarizeOutstanding({ a: "clear:pending" }, now)!), "clear");
  assert.equal(fulfilmentUrgency(summarizeOutstanding({ a: "paid_unissued:due_in=5s" }, now)!), "owed");
  assert.equal(fulfilmentUrgency(summarizeOutstanding({ a: "blocked:x" }, now)!), "owed");
  assert.equal(fulfilmentUrgency(summarizeOutstanding({ a: "paid_unissued:due_in=5s", b: "paid_unissued:overdue_by=1s" }, now)!), "overdue");
  assert.equal(fulfilmentUrgency(undefined), "unknown");
  assert.equal(summarizeOutstanding("nope", now), undefined);
  assert.equal(summarizeOutstanding([1], now), undefined);
});

test("argv expands a leading ~/ and nothing else", () => {
  assert.deepEqual(expandArgv(["uv", "~/x.json", "a~b", "~"], "/home/me"), ["uv", "/home/me/x.json", "a~b", "/home/me"]);
});

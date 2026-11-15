import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import {
  listArgs,
  projectRow,
  readTranscriptDetail,
  readTranscriptSearch,
  readTranscripts,
  registerTranscriptRoutes,
  resetTranscriptsCache,
  searchArgs
} from "./transcripts.js";
import { harvestJobs, reviewPath } from "./transcript-harvest.js";
import type { CollectedEvent } from "./event-store.js";

// The Transcripts tab reads `wax --json transcripts browse|search` through this
// module. These tests pin the safety properties: an allowlist projection (the
// body, note path, frontmatter and S3 locations can never pass), a DOWN source on
// CLI failure (never healthy emptiness), a bounded cache, and argv-only validation.

const T0 = 1_700_000_000_000;

async function fakeWax(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "holocene-transcripts-"));
  const executable = join(dir, "fake-wax");
  await writeFile(executable, `#!${process.execPath}\n${script}\n`);
  await chmod(executable, 0o700);
  return executable;
}

const ROW = {
  transcript_id: 1752, wax_item_id: "a369671213a6fa3c", classification: "monolog",
  classification_detail: null, classification_confidence: 0.97, classification_source: "jev-1.13.0",
  title: "Hopes for a Smooth Wedding Day", summary: "The speaker hopes it goes well.",
  effective_at: "2026-10-29T10:22:42Z", duration_s: 15.087, word_count: 20, speaker_count: 0,
  origin: "wax", source_hint: "rec", tags: ["family"], project_ids: ["holocene"], projects: ["Holocene"],
  language: "en", diarized: false, audio_available: true,
  harvest: { state: "none", run_count: 0, ticket_count: 0, item_count: 0, last_harvested_at: null },
  // Planted: none of these may ever pass the projection.
  content: "SECRET BODY TEXT", note_path: "/home/delorenj/d/Transcripts/private.md",
  frontmatter: { token: "sk-leak" }, audio_s3_uri: "s3://recordings/x.ogg", dsn: "postgres://u:p@h/db"
};

const LIST = {
  schema: 1, generated_at: "2026-10-29T11:00:00Z", store: { state: "ok", latest_migration: "0005" },
  counts: { monolog: 48, meeting: 62, phone_call: 0, other: 37, unsorted: 383, hidden_hermes: 335, secret: 9 },
  rows: [
    ROW,
    { ...ROW, transcript_id: 7, classification: "bogus-kind", title: "" }
  ],
  projects: [{ project_id: "holocene", name: "Holocene", count: 1 }],
  truncated: false
};

const DETAIL = {
  schema: 1, generated_at: "2026-10-29T11:00:00Z", store: { state: "ok", latest_migration: "0005" },
  row: ROW,
  tickets: [
    {
      harvest_id: "h1", harvested_at: "2026-10-29T10:00:00Z", item_id: "h-72204a2c0900", title: "Add a tab",
      category: "feature", item_status: "firm", gate_state: "clear", quote: "q".repeat(900),
      provider: "plane", board_id: "b1", publish_status: "published", ticket_ref: "PX-123",
      ticket_url: "https://plane.delo.sh/33god/browse/PX-123/", project_id: "pilot", lane: "Todo", published_at: null,
      note_path: "/leak"
    },
    {
      harvest_id: "h1", item_id: "h-evil", title: "Bad link", ticket_ref: "PX-9",
      ticket_url: "javascript:alert(1)", publish_status: "published"
    }
  ],
  pass_history: [{ slug: "classification", pass_version: 1, state: "completed", finished_at: "2026-10-29T10:23:18Z", env: "x" }]
};

const SEARCH = {
  count: 1, mode: "lexical", query: "wedding",
  results: [
    {
      transcript_id: 1752, display_title: "Hopes for a Smooth Wedding Day", snippet: "hoping the «wedding» goes", score: 0.0239,
      classification: "monolog", effective_at: "2026-10-29T06:22:42-04:00", origin: "wax",
      note_path: "/home/delorenj/d/Transcripts/private.md", audio_s3_uri: "s3://recordings/x.ogg", audio_https_url: "https://s3.delo.sh/x.ogg"
    }
  ]
};

/** A fake CLI that answers browse (list/detail) and search from canned JSON. */
function router(opts: { list?: unknown; detail?: unknown; search?: unknown } = {}) {
  return `
const a = process.argv.slice(2);
if (a.includes('search')) { console.log(JSON.stringify(${JSON.stringify(opts.search ?? SEARCH)})); }
else if (a.includes('--id')) {
  if (a[a.indexOf('--id') + 1] === '99999') { console.error('error: no transcript #99999'); process.exit(2); }
  console.log(JSON.stringify(${JSON.stringify(opts.detail ?? DETAIL)}));
} else { console.log(JSON.stringify(${JSON.stringify(opts.list ?? LIST)})); }`;
}

test("the row projection drops body, path, frontmatter, S3 and dsn keys", () => {
  const row = projectRow(ROW) as unknown as Record<string, unknown>;
  assert.equal(row.title, "Hopes for a Smooth Wedding Day");
  for (const leak of ["content", "note_path", "frontmatter", "audio_s3_uri", "dsn"]) assert.equal(leak in row, false, leak);
  assert.equal(JSON.stringify(row).includes("SECRET BODY TEXT"), false);
  assert.equal(JSON.stringify(row).includes("sk-leak"), false);
});

test("a healthy read returns rows with a live source; unknown kinds become unsorted", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(router());
  const payload = await readTranscripts({}, { executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.value, "live");
  assert.equal(payload.source.down, undefined);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].classification, "monolog");
  assert.equal(payload.rows[1].classification, null);
  assert.equal(payload.rows[1].title, "Recording #7");
  assert.equal(payload.counts.monolog, 48);
  assert.equal(payload.counts.unsorted, 383);
  assert.equal("secret" in payload.counts, false);
  assert.equal(payload.store?.latest_migration, "0005");
  assert.deepEqual(payload.projects, [{ project_id: "holocene", name: "Holocene", count: 1 }]);
  assert.equal(JSON.stringify(payload).includes("SECRET BODY TEXT"), false);
  assert.equal(JSON.stringify(payload).includes("private.md"), false);
});

test("the detail call projects tickets: https-only links, capped quotes, no planted keys", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(router());
  const d = await readTranscriptDetail(1752, { executable, root: "/srv/heyma", now: T0 });
  assert.ok(d);
  assert.equal(d.row?.transcript_id, 1752);
  assert.equal(d.tickets.length, 2);
  assert.equal(d.tickets[0].ticket_url, "https://plane.delo.sh/33god/browse/PX-123/");
  assert.ok((d.tickets[0].quote ?? "").length <= 400);
  assert.equal(d.tickets[1].ticket_url, null);
  assert.equal("note_path" in d.tickets[0], false);
  assert.equal(d.pass_history[0].slug, "classification");
  assert.equal("env" in d.pass_history[0], false);
});

test("an unknown transcript id is not found (undefined), not an empty healthy row", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(router());
  assert.equal(await readTranscriptDetail(99999, { executable, root: "/srv/heyma", now: T0 }), undefined);
});

test("search keeps the allowlisted fields and never the note path or audio locations", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(router());
  const s = await readTranscriptSearch("wedding", "monolog", { executable, root: "/srv/heyma", now: T0 });
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].display_title, "Hopes for a Smooth Wedding Day");
  assert.equal(s.results[0].snippet, "hoping the «wedding» goes");
  const encoded = JSON.stringify(s);
  for (const leak of ["note_path", "audio_s3_uri", "audio_https_url", "private.md"]) assert.equal(encoded.includes(leak), false, leak);
});

test("a CLI failure with no prior read is DOWN, never healthy emptiness", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(`console.error('error: transcript store unreachable\\nTraceback noise'); process.exit(2);`);
  const payload = await readTranscripts({}, { executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.down, true);
  assert.equal(payload.source.detail, "error: transcript store unreachable");
  assert.deepEqual(payload.rows, []);
  assert.deepEqual(payload.counts, {});
});

test("a store that answers but is not ok is a failure, not an empty list", async (t) => {
  t.after(resetTranscriptsCache);
  const executable = await fakeWax(router({ list: { ...LIST, store: { state: "unreachable" }, rows: [], counts: {} } }));
  const payload = await readTranscripts({}, { executable, root: "/srv/heyma", now: T0 });
  assert.equal(payload.source.down, true);
  assert.match(payload.source.detail ?? "", /unreachable/u);
});

test("a CLI failure after a good read keeps the last rows, labeled stale", async (t) => {
  t.after(resetTranscriptsCache);
  const good = await fakeWax(router());
  await readTranscripts({}, { executable: good, root: "/srv/heyma", now: T0 });
  const bad = await fakeWax(`console.error('error: pool exhausted'); process.exit(2);`);
  const payload = await readTranscripts({}, { executable: bad, root: "/srv/heyma", now: T0 + 60_000 });
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.source.down, true);
  assert.equal(payload.source.value, "stale");
  assert.match(payload.source.detail ?? "", /last good read/u);
  assert.match(payload.source.detail ?? "", /pool exhausted/u);
});

test("reads inside the TTL hit the cache; a read after it re-runs the CLI", async (t) => {
  t.after(resetTranscriptsCache);
  const dir = await mkdtemp(join(tmpdir(), "holocene-transcripts-count-"));
  t.after(async () => rm(dir, { force: true, recursive: true }));
  const executable = join(dir, "fake-wax");
  const counter = join(dir, "count");
  await writeFile(
    executable,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');
console.log(JSON.stringify(${JSON.stringify(LIST)}));`
  );
  await chmod(executable, 0o700);
  const opts = { executable, root: "/srv/heyma" };
  await readTranscripts({}, { ...opts, now: T0 });
  await readTranscripts({}, { ...opts, now: T0 + 2_000 });
  assert.equal((await readFile(counter, "utf8")).length, 1);
  await readTranscripts({}, { ...opts, now: T0 + 10_000 });
  assert.equal((await readFile(counter, "utf8")).length, 2);
  // a different flag set is a different cache key
  await readTranscripts({ view: "meeting" }, { ...opts, now: T0 + 10_500 });
  assert.equal((await readFile(counter, "utf8")).length, 3);
});

test("argv building validates every value and never builds a shell string", () => {
  assert.deepEqual(listArgs({}).slice(0, 3), ["--json", "transcripts", "browse"]);
  const args = listArgs({ view: "monolog", includeHermes: true, project: "holocene", since: "2026-10-01", until: "2026-10-29T12:00:00Z" });
  assert.deepEqual(args.slice(args.indexOf("--view")), ["--view", "monolog", "--include-hermes", "--project", "holocene", "--since", "2026-10-01", "--until", "2026-10-29T12:00:00Z"]);
  assert.equal(listArgs({ view: "all" }).includes("--view"), false);
  assert.throws(() => listArgs({ project: "x; rm -rf /" }), RangeError);
  assert.throws(() => listArgs({ since: "yesterday" }), RangeError);
  assert.throws(() => listArgs({ until: "2026-10-01'; DROP" }), RangeError);
  const s = searchArgs("--help me", "phone_call");
  assert.deepEqual(s.slice(s.indexOf("--classification")), ["--classification", "phone_call", "--", "--help", "me"]);
  assert.equal(searchArgs("x", "unsorted").includes("--classification"), false);
  assert.throws(() => searchArgs("x", "nonsense"), RangeError);
});

test("routes: invalid view and non-numeric id are 400, an empty search is 400, a missing id is 404", async (t) => {
  t.after(resetTranscriptsCache);
  const app = Fastify();
  registerTranscriptRoutes(app);
  t.after(() => app.close());
  const get = (url: string) => app.inject({ method: "GET", url });
  assert.equal((await get("/api/modules/transcripts/list?view=nope")).statusCode, 400);
  assert.equal((await get("/api/modules/transcripts/list?project=a%3Bb")).statusCode, 400);
  assert.equal((await get("/api/modules/transcripts/abc")).statusCode, 400);
  assert.equal((await get("/api/modules/transcripts/search")).statusCode, 400);
  assert.equal((await get("/api/modules/transcripts/search?q=x&view=nope")).statusCode, 400);
});

// ---------- Harvest button + harvest_job projection ----------

const evt = (cursor: number, type: string, data: Record<string, unknown>, time = "2026-11-15T12:00:00Z"): CollectedEvent => ({
  cursor, stream: "BLOODBANK", sequence: cursor, subject: `bloodbank.evt.${type.split(".").slice(1).join(".")}`, collected_at: time,
  envelope: { id: `e${cursor}`, type, time, data } as unknown as CollectedEvent["envelope"]
});
const NOW = Date.parse("2026-11-15T12:05:00Z");
const rowOf = (transcript_id: number, wax_item_id: string | null = null) => ({ transcript_id, wax_item_id });

test("harvest_job: the latest harvest event per transcript wins and states map to the UI states", () => {
  const events = [ // newest first, as store.recent returns
    evt(6, "bloodbank.audio.harvest.completed", { transcript_id: 1752, wax_item_id: "a369671213a6fa3c", harvest_id: "h-abc", review_url: "https://holocene.delo.sh/harvest/review/h-abc/", items: 5, clear: 3, held: 1, rejected: 1 }),
    evt(5, "bloodbank.audio.harvest.started", { transcript_id: 1752, wax_item_id: "a369671213a6fa3c" }),
    evt(4, "bloodbank.audio.harvest.queued", { transcript_id: 1752, wax_item_id: "a369671213a6fa3c", waiting_for: "enrichment" }),
    evt(3, "bloodbank.audio.harvest.failed", { transcript_id: 7, wax_item_id: null, stage: "enrichment", reason: "pass classification failed" }),
    evt(2, "bloodbank.audio.harvest.published", { transcript_id: 9, wax_item_id: null, harvest_id: "h-9", created: 2, adopted: 1, failed: 0, tickets: [] }),
    evt(1, "bloodbank.audio.harvest.queued", { transcript_id: 9, wax_item_id: null })
  ];
  const lookup = harvestJobs(events, NOW);
  const a = lookup(rowOf(1752, "a369671213a6fa3c"));
  assert.equal(a?.state, "review_ready");
  assert.equal(a?.harvest_id, "h-abc");
  assert.equal(a?.review_url, "/harvest/review/h-abc/");
  assert.deepEqual(a?.items, { total: 5, clear: 3, held: 1, rejected: 1 });
  const b = lookup(rowOf(7));
  assert.equal(b?.state, "failed");
  assert.equal(b?.stage, "enrichment");
  assert.equal(b?.reason, "pass classification failed");
  const c = lookup(rowOf(9));
  assert.equal(c?.state, "published");
  assert.deepEqual(c?.tickets, { created: 2, adopted: 1, failed: 0 });
  assert.equal(lookup(rowOf(404)), null);
});

test("harvest_job: matches on wax_item_id when the event carries no transcript_id; a stale queued job is flagged", () => {
  const lookup = harvestJobs([evt(1, "bloodbank.audio.harvest.queued", { transcript_id: null, wax_item_id: "a369671213a6fa3c", waiting_for: "enrichment" }, "2026-11-15T01:00:00Z")], NOW);
  const job = lookup(rowOf(1752, "a369671213a6fa3c"));
  assert.equal(job?.state, "queued");
  assert.equal(job?.waiting_for, "enrichment");
  assert.equal(job?.stale, true);
});

test("harvest_job: the review link is only ever a relative /harvest/review path", () => {
  assert.equal(reviewPath("https://holocene.delo.sh/harvest/review/h1/", "h1"), "/harvest/review/h1/");
  assert.equal(reviewPath("https://evil.example/phish", "h1"), "/harvest/review/h1/");
  assert.equal(reviewPath("javascript:alert(1)", null), null);
  assert.equal(reviewPath(undefined, null), null);
  const lookup = harvestJobs([evt(1, "bloodbank.audio.harvest.completed", { transcript_id: 3, harvest_id: "bad/id", review_url: "https://x.test/a" })], NOW);
  assert.equal(lookup(rowOf(3))?.review_url, null);
});

/** A fake bb-emit that records its argv, prints the --print-ids line, and can fail. */
async function fakeBbEmit(mode: "ok" | "fail" | "hang" = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "holocene-bbemit-"));
  const argvFile = join(dir, "argv.json");
  const executable = join(dir, "fake-bb-emit");
  const body = mode === "fail"
    ? `console.error('bb-emit: NATS unreachable\\ntrace'); process.exit(1);`
    : mode === "hang"
      ? `setTimeout(() => {}, 60000);`
      : `const a = process.argv.slice(2); const at = (f) => a[a.indexOf(f) + 1];
console.log('PASS noise');
console.log(JSON.stringify({ id: 'evt-1', type: at('--type'), command_id: at('--command-id'), correlationid: at('--correlation') }));`;
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`);
  await chmod(executable, 0o700);
  return { dir, executable, argv: async () => JSON.parse(await readFile(argvFile, "utf8")) as string[] };
}

const argOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("POST harvest publishes one start command with argv only and returns its ids", async (t) => {
  t.after(resetTranscriptsCache);
  const wax = await fakeWax(router());
  const bb = await fakeBbEmit();
  t.after(() => rm(bb.dir, { recursive: true, force: true }));
  const app = Fastify();
  registerTranscriptRoutes(app, undefined, { wax: { executable: wax, root: "/srv/heyma" }, emit: { executable: bb.executable } });
  t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest", payload: { force: true } });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json() as { ok: boolean; command_id: string; correlation_id: string };
  assert.equal(out.ok, true);
  assert.match(out.command_id, /^[0-9a-f-]{36}$/u);
  assert.match(out.correlation_id, /^[0-9a-f-]{36}$/u);
  const argv = await bb.argv();
  assert.ok(argv.includes("--strict"));
  assert.equal(argOf(argv, "--kind"), "command");
  assert.equal(argOf(argv, "--type"), "bloodbank.cmd.audio.harvest.start");
  assert.equal(argOf(argv, "--producer"), "holocene");
  assert.equal(argOf(argv, "--service"), "holocene-api");
  assert.equal(argOf(argv, "--source"), "urn:33god:service:holocene-api");
  assert.equal(argOf(argv, "--actor-id"), "holocene");
  assert.equal(argOf(argv, "--correlation"), out.correlation_id);
  assert.deepEqual(JSON.parse(argOf(argv, "--data")), { transcript_id: 1752, wax_item_id: "a369671213a6fa3c", requested_by: "holocene", force: true });
});

test("POST harvest: no body means force false; unknown id 404; bad id/body 400; a null wax_item_id still publishes", async (t) => {
  t.after(resetTranscriptsCache);
  const wax = await fakeWax(router({ detail: { ...DETAIL, row: { ...ROW, wax_item_id: null } } }));
  const bb = await fakeBbEmit();
  t.after(() => rm(bb.dir, { recursive: true, force: true }));
  const app = Fastify();
  registerTranscriptRoutes(app, undefined, { wax: { executable: wax, root: "/srv/heyma" }, emit: { executable: bb.executable } });
  t.after(() => app.close());
  const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload: payload as object }) });
  assert.equal((await post("/api/modules/transcripts/99999/harvest")).statusCode, 404);
  assert.equal((await post("/api/modules/transcripts/abc/harvest")).statusCode, 400);
  assert.equal((await post("/api/modules/transcripts/0/harvest")).statusCode, 400);
  assert.equal((await post("/api/modules/transcripts/1752/harvest", { force: "yes" })).statusCode, 400);
  assert.equal((await post("/api/modules/transcripts/1752/harvest", [1])).statusCode, 400);
  assert.equal((await post("/api/modules/transcripts/1752/harvest")).statusCode, 200);
  assert.deepEqual(JSON.parse(argOf(await bb.argv(), "--data")), { transcript_id: 1752, wax_item_id: null, requested_by: "holocene", force: false });
});

test("POST harvest: a failing or hung bb-emit is a clear 502; wax down is 502 too", async (t) => {
  t.after(resetTranscriptsCache);
  const wax = await fakeWax(router());
  const bad = await fakeBbEmit("fail");
  const hang = await fakeBbEmit("hang");
  t.after(() => Promise.all([rm(bad.dir, { recursive: true, force: true }), rm(hang.dir, { recursive: true, force: true })]));
  const mk = (emit: { executable: string; timeoutMs?: number }, waxExe = wax) => {
    const app = Fastify();
    registerTranscriptRoutes(app, undefined, { wax: { executable: waxExe, root: "/srv/heyma" }, emit });
    t.after(() => app.close());
    return app;
  };
  const failed = await mk({ executable: bad.executable }).inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest" });
  assert.equal(failed.statusCode, 502);
  assert.match((failed.json() as { error: string }).error, /NATS unreachable/u);
  const slow = await mk({ executable: hang.executable, timeoutMs: 200 }).inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest" });
  assert.equal(slow.statusCode, 502);
  assert.match((slow.json() as { error: string }).error, /timed out/u);
  resetTranscriptsCache();
  const down = await fakeWax(`console.error('error: store unreachable'); process.exit(2);`);
  const noWax = await mk({ executable: bad.executable }, down).inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest" });
  assert.equal(noWax.statusCode, 502);
});

test("list and detail carry harvest_job from the event store (null when none); a queued job refuses a second click unless forced", async (t) => {
  t.after(resetTranscriptsCache);
  const wax = await fakeWax(router({ list: { ...LIST, rows: [ROW, { ...ROW, transcript_id: 7, wax_item_id: null }] } }));
  const bb = await fakeBbEmit();
  t.after(() => rm(bb.dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const events = [evt(1, "bloodbank.audio.harvest.queued", { transcript_id: 1752, wax_item_id: "a369671213a6fa3c", waiting_for: "enrichment" }, now)];
  const store = { cursor: 1, recent: () => events };
  const app = Fastify();
  registerTranscriptRoutes(app, store, { wax: { executable: wax, root: "/srv/heyma" }, emit: { executable: bb.executable } });
  t.after(() => app.close());
  const list = (await app.inject({ method: "GET", url: "/api/modules/transcripts/list" })).json() as { rows: Array<{ transcript_id: number; harvest_job: { state: string } | null }> };
  assert.equal(list.rows.find((r) => r.transcript_id === 1752)?.harvest_job?.state, "queued");
  assert.equal(list.rows.find((r) => r.transcript_id === 7)?.harvest_job, null);
  const detail = (await app.inject({ method: "GET", url: "/api/modules/transcripts/1752" })).json() as { row: { harvest_job: { state: string } | null } };
  assert.equal(detail.row.harvest_job?.state, "queued");
  assert.equal((await app.inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest" })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/modules/transcripts/1752/harvest", payload: { force: true } })).statusCode, 200);
});

test("without a store every row's harvest_job is null, and wax can never inject one", async (t) => {
  t.after(resetTranscriptsCache);
  const wax = await fakeWax(router({ list: { ...LIST, rows: [{ ...ROW, harvest_job: { state: "published" } }] } }));
  const app = Fastify();
  registerTranscriptRoutes(app, undefined, { wax: { executable: wax, root: "/srv/heyma" } });
  t.after(() => app.close());
  const list = (await app.inject({ method: "GET", url: "/api/modules/transcripts/list" })).json() as { rows: Array<{ harvest_job: unknown }> };
  assert.equal(list.rows[0].harvest_job, null);
});

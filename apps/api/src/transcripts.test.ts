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

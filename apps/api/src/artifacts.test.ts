import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { authorizeArtifacts, boundaries, createArtifactCatalog, listMinio, normalizeMinio, normalizeR2, queryArtifacts, registerArtifactRoutes, safePublishedUrl } from "./artifacts.js";
import type { Artifact } from "./artifacts.js";

const row = (key: string, modified = "2026-11-20T12:00:00Z") => ({ key, modified });
const fixture = (id: string, category: Artifact["category"] = "images", date?: string): Artifact => ({ id, source: "projects", title: id, filenames: [id], category, originalUrl: "https://s3.delo.sh/projects/example/entry.jpg", date, dateKind: date ? "modified" : "unknown" });

test("MinIO groups sites, keeps useful files and same-name publications distinct; no hubs or scaffold", () => {
  const rows = [row("demo/2026-11-20/kit/index.html"), row("demo/2026-11-20/kit/style.css"), row("demo/2026-11-20/kit/shots/一.jpg"), row("demo/2026-11-20/kit/doc.pdf"), row("demo/2026-11-20/index-abcdef123456.html"), row("demo/session-uuid/kit/index.html")];
  const result = normalizeMinio("projects", rows);
  assert.equal(result.length, 4);
  assert.equal(result.filter((r) => r.title === "kit").length, 2);
  assert.ok(result.find((r) => r.category === "images")?.originalUrl.includes("%E4%B8%80"));
  assert.ok(result.find((r) => r.category === "pdfs"));
  assert.equal(normalizeMinio("share", [row("random/kit/index.html")]).length, 1);
  assert.equal(normalizeMinio("projects", [row("project/session-uuid/loose.mp3")])[0].title, "loose.mp3");
  assert.equal(normalizeMinio("projects", [row("project/2026-11-20/x/../evil.jpg")]).length, 0);
});

test("R2 gallery variants replace duplicate member pages, preserve safe originals and metadata", () => {
  const rows = [row("aaaaaaaabbbbbbbb/gallery"), row("aaaaaaaabbbbbbbb/gallery.json"), row("ccccccccdddddddd/member"), row("ccccccccdddddddd/vid.mp4"), row("ccccccccdddddddd/poster.jpg")];
  const manifest = { items: [{ name: "member", label: "Version A", notes: "Description", letter: "A", entry_url: "https://v.delo.sh/ccccccccdddddddd/member", video_url: "https://v.delo.sh/ccccccccdddddddd/vid.mp4", poster_url: "https://v.delo.sh/ccccccccdddddddd/poster.jpg" }, { name: "attack", entry_url: "javascript:alert(1)", video_url: "https://evil.test/hack.mp4" }] };
  const result = normalizeR2(rows, { "aaaaaaaabbbbbbbb/gallery.json": { manifest }, "ccccccccdddddddd/member": { title: "Member", published: "2026-11-19T12:00:00Z", description: "Detailed notes" } });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Version A");
  assert.equal(result[0].galleryUrl, "https://v.delo.sh/aaaaaaaabbbbbbbb/gallery");
  assert.equal(safePublishedUrl("https://v.delo.sh/../secret", "https://v.delo.sh"), undefined);
  assert.equal(safePublishedUrl("https://v.delo.sh/abc/%2e%2e/file", "https://v.delo.sh"), undefined);
  const solo = normalizeR2(rows.slice(2), { "ccccccccdddddddd/member": { title: "Member", published: "2026-11-19T12:00:00Z", description: "Detailed notes" } });
  assert.equal(solo[0].dateKind, "published");
  assert.equal(solo[0].description, "Detailed notes");
});

test("date boundaries are local and DST aware with exact inclusive/exclusive filtering", () => {
  const spring = boundaries("2026-03-08", "2026-03-08", "America/New_York");
  assert.deepEqual(spring.map((x) => new Date(x).toISOString()), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  const fall = boundaries("2026-11-01", "2026-11-01", "America/New_York");
  assert.equal((fall[1] - fall[0]) / 3600000, 25);
  assert.deepEqual(boundaries("2026-03-08", "2026-03-08", "UTC").map((x) => new Date(x).toISOString()), ["2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"]);
  for (const [from, to, zone] of [["2026-02-30", "2026-03-01", "UTC"], ["2026-03-02", "2026-03-01", "UTC"], ["2026-03-01", "2026-03-02", "not-a-zone"]]) assert.throws(() => boundaries(from, to, zone));
  const items = [fixture("start", "images", "2026-03-08T05:00:00Z"), fixture("last", "images", "2026-03-09T03:59:59Z"), fixture("end", "images", "2026-03-09T04:00:00Z"), fixture("unknown")];
  const result = queryArtifacts(items, { from: "2026-03-08", to: "2026-03-08", zone: "America/New_York" });
  assert.equal(result.total, 2); assert.equal(result.excludedUnknownDates, 1);
});

test("full catalog search/date/type before pagination, stable ties and categories", () => {
  const items = Array.from({ length: 35 }, (_, i) => fixture(`ordinary-${i}`, "images", "2026-11-19T00:00:00Z"));
  items.push({ ...fixture("needle", "pdfs", "2026-11-19T00:00:00Z"), description: "RésUmÉ" });
  assert.equal(queryArtifacts(items, { search: "résumé", type: "pdfs", from: "2026-11-19", to: "2026-11-19", limit: "2" }).total, 1);
  assert.equal(queryArtifacts(items, { search: "needle", page: "1" }).total, 1);
  assert.deepEqual(queryArtifacts(items, { page: "2", limit: "10" }).items.map((r) => r.id), queryArtifacts(items, { page: "2", limit: "10" }).items.map((r) => r.id));
  for (const kind of ["images", "videos", "audio", "pdfs", "other"] as const) assert.equal(queryArtifacts([fixture("x", kind)], { type: kind }).total, 1);
  assert.throws(() => queryArtifacts(items, { page: "0" }));
  assert.throws(() => queryArtifacts(items, { zone: "not-a-zone" }));
  assert.throws(() => queryArtifacts(items, { from: "2026-11-19" }));
});

test("multiple HTML pages attach to one site while useful documents remain separate", () => {
  const items = normalizeMinio("projects", ["demo/2026-11-20/site/index.html", "demo/2026-11-20/site/about.html", "demo/2026-11-20/site/style.css", "demo/2026-11-20/site/manual.pdf", "demo/2026-11-20/site/photos/cover.jpg"].map((key) => row(key)));
  assert.equal(items.length, 3);
  assert.ok(items[0].filenames.includes("about.html"));
  assert.equal(queryArtifacts(items, { search: "about.html" }).total, 1);
  assert.ok(items.some((item) => item.category === "pdfs"));
});

test("gallery variants inherit member provenance and retain all searchable metadata", () => {
  const rows = [row("aaaabbbbccccdddd/campaign"), row("aaaabbbbccccdddd/gallery.json"), row("eeeeffffaaaabbbb/campaign-a", "2026-11-19T12:00:00Z"), row("eeeeffffaaaabbbb/clip.mp4")];
  const member = { name: "campaign-a", label: "Cut A", notes: "Director notes", entry_url: "https://v.delo.sh/eeeeffffaaaabbbb/campaign-a", video_url: "https://v.delo.sh/eeeeffffaaaabbbb/clip.mp4" };
  const enrichment = { "aaaabbbbccccdddd/gallery.json": { manifest: { title: "Campaign 2026", description: "Gallery synopsis", items: [member] } }, "eeeeffffaaaabbbb/campaign-a": { title: "Member title", description: "Member synopsis", published: "2026-11-18T12:00:00Z" } };
  const items = normalizeR2(rows, enrichment);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, "2026-11-18T12:00:00.000Z");
  assert.equal(items[0].dateKind, "published");
  assert.ok(items[0].filenames.includes("clip.mp4"));
  for (const search of ["Campaign 2026", "Gallery synopsis", "Member title", "Member synopsis", "Director notes", "clip.mp4"]) assert.equal(queryArtifacts(items, { search }).total, 1, search);
  assert.equal((items[0].description ?? "").includes("Campaign 2026"), false, "gallery name has its own field");
  const malformed = normalizeR2(rows, { "aaaabbbbccccdddd/gallery.json": { manifest: JSON.parse('{"title":{"toString":null},"items":[{}]}') } });
  assert.ok(malformed.some((item) => item.id === "r2:eeeeffffaaaabbbb/campaign-a"));
});

test("IANA aliases and midnight transitions preserve local calendar days", () => {
  for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "America/Indiana/Indianapolis"]) assert.equal(queryArtifacts([], { zone }).total, 0);
  for (const zone of ["Bad/Zone", "x".repeat(81)]) assert.throws(() => queryArtifacts([], { zone }));
  assert.deepEqual(boundaries("2026-09-05", "2026-09-05", "America/Santiago").map((n) => new Date(n).toISOString()), ["2026-09-05T04:00:00.000Z", "2026-09-06T04:00:00.000Z"]);
  assert.deepEqual(boundaries("2026-09-06", "2026-09-06", "America/Santiago").map((n) => new Date(n).toISOString()), ["2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"]);
  const santiago = [fixture("last", "images", "2026-09-06T03:30:00Z"), fixture("next", "images", "2026-09-06T04:00:00Z")];
  assert.deepEqual(queryArtifacts(santiago, { from: "2026-09-05", to: "2026-09-05", zone: "America/Santiago" }).items.map((i) => i.id), ["last"]);
  assert.deepEqual(boundaries("2026-11-01", "2026-11-01", "America/Havana").map((n) => new Date(n).toISOString()), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  assert.deepEqual(boundaries("2011-12-30", "2011-12-30", "Pacific/Apia"), [Date.parse("2011-12-30T10:00:00Z"), Date.parse("2011-12-30T10:00:00Z")]);
});

test("recursive MinIO listing retains every object and isolates malformed optional HTML", async (t) => {
  const prior = globalThis.fetch;
  const fetched: string[] = [];
  t.after(() => { globalThis.fetch = prior; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("/report.html")) return new Response("<title>Report title</title><meta name='description' content='Report summary'>");
    if (url.endsWith("/broken.html")) throw Error("optional enrichment failed");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const keys = ["demo/day/a/report.html", "demo/day/b/broken.html", ...Array.from({ length: 1004 }, (_, i) => `demo/day/files/${i}.pdf`)];
  const lines = keys.map((key) => JSON.stringify({ type: "file", key, lastModified: "2026-11-20T12:00:00Z" })).join("\n");
  const result = await listMinio("projects", async (cmd, args) => {
    assert.equal(cmd, "mc"); assert.ok(args.includes("--recursive")); return lines;
  });
  assert.equal(result.length, 1006);
  assert.equal(result.find((item) => item.originalUrl.endsWith("/report.html"))?.title, "Report title");
  assert.equal(result.find((item) => item.originalUrl.endsWith("/report.html"))?.description, "Report summary");
  assert.ok(result.some((item) => item.originalUrl.endsWith("/broken.html")));
  assert.equal(fetched.length, 2);
  await assert.rejects(listMinio("projects", async () => `${lines}\n${JSON.stringify({ status: "error" })}`));
  await assert.rejects(listMinio("projects", async () => `${lines}\nnot-json`));
});

test("direct API denies anonymous requests and succeeds with fresh signed server request", async (t) => {
  const prior = process.env.TELEGRAM_HQ_BOT_TOKEN;
  process.env.TELEGRAM_HQ_BOT_TOKEN = "unit-test-only";
  t.after(() => { if (prior === undefined) delete process.env.TELEGRAM_HQ_BOT_TOKEN; else process.env.TELEGRAM_HQ_BOT_TOKEN = prior; });
  const app = Fastify();
  registerArtifactRoutes(app, createArtifactCatalog({ projects: async () => [fixture("private")], share: async () => [], r2: async () => [] }));
  const denied = await app.inject({ method: "GET", url: "/api/modules/artifacts/catalog" });
  assert.equal(denied.statusCode, 401);
  assert.doesNotMatch(denied.body, /private/);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", "unit-test-only").update(`artifacts:${timestamp}`).digest("hex");
  const ok = await app.inject({ method: "GET", url: "/api/modules/artifacts/catalog", headers: { "x-artifacts-timestamp": timestamp, "x-artifacts-signature": signature } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().total, 1);
  assert.equal(authorizeArtifacts(signature, String(Date.now() - 60000), "unit-test-only"), false);
  await app.close();
});

test("partial failure, stale snapshot and full failure remain explicit", async () => {
  let down = false;
  const catalog = createArtifactCatalog({ projects: async () => { if (down) throw Error("secret upstream"); return [fixture("cached")]; }, share: async () => { throw Error("unavailable"); }, r2: async () => [] }, 0);
  const first = await catalog(); assert.equal(first.sources.projects.ok, true); assert.equal(first.sources.share.ok, false);
  down = true;
  const second = await catalog(true); assert.equal(second.sources.projects.stale, true); assert.equal(second.items.length, 1);
  const full = await createArtifactCatalog({ projects: async () => { throw Error("x"); }, share: async () => { throw Error("x"); }, r2: async () => { throw Error("x"); } })();
  assert.equal(full.items.length, 0); assert.ok(Object.values(full.sources).every((s) => !s.ok));
});

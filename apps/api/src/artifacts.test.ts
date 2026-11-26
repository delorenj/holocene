import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { authorizeArtifacts, boundaries, createArtifactCatalog, decodeHtmlEntities, extractHtmlMetadata, listMinio, normalizeMinio, normalizeR2, queryArtifacts, queryDayGroups, registerArtifactRoutes, resolveTarget, safePublishedUrl } from "./artifacts.js";
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

test("legacy session folders preserve independent loose HTML pages regardless of listing order", () => {
  const keys = ["demo/session-uuid/zeta.html", "demo/session-uuid/alpha.html"];
  for (const ordered of [keys, [...keys].reverse()]) {
    const items = normalizeMinio("projects", ordered.map((key) => row(key)));
    assert.deepEqual(items.map((item) => item.id), ["projects:demo/session-uuid/alpha.html", "projects:demo/session-uuid/zeta.html"]);
    assert.deepEqual(items.map((item) => item.title), ["alpha.html", "zeta.html"]);
    for (const name of ["alpha.html", "zeta.html"]) {
      const [match] = queryArtifacts(items, { search: name }).items;
      assert.equal(queryArtifacts(items, { search: name }).total, 1);
      assert.equal(match.originalUrl, `https://s3.delo.sh/projects/demo/session-uuid/${name}`);
      assert.deepEqual(match.filenames, [name]);
    }
  }
});

test("legacy session folder with a root index is one site regardless of listing order", () => {
  const keys = ["demo/session-uuid/index.html", "demo/session-uuid/about.html", "demo/session-uuid/style.css", "demo/session-uuid/clip.mp4"];
  for (const ordered of [keys, [...keys].reverse()]) {
    const items = normalizeMinio("projects", ordered.map((key) => row(key)));
    const pages = items.filter((item) => /\.html$/.test(item.originalUrl));
    assert.equal(pages.length, 1, "no secondary HTML duplicates");
    assert.equal(pages[0].originalUrl, "https://s3.delo.sh/projects/demo/session-uuid/index.html");
    assert.equal(pages[0].title, "session uuid");
    assert.deepEqual([...pages[0].filenames].sort(), ["about.html", "clip.mp4", "index.html", "style.css"]);
    assert.equal(queryArtifacts(items, { search: "about.html" }).total, 1);
    assert.ok(items.some((item) => item.category === "videos" && item.originalUrl.endsWith("/clip.mp4")), "media original stays independent");
    assert.equal(items.length, 2);
  }
  const loose = normalizeMinio("projects", ["demo/session-uuid/zeta.html", "demo/session-uuid/alpha.html", "demo/session-uuid/style.css"].map((key) => row(key)));
  assert.deepEqual(loose.map((item) => item.title).sort(), ["alpha.html", "zeta.html"]);
});

test("HTML metadata decodes character references as inert text", () => {
  assert.equal(decodeHtmlEntities("Research &amp; Development"), "Research & Development");
  assert.equal(decodeHtmlEntities("Jarad&#39;s &#x27;plan&#x27; &quot;v2&quot; &mdash; caf&eacute; &#x1F680; &#128640; &#8217;"), "Jarad's 'plan' \"v2\" — café 🚀 🚀 ’");
  assert.equal(decodeHtmlEntities("&lt;script&gt;alert(1)&lt;/script&gt;"), "<script>alert(1)</script>");
  assert.equal(decodeHtmlEntities("&#150; &#0; &#xD800; &#x110000;"), "– \ufffd \ufffd \ufffd");
  assert.equal(decodeHtmlEntities("Q&A, AT&T, 5 & 6, &bogus; &amp"), "Q&A, AT&T, 5 & 6, &bogus; &");
  assert.equal(decodeHtmlEntities("Plain text with no references"), "Plain text with no references");
  assert.equal(decodeHtmlEntities("&amp;amp;"), "&amp;", "decodes once");
  assert.equal(decodeHtmlEntities("&Alpha; &NotEqual; &Bacute; &bogus;"), "Α ≠ &Bacute; &bogus;", "complete HTML5 names; invented names stay literal");
  assert.deepEqual(extractHtmlMetadata(`<title>&notit; &copy=x</title><meta name="description" content="&notit; &copy=x">`), { title: "¬it; ©=x", description: "&notit; &copy=x" }, "text vs attribute legacy-name context");
  assert.deepEqual(extractHtmlMetadata(`<title>
    Research &amp; Development </title><meta content="A &amp; B summary" name="description"><meta name="description" content="second">`), { title: "Research & Development", description: "A & B summary" });
  assert.deepEqual(extractHtmlMetadata(`<meta property="og:title" content="x"><meta data-x='a>b' NAME=Description content='It&#39;s "quoted"'>`), { title: undefined, description: "It's \"quoted\"" });
});

test("listMinio enrichment and search use decoded metadata for reordered attributes", async (t) => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  globalThis.fetch = (async () => new Response("<!doctype html><title>Research &amp; Development</title><meta content=\"A &amp; B summary &#8212; Jarad&#39;s caf&#xE9;\" name=\"description\">")) as typeof fetch;
  const items = await listMinio("projects", async () => JSON.stringify({ type: "file", key: "demo/2026-11-20/report/index.html", lastModified: "2026-11-20T12:00:00Z" }));
  assert.equal(items[0].title, "Research & Development");
  assert.equal(items[0].description, "A & B summary — Jarad's café");
  for (const search of ["Research & Development", "A & B summary", "Jarad's café"]) assert.equal(queryArtifacts(items, { search }).total, 1, search);
  assert.equal(queryArtifacts(items, { search: "&amp;" }).total, 0);
});

test("listMinio enrichment and search decode the complete HTML5 reference set", async (t) => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  const pages: Record<string, string> = {
    greek: `<title>Study of &Alpha; particles</title><meta content="&NotEqual; result" name="description">`,
    invalid: `<title>Invented &bogus; and &Bacute;</title><meta name='description' content='Literal &bogus;'>`,
    numeric: `<title>Research &#945; &amp; &#x3B2;</title><meta data-x="1" content="Decoded &#128640; &#x1F680; &#150; &quot;ok&quot; &rsquo;" name="description">`,
  };
  globalThis.fetch = (async (input: string | URL | Request) => new Response(pages[String(input).split("/").at(-2)!])) as typeof fetch;
  const lines = Object.keys(pages).map((name) => JSON.stringify({ type: "file", key: `demo/2026-11-20/${name}/index.html`, lastModified: "2026-11-20T12:00:00Z" })).join("\n");
  const items = await listMinio("projects", async () => lines);
  const by = (name: string) => items.find((item) => item.originalUrl.includes(`/${name}/`))!;
  assert.deepEqual([by("greek").title, by("greek").description], ["Study of Α particles", "≠ result"]);
  assert.deepEqual([by("invalid").title, by("invalid").description], ["Invented &bogus; and &Bacute;", "Literal &bogus;"]);
  assert.deepEqual([by("numeric").title, by("numeric").description], ["Research α & β", "Decoded 🚀 🚀 – \"ok\" ’"]);
  for (const [search, name] of [["Α particles", "greek"], ["≠ result", "greek"], ["&Bacute;", "invalid"], ["α & β", "numeric"], ["🚀", "numeric"]]) {
    const result = queryArtifacts(items, { search });
    assert.equal(result.total, 1, search);
    assert.ok(result.items[0].originalUrl.includes(`/${name}/`), search);
  }
  assert.equal(queryArtifacts(items, { search: "B\u0301" }).total, 0, "invalid name is not invented into an accent");
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

// ---- HOLOC-69: Collection → Day → Publication placement, day groups, day view, documents ----
test("dated folders give a published day, hubs are navigation only, bundles keep every file reachable", () => {
  const rows = [row("tolt/2026-11-25/report/index.html", "2026-11-26T04:30:00Z"), row("tolt/2026-11-25/report/style.css"), row("tolt/2026-11-25/report/chart.png"),
    row("tolt/2026-11-25/index-abcdef1234567890.html"), row("tolt/index-abcdef1234567890.html"), row("tolt/2026-11-24/notes/notes.md", "2026-11-24T15:00:00Z")];
  const items = normalizeMinio("projects", rows);
  assert.equal(items.length, 3, "hubs are not artifacts");
  const primary = items.find((i) => i.id === "projects:tolt/2026-11-25/report/index.html")!;
  assert.deepEqual([primary.collection, primary.day, primary.dayKind, primary.layout, primary.primary], ["tolt", "2026-11-25", "published", "dated", true]);
  assert.equal(primary.dateKind, "modified", "the instant stays a modified time");
  assert.equal(primary.hubUrl, "https://s3.delo.sh/projects/tolt/2026-11-25/index-abcdef1234567890.html");
  assert.equal(primary.baseUrl, "https://s3.delo.sh/projects/tolt/2026-11-25/report/");
  assert.deepEqual(primary.filenames, ["chart.png", "index.html", "style.css"]);
  const chart = items.find((i) => i.category === "images")!;
  assert.equal(chart.publication, primary.publication);
  assert.equal(chart.primary, false);
  assert.equal(items.find((i) => i.day === "2026-11-24")!.hubUrl, undefined);
});

test("legacy session and share placement use the America/New_York day of the modified time", () => {
  const [late] = normalizeMinio("projects", [row("james-brennan/3fbcf2a0/position/index.html", "2026-11-11T03:30:00Z")]);
  assert.deepEqual([late.collection, late.day, late.dayKind, late.layout], ["james-brennan", "2026-11-10", "modified", "session"]);
  const [next] = normalizeMinio("projects", [row("james-brennan/3fbcf2a0/position/index.html", "2026-11-11T05:00:00Z")]);
  assert.equal(next.day, "2026-11-11");
  const [undated] = normalizeMinio("projects", [{ key: "old/session/loose.txt" }]);
  assert.deepEqual([undated.day, undated.dayKind, undated.publication, undated.primary], [undefined, "unknown", "projects:old/session/loose.txt", true]);
  const [shared] = normalizeMinio("share", [row("abcdef0123456789abcdef01/deck/index.html")]);
  assert.deepEqual([shared.collection, shared.layout, shared.dayKind, shared.baseUrl], ["share", "share", "modified", "https://s3.delo.sh/share/abcdef0123456789abcdef01/deck/"]);
  const [video] = normalizeR2([row("ccccccccdddddddd/member", "2026-11-20T02:00:00Z"), row("ccccccccdddddddd/vid.mp4")], { "ccccccccdddddddd/member": { published: "2026-11-19T12:00:00Z" } });
  assert.deepEqual([video.collection, video.day, video.dayKind, video.layout, video.baseUrl], ["video", "2026-11-19", "published", "video", "https://v.delo.sh/ccccccccdddddddd/"]);
});

test("day groups reveal where search matches live; day view orders publications and links adjacent days", () => {
  const rows = [
    row("brennan/s1/position-a/index.html", "2026-11-10T22:00:00Z"), row("brennan/s1/position-b/index.html", "2026-11-10T14:00:00Z"),
    row("brennan/s2/teams/index.html", "2026-11-09T14:00:00Z"), row("brennan/s2/teams/fonts/a.woff2", "2026-11-09T14:00:00Z"),
    row("brennan/2026-11-12/brief/index.html", "2026-11-12T15:00:00Z"), row("brennan/2026-11-12/brief/photo.jpg", "2026-11-12T15:00:00Z"),
    row("other/2026-11-10/x/index.html", "2026-11-10T15:00:00Z"), { key: "brennan/s3/undated.txt" }];
  const items = normalizeMinio("projects", rows);
  const grouped = queryDayGroups(items, { search: "position" });
  assert.deepEqual(grouped.groups.map((g) => [g.collection, g.day, g.matched, g.count]), [["brennan", "2026-11-10", 2, 2]]);
  const all = queryDayGroups(items, { project: "brennan" });
  assert.deepEqual(all.groups.map((g) => g.day), ["2026-11-12", "2026-11-10", "2026-11-09", "undated"]);
  assert.deepEqual(all.groups[0].dayKinds, ["published"]);
  const day = queryArtifacts(items, { project: "brennan", day: "2026-11-10", limit: "1000" });
  assert.deepEqual(day.items.map((i) => i.title), ["position a", "position b"], "newest publication first");
  assert.deepEqual([day.navigation?.previous?.day, day.navigation?.next?.day], ["2026-11-09", "2026-11-12"]);
  const brief = queryArtifacts(items, { project: "brennan", day: "2026-11-12" });
  assert.deepEqual(brief.items.map((i) => i.primary), [true, false], "primary before its originals");
  assert.equal(queryArtifacts(items, { project: "brennan", day: "undated" }).navigation?.next?.day, "2026-11-09");
  const missing = queryArtifacts(items, { project: "brennan", day: "2026-11-11" });
  assert.deepEqual([missing.total, missing.navigation?.previous?.day, missing.navigation?.next?.day], [0, "2026-11-10", "2026-11-12"]);
  for (const bad of [{ day: "2026-11-10" }, { project: "brennan", day: "2026-02-30" }, { project: "", day: "2026-11-10" }, { group: "weeks" }]) assert.throws(() => queryArtifacts(items, bad));
  assert.equal(queryArtifacts(items, { search: "2026-11-12" }).total, 2, "search reaches the day");
  // Dated folders filter by their calendar day; session items by their instant in the request zone.
  assert.equal(queryArtifacts(items, { from: "2026-11-12", to: "2026-11-12", zone: "America/New_York" }).total, 2);
  assert.throws(() => queryArtifacts(items, { limit: "1000" }), "large pages only for one day");
});

test("document endpoint resolves only catalog targets, wraps HTML in CSP, refuses binaries and unsigned callers", async (t) => {
  const prior = process.env.TELEGRAM_HQ_BOT_TOKEN;
  process.env.TELEGRAM_HQ_BOT_TOKEN = "unit-test-only";
  t.after(() => { if (prior === undefined) delete process.env.TELEGRAM_HQ_BOT_TOKEN; else process.env.TELEGRAM_HQ_BOT_TOKEN = prior; });
  const items = normalizeMinio("projects", [row("demo/2026-11-20/site/index.html"), row("demo/2026-11-20/site/notes.md"), row("demo/2026-11-20/site/data.zip"), row("demo/2026-11-20/site/fonts/a.woff2")]);
  const fetched: Array<{ url: string; credentials?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push({ url, credentials: init?.credentials });
    if (url.endsWith(".zip")) return new Response("PK", { headers: { "content-type": "application/zip" } });
    if (url.endsWith(".md")) return new Response("# Notes\n<script>alert(1)</script>", { headers: { "content-type": "text/plain" } });
    return new Response("<!doctype html><title>Site</title><script>fetch('/api')</script>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const app = Fastify();
  registerArtifactRoutes(app, createArtifactCatalog({ projects: async () => items, share: async () => [], r2: async () => [] }), fetcher);
  const headers = () => { const timestamp = String(Date.now()); return { "x-artifacts-timestamp": timestamp, "x-artifacts-signature": createHmac("sha256", "unit-test-only").update(`artifacts:${timestamp}`).digest("hex") }; };
  const id = encodeURIComponent("projects:demo/2026-11-20/site/index.html");
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${id}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/artifacts/download?id=${id}` })).statusCode, 401);
  const html = await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${id}`, headers: headers() });
  assert.equal(html.statusCode, 200);
  const doc = html.json();
  assert.equal(doc.kind, "html");
  assert.match(doc.srcdoc, /^<!doctype html><base href="https:\/\/s3\.delo\.sh\/projects\/demo\/2026-11-20\/site\/" target="_blank"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*connect-src 'none'/);
  const md = (await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${id}&file=notes.md`, headers: headers() })).json();
  assert.equal(md.kind, "markdown");
  assert.doesNotMatch(md.srcdoc, /<script>alert/);
  assert.match(md.srcdoc, /script-src 'none'/);
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${id}&file=data.zip`, headers: headers() })).statusCode, 415);
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${id}&file=../../secret.html`, headers: headers() })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/modules/artifacts/document?id=${encodeURIComponent("projects:not/listed/x.html")}`, headers: headers() })).statusCode, 404);
  const download = await app.inject({ method: "GET", url: `/api/modules/artifacts/download?id=${id}&file=fonts/a.woff2`, headers: headers() });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers["content-disposition"]), /^attachment; filename="a\.woff2"/);
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.ok(fetched.every((f) => f.credentials === "omit" && f.url.startsWith("https://s3.delo.sh/projects/demo/2026-11-20/site/")));
  await app.close();
});

test("resolveTarget keeps downloads on the published hosts and R2 downloads take the video file", () => {
  const [video] = normalizeR2([row("ccccccccdddddddd/member"), row("ccccccccdddddddd/vid.mp4")]);
  assert.equal(resolveTarget(video, undefined, true)?.url, "https://v.delo.sh/ccccccccdddddddd/vid.mp4");
  assert.equal(resolveTarget(video, "vid.mp4")?.url, "https://v.delo.sh/ccccccccdddddddd/vid.mp4");
  assert.equal(resolveTarget(video, "other.mp4"), undefined);
  assert.equal(resolveTarget({ ...video, originalUrl: "https://evil.test/x" }), undefined);
});

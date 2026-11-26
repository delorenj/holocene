import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionLabel, dayKindLabel, dayLabel, deepLink, documentHref, downloadHref, fileUrl, mediaSource, neighbours, parseDeepLink, placeOf, publications, sandboxFor, sameView, thumbOf, viewerKind, type Item } from "./navigator-model";

const item = (over: Partial<Item> = {}): Item => ({ id: "projects:tolt/2026-11-25/report/index.html", source: "projects", project: "tolt", title: "report", filenames: ["chart.png", "fonts/Ünïcode font.woff2", "index.html"], category: "other",
  originalUrl: "https://s3.delo.sh/projects/tolt/2026-11-25/report/index.html", dateKind: "modified", collection: "tolt", day: "2026-11-25", dayKind: "published",
  layout: "dated", publication: "projects:tolt/2026-11-25/report", primary: true, baseUrl: "https://s3.delo.sh/projects/tolt/2026-11-25/report/", ...over });

test("deep links round-trip and reject malformed days", () => {
  const state = { project: "james-brennan", day: "2026-11-10", artifact: "projects:james-brennan/uuid/position/index.html", file: "fonts/a b.woff2" };
  const link = deepLink(state);
  assert.ok(link.startsWith("/artifacts?project=james-brennan&day=2026-11-10&artifact=projects%3Ajames-brennan%2Fuuid"));
  assert.deepEqual(parseDeepLink(link.slice("/artifacts".length)), state);
  assert.deepEqual(parseDeepLink("?project=x&day=undated"), { project: "x", day: "undated", artifact: undefined, file: undefined });
  for (const bad of ["?project=x&day=2026-02-30", "?project=x", "?day=2026-11-10", `?project=${"x".repeat(201)}&day=2026-11-10`, ""]) assert.equal(parseDeepLink(bad), undefined, bad);
  assert.equal(parseDeepLink("?project=x&day=2026-11-10&file=a.md")?.file, undefined, "a file needs its artifact");
  assert.deepEqual(placeOf(item({ day: undefined })), { project: "tolt", day: "undated", artifact: item().id });
  assert.ok(sameView(parseDeepLink(link.slice(10)), state));
});

test("bundle files resolve under the publication folder only", () => {
  assert.equal(fileUrl(item(), "fonts/Ünïcode font.woff2"), "https://s3.delo.sh/projects/tolt/2026-11-25/report/fonts/%C3%9Cn%C3%AFcode%20font.woff2");
  assert.equal(fileUrl(item(), "../../other/secret.html"), undefined);
  assert.equal(fileUrl(item({ baseUrl: undefined }), "chart.png"), undefined);
  assert.equal(documentHref(item(), "notes.md"), "/api/artifacts/document?id=projects%3Atolt%2F2026-11-25%2Freport%2Findex.html&file=notes.md");
  assert.equal(downloadHref(item()), "/api/artifacts/download?id=projects%3Atolt%2F2026-11-25%2Freport%2Findex.html");
});

test("viewer kinds: native media, PDF viewer, sandboxed documents, R2 video", () => {
  assert.equal(viewerKind(item()), "document");
  assert.equal(viewerKind(item(), "chart.png"), "image");
  assert.equal(viewerKind(item(), "fonts/Ünïcode font.woff2"), "none");
  assert.equal(viewerKind(item({ originalUrl: "https://s3.delo.sh/projects/x/d/a.pdf" })), "pdf");
  assert.equal(viewerKind(item({ originalUrl: "https://s3.delo.sh/projects/x/d/song.mp3" })), "audio");
  assert.equal(viewerKind(item({ originalUrl: "https://s3.delo.sh/projects/x/d/run.log" })), "document");
  const video = item({ id: "r2:abc/clip", source: "r2", filenames: ["clip", "clip.mp4"], originalUrl: "https://v.delo.sh/abc/clip", mediaUrl: "https://v.delo.sh/abc/clip.mp4", category: "videos", baseUrl: "https://v.delo.sh/abc/" });
  assert.equal(viewerKind(video), "video");
  assert.equal(mediaSource(video), "https://v.delo.sh/abc/clip.mp4");
  assert.equal(viewerKind(video, "clip"), "none");
  assert.equal(viewerKind({ ...video, mediaUrl: undefined }), "none");
});

test("sandbox never grants same-origin, top navigation or forms; scripts only for HTML", () => {
  for (const kind of ["html", "markdown", "text"]) {
    const tokens = sandboxFor(kind).split(" ");
    for (const banned of ["allow-same-origin", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-forms", "allow-modals", "allow-downloads"]) assert.ok(!tokens.includes(banned), `${kind} ${banned}`);
    assert.equal(tokens.includes("allow-scripts"), kind === "html");
  }
});

test("neighbours and publication grouping follow the API's day order", () => {
  const items = [item(), item({ id: "b", primary: false, title: "chart.png" }), item({ id: "c", publication: "p2", title: "other" })];
  assert.deepEqual([neighbours(items, "b").previous?.id, neighbours(items, "b").next?.id], [item().id, "c"]);
  assert.equal(neighbours(items, item().id).previous, undefined);
  assert.equal(neighbours(items, "c").next, undefined);
  assert.equal(neighbours(items, "missing").index, -1);
  assert.deepEqual(publications(items).map((p) => [p.title, p.items.length]), [["report", 2], ["other", 1]]);
});

test("labels say where a day came from and never call a modified time published", () => {
  assert.equal(dayLabel("2026-11-24"), "Tue, Nov 24, 2026");
  assert.equal(dayLabel("undated"), "Undated");
  assert.equal(dayKindLabel(["published"]), "published day");
  assert.equal(dayKindLabel(["modified"]), "day of last modification");
  assert.equal(dayKindLabel(["published", "modified"]), "published and modified days");
  assert.equal(dayKindLabel(["unknown"]), "date unknown");
  assert.equal(collectionLabel("video"), "video (R2)");
  assert.deepEqual(thumbOf(item()), { glyph: "HTML" });
  assert.deepEqual(thumbOf(item({ category: "images", mediaUrl: "https://s3.delo.sh/x.png" })), { src: "https://s3.delo.sh/x.png", glyph: "IMG" });
});

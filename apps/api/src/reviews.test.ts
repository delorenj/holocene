import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { normalizeMinio, type Artifact } from "./artifacts.js";
import { parseProjectSegment, resolveProject, lookupProject } from "./project-identity.js";
import { ReviewStore } from "./review-store.js";
import { AWAITING_CONTRACT, captureRevision, feedbackRecipient, freezeFeedback, homePayload, manifestHash, parseNewAnnotation, registerReviewRoutes, reviewSignature, revisionDocument, verifyReviewRequest } from "./reviews.js";

const registry = { projects: { greeninbetween: { project_id: "greeninbetween", project_name: "Green In Between", repo_path: "/home/x/code/green-in-between", agents: { "green-in-between-pm": { role: "pm" }, helper: { role: "dev" } } }, holocene: { repo_path: "/h" } } };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("identity: one canonical segment, named failures, no aliases, duplicates conflict", async () => {
  assert.deepEqual(parseProjectSegment("greeninbetween"), { id: "greeninbetween" });
  assert.ok("error" in parseProjectSegment("Green%20In"));
  assert.ok("error" in parseProjectSegment("GreenInBetween"));
  assert.ok("error" in parseProjectSegment("greeninbetween%252F"));
  assert.ok("error" in parseProjectSegment("%E0%A4%A"));
  assert.ok("error" in parseProjectSegment(".."));
  assert.equal(resolveProject("greeninbetween", registry).status, 200);
  assert.equal(resolveProject("green-in-between", registry).status, 404);
  assert.equal(resolveProject("pool", registry).status, 404);
  assert.equal(resolveProject("Green%20In", registry).status, 400);
  assert.equal(resolveProject("holocene", registry).status, 200);
  const dup = { projects: { a: { project_id: "gib", repo_path: "/a" }, b: { project_id: "GIB", repo_path: "/b" } } };
  assert.equal(resolveProject("gib", dup).status, 409);
  assert.equal(resolveProject("gib", { nope: 1 }).status, 503);
  assert.equal((await lookupProject("gib", async () => { throw Error("down"); })).status, 503);
  assert.equal((await lookupProject("Bad Id", async () => { throw Error("never read"); })).status, 400);
});

test("review publications stay out of the gallery; ordinary publications are untouched", () => {
  const rows = [{ key: "gib/2026-11-26/review-0123456789abcdef/index.html" }, { key: "gib/2026-11-26/walk/index.html" }, { key: "gib/2026-11-26/review-notes/index.html" }];
  assert.deepEqual(normalizeMinio("projects", rows).map((a) => a.title).sort(), ["review notes", "walk"]);
});

const item = (over: Partial<Artifact> = {}): Artifact => ({ id: "projects:gib/2026-11-19/walk/index.html", source: "projects", project: "gib", collection: "gib", title: "walk", filenames: ["index.html", "img/a.png"], category: "other",
  originalUrl: "https://s3.delo.sh/projects/gib/2026-11-19/walk/index.html", baseUrl: "https://s3.delo.sh/projects/gib/2026-11-19/walk/", date: "2026-11-19T12:00:00.000Z", dateKind: "modified", primary: true, day: "2026-11-19", ...over });
function origin(files: Record<string, string>) {
  return (async (url: string | URL | Request) => {
    const body = files[String(url)];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

test("capture copies exact bytes into a hash-addressed snapshot; identical bytes are one revision; tampering is refused", async () => {
  const store = new ReviewStore(":memory:");
  const files: Record<string, string> = { "https://s3.delo.sh/projects/gib/2026-11-19/walk/index.html": "<!doctype html><h1>v1</h1>", "https://s3.delo.sh/projects/gib/2026-11-19/walk/img/a.png": "PNG" };
  const published: string[] = [];
  const publish = async (_dir: string, project: string, name: string, entry: string) => { published.push(name); return `https://s3.delo.sh/projects/${project}/2026-11-26/${name}/${entry}`; };
  const first = await captureRevision(store, "gib", item(), "op@example.com", origin(files), publish);
  assert.equal(first.status, 201);
  assert.ok("revision" in first);
  const rev = first.revision;
  assert.equal(rev.revisionId, manifestHash([{ path: "img/a.png", sha256: sha("PNG"), size: 3 }, { path: "index.html", sha256: sha(files["https://s3.delo.sh/projects/gib/2026-11-19/walk/index.html"]), size: 26 }]));
  assert.equal(rev.snapshotUrl, `https://s3.delo.sh/projects/gib/2026-11-26/review-${rev.revisionId.slice(0, 16)}/index.html`);
  const again = await captureRevision(store, "gib", item(), "op@example.com", origin(files), publish);
  assert.equal(again.status, 200);
  assert.equal(published.length, 1, "identical bytes never republish");
  // The original is overwritten: a new capture is a new revision, the old one is unchanged.
  files["https://s3.delo.sh/projects/gib/2026-11-19/walk/index.html"] = "<!doctype html><h1>v2</h1>";
  const second = await captureRevision(store, "gib", item(), "op@example.com", origin(files), publish);
  assert.ok("revision" in second && second.revision.revisionId !== rev.revisionId);
  assert.equal(store.revision(rev.revisionId)!.entrySha256, sha("<!doctype html><h1>v1</h1>"));
  // Rendering verifies the snapshot bytes.
  const good = await revisionDocument(rev, origin({ [rev.snapshotUrl]: "<!doctype html><h1>v1</h1>" }));
  assert.equal(good.status, 200);
  assert.match((good.body as { srcdoc: string }).srcdoc, /^<!doctype html><base href="https:\/\/s3\.delo\.sh\/projects\/gib\/2026-11-26\/review-/);
  assert.equal((await revisionDocument(rev, origin({ [rev.snapshotUrl]: "<h1>evil</h1>" }))).status, 409);
  // Refusals.
  assert.equal((await captureRevision(store, "other", item(), "u@x.y", origin(files), publish)).status, 404);
  assert.equal((await captureRevision(store, "gib", item({ originalUrl: "https://s3.delo.sh/projects/gib/2026-11-19/walk/a.png" }), "u@x.y", origin(files), publish)).status, 400);
  assert.equal((await captureRevision(store, "gib", item(), "u@x.y", origin({}), publish)).status, 502);
  assert.equal((await captureRevision(store, "gib", item({ filenames: ["index.html", "x"] }), "u@x.y", origin({ ...files, "https://s3.delo.sh/projects/gib/2026-11-19/walk/x": "1" }), async () => "https://evil.test/x")).status, 502);
  assert.equal((await captureRevision(store, "gib", item({ filenames: ["index.html", "../x"] }), "u@x.y", origin(files), publish)).status, 400);
  // A byte-identical copy published as a different walkthrough is refused loudly, never handed the other walkthrough's revision.
  const twinFiles = { "https://s3.delo.sh/projects/gib/2026-11-20/twin/index.html": files["https://s3.delo.sh/projects/gib/2026-11-19/walk/index.html"], "https://s3.delo.sh/projects/gib/2026-11-20/twin/img/a.png": "PNG" };
  const twin = item({ id: "projects:gib/2026-11-20/twin/index.html", originalUrl: "https://s3.delo.sh/projects/gib/2026-11-20/twin/index.html", baseUrl: "https://s3.delo.sh/projects/gib/2026-11-20/twin/" });
  assert.equal((await captureRevision(store, "gib", twin, "u@x.y", origin(twinFiles), publish)).status, 409);
});

test("home: walkthroughs from the project's collection, latest vs reviewed, unattributed counted not assigned", () => {
  const store = new ReviewStore(":memory:");
  const rev = { revisionId: "a".repeat(64), projectId: "gib", artifactId: item().id, title: "walk", entry: "index.html", sourceUrl: item().originalUrl, sourceModified: "2026-11-19T12:00:00.000Z", snapshotBaseUrl: "s/", snapshotUrl: "s/index.html", entrySha256: "b".repeat(64), manifest: [], createdAt: "2026-11-26T00:00:00Z", createdBy: "op@example.com" };
  store.putRevision(rev);
  const sources = { projects: { ok: true, stale: false, fetchedAt: "t" }, share: { ok: true, stale: false }, r2: { ok: false, stale: true } };
  const items = [item({ date: "2026-11-25T00:00:00.000Z" }), item({ id: "projects:gib/2026-11-19/walk/img/a.png", primary: false, originalUrl: "https://s3.delo.sh/projects/gib/2026-11-19/walk/img/a.png", category: "images" }), item({ id: "share:x", source: "share", collection: "share", project: undefined }), item({ id: "r2:y", source: "r2", collection: "video", project: undefined }), item({ id: "projects:other/z/index.html", collection: "other", project: "other" })];
  const home = homePayload({ id: "gib", name: "GIB", repoPath: "/r", pmAgents: [] }, { items, sources, retryAfterMs: 0 }, store.revisions("gib"));
  assert.deepEqual(home.walkthroughs.map((w) => w.id), [item().id]);
  assert.equal(home.otherArtifacts, 1);
  assert.deepEqual(home.unattributed, { share: 1, video: 1 });
  assert.equal(home.revisions[0].latest.state, "republished");
  assert.equal(home.complete, false);
  assert.equal(homePayload({ id: "gib", name: "GIB", repoPath: "/r", pmAgents: [] }, { items: [], sources, retryAfterMs: 0 }, store.revisions("gib")).revisions[0].latest.state, "missing");
});

test("annotations and drafts survive a store restart; anchors never change; stale versions and other authors are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviews-test-"));
  try {
    const path = join(dir, "reviews.sqlite3");
    let store = new ReviewStore(path);
    store.putRevision({ revisionId: "c".repeat(64), projectId: "gib", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "s/index.html", entrySha256: "d".repeat(64), manifest: [{ path: "index.html", sha256: "d".repeat(64), size: 1 }], createdAt: "now", createdBy: "op@example.com" });
    const anchor = { type: "text", quote: "Pass and play", prefix: "Start ", suffix: " mode" };
    const saved = store.createAnnotation({ id: "11111111-1111-4111-8111-111111111111", revisionId: "c".repeat(64), author: "op@example.com", status: "saved", kind: "text", anchor, comment: "Typo" });
    const draft = store.createAnnotation({ revisionId: "c".repeat(64), author: "op@example.com", status: "draft", kind: "element", anchor: { type: "element", path: "main>img" }, comment: "half" });
    assert.equal(store.createAnnotation({ id: saved.id, revisionId: "c".repeat(64), author: "op@example.com", status: "saved", kind: "text", anchor, comment: "Typo" }).version, 1, "a retried create is the same row");
    store.close();
    store = new ReviewStore(path);
    const back = store.annotations("c".repeat(64));
    const rows = back.map((a) => [a.id, a.status, a.author, a.projectId, a.artifactId].join("|")).sort();
    assert.deepEqual(rows, [[saved.id, "saved", "op@example.com", "gib", "a"].join("|"), [draft.id, "draft", "op@example.com", "gib", "a"].join("|")].sort());
    assert.deepEqual(back.find((a) => a.id === saved.id)!.anchor, anchor);
    assert.equal(store.updateAnnotation(saved.id, "else@example.com", 1, { comment: "x" }), "forbidden");
    const updated = store.updateAnnotation(saved.id, "op@example.com", 1, { comment: "Typo here" });
    assert.ok(typeof updated === "object" && updated.version === 2);
    assert.equal(store.updateAnnotation(saved.id, "op@example.com", 1, { comment: "stale" }), "conflict");
    assert.equal(store.deleteAnnotation(saved.id, "op@example.com", 1), "conflict");
    assert.equal(store.deleteAnnotation(saved.id, "op@example.com", 2), "deleted");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("annotation bodies are validated and capped", () => {
  assert.ok(parseNewAnnotation({ status: "draft", kind: "text", anchor: { q: 1 }, comment: "" }));
  assert.equal(parseNewAnnotation({ status: "saved", kind: "text", anchor: { q: 1 }, comment: "  " }), undefined);
  assert.equal(parseNewAnnotation({ status: "sent", kind: "text", anchor: {}, comment: "x" }), undefined);
  assert.equal(parseNewAnnotation({ status: "saved", kind: "text", anchor: "str", comment: "x" }), undefined);
  assert.equal(parseNewAnnotation({ status: "saved", kind: "text", anchor: { big: "x".repeat(40000) }, comment: "x" }), undefined);
  assert.equal(parseNewAnnotation({ id: "not-a-uuid", status: "saved", kind: "text", anchor: {}, comment: "x" }), undefined);
});

test("signature binds method, path, body, author and time; the catalog read signature does not pass", () => {
  const ts = String(Date.now());
  const sig = reviewSignature("s3cret", "POST", "/api/modules/projects/gib/revisions", "{\"a\":1}", "op@example.com", ts);
  const h = { "x-review-signature": sig, "x-review-timestamp": ts, "x-review-user": "op@example.com" };
  assert.equal(verifyReviewRequest(h, "POST", "/api/modules/projects/gib/revisions", "{\"a\":1}", "s3cret"), "op@example.com");
  assert.equal(verifyReviewRequest(h, "POST", "/api/modules/projects/gib/revisions", "{\"a\":2}", "s3cret"), undefined);
  assert.equal(verifyReviewRequest(h, "PATCH", "/api/modules/projects/gib/revisions", "{\"a\":1}", "s3cret"), undefined);
  assert.equal(verifyReviewRequest(h, "POST", "/api/modules/projects/other/revisions", "{\"a\":1}", "s3cret"), undefined);
  assert.equal(verifyReviewRequest({ ...h, "x-review-user": "eve@example.com" }, "POST", "/api/modules/projects/gib/revisions", "{\"a\":1}", "s3cret"), undefined);
  assert.equal(verifyReviewRequest(h, "POST", "/api/modules/projects/gib/revisions", "{\"a\":1}", "s3cret", Date.now() + 60000), undefined);
  assert.equal(verifyReviewRequest(h, "POST", "/api/modules/projects/gib/revisions", "{\"a\":1}", undefined), undefined);
});

test("routes: unsigned refused, author from the signed header, annotation lifecycle over HTTP", async (t) => {
  const store = new ReviewStore(":memory:");
  store.putRevision({ revisionId: "e".repeat(64), projectId: "greeninbetween", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "https://s3.delo.sh/s/index.html", entrySha256: sha("<p>ok</p>"), manifest: [], createdAt: "now", createdBy: "op@example.com" });
  const app = Fastify();
  t.after(() => app.close());
  const catalog = async () => ({ items: [], sources: { projects: { ok: true, stale: false } }, retryAfterMs: 0 });
  await registerReviewRoutes(app, catalog, { store, registry: async () => registry, secret: () => "k", fetcher: origin({ "https://s3.delo.sh/s/index.html": "<p>ok</p>" }) });
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, user = "Op@Example.com") => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Date.now());
    return app.inject({ method, url, payload: payload || undefined, headers: { ...(payload ? { "content-type": "application/json" } : {}), "x-review-user": user, "x-review-timestamp": ts, "x-review-signature": reviewSignature("k", method, url, payload, user, ts) } });
  };
  assert.equal((await app.inject({ method: "GET", url: "/api/modules/projects/greeninbetween/home" })).statusCode, 401);
  assert.equal((await call("GET", "/api/modules/projects/greeninbetween/home")).statusCode, 200);
  assert.equal((await call("GET", "/api/modules/projects/green-in-between/home")).statusCode, 404);
  assert.equal((await call("GET", "/api/modules/projects/Green%20In/home")).statusCode, 400);
  const base = `/api/modules/projects/greeninbetween/revisions/${"e".repeat(64)}`;
  assert.equal((await call("GET", `/api/modules/projects/holocene/revisions/${"e".repeat(64)}`)).statusCode, 404, "a revision belongs to one project");
  assert.equal((await call("GET", `${base}/document`)).statusCode, 200);
  const created = await call("POST", `${base}/annotations`, { status: "saved", kind: "text", anchor: { quote: "ok" }, comment: "Nice", author: "spoof@example.com" });
  assert.equal(created.statusCode, 201);
  const ann = created.json().annotation;
  assert.equal(ann.author, "op@example.com", "author comes from the signed header, never the body");
  assert.equal((await call("PATCH", `${base}/annotations/${ann.id}`, { version: 1, comment: "x" }, "eve@example.com")).statusCode, 403);
  assert.equal((await call("PATCH", `${base}/annotations/${ann.id}`, { version: 1, comment: "Nicer" })).json().annotation.version, 2);
  assert.equal((await call("PATCH", `${base}/annotations/${ann.id}`, { version: 1, comment: "stale" })).statusCode, 409);
  assert.equal((await call("GET", base)).json().annotations.length, 1);
  assert.equal((await call("DELETE", `${base}/annotations/${ann.id}?version=2`)).statusCode, 204);
  // A tampered body under a valid header set is refused.
  const ts = String(Date.now());
  const url = `${base}/annotations`;
  const res = await app.inject({ method: "POST", url, payload: JSON.stringify({ status: "saved", kind: "text", anchor: {}, comment: "evil" }), headers: { "content-type": "application/json", "x-review-user": "op@example.com", "x-review-timestamp": ts, "x-review-signature": reviewSignature("k", "POST", url, "{}", "op@example.com", ts) } });
  assert.equal(res.statusCode, 401);
});

test("the API verifies the same fixed signature vector the web proxy signs (apps/web review-proxy.test.ts)", () => {
  assert.equal(reviewSignature("s3cret", "PATCH", "/api/modules/projects/greeninbetween/revisions/abc/annotations/x?v=1", "{\"version\":1}", "op@example.com", "1795740000000"),
    "4859de2fd5d89e4d2f31ee49e50d66be64fe866a4b5d38bc82fc1301addb14d4");
});

test("capture accepts the publisher's strict percent-encoding of an entry name with !'()*", async () => {
  const store = new ReviewStore(":memory:");
  const base = "https://s3.delo.sh/projects/gib/2026-11-19/walk/";
  const files = { [`${base}it%27s%20%28v1%29%21.html`]: "<!doctype html><p>x</p>" };
  const publish = async (_dir: string, project: string, name: string) => `https://s3.delo.sh/projects/${project}/2026-11-26/${name}/it%27s%20%28v1%29%21.html`;
  const res = await captureRevision(store, "gib", item({ filenames: ["it's (v1)!.html"], originalUrl: `${base}it's%20(v1)!.html`, baseUrl: base }), "op@example.com", origin(files), publish);
  assert.equal(res.status, 201);
});

test("feedback: one PM recipient or a refusal; only saved annotations freeze; the digest binds the content", () => {
  assert.deepEqual(feedbackRecipient({ id: "gib", pmAgents: ["gib-pm"] }), { recipient: "gib-pm" });
  assert.ok("error" in feedbackRecipient({ id: "gib", pmAgents: [] }));
  assert.ok("error" in feedbackRecipient({ id: "gib", pmAgents: ["a", "b"] }));
  assert.deepEqual(resolveProject("greeninbetween", registry).status === 200 && (resolveProject("greeninbetween", registry) as { project: { pmAgents: string[] } }).project.pmAgents, ["green-in-between-pm"]);
  const a = (id: string, status: "draft" | "saved", version = 1) => ({ id, revisionId: "r", projectId: "gib", artifactId: "a", author: "op@example.com", status, kind: "text" as const, anchor: { quote: id }, comment: `c-${id}`, createdAt: "t", updatedAt: "t", version });
  const one = freezeFeedback([a("1", "saved"), a("2", "draft")], "");
  assert.deepEqual(one.annotations.map((x) => x.id), ["1"]);
  assert.notEqual(one.digest, freezeFeedback([a("1", "saved", 2)], "").digest, "an edited annotation is different content");
  assert.notEqual(one.digest, freezeFeedback([a("1", "saved")], "note").digest);
});

test("feedback over HTTP: frozen, idempotent, durable across restart, refused without saved annotations; nothing published", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "holoc-feedback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "reviews.sqlite3");
  const rev = "f".repeat(64);
  const boot = async () => {
    const store = new ReviewStore(file);
    if (!store.revision(rev)) store.putRevision({ revisionId: rev, projectId: "greeninbetween", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "https://s3.delo.sh/s/index.html", entrySha256: sha("<p>ok</p>"), manifest: [], createdAt: "now", createdBy: "op@example.com" });
    const app = Fastify();
    await registerReviewRoutes(app, async () => ({ items: [], sources: {}, retryAfterMs: 0 }), { store, registry: async () => registry, secret: () => "k", fetcher: origin({}) });
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, user = "op@example.com") => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      const ts = String(Date.now());
      return app.inject({ method, url, payload: payload || undefined, headers: { ...(payload ? { "content-type": "application/json" } : {}), "x-review-user": user, "x-review-timestamp": ts, "x-review-signature": reviewSignature("k", method, url, payload, user, ts) } });
    };
    return { app, call };
  };
  const base = `/api/modules/projects/greeninbetween/revisions/${rev}`;
  const first = await boot();
  const id = "0b8e7f52-6a0c-4d0e-9f7e-3a1b2c4d5e6f";
  assert.equal((await first.call("POST", `${base}/feedback`, { submissionId: id })).statusCode, 400, "no saved annotation, nothing to send");
  const ann = (await first.call("POST", `${base}/annotations`, { status: "saved", kind: "text", anchor: { quote: "ok" }, comment: "Fix this" })).json().annotation;
  await first.call("POST", `${base}/annotations`, { status: "draft", kind: "text", anchor: { quote: "d" }, comment: "unsent draft" });
  assert.equal((await first.call("POST", `${base}/feedback`, { submissionId: "nope" })).statusCode, 400);
  const sent = await first.call("POST", `${base}/feedback`, { submissionId: id, note: " Please look " });
  assert.equal(sent.statusCode, 201);
  const sub = sent.json().submission;
  assert.equal(sub.recipient, "green-in-between-pm");
  assert.equal(sub.state, "saved");
  assert.equal(sub.stateDetail, AWAITING_CONTRACT);
  assert.equal(sub.note, "Please look");
  assert.deepEqual(sub.annotations.map((x: { comment: string }) => x.comment), ["Fix this"], "drafts never ship");
  const again = await first.call("POST", `${base}/feedback`, { submissionId: id, note: "Please look" });
  assert.equal(again.statusCode, 200, "a double click returns the same submission");
  assert.equal(again.json().submission.correlationId, sub.correlationId, "a retry reuses the frozen identity");
  assert.equal((await first.call("POST", `${base}/feedback`, { submissionId: id, note: "other" })).statusCode, 409);
  assert.equal((await first.call("POST", `${base}/feedback`, { submissionId: id, note: "Please look" }, "eve@example.com")).statusCode, 409);
  // Later edits and deletes never change what was sent.
  await first.call("PATCH", `${base}/annotations/${ann.id}`, { version: 1, comment: "changed later" });
  await first.call("DELETE", `${base}/annotations/${ann.id}?version=2`);
  await first.app.close();
  const second = await boot();
  t.after(() => second.app.close());
  const list = (await second.call("GET", `${base}/feedback`)).json().submissions;
  assert.equal(list.length, 1);
  assert.equal(list[0].annotations[0].comment, "Fix this");
  assert.equal(list[0].correlationId, sub.correlationId);
  assert.equal(list[0].digest, sub.digest);
});

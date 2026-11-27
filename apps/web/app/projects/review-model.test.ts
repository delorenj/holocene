import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorLabel, galleryLink, identityMessage, latestLabel, projectHref, reviewHref, saveOutcome } from "./review-model";

test("the home URL is one canonical segment encoded once", () => {
  assert.equal(projectHref("greeninbetween"), "/projects/greeninbetween");
  assert.equal(projectHref("a/b"), "/projects/a%2Fb");
  assert.equal(reviewHref("greeninbetween", "f".repeat(64)), `/projects/greeninbetween/review/${"f".repeat(64)}`);
});

test("identity failures are named, never guessed", () => {
  assert.match(identityMessage(404, "green-in-between"), /not aliases/);
  assert.match(identityMessage(409, "gib"), /conflicting/);
  assert.match(identityMessage(503, "gib"), /unavailable/);
  assert.match(identityMessage(400, "X", "Malformed project id: \"X\""), /^Malformed/);
});

test("latest vs reviewed labels and gallery deep links", () => {
  assert.equal(latestLabel({ latest: { state: "republished" } }), "Published again since this review");
  assert.equal(latestLabel({ latest: { state: "current" } }), "Matches the latest publication");
  assert.equal(galleryLink({ id: "projects:g/2026-11-19/w/index.html", title: "w", originalUrl: "u", files: 1, collection: "g", day: "2026-11-19" }), "/artifacts?project=g&day=2026-11-19&artifact=projects%3Ag%2F2026-11-19%2Fw%2Findex.html");
});

test("a failed save stays visible as failed; only 2xx is saved", () => {
  assert.deepEqual(saveOutcome(201, {}), { state: "saved" });
  assert.equal(saveOutcome(500, {}).state, "failed");
  assert.equal(saveOutcome(0, {}).error, "Network error");
  assert.equal(saveOutcome(409, { error: "changed" }).state, "conflict");
});

test("anchor labels quote text or name the element", () => {
  assert.equal(anchorLabel({ originalText: "Pass and play" }), "“Pass and play”");
  assert.equal(anchorLabel({ tagName: "img" }), "Element img");
  assert.equal(anchorLabel({}), "Pinned element");
  assert.ok(anchorLabel({ quote: "x".repeat(200) }).length < 130);
});

test("bridge messages are shape-checked and bounded", async () => {
  const { readBridge } = await import("./review-model");
  assert.equal(readBridge({ type: "other-ready" }), undefined);
  assert.equal(readBridge("plannotator-bridge-ready"), undefined);
  assert.deepEqual(readBridge({ type: "plannotator-bridge-ready", protocolVersion: 2 }), { type: "ready", protocolVersion: 2 });
  const sel = readBridge({ type: "plannotator-bridge-selection", text: "x".repeat(20000), pinpoint: true, anchor: { selector: "h1" }, context: [] });
  assert.equal(sel?.type === "selection" && sel.text.length, 10000);
  assert.equal(sel?.type === "selection" && sel.context, undefined);
  assert.equal(readBridge({ type: "plannotator-bridge-mark-click", id: "" }), undefined);
  assert.deepEqual(readBridge({ type: "plannotator-bridge-unanchored", ids: ["a", 3, "b"] }), { type: "unanchored", ids: ["a", "b"] });
  assert.equal(readBridge({ type: "plannotator-bridge-resize", height: Infinity }), undefined);
});

test("restore batch numbers saved annotations and re-finds every anchor", async () => {
  const { restoreMessages, numbering } = await import("./review-model");
  const a = (id: string, status: "draft" | "saved", createdAt: string, anchor: Record<string, unknown>) => ({ id, revisionId: "r", author: "j@x.io", status, kind: "text" as const, anchor, comment: "c", createdAt, updatedAt: createdAt, version: 1 });
  const list = [a("b", "saved", "2026-11-26T02:00:00Z", { originalText: "two" }), a("d", "draft", "2026-11-26T01:30:00Z", { originalText: "draft" }), a("a", "saved", "2026-11-26T01:00:00Z", { originalText: "one", htmlAnchor: { selector: "p" } })];
  assert.deepEqual([...numbering(list)], [["a", 1], ["b", 2]]);
  const msgs = restoreMessages(list);
  assert.equal(msgs[0].type, "plannotator-bridge-clear-marks");
  assert.deepEqual(msgs[1].annotations, [{ id: "a", number: 1 }, { id: "b", number: 2 }]);
  assert.equal(msgs.filter((m) => m.type === "plannotator-bridge-find-and-mark").length, 3);
  assert.deepEqual(msgs.find((m) => m.id === "a")?.anchor, { selector: "p" });
  assert.equal(msgs.at(-1)?.type, "plannotator-bridge-report-unanchored");
});

test("the bridge lands after the CSP and referrer metas", async () => {
  const { injectBridge } = await import("./review-model");
  const doc = `<!doctype html><base href="x"><meta http-equiv="Content-Security-Policy" content="y"><meta name="referrer" content="no-referrer"><p>page</p>`;
  const out = injectBridge(doc, "CSS", "JS");
  assert.ok(out.indexOf("Content-Security-Policy") < out.indexOf("<script data-holocene-review>JS</script>"));
  assert.ok(out.indexOf("JS</script>") < out.indexOf("<p>page</p>"));
});

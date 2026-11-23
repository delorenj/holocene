import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProduct, launchEvidence, publication } from "./products-model.js";

const receipt = (url = "https://s3.delo.sh/projects/example/2026-11-20/launch-dashboard/index.html") => ({ schema: "launch-dashboard/1", published: { url, at: "2026-11-20T21:48:41Z" }, private: "op://never/serialize" });
test("explicit committed lifecycle only; malformed and absent modes never imply steady", () => {
  assert.deepEqual(classifyProduct("mode: launch"), { stage: "launch" });
  assert.deepEqual(classifyProduct("mode: steady"), { steady: true });
  for (const raw of ["", "mode: unknown", "mode: LIVE", "[]", "mode: ["]) assert.ok(classifyProduct(raw).issue);
  assert.equal(classifyProduct("mode: live").stage, "live");
  assert.ok(classifyProduct("mode: live").issue);
});
test("launch evidence counts only known gates and never equates publication with gate observation", () => {
  const now = Date.parse("2026-11-22T23:00:00Z");
  const sample = { ...receipt(), items: [{ id: "action", status: "open", verified_at: "2026-11-22T20:00:00Z" }], requirements: { x: { status: "owner", item: "action", verified_at: "2026-11-22T20:00:00Z" } }, private: "op://secret" };
  const current = launchEvidence(sample, now);
  assert.equal(current.state, "attention"); assert.equal(current.openActions, 1); assert.equal(current.ownerBlockers, 1);
  assert.equal(current.observedAt, "2026-11-22T20:00:00.000Z"); assert.ok(!JSON.stringify(current).includes("op://"));
  assert.equal(launchEvidence({ ...sample, items: [{ id: "action", status: "open", verified_at: null }] }, now).state, "unknown");
  assert.equal(launchEvidence({ ...sample, items: [{ id: "action", status: "open", verified_at: "2026-11-01T00:00:00Z" }] }, now).state, "stale");
  assert.equal(launchEvidence(receipt(), now).state, "unknown");
  assert.equal(launchEvidence(undefined, now).openActions, undefined);
  assert.equal(launchEvidence({ ...sample, items: [{ status: "unrecognized" }] }, now).state, "unknown");
});
test("receipt resolves only allowlisted HTTPS publications, omits extra fields", () => {
  assert.deepEqual(publication(receipt()), { href: receipt().published.url, label: "Open launch dashboard", publishedAt: "2026-11-20T21:48:41.000Z" });
  for (const url of ["javascript:alert(1)", "http://s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh.evil.test/projects/x/launch-dashboard/index.html", "https://user:password@s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh:443/projects/x/launch-dashboard/index.html?token=secret", "https://s3.delo.sh/projects/x/launch-dashboard/index.html#x", "//s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh/projects/x/%2e%2e/launch-dashboard/index.html", "https://s3.delo.sh/projects/x/a/../launch-dashboard/index.html", "https://s3.delo.sh/other/index.html"]) assert.equal(publication(receipt(url)), undefined, url);
  assert.equal(publication({ ...receipt(), schema: "wrong" }), undefined);
  assert.equal(publication({ schema: "launch-dashboard/1", published: { url: receipt().published.url, at: "yesterday" } }), undefined);
});

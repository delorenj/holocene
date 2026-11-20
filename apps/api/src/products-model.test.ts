import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProduct, publication } from "./products-model.js";

const receipt = (url = "https://s3.delo.sh/projects/example/2026-11-20/launch-dashboard/index.html") => ({ schema: "launch-dashboard/1", published: { url, at: "2026-11-20T21:48:41Z" }, private: "op://never/serialize" });
test("explicit committed lifecycle only; malformed and absent modes never imply steady", () => {
  assert.deepEqual(classifyProduct("mode: launch"), { stage: "launch" });
  assert.deepEqual(classifyProduct("mode: steady"), { steady: true });
  for (const raw of ["", "mode: unknown", "mode: LIVE", "[]", "mode: ["]) assert.ok(classifyProduct(raw).issue);
  assert.equal(classifyProduct("mode: live").stage, "live");
  assert.ok(classifyProduct("mode: live").issue);
});
test("receipt resolves only allowlisted HTTPS publications, omits extra fields", () => {
  assert.deepEqual(publication(receipt()), { href: receipt().published.url, label: "Open launch dashboard", publishedAt: "2026-11-20T21:48:41.000Z" });
  for (const url of ["javascript:alert(1)", "http://s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh.evil.test/projects/x/launch-dashboard/index.html", "https://user:password@s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh:443/projects/x/launch-dashboard/index.html?token=secret", "https://s3.delo.sh/projects/x/launch-dashboard/index.html#x", "//s3.delo.sh/projects/x/launch-dashboard/index.html", "https://s3.delo.sh/projects/x/%2e%2e/launch-dashboard/index.html", "https://s3.delo.sh/projects/x/a/../launch-dashboard/index.html", "https://s3.delo.sh/other/index.html"]) assert.equal(publication(receipt(url)), undefined, url);
  assert.equal(publication({ ...receipt(), schema: "wrong" }), undefined);
  assert.equal(publication({ schema: "launch-dashboard/1", published: { url: receipt().published.url, at: "yesterday" } }), undefined);
});

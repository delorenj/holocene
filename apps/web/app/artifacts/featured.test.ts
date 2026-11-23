import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURED, featuredQuery, pickFeatured } from "./featured";

test("featured artifacts match only by exact published URL", () => {
  const ref = FEATURED[0];
  assert.equal(pickFeatured(ref, [{ originalUrl: `${ref.originalUrl}-other` }]), undefined);
  assert.deepEqual(pickFeatured(ref, [{ originalUrl: "x" }, { originalUrl: ref.originalUrl }]), { originalUrl: ref.originalUrl });
  assert.equal(featuredQuery(ref).get("featured"), "1");
  for (const f of FEATURED) assert.match(f.originalUrl, /^https:\/\/(v|s3)\.delo\.sh\//);
});

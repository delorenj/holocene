import assert from "node:assert/strict";
import { test } from "node:test";
import { refFor } from "../hub/published";
import { FEATURED, featuredQuery, pickFeatured } from "./featured";

test("featured artifacts match only by exact published URL", () => {
  const ref = FEATURED[0];
  assert.equal(pickFeatured(ref, [{ originalUrl: `${ref.originalUrl}-other` }]), undefined);
  assert.deepEqual(pickFeatured(ref, [{ originalUrl: "x" }, { originalUrl: ref.originalUrl }]), { originalUrl: ref.originalUrl });
  assert.equal(featuredQuery(ref).get("featured"), "1");
  for (const f of FEATURED) assert.match(f.originalUrl, /^https:\/\/(v|s3)\.delo\.sh\//);
});

test("a share URL's catalog search is its last path segment, or its folder for an index page", () => {
  assert.deepEqual(refFor("https://v.delo.sh/0184/holocene-auto-agent-pad"), { originalUrl: "https://v.delo.sh/0184/holocene-auto-agent-pad", search: "holocene-auto-agent-pad", type: "videos" });
  assert.equal(refFor("https://s3.delo.sh/projects/x/2026-11-23/demo-reel/index.html", "all").search, "demo-reel");
  assert.equal(refFor("not a url").search, "");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationAllowed, signReview } from "./review-proxy";

// The same vector is asserted against the API's reviewSignature (apps/api/src/reviews.test.ts); a drift on either side fails a suite.
const VECTOR = { secret: "s3cret", method: "PATCH", path: "/api/modules/projects/greeninbetween/revisions/abc/annotations/x?v=1", body: "{\"version\":1}", user: "op@example.com", ts: "1795740000000" };

test("the proxy signature matches the shared vector the API verifies", () => {
  const v = VECTOR;
  assert.equal(signReview(v.secret, v.method, v.path, v.body, v.user, v.ts), "4859de2fd5d89e4d2f31ee49e50d66be64fe866a4b5d38bc82fc1301addb14d4");
});

const req = (method: string, headers: Record<string, string>) => new Request("http://holocene.local/api/projects/x/revisions", { method, headers });

test("review mutations need a same-origin Origin and a JSON body", () => {
  const host = { host: "holocene.delo.sh", "x-forwarded-proto": "https" };
  assert.equal(mutationAllowed(req("POST", { ...host, origin: "https://holocene.delo.sh", "content-type": "application/json; charset=utf-8" })), true);
  assert.equal(mutationAllowed(req("POST", { ...host, "content-type": "application/json" })), false, "missing Origin");
  assert.equal(mutationAllowed(req("POST", { ...host, origin: "null", "content-type": "application/json" })), false, "sandboxed frame");
  assert.equal(mutationAllowed(req("POST", { ...host, origin: "https://evil.example", "content-type": "application/json" })), false, "cross-site");
  assert.equal(mutationAllowed(req("POST", { ...host, origin: "http://holocene.delo.sh", "content-type": "application/json" })), false, "scheme mismatch");
  assert.equal(mutationAllowed(req("POST", { ...host, origin: "https://holocene.delo.sh", "content-type": "text/plain" })), false, "form-style body");
  assert.equal(mutationAllowed(req("DELETE", { ...host, origin: "https://holocene.delo.sh" })), true);
  assert.equal(mutationAllowed(req("POST", { host: "a", "x-forwarded-host": "holocene.delo.sh", origin: "https://holocene.delo.sh", "content-type": "application/json" })), true, "forwarded host wins");
});

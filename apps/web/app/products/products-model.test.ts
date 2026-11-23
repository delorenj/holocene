import assert from "node:assert/strict";
import { test } from "node:test";
import { groupIssues, receiptPath, stamp } from "./products-model";

test("receipt path drops scheme and index file but keeps the published location", () => {
  assert.equal(receiptPath("https://s3.delo.sh/projects/tolt/2026-11-18/launch-dashboard/index.html"), "s3.delo.sh/projects/tolt/2026-11-18/launch-dashboard");
  assert.equal(receiptPath("not a url"), "not a url");
});
test("stamps are UTC minutes and invalid input is shown verbatim", () => {
  assert.equal(stamp("2026-11-23T13:52:20.000Z"), "2026-11-23 13:52 UTC");
  assert.equal(stamp("garbage"), "garbage");
});
test("missing declarations are separated from unreadable or invalid ones", () => {
  const g = groupIssues([{ id: "a", name: "A", state: "missing", detail: "" }, { id: "b", name: "B", state: "unavailable", detail: "" }, { id: "c", name: "C", state: "invalid", detail: "" }]);
  assert.deepEqual(g.missing.map((i) => i.id), ["a"]); assert.deepEqual(g.actionable.map((i) => i.id), ["b", "c"]);
});

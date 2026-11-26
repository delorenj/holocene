import assert from "node:assert/strict";
import { test } from "node:test";
import type { Signal } from "./types";
import { directReports, heldTag, visibleFacts } from "./inspector-model";

test("a tile hides only absent values; zero is a sourced value", () => {
  const facts = [
    { label: "Tools", value: 0 },
    { label: "Needs you", value: 0 },
    { label: "Gone", value: undefined },
    { label: "Null", value: null },
    { label: "Blank", value: "" },
    { label: "Gateway", value: "active" }
  ];
  assert.deepEqual(visibleFacts(facts).map((f) => f.label), ["Tools", "Needs you", "Gateway"]);
  assert.deepEqual(visibleFacts([{ label: "x", value: undefined }]), []);
});

test("held tag joins state and duration, and drops a missing duration", () => {
  assert.equal(heldTag("idle"), "idle");
  assert.equal(heldTag("idle", 840), "idle · 14m");
  assert.equal(heldTag("", 30), "30s");
});

test("directs exclude the agent itself, include any role, and rank by signal then name", () => {
  const a = (id: string, signal: Signal, reportsTo: string, role = "pm") => ({ id, name: id, signal, reportsTo, role });
  const agents = [a("boss", "quiet", "boss", "director"), a("zed", "quiet", "boss"), a("amy", "quiet", "boss"), a("bad", "broken", "boss"), a("other", "you", "elsewhere"), a("sub", "working", "pm-1"), a("pm-1", "quiet", "boss")];
  assert.deepEqual(directReports(agents, "boss").map((x) => x.id), ["bad", "amy", "pm-1", "zed"]);
  assert.deepEqual(directReports(agents, "pm-1").map((x) => x.id), ["sub"]);
});

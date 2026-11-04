import assert from "node:assert/strict";
import { test } from "node:test";
import { activeActions, canFix, groupByProject, padHistory, splitViews, summarizeHistory, taskChipLabel } from "./candybar-model";
import type { RunResult } from "./types";

const runs = (s: string): RunResult[] => [...s].map((c) => (c === "p" ? "success" : c === "f" ? "fail" : "running"));
const row = (over: Record<string, unknown> = {}) => ({ archived: false, enabled: true, lastRun: undefined, history: undefined, profile: undefined, ...over }) as never;

test("summarizeHistory words the counts for assistive tech", () => {
  assert.equal(summarizeHistory(runs("p".repeat(24) + "f".repeat(6))).label, "Last 30 runs: 24 passed, 6 failed");
  assert.equal(summarizeHistory(runs("ppr")).label, "Last 3 runs: 2 passed, 0 failed, 1 running");
  assert.equal(summarizeHistory(runs("p")).label, "Last 1 run: 1 passed, 0 failed");
  assert.equal(summarizeHistory([]).label, "No runs recorded yet");
  assert.equal(summarizeHistory(undefined).total, 0);
});

test("padHistory fills to 30 cells with the newest run on the right", () => {
  const cells = padHistory(runs("pf"));
  assert.equal(cells.length, 30);
  assert.deepEqual(cells.slice(-2), ["success", "fail"]);
  assert.equal(cells[27], null);
  assert.equal(padHistory(runs("p".repeat(40))).length, 30);
  assert.deepEqual(padHistory(undefined).filter(Boolean), []);
});

test("Fix is offered after a failed last run or 3 failures in the last 10, never when archived", () => {
  assert.equal(canFix(row({ lastRun: { result: "fail", startedAt: "x" } })), true);
  assert.equal(canFix(row({ lastRun: { result: "success", startedAt: "x" }, history: runs("pppppppfpf") })), false, "2 of the last 10");
  assert.equal(canFix(row({ lastRun: { result: "success", startedAt: "x" }, history: runs("fpppppppfpf") })), false, "the 11th-newest failure is outside the last 10");
  assert.equal(canFix(row({ lastRun: { result: "success", startedAt: "x" }, history: runs("pppfpfpppf") })), true, "3 of the last 10");
  assert.equal(canFix(row({ lastRun: { result: "success", startedAt: "x" }, history: runs("ffffpppppppppppppp") })), false, "old failures are outside the last 10");
  assert.equal(canFix(row({ lastRun: { result: "success", startedAt: "x" }, history: runs("ppppppfffp") })), true);
  assert.equal(canFix(row({ archived: true, lastRun: { result: "fail", startedAt: "x" } })), false);
  assert.equal(canFix(row()), false);
});

test("groupByProject orders projects A to Z, then Unclassified, then Unknown when profiles were unreadable", () => {
  const p = (name?: string) => ({ profile: name ? { project: { id: name, name, confidence: 1, method: "ledger" } } : null, n: name });
  const rows = [{ ...p("b"), id: 1 }, { ...p(), id: 2 }, { id: 6, profile: undefined }, { ...p("a"), id: 3 }, { ...p("b"), id: 4 }, { ...p(), id: 5 }] as never[];
  const groups = groupByProject(rows);
  assert.deepEqual(groups.map((g) => g.label), ["a", "b", "Unclassified", "Unknown (profiles unavailable)"]);
  assert.deepEqual(groups.map((g) => g.items.map((i: { id: number }) => i.id)), [[3], [1, 4], [2, 5], [6]]);
  assert.deepEqual(groupByProject([{ profile: undefined }] as never[]).map((g) => g.label), ["Unknown (profiles unavailable)"], "never Unclassified when the data is missing");
  assert.deepEqual(groupByProject([]), []);
});

test("splitViews keeps archived rows out of every other view", () => {
  const rows = [row({ enabled: true }), row({ enabled: false }), row({ enabled: true, lastRun: { result: "fail", startedAt: "x" } }), row({ archived: true, enabled: false }), row({ archived: true, enabled: true, lastRun: { result: "fail", startedAt: "x" } })];
  const v = splitViews(rows);
  assert.deepEqual([v.active.length, v.inactive.length, v.failing.length, v.archived.length], [2, 1, 1, 2]);
});

test("task chips and active actions", () => {
  const at = "2026-11-03T17:00:00Z";
  const now = Date.parse("2026-11-03T17:04:00Z");
  assert.equal(taskChipLabel({ action: "enrich", status: "running", createdAt: at }), "Enriching");
  assert.equal(taskChipLabel({ action: "refactor", status: "running", createdAt: at, startedAt: "2026-11-03T17:01:00Z" }, now), "Refactoring 3m", "running counts from the start");
  assert.equal(taskChipLabel({ action: "fix", status: "queued", createdAt: at }, now), "Fix queued 4m", "queued counts from creation");
  const t = (action: "fix" | "evaluate") => ({ id: action, candybarId: "c", action, status: "running" as const, createdAt: "x" });
  assert.deepEqual([...activeActions({ tasks: { active: [t("fix"), t("evaluate")], latest: {} } })].sort(), ["evaluate", "fix"]);
  assert.equal(activeActions({}).size, 0);
});

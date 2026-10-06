import assert from "node:assert/strict";
import { test } from "node:test";
import { activityOf, DONE_WINDOW_MS, ERROR_WINDOW_MS, HELD_WINDOW_MS, reconcile, WORKING_WINDOW_MS, worst, type Declared } from "./deckard-state.js";

const T0 = Date.parse("2026-10-06T12:00:00Z");
const ev = (offsetMs: number, activity: Declared["activity"], type?: string): Declared => ({ at: T0 + offsetMs, activity, type });

test("event types map to Deckard's activities", () => {
  assert.equal(activityOf("bloodbank.conversation.turn.started"), "working");
  assert.equal(activityOf("bloodbank.agent.tool.requested"), "working");
  assert.equal(activityOf("bloodbank.agent.tool.completed"), "working");
  assert.equal(activityOf("bloodbank.agent.invocation.started"), "working");
  assert.equal(activityOf("bloodbank.agent.invocation.completed"), "working");
  assert.equal(activityOf("bloodbank.agent.invocation.failed"), "failed");
  assert.equal(activityOf("bloodbank.conversation.turn.completed", "claude", "completed"), "turn-ended");
  assert.equal(activityOf("bloodbank.conversation.turn.completed", "claude", "failed"), "failed");
  assert.equal(activityOf("bloodbank.agent.session.started"), "session-started");
  assert.equal(activityOf("bloodbank.agent.session.ended", "claude"), "session-ended");
  assert.equal(activityOf("bloodbank.agent.session.ended", "antigravity"), "turn-ended");
  assert.equal(activityOf("bloodbank.v1.agent.tool.requested"), "working");
});

test("pipeline noise and unrelated events say nothing about an agent", () => {
  assert.equal(activityOf("bloodbank.agent.invocation.skipped"), undefined);
  assert.equal(activityOf("bloodbank.agent.hook.updated"), undefined);
  assert.equal(activityOf("bloodbank.repo.task.updated"), undefined);
  assert.equal(activityOf("short.type"), undefined);
});

test("worst wins: one agent finishing never hides another that is working, failed or blocked", () => {
  assert.equal(worst("done", "active"), "active");
  assert.equal(worst("active", "error"), "error");
  assert.equal(worst("error", "hitl"), "hitl");
  assert.equal(worst("idle", "done"), "done");
  assert.equal(worst(), "idle");
});

test("working evidence decays: presence is not work", () => {
  const events = [ev(0, "working", "bloodbank.conversation.turn.started")];
  assert.equal(reconcile(events, T0 + 60_000).state, "active");
  assert.equal(reconcile(events, T0 + WORKING_WINDOW_MS - 1).state, "active");
  assert.equal(reconcile(events, T0 + WORKING_WINDOW_MS + 1).state, "idle");
});

test("a missing terminal event decays to dark and never becomes a check", () => {
  const events = [ev(0, "working"), ev(5_000, "working")];
  assert.equal(reconcile(events, T0 + 3 * 3600_000).state, "idle");
});

test("a finished turn keeps its check until new work, then lapses after two hours unseen", () => {
  const events = [ev(0, "working"), ev(60_000, "turn-ended")];
  const finished = reconcile(events, T0 + 3_600_000);
  assert.equal(finished.state, "done");
  assert.equal(finished.sinceMs, T0 + 60_000);
  assert.equal(reconcile(events, T0 + 60_000 + DONE_WINDOW_MS + 1).state, "idle");
  assert.equal(reconcile([...events, ev(3_700_000, "working")], T0 + 3_800_000).state, "active");
});

test("a failure reads red briefly, then clears", () => {
  const events = [ev(0, "working"), ev(10_000, "failed")];
  assert.equal(reconcile(events, T0 + 20_000).state, "error");
  assert.equal(reconcile(events, T0 + 10_000 + ERROR_WINDOW_MS + 1).state, "idle");
});

test("the same session starting again does not blank a pulse or a check", () => {
  assert.equal(reconcile([ev(0, "working"), ev(1_000, "session-started")], T0 + 2_000).state, "active");
  assert.equal(reconcile([ev(0, "turn-ended"), ev(1_000, "session-started")], T0 + 2_000).state, "done");
});

test("a session end drops the pulse at once", () => {
  assert.equal(reconcile([ev(0, "working"), ev(1_000, "session-ended")], T0 + 2_000).state, "idle");
});

test("open subagents hold the pulse to the held ceiling, not past it", () => {
  const events = [ev(0, "working")];
  assert.equal(reconcile(events, T0 + WORKING_WINDOW_MS + 1, false).state, "idle");
  assert.equal(reconcile(events, T0 + WORKING_WINDOW_MS + 1, true).state, "active");
  assert.equal(reconcile(events, T0 + HELD_WINDOW_MS + 1, true).state, "idle");
});

test("events arrive in any order and a lapse between bursts starts a new run", () => {
  const events = [ev(WORKING_WINDOW_MS + 5_000, "working"), ev(0, "working")];
  const reading = reconcile(events, T0 + WORKING_WINDOW_MS + 6_000);
  assert.equal(reading.state, "active");
  assert.equal(reading.sinceMs, T0 + WORKING_WINDOW_MS + 5_000);
});

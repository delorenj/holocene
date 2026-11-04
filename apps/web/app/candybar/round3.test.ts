import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionStore, FOCUS_INTENT_MS } from "./action-store";
import type { ActionResult } from "./candybar-api";
import {
  cancelConfirm,
  cancelLabel,
  cancelledNote,
  ERROR_NOTE_MS,
  fixOffered,
  followUpLabel,
  followUpStatusOf,
  inFlightTasks,
  NOTE_MS,
  noteVisible,
  staleNote,
  stewardControl,
  toggleBlockedReason,
  toggleInFlight
} from "./candybar-model";
import { endOnInteraction } from "./focus-intent";
import { runCancel, runRowAction, type CancelDeps, type RunDeps } from "./row-actions";
import { fireBlockedReason, runFireAction, type FireDeps } from "./fire-actions";
import type { Fire } from "./schedule-model";
import type { CandybarRow, Task } from "./types";

// HOLOC-24 round 3 (the second adversarial review's N1, N2, N4, N5, N7, N8). N3 is in schedule-sync.test.ts, N6 in
// schedule-model.test.ts.

const ID = "01a17948-1e34-7611-a5c9-19ac51c114fb";
const NOW = Date.parse("2026-11-03T17:10:00Z");
const task = (over: Partial<Task> = {}): Task => ({ id: "t1", candybarId: ID, action: "fix", status: "running", createdAt: "2026-11-03T17:05:00Z", startedAt: "2026-11-03T17:06:00Z", ...over });
const row = (over: Partial<CandybarRow> = {}): CandybarRow => ({
  id: ID, name: "hermes-single-install-guard", description: "", tags: [], schedule: "0 5 * * *", timezone: "UTC", noise: false,
  enabled: true, archived: false, createdAt: "2026-10-26T05:28:45Z", nextFire: "2026-11-04T05:00:00Z",
  lastRun: { result: "success", startedAt: "2026-11-03T17:09:00Z" }, history: ["fail", "fail", "fail", "success"],
  profile: { overview: null, templateVersion: null, project: null, enrichedAt: null, evaluation: null },
  tasks: { active: [], latest: {} },
  ...over
});
const ok = (body: Record<string, unknown> = {}): ActionResult => ({ ok: true, body });

// ---------- N1: Fix stays while its task is in flight ----------

test("N1: the Fix button stays while a fix is queued, running or being requested, even when the last run turned green", () => {
  const green = row({ history: ["success", "success", "success", "fail", "success"] }); // the proving run passed: lastRun success, one failure left in the last 10
  assert.equal(fixOffered(green, stewardControl(green, "fix", NOW)), false, "a healthy job with no fix in flight: no Fix");
  const running = row({ tasks: { active: [task()], latest: {} } });
  const ctl = stewardControl(running, "fix", NOW);
  assert.equal(fixOffered(running, ctl), true, "the fix is running: the button stays, carrying its state");
  assert.equal(ctl.label, "Fixing 4m");
  assert.equal(ctl.disabled, true);
  const queued = row({ tasks: { active: [task({ status: "queued" })], latest: {} } });
  assert.equal(stewardControl(queued, "fix", NOW).label, "Fix queued 5m");
  assert.equal(fixOffered(queued, stewardControl(queued, "fix", NOW)), true);
  assert.equal(fixOffered(green, stewardControl(green, "fix", NOW, { busy: true })), true, "the request is in flight");
  const justQueued = task({ id: "new", status: "queued", createdAt: "2026-11-03T17:09:55Z" });
  assert.equal(fixOffered(green, stewardControl(green, "fix", NOW, { pending: justQueued })), true, "queued by this page, the list has not caught up");
  const archived = row({ archived: true, tasks: { active: [task()], latest: {} } });
  assert.equal(fixOffered(archived, stewardControl(archived, "fix", NOW)), false, "never for an archived candybar");
  const failing = row({ lastRun: { result: "fail", startedAt: "x" } });
  assert.equal(fixOffered(failing, stewardControl(failing, "fix", NOW)), true, "the original rule still holds");
});

// ---------- N2: cancel ----------

const cancelDeps = (answer: () => ActionResult, over: Partial<CancelDeps> = {}) => {
  const store = createActionStore();
  const asked: string[] = [];
  const confirms: string[] = [];
  let reloads = 0;
  const d: CancelDeps = {
    store,
    cancel: async (id) => (asked.push(id), answer()),
    confirm: (t) => (confirms.push(t), true),
    onChanged: () => void (reloads += 1),
    now: () => NOW,
    ...over
  };
  return { d, store, asked, confirms, reloads: () => reloads };
};

test("N2: Cancel confirms first, then asks Candybar to cancel that task, and the button returns once the list moves on", async () => {
  const evaluate = task({ id: "01a1a4d9-6a5a-7767-8ca7-bac158bdb89d", action: "evaluate", status: "queued", createdAt: "2026-11-03T17:09:55Z" });
  const t = cancelDeps(() => ok({ ok: true, task: { ...evaluate, status: "failed", error: "cancelled by operator" } }));
  t.store.remember(evaluate);
  assert.equal(stewardControl(row({ tasks: { active: [], latest: {} } }), "evaluate", NOW, { pending: t.store.pending(ID, "evaluate") }).disabled, true, "held by the page's own queued task");
  assert.equal(await runCancel(row(), evaluate, t.d), "sent");
  assert.match(t.confirms[0], /^Cancel the evaluate of hermes-single-install-guard\?/);
  assert.match(t.confirms[0], /It has not started/);
  assert.deepEqual(t.asked, [evaluate.id]);
  assert.equal(t.store.pending(ID, "evaluate"), undefined, "forgotten: the button does not wait for a list that already moved on");
  assert.equal(stewardControl(row(), "evaluate", NOW, { pending: t.store.pending(ID, "evaluate") }).disabled, false, "the button returns");
  assert.equal(t.reloads(), 1);
  assert.match(t.store.get().announcement.text, /Cancelled the evaluate of hermes-single-install-guard\. It ends as failed \(cancelled by operator\)\./);
  assert.equal(t.store.isBusy(`${ID}:cancel:${evaluate.id}`), false);
});

test("N2: a dismissed confirm sends nothing; a running task's confirm says the steward stops the agent; a second click sends nothing", async () => {
  const running = task({ action: "fix", status: "running" });
  const no = cancelDeps(() => ok(), { confirm: () => false });
  assert.equal(await runCancel(row(), running, no.d), "dismissed");
  assert.equal(no.asked.length, 0);
  assert.match(cancelConfirm("x", running), /stops the agent within a minute\. Anything it already committed or pushed stays\./);
  assert.doesNotMatch(cancelConfirm("x", task({ action: "enrich", status: "running" })), /committed/, "an enrich writes only Candybar's notes");
  assert.equal(cancelLabel(task({ action: "refactor" })), "Cancel refactor");
  assert.match(cancelledNote("x", running), /The steward stops the agent within a minute\.$/);
  const waiting: Array<(r: ActionResult) => void> = [];
  const t = cancelDeps(() => ok());
  t.d.cancel = (id) => new Promise<ActionResult>((r) => (t.asked.push(id), void waiting.push(r)));
  const first = runCancel(row(), running, t.d);
  assert.equal(await runCancel(row(), running, t.d), "busy");
  assert.equal(t.asked.length, 1);
  waiting[0](ok());
  await first;
});

test("N2: a 409 (already finished) is information and reloads; any other failure is an error note", async () => {
  const done = cancelDeps(() => ({ ok: false, status: 409, error: "task t1 is already succeeded", body: {} }));
  await runCancel(row(), task(), done.d);
  const note = done.store.get().notes.get(ID);
  assert.deepEqual([note?.tone, note?.text], ["info", "The fix of hermes-single-install-guard had already finished, so there was nothing to cancel."]);
  assert.equal(done.reloads(), 1);
  assert.equal(done.store.get().announcement.assertive, undefined);
  const bad = cancelDeps(() => ({ ok: false, status: 502, error: "candybar.delo.sh: timed out", body: {} }));
  await runCancel(row(), task(), bad.d);
  assert.equal(bad.store.get().notes.get(ID)?.text, "Cancel fix failed: candybar.delo.sh: timed out (502)");
  assert.equal(bad.store.get().announcement.assertive, true);
  assert.equal(bad.reloads(), 0);
});

test("N2: every task in flight gets a Cancel, a refactor included, and the page's just-queued one too", () => {
  const c = row({ tasks: { active: [task({ id: "r", action: "refactor" }), task({ id: "e", action: "evaluate", status: "queued" })], latest: {} } });
  assert.deepEqual(inFlightTasks(c).map((t) => t.id), ["e", "r"]);
  const justQueued = task({ id: "n", action: "enrich", status: "queued", createdAt: "2026-11-03T17:09:59Z" });
  assert.deepEqual(inFlightTasks(row(), (a) => (a === "enrich" ? justQueued : undefined)).map((t) => t.id), ["n"]);
  assert.deepEqual(inFlightTasks(row()), []);
});

// ---------- N4: stale data ----------

test("N4: stale profiles and tasks are named with their age, which keeps growing until the next fresh read", () => {
  const GEN = "2026-11-03T17:10:00Z";
  assert.equal(staleNote(undefined, GEN, NOW), undefined);
  assert.equal(staleNote({}, GEN, NOW), undefined);
  assert.match(staleNote({ profiles: 40, tasks: 40 }, GEN, NOW) ?? "", /^Profiles and steward tasks are 40s old \(Candybar did not answer the last read\)\./);
  assert.match(staleNote({ profiles: 40, tasks: 40 }, GEN, NOW + 20_000) ?? "", /^Profiles and steward tasks are 1m old/);
  assert.match(staleNote({ profiles: 40, tasks: 100 }, GEN, NOW) ?? "", /^Profiles are 40s old and steward tasks are 1m old/);
  assert.match(staleNote({ tasks: 12 }, GEN, NOW) ?? "", /^Steward tasks are 12s old/);
  // The buttons stay usable on stale data: the row still carries its tasks and profile.
  assert.equal(stewardControl(row(), "enrich", NOW).disabled, false);
});

// ---------- N5: a follow-up's label uses the child's own outcome ----------

test("N5: without followUpStatus the child task's outcome words the follow-up", () => {
  const e = { followUp: "refactor" as const, taskId: "ev1" };
  const kid = (status: Task["status"], outcome?: string) => ({ id: "k", status, parentTaskId: "ev1", ...(outcome ? { outcome } : {}) });
  assert.equal(followUpLabel(e, kid("succeeded", "done_proven")), "refactor done");
  assert.equal(followUpLabel(e, kid("succeeded", "done")), "refactor done");
  assert.equal(followUpLabel(e, kid("succeeded")), "refactor done", "an older row with no outcome");
  assert.equal(followUpLabel(e, kid("succeeded", "done_not_proven")), "refactor done, not proven");
  assert.equal(followUpLabel(e, kid("succeeded", "not_applied")), "refactor not applied, flagged for you to decide", "the Suboptimal case: nothing was changed");
  assert.equal(followUpStatusOf(e, kid("succeeded", "not_applied")), "flagged");
  assert.equal(followUpStatusOf(e, kid("succeeded", "done_proven")), "done");
  assert.equal(followUpStatusOf(e, kid("succeeded", "done_not_proven")), "failed");
  assert.equal(followUpLabel(e, kid("failed")), "refactor failed");
  assert.equal(followUpLabel(e, kid("running")), "refactor running");
  const fix = { followUp: "fix" as const, taskId: "ev1" };
  assert.equal(followUpLabel(fix, kid("succeeded", "fixed")), "fix fixed");
  assert.equal(followUpLabel(fix, kid("succeeded", "not_fixed")), "fix not fixed");
  assert.equal(followUpLabel(fix, kid("succeeded", "flagged")), "fix done", "an outcome nobody knows reads as done only because the task succeeded");
  // followUpTaskId names the child exactly.
  assert.equal(followUpLabel({ ...e, taskId: undefined, followUpTaskId: "k" }, kid("succeeded", "not_applied")), "refactor not applied, flagged for you to decide");
  // Someone else's refactor says nothing.
  assert.equal(followUpLabel(e, { id: "z", status: "succeeded", parentTaskId: "other", outcome: "done_proven" }), "refactor");
});

test("N5: with followUpStatus, Candybar's word stands, and a flagged refactor still says it was not applied", () => {
  const e = { followUp: "refactor" as const, taskId: "ev1" };
  assert.equal(followUpLabel({ ...e, followUpStatus: "done" }, { id: "k", status: "succeeded", parentTaskId: "ev1", outcome: "not_applied" }), "refactor done", "Candybar's status wins over the child's");
  assert.equal(followUpLabel({ ...e, followUpStatus: "flagged" }), "refactor flagged for you to decide");
  assert.equal(followUpLabel({ ...e, followUpStatus: "flagged" }, { id: "k", status: "succeeded", parentTaskId: "ev1", outcome: "not_applied" }), "refactor not applied, flagged for you to decide");
  assert.equal(followUpLabel({ followUp: "archive", followUpStatus: "flagged" }), "archive flagged: protected, not archived");
  assert.equal(followUpStatusOf({ followUp: "none", followUpStatus: "flagged" }), undefined);
});

// ---------- N7: one change per candybar at a time ----------

test("N7: while one toggle runs, the other toggles are blocked with the reason; steward actions are not", async () => {
  const waiting: Array<(r: ActionResult) => void> = [];
  const store = createActionStore();
  const sent: string[] = [];
  const d: RunDeps = {
    store,
    post: (id, path) => new Promise<ActionResult>((r) => (sent.push(path), void waiting.push(r))),
    confirm: () => true,
    onChanged: () => undefined,
    now: () => NOW
  };
  const c = row();
  const disable = runRowAction(c, "enabled", d);
  assert.equal(toggleInFlight(store.get().busy, ID), "enabled");
  assert.equal(await runRowAction(c, "archived", d), "blocked", "Archive while Disable runs");
  assert.equal(store.get().announcement.text, "Disabling is in progress; one change to a candybar at a time.");
  assert.equal(await runRowAction(c, "noise", d), "blocked");
  assert.deepEqual(sent, ["enabled"], "only the first reached Candybar");
  assert.equal(await runRowAction(c, "enabled", d), "busy", "the same action twice is still the busy case");
  // Another candybar is not held.
  const other = row({ id: "01a178c9-69e0-730c-b1a8-b920a839d9bf" });
  const second = runRowAction(other, "noise", d);
  assert.equal(sent.length, 2);
  // A steward request is not a toggle.
  const enrich = runRowAction(c, "enrich", d);
  assert.equal(sent.length, 3);
  waiting[0](ok());
  await disable;
  assert.equal(toggleInFlight(store.get().busy, ID), undefined, "the next one may go");
  const archive = runRowAction(c, "archived", d);
  assert.equal(sent.length, 4);
  waiting[1](ok());
  waiting[2](ok({ task: task({ action: "enrich" }) }));
  waiting[3](ok());
  await Promise.all([second, enrich, archive]);
});

test("N7: the reasons name what is running, in the row's own words", () => {
  assert.equal(toggleBlockedReason(row({ enabled: true }), "enabled"), "Disabling is in progress; one change to a candybar at a time.");
  assert.equal(toggleBlockedReason(row({ enabled: false }), "enabled"), "Enabling is in progress; one change to a candybar at a time.");
  assert.equal(toggleBlockedReason(row({ archived: false }), "archived"), "Archiving is in progress; one change to a candybar at a time.");
  assert.equal(toggleBlockedReason(row({ noise: true }), "noise"), "Unmarking noise is in progress; one change to a candybar at a time.");
  assert.equal(toggleInFlight(new Set([`${ID}:archived`, "other:noise"]), ID), "archived");
  assert.equal(toggleInFlight(new Set([`${ID}:evaluate`, `${ID}:cancel:t1`]), ID), undefined);
});

test("N7: Mark noise on the Schedule is held while the same candybar's Disable or Archive runs", async () => {
  const f: Fire = { key: `${ID}@2026-11-04T03:07:00+00:00`, candybarId: ID, name: "newapi-staff-sso", schedule: "7 * * * *", fireTime: "2026-11-04T03:07:00+00:00", t: Date.parse("2026-11-04T03:07:00Z"), state: "upcoming", skipped: false, noise: false, timezone: "UTC" };
  const store = createActionStore();
  const sent: string[] = [];
  const d: FireDeps = {
    store, post: async (_id, path) => (sent.push(path), ok()), confirm: () => true, showNoise: true, clock: () => "", now: () => NOW,
    onSkipped: () => undefined, onNoise: () => undefined, onRefetch: () => undefined, onError: () => undefined
  };
  assert.ok(store.begin(`${ID}:archived`));
  assert.equal(await runFireAction(f, "noise", d), "blocked");
  assert.equal(store.get().announcement.text, fireBlockedReason("newapi-staff-sso", "archived"));
  assert.match(store.get().announcement.text, /An archive change to newapi-staff-sso is in progress; one change to a candybar at a time\./);
  assert.deepEqual(sent, []);
  assert.equal(await runFireAction(f, "skip", d), "sent", "skipping one fire is not a change to the candybar");
  store.end(`${ID}:archived`);
  assert.equal(await runFireAction(f, "noise", d), "sent");
});

test("N7: an error note clears after 10 s, other notes after 30 s, and the next action clears it at once", async () => {
  assert.equal(noteVisible({ tone: "error", at: NOW }, NOW + ERROR_NOTE_MS - 1), true);
  assert.equal(noteVisible({ tone: "error", at: NOW }, NOW + ERROR_NOTE_MS), false);
  assert.equal(noteVisible({ tone: "done", at: NOW }, NOW + ERROR_NOTE_MS + 1), true);
  assert.equal(noteVisible({ tone: "info", at: NOW }, NOW + NOTE_MS), false);
  const store = createActionStore();
  store.note(ID, { tone: "error", text: "Archive failed" }, NOW);
  const d: RunDeps = { store, post: async () => ok(), confirm: () => true, onChanged: () => undefined, now: () => NOW + 1_000 };
  await runRowAction(row(), "noise", d);
  assert.notEqual(store.get().notes.get(ID)?.tone, "error", "the next action replaced the error");
});

// ---------- N8: a focus intent ends when the operator takes over ----------

test("N8: any pointerdown or keydown ends the focus intent; key auto-repeat does not", () => {
  const store = createActionStore();
  const target = new EventTarget();
  const stop = endOnInteraction(target, () => store.clearFocusIntent());
  for (const type of ["pointerdown", "keydown"]) {
    store.intendFocus(ID, "enabled", NOW);
    assert.ok(store.focusIntent(NOW), "an action left an intent");
    target.dispatchEvent(new Event(type));
    assert.equal(store.focusIntent(NOW), undefined, `${type} ends it (long before the ${FOCUS_INTENT_MS} ms backstop)`);
  }
  store.intendFocus(ID, "enabled", NOW);
  const repeat = new Event("keydown");
  Object.defineProperty(repeat, "repeat", { value: true });
  target.dispatchEvent(repeat);
  assert.ok(store.focusIntent(NOW), "a held key is the action's own, not the operator moving on");
  target.dispatchEvent(new Event("pointerup"));
  target.dispatchEvent(new Event("click"));
  assert.ok(store.focusIntent(NOW), "only pointerdown and keydown count");
  stop();
  target.dispatchEvent(new Event("pointerdown"));
  assert.ok(store.focusIntent(NOW), "the cleanup removes the listeners");
});

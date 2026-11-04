import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionStore, liveText, FOCUS_INTENT_MS } from "./action-store";
import type { ActionResult } from "./candybar-api";
import {
  confirmText,
  conflictNote,
  followUpLabel,
  inFlight,
  rowDescription,
  rowName,
  stewardControl,
  taskOutcomeLabel,
  taskSpend
} from "./candybar-model";
import { fireActionKey, fireActionsFor, runFireAction, type FireDeps } from "./fire-actions";
import { runRowAction, type RunDeps } from "./row-actions";
import type { Fire } from "./schedule-model";
import type { CandybarRow, Task } from "./types";

// The decisions behind the Definitions action bar and the Schedule row actions (HOLOC-24 review findings 1, 2, 4-7,
// 10-12), tested without a DOM: labels, confirms, what one click sends and what the page learns from the answer.

const ID = "01a17948-1e34-7611-a5c9-19ac51c114fb";
const NOW = Date.parse("2026-11-03T17:10:00Z");
const task = (over: Partial<Task> = {}): Task => ({ id: "t1", candybarId: ID, action: "evaluate", status: "queued", createdAt: "2026-11-03T17:08:00Z", ...over });
const row = (over: Partial<CandybarRow> = {}): CandybarRow => ({
  id: ID, name: "restic-vault", description: "Offsite backup", tags: ["backups"], schedule: "30 4 * * *", timezone: "America/New_York", noise: false,
  enabled: true, archived: false, createdAt: "2026-10-26T05:28:45Z", nextFire: "2026-11-04T09:30:00Z",
  lastRun: { result: "success", startedAt: "2026-11-03T09:30:00Z" }, history: ["success", "success"],
  profile: { overview: null, templateVersion: null, project: { id: "docker", name: "Docker", confidence: 1, method: "ledger" }, enrichedAt: null, evaluation: null },
  tasks: { active: [], latest: {} },
  ...over
});

// ---------- steward buttons ----------

test("a steward button tells queued from running, with the task's age", () => {
  const queued = stewardControl(row({ tasks: { active: [task()], latest: {} } }), "evaluate", NOW);
  assert.deepEqual([queued.label, queued.disabled, queued.warn], ["Evaluate queued 2m", true, undefined]);
  const running = stewardControl(row({ tasks: { active: [task({ status: "running", startedAt: "2026-11-03T17:06:00Z" })], latest: {} } }), "evaluate", NOW);
  assert.equal(running.label, "Evaluating 4m", "running counts from the start, not from the queue");
  assert.equal(stewardControl(row(), "evaluate", NOW).disabled, false);
  assert.equal(stewardControl(row(), "evaluate", NOW, { busy: true }).label, "Queuing…");
});

test("a task queued for more than 2 minutes says the steward may be down", () => {
  const c = stewardControl(row({ tasks: { active: [task({ createdAt: "2026-11-03T17:05:00Z" })], latest: {} } }), "evaluate", NOW);
  assert.equal(c.label, "Evaluate queued 5m");
  assert.equal(c.reason, "Evaluate queued 5m: is candybar-steward running?");
  assert.equal(c.warn, true);
});

test("steward buttons are off, with the reason, when tasks or profiles could not be read", () => {
  const noTasks = stewardControl(row({ tasks: undefined }), "enrich", NOW);
  assert.equal(noTasks.disabled, true);
  assert.match(noTasks.reason ?? "", /Steward tasks could not be read/);
  const noProfiles = stewardControl(row({ profile: undefined }), "fix", NOW);
  assert.equal(noProfiles.disabled, true);
  assert.match(noProfiles.reason ?? "", /Profiles could not be read/);
});

test("a task this page just queued holds the button until the list shows it (no blind re-enable)", () => {
  const pending = task({ id: "new", createdAt: "2026-11-03T17:09:50Z" });
  const before = row({ tasks: { active: [], latest: { evaluate: task({ id: "old", status: "succeeded", createdAt: "2026-11-02T10:00:00Z" }) } } });
  assert.equal(inFlight(before, "evaluate", pending)?.id, "new", "the list still shows only an older task");
  assert.equal(stewardControl(before, "evaluate", NOW, { pending }).label, "Evaluate queued 10s");
  const caughtUp = row({ tasks: { active: [], latest: { evaluate: task({ id: "new", status: "succeeded", createdAt: pending.createdAt }) } } });
  assert.equal(inFlight(caughtUp, "evaluate", pending), undefined, "the list has it (and it already finished)");
  assert.equal(inFlight(before, "enrich", pending), undefined, "another action's task holds nothing");
});

// ---------- confirms and notes ----------

test("Fix and Evaluate confirm first and say what will happen", () => {
  const withRepo = row({ profile: { ...row().profile!, overview: { summary: "", purpose: "", behavior: [], inputs: [], outputs: [], sideEffects: [], dependencies: [], failureModes: [], verification: [], runbook: [], source: { repo: "delorenj/DeLoContainers", paths: [], runner: "systemd" }, cadenceNote: "" } } });
  const fix = confirmText(withRepo, "fix")!;
  assert.match(fix, /^Fix restic-vault\?/);
  assert.match(fix, /commits and pushes a repair straight to main in delorenj\/DeLoContainers/);
  assert.match(fix, /runs restic-vault once to prove it/);
  assert.match(confirmText(row(), "fix")!, /in the job's repo/, "no overview: the repo is not named");
  const evaluate = confirmText(row(), "evaluate")!;
  assert.match(evaluate, /adversarial review/);
  assert.match(evaluate, /Suboptimal queues a refactor/);
  assert.match(evaluate, /Drifted queues a fix/);
  assert.match(evaluate, /Orphaned archives the candybar/);
  assert.match(evaluate, /protected candybar is only flagged/);
  assert.equal(confirmText(row(), "enrich"), undefined, "Enrich only writes Candybar's own notes");
  assert.equal(confirmText(row(), "noise"), undefined);
  assert.equal(confirmText(row({ enabled: false }), "enabled"), undefined, "enabling asks nothing");
});

test("a 409 for a twin task reads as information", () => {
  assert.equal(conflictNote("evaluate", task({ status: "running", startedAt: "2026-11-03T17:07:00Z" }), NOW), "Already running: Evaluate started 3m ago.");
  assert.equal(conflictNote("enrich", task({ createdAt: "2026-11-03T17:09:00Z" }), NOW), "Already queued: Enrich queued 1m ago.");
  assert.equal(conflictNote("enrich", task({ createdAt: "2026-11-03T17:00:00Z" }), NOW), "Already queued: Enrich queued 10m ago. Is candybar-steward running?");
  assert.equal(conflictNote("fix", undefined, NOW), "Already queued or running: Fix.");
});

test("the steward's newer fields read as words: follow-up status, outcomes, spend", () => {
  const e = { followUp: "refactor" as const, taskId: "ev1" };
  assert.equal(followUpLabel({ ...e, followUpStatus: "queued" }), "refactor queued");
  assert.equal(followUpLabel({ ...e, followUpStatus: "done" }), "refactor done");
  assert.equal(followUpLabel({ followUp: "archive", followUpStatus: "flagged" }), "archive flagged (protected, not archived)");
  assert.equal(followUpLabel({ followUp: "none", followUpStatus: "flagged" }), "none");
  assert.equal(followUpLabel(e, { status: "succeeded", parentTaskId: "ev1" }), "refactor done", "an older Candybar: the child task says it");
  assert.equal(followUpLabel(e, { status: "succeeded", parentTaskId: "other" }), "refactor", "someone else's refactor says nothing");
  assert.equal(taskOutcomeLabel("done_proven"), "done, proven by a run");
  assert.equal(taskOutcomeLabel("done_not_proven"), "done, not proven");
  assert.equal(taskOutcomeLabel("not_applied"), "not applied");
  assert.equal(taskOutcomeLabel("Suboptimal"), "Suboptimal");
  assert.equal(taskSpend({ costUsd: 0.4213, tokens: { input: 1200, output: 340 } }), "$0.4213 · 1,540 tokens");
  assert.equal(taskSpend({ tokens: { total: 9 } }), "9 tokens");
  assert.equal(taskSpend({}), undefined);
});

test("the row button's name is short (name, state, next fire); the rest is its description", () => {
  const c = row({ tasks: { active: [task()], latest: {} }, profile: { ...row().profile!, evaluation: { outcome: "Suboptimal", summary: "", axes: {}, recommendation: "", followUp: "refactor", reportKey: "" } } });
  const name = rowName(c, NOW, true);
  assert.equal(name, "restic-vault, active, next fire in 16h 20m");
  assert.ok(name.length < 60);
  assert.equal(rowName(row({ enabled: false }), NOW, true), "restic-vault, inactive, not scheduled");
  assert.equal(rowName(row({ archived: true, enabled: false }), NOW, true), "restic-vault, archived, not scheduled");
  assert.equal(rowName(row({ lastRun: { result: "fail", startedAt: "x" } }), NOW, false), "restic-vault, failing, next fire unknown");
  assert.equal(rowName(row({ nextFire: null }), NOW, true), "restic-vault, active, no fire within 24 hours");
  const desc = rowDescription(c, NOW);
  assert.equal(desc, "Offsite backup Last run passed. Last 2 runs: 2 passed, 0 failed. Evaluate queued 2m. Evaluation: Suboptimal. Project Docker.");
  assert.equal(desc.includes("30 4 * * *"), false, "the cron is not in it");
});

// ---------- one click, start to finish ----------

type Sent = { id: string; path: string; body: Record<string, unknown> };
function deps(answer: (s: Sent) => ActionResult | Promise<ActionResult>, over: Partial<RunDeps> = {}) {
  const sent: Sent[] = [];
  const store = createActionStore();
  let reloads = 0;
  const confirms: string[] = [];
  const d: RunDeps = {
    store,
    post: async (id, path, body) => {
      const s = { id, path, body };
      sent.push(s);
      return answer(s);
    },
    confirm: (t) => (confirms.push(t), true),
    onChanged: () => void (reloads += 1),
    now: () => NOW,
    ...over
  };
  return { d, sent, store, confirms, reloads: () => reloads };
}
const ok = (body: Record<string, unknown> = {}): ActionResult => ({ ok: true, body });

test("dismissing a confirm sends nothing", async () => {
  const t = deps(() => ok(), { confirm: () => false });
  assert.equal(await runRowAction(row(), "evaluate", t.d), "dismissed");
  assert.equal(await runRowAction(row(), "archived", t.d), "dismissed");
  assert.equal(t.sent.length, 0);
});

test("a second click while the first request runs sends nothing, and the busy key is per row and action", async () => {
  const waiting: Array<(r: ActionResult) => void> = [];
  const release = (r: ActionResult) => waiting.shift()?.(r);
  const t = deps(() => new Promise<ActionResult>((r) => void waiting.push(r)));
  const first = runRowAction(row(), "noise", t.d);
  assert.equal(t.store.isBusy(`${ID}:noise`), true);
  assert.equal(await runRowAction(row(), "noise", t.d), "busy");
  const other = row({ id: "01a178c9-69e0-730c-b1a8-b920a839d9bf", name: "deploy-smoke-exec" });
  const second = runRowAction(other, "noise", t.d);
  assert.equal(t.sent.length, 2, "another row's noise is its own key");
  release(ok());
  await first;
  assert.equal(t.store.isBusy(`${ID}:noise`), false);
  release(ok());
  await second;
});

test("a steward 409 naming a twin is a note, remembers the twin, and reloads the list", async () => {
  const twin = task({ status: "running", startedAt: "2026-11-03T17:07:00Z" });
  const t = deps(() => ({ ok: false, status: 409, error: "restic-vault already has a running evaluate task", body: { taskId: twin.id, task: twin } }));
  await runRowAction(row(), "evaluate", t.d);
  const note = t.store.get().notes.get(ID);
  assert.deepEqual([note?.tone, note?.text], ["info", "Already running: Evaluate started 3m ago."]);
  assert.equal(t.store.get().announcement.assertive, undefined, "polite, not an alert");
  assert.equal(t.store.pending(ID, "evaluate")?.id, twin.id);
  assert.equal(t.reloads(), 1);
});

test("a failure is an error note and an assertive announcement; only a 409 reloads", async () => {
  const t = deps(() => ({ ok: false, status: 502, error: "candybar.delo.sh: timed out", body: {} }));
  await runRowAction(row(), "enabled", t.d);
  assert.deepEqual(t.store.get().notes.get(ID)?.text, "Disable failed: candybar.delo.sh: timed out (502)");
  assert.equal(t.store.get().announcement.assertive, true);
  assert.equal(t.reloads(), 0);
  const stale = deps(() => ({ ok: false, status: 409, error: "unarchive it first", body: {} }));
  await runRowAction(row({ enabled: false }), "enabled", stale.d);
  assert.equal(stale.store.get().notes.get(ID)?.tone, "error", "a 409 with no twin task is a real refusal");
  assert.equal(stale.reloads(), 1);
});

test("a queued steward task is remembered and announced; a toggle leaves a focus intent for the row's new place", async () => {
  const queued = task({ id: "q1", createdAt: new Date(NOW).toISOString() });
  const s = deps(() => ok({ ok: true, task: queued }));
  assert.equal(await runRowAction(row(), "evaluate", s.d), "sent");
  assert.equal(s.sent[0].path, "steward");
  assert.deepEqual(s.sent[0].body, { action: "evaluate" });
  assert.equal(s.store.pending(ID, "evaluate")?.id, "q1");
  assert.match(s.store.get().announcement.text, /Evaluate of restic-vault queued/);
  assert.equal(stewardControl(row(), "evaluate", NOW, { pending: s.store.pending(ID, "evaluate") }).label, "Evaluate queued 0s");

  const d = deps(() => ok({ ok: true, enabled: false }));
  await runRowAction(row(), "enabled", d.d);
  assert.deepEqual(d.sent[0], { id: ID, path: "enabled", body: { enabled: false } });
  assert.match(d.confirms[0], /^Disable restic-vault\?/);
  assert.deepEqual(d.store.focusIntent(NOW), { candybarId: ID, key: "enabled", until: NOW + FOCUS_INTENT_MS });
  assert.equal(d.store.focusIntent(NOW + FOCUS_INTENT_MS + 1), undefined, "the intent expires");
  assert.match(d.store.get().notes.get(ID)?.text ?? "", /listed under Inactive/);
});

test("a steward button that is off says why instead of sending", async () => {
  const t = deps(() => ok());
  assert.equal(await runRowAction(row({ tasks: undefined }), "enrich", t.d), "blocked");
  assert.equal(t.sent.length, 0);
  assert.match(t.store.get().announcement.text, /Steward tasks could not be read/);
  const running = row({ tasks: { active: [task({ status: "running", startedAt: "2026-11-03T17:00:00Z" })], latest: {} } });
  assert.equal(await runRowAction(running, "evaluate", t.d), "blocked");
  assert.equal(t.sent.length, 0);
});

test("the store forgets a queued task once the list shows it, and the live text changes even for the same words", () => {
  const store = createActionStore();
  const q = task({ id: "q1" });
  store.remember(q);
  store.reconcile([{ id: ID, tasks: { active: [], latest: {} } }]);
  assert.equal(store.pending(ID, "evaluate")?.id, "q1");
  store.reconcile([{ id: ID, tasks: { active: [q], latest: { evaluate: q } } }]);
  assert.equal(store.pending(ID, "evaluate"), undefined);
  store.announce("Marked x as noise.");
  const a = liveText(store.get().announcement);
  store.announce("Marked x as noise.");
  assert.notEqual(liveText(store.get().announcement), a);
  assert.equal(liveText(store.get().announcement).trim(), a.trim());
});

// ---------- Schedule row actions ----------

const fire = (over: Partial<Fire> = {}): Fire => ({
  key: `${ID}@2026-11-04T03:07:00+00:00`, candybarId: ID, name: "newapi-staff-sso", schedule: "7 * * * *", fireTime: "2026-11-04T03:07:00+00:00",
  t: Date.parse("2026-11-04T03:07:00Z"), state: "upcoming", skipped: false, noise: false, timezone: "UTC", ...over
});
function fireDeps(answer: (s: Sent) => ActionResult | Promise<ActionResult>, over: Partial<FireDeps> = {}) {
  const sent: Sent[] = [];
  const confirms: string[] = [];
  const events: string[] = [];
  const d: FireDeps = {
    store: createActionStore(),
    post: async (id, path, body) => {
      const s = { id, path, body };
      sent.push(s);
      return answer(s);
    },
    confirm: (t) => (confirms.push(t), true),
    zone: "UTC",
    viewer: "America/New_York",
    viewEnd: Date.parse("2026-11-04T05:00:00Z"),
    showNoise: false,
    clock: (t) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(t),
    now: () => Date.parse("2026-11-04T03:00:00Z"),
    onSkipped: (k) => events.push(`skipped ${k}`),
    onNoise: (id, n) => events.push(`noise ${n}`),
    onRefetch: () => events.push("refetch"),
    onError: (t) => events.push(`error ${t}`),
    ...over
  };
  return { d, sent, confirms, events };
}

test("Skip rest of day names the date, the zone and the hours of your day it covers, and sends the date you saw", async () => {
  const t = fireDeps(() => ok({ ok: true, skipped: true, date: "2026-11-04", timezone: "UTC" }));
  assert.equal(await runFireAction(fire(), "rest", t.d), "sent");
  assert.equal(
    t.confirms[0],
    "Skip every fire of newapi-staff-sso on 2026-11-04 (UTC), 7:00 PM tonight to 7:00 PM tomorrow EST?\n\nThis view lists only your day, so the fires after midnight are skipped without showing here."
  );
  assert.deepEqual(t.sent[0].body, { fireTime: "2026-11-04T03:07:00+00:00", expectDate: "2026-11-04" });
  assert.deepEqual(t.events, ["refetch"]);
  assert.equal(t.d.store.get().announcement.text, "Skipped every fire of newapi-staff-sso on 2026-11-04 (UTC).");
  const dismissed = fireDeps(() => ok(), { confirm: () => false });
  assert.equal(await runFireAction(fire(), "rest", dismissed.d), "dismissed");
  assert.equal(dismissed.sent.length, 0);
});

test("Skip marks the row, Mark noise flips it and says the row is now hidden; a failure is reported", async () => {
  const t = fireDeps(() => ok({ ok: true }));
  await runFireAction(fire(), "skip", t.d);
  assert.deepEqual(t.sent[0], { id: ID, path: "skip", body: { fireTime: "2026-11-04T03:07:00+00:00" } });
  assert.equal(t.d.store.get().announcement.text, "Skipped newapi-staff-sso at 10:07 PM.");
  await runFireAction(fire(), "noise", t.d);
  assert.deepEqual(t.sent[1].body, { noise: true });
  assert.match(t.d.store.get().announcement.text, /Its fires are hidden now; tick Show noise/);
  assert.deepEqual(t.events, [`skipped ${fire().key}`, "noise true"]);
  const bad = fireDeps(() => ({ ok: false, status: 404, error: "no candybar", body: {} }));
  await runFireAction(fire({ noise: true }), "noise", bad.d);
  assert.deepEqual(bad.events, ["error Unmark noise failed for newapi-staff-sso: no candybar (404)"]);
  assert.equal(bad.d.store.get().announcement.assertive, true);
});

test("each fire's skip is its own busy key; noise is the candybar's (shared with Definitions)", async () => {
  const waiting: Array<(r: ActionResult) => void> = [];
  const release = (r: ActionResult) => waiting.shift()?.(r);
  const t = fireDeps(() => new Promise<ActionResult>((r) => void waiting.push(r)));
  const a = fire();
  const b = fire({ key: `${ID}@2026-11-04T04:07:00+00:00`, fireTime: "2026-11-04T04:07:00+00:00", t: Date.parse("2026-11-04T04:07:00Z") });
  const first = runFireAction(a, "skip", t.d);
  assert.equal(await runFireAction(a, "skip", t.d), "busy", "no double submit");
  const second = runFireAction(b, "skip", t.d);
  assert.equal(t.sent.length, 2, "another fire of the same candybar is not blocked");
  assert.equal(fireActionKey(a, "noise"), `${ID}:noise`);
  release(ok());
  await first;
  assert.equal(t.d.store.isBusy(fireActionKey(b, "skip")), true, "the second is still in flight after the first finished");
  release(ok());
  await second;
  assert.deepEqual(fireActionsFor({ state: "past", skipped: false }), ["noise"]);
  assert.deepEqual(fireActionsFor({ state: "upcoming", skipped: true }), ["noise"]);
  assert.equal(await runFireAction(fire({ state: "past" }), "skip", t.d), "blocked");
});

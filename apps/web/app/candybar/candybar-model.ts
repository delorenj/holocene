import type { CandybarPayload, CandybarRow, Evaluation, RunResult, Task, TaskAction, ViewId } from "./types";

// Pure helpers for the Definitions tab's row actions and signals, and the decisions behind the action bar and the
// Schedule row actions (labels, what is disabled and why, what a confirm says, what a result says). DOM-free so they
// are tested directly.

export const HISTORY_SLOTS = 30;

export type HistorySummary = { total: number; passed: number; failed: number; running: number; label: string };

/** "Last 30 runs: 24 passed, 6 failed"; running ones are named only when there are some. */
export function summarizeHistory(history: RunResult[] | undefined): HistorySummary {
  const h = history ?? [];
  const passed = h.filter((r) => r === "success").length;
  const failed = h.filter((r) => r === "fail").length;
  const running = h.filter((r) => r === "running").length;
  if (!h.length) return { total: 0, passed, failed, running, label: "No runs recorded yet" };
  const parts = [`${passed} passed`, `${failed} failed`, ...(running ? [`${running} running`] : [])];
  return { total: h.length, passed, failed, running, label: `Last ${h.length} ${h.length === 1 ? "run" : "runs"}: ${parts.join(", ")}` };
}

/** Exactly `slots` cells, oldest left. Missing runs are empty cells on the left, so the newest run is always at the right edge. */
export function padHistory(history: RunResult[] | undefined, slots = HISTORY_SLOTS): Array<RunResult | null> {
  const h = (history ?? []).slice(-slots);
  return [...Array<null>(slots - h.length).fill(null), ...h];
}

/** Fix is offered when the last run failed, or at least 3 of the last 10 failed; never for an archived candybar. */
export function canFix(c: Pick<CandybarRow, "archived" | "lastRun" | "history">): boolean {
  if (c.archived) return false;
  if (c.lastRun?.result === "fail") return true;
  return (c.history ?? []).slice(-10).filter((r) => r === "fail").length >= 3;
}

export const UNCLASSIFIED = "Unclassified";
export const UNKNOWN_PROJECT = "Unknown (profiles unavailable)";

export type Group<T> = { key: string; label: string; items: T[] };

export const projectOf = (c: Pick<CandybarRow, "profile">): string | undefined => c.profile?.project?.name || undefined;

/**
 * One group per project, A to Z, then "Unclassified" (read, no project), then "Unknown" (the profiles could not be
 * read, so the project is not known either way). Items keep the order they came in.
 */
export function groupByProject<T extends Pick<CandybarRow, "profile">>(rows: T[]): Array<Group<T>> {
  const groups = new Map<string, Group<T>>();
  for (const row of rows) {
    const name = projectOf(row);
    const key = row.profile === undefined ? "unknown" : name ? `p:${name}` : "unclassified";
    const g = groups.get(key) ?? { key, label: key === "unknown" ? UNKNOWN_PROJECT : name ?? UNCLASSIFIED, items: [] };
    g.items.push(row);
    groups.set(key, g);
  }
  const rank = (g: Group<T>) => (g.key === "unknown" ? 2 : g.key === "unclassified" ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export const ACTION_LABEL: Record<TaskAction, string> = { enrich: "Enrich", evaluate: "Evaluate", fix: "Fix", refactor: "Refactor" };
const ING: Record<TaskAction, string> = { enrich: "Enriching", evaluate: "Evaluating", fix: "Fixing", refactor: "Refactoring" };

/** "45s", "4m", "1h 05m", "2d 03h": the hub's duration words, kept here so the model stays DOM-free. */
export function age(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${pad(m % 60)}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d >= 10 ? `${d}d` : `${d}d ${pad(h % 24)}h`;
}

/** A queued task older than this has probably not been picked up: the steward may be down. */
export const QUEUED_STALE_S = 120;

const secondsSince = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
};

/** How long a task has been in its state: running since it started, queued since it was created. */
export function taskAge(t: Pick<Task, "status" | "createdAt" | "startedAt">, now: number): number {
  return secondsSince(t.status === "running" ? t.startedAt ?? t.createdAt : t.createdAt, now);
}

/** A task in flight: running ones read "Evaluating 4m", queued ones "Evaluate queued 2m". Without `now`, no age. */
export function taskChipLabel(t: Pick<Task, "action" | "status" | "createdAt" | "startedAt">, now?: number): string {
  const when = now === undefined ? "" : ` ${age(taskAge(t, now))}`;
  return t.status === "running" ? `${ING[t.action]}${when}` : `${ACTION_LABEL[t.action]} queued${when}`;
}

export const isStaleQueued = (t: Pick<Task, "status" | "createdAt" | "startedAt">, now: number) => t.status === "queued" && taskAge(t, now) > QUEUED_STALE_S;

/** "queued 5m: the steward may be down. You can cancel it." once a task has waited past QUEUED_STALE_S. */
export const staleHint = (t: Pick<Task, "status" | "createdAt" | "startedAt">, now: number) =>
  `queued ${age(taskAge(t, now))}: the steward (candybar-steward) may be down. You can cancel it.`;

export function activeActions(c: Pick<CandybarRow, "tasks">): Set<TaskAction> {
  return new Set((c.tasks?.active ?? []).map((t) => t.action));
}

/**
 * The task of `action` still in flight for this row: the list's own (running before queued), else one this page just
 * queued (`pending`, from the POST's 202) that the list has not caught up with yet. The list has caught up once its
 * newest task of that action is the pending one or a later one.
 */
export function inFlight(c: Pick<CandybarRow, "tasks">, action: TaskAction, pending?: Task): Task | undefined {
  const listed = (c.tasks?.active ?? []).filter((t) => t.action === action);
  const own = listed.find((t) => t.status === "running") ?? listed[0];
  if (own) return own;
  if (!pending || pending.action !== action) return undefined;
  const latest = c.tasks?.latest[action];
  if (latest && (latest.id === pending.id || Date.parse(latest.createdAt) >= Date.parse(pending.createdAt))) return undefined;
  return pending;
}

export const TASK_ACTIONS: TaskAction[] = ["enrich", "evaluate", "fix", "refactor"];

/** Every task still in flight for this row (one per action at most), the page's just-queued ones included. */
export function inFlightTasks(c: Pick<CandybarRow, "tasks">, pendingOf: (action: TaskAction) => Task | undefined = () => undefined): Task[] {
  return TASK_ACTIONS.map((a) => inFlight(c, a, pendingOf(a))).filter((t): t is Task => t !== undefined);
}

/** Why the steward buttons cannot be trusted right now, or undefined when they can. */
export function stewardUnavailable(c: Pick<CandybarRow, "tasks" | "profile">): string | undefined {
  if (c.tasks === undefined) return "Steward tasks could not be read from Candybar, so Holocene cannot tell whether one is already queued.";
  if (c.profile === undefined) return "Profiles could not be read from Candybar, so its steward may not be reachable.";
  return undefined;
}

export type Control = {
  label: string;
  /** Rendered as aria-disabled: the button keeps focus and stays in the tab order. */
  disabled: boolean;
  busy: boolean;
  /** Said beside the bar (and by aria-describedby) when the button is off or the steward looks stuck. */
  reason?: string;
  /** True when the reason is a warning (a queued task nobody picked up). */
  warn?: boolean;
  task?: Task;
};

/** The state of one steward button (Enrich, Evaluate, Fix). */
export function stewardControl(
  c: Pick<CandybarRow, "tasks" | "profile">,
  action: Exclude<TaskAction, "refactor">,
  now: number,
  opts: { pending?: Task; busy?: boolean } = {}
): Control {
  const label = ACTION_LABEL[action];
  if (opts.busy) return { label: "Queuing…", disabled: true, busy: true };
  const unavailable = stewardUnavailable(c);
  if (unavailable) return { label, disabled: true, busy: false, reason: unavailable };
  const task = inFlight(c, action, opts.pending);
  if (!task) {
    // Candybar refuses a fix while a refactor is queued or running (one change to a job at a time).
    const refactor = action === "fix" ? inFlight(c, "refactor") : undefined;
    if (refactor) return { label, disabled: true, busy: false, reason: `${taskChipLabel(refactor, now)}: Fix waits until it ends (one change to a job at a time).` };
    return { label, disabled: false, busy: false };
  }
  const stale = isStaleQueued(task, now);
  return {
    label: taskChipLabel(task, now),
    disabled: true,
    busy: false,
    task,
    ...(stale ? { reason: `${label} ${staleHint(task, now)}`, warn: true } : {})
  };
}

/**
 * Whether the Fix button is on the bar. Fix is offered while the job is failing (canFix), and it STAYS while a fix is
 * queued, running or being requested, even if the proving run turned the last result green: the button carries the
 * task's state, and a button that vanishes mid-task drops the operator's focus. Never for an archived candybar.
 */
export function fixOffered(c: Pick<CandybarRow, "archived" | "lastRun" | "history">, ctl: Pick<Control, "task" | "busy">): boolean {
  if (c.archived) return false;
  return canFix(c) || ctl.task !== undefined || ctl.busy;
}

// ---------- cancelling a steward task ----------

export const cancelLabel = (t: Pick<Task, "action">) => `Cancel ${ACTION_LABEL[t.action].toLowerCase()}`;

/** Asked before a task is cancelled: what happens to a queued one and to one already running. */
export function cancelConfirm(name: string, t: Pick<Task, "action" | "status">): string {
  const verb = ACTION_LABEL[t.action].toLowerCase();
  const mutates = t.action === "fix" || t.action === "refactor";
  const body =
    t.status === "running"
      ? `The task ends as failed ("cancelled by operator"). The steward stops the agent within a minute.${mutates ? " Anything it already committed or pushed stays." : ""}`
      : `It has not started. The task ends as failed ("cancelled by operator") and never runs.`;
  return `Cancel the ${verb} of ${name}?\n\n${body}`;
}

export const cancelledNote = (name: string, t: Pick<Task, "action" | "status">) =>
  `Cancelled the ${ACTION_LABEL[t.action].toLowerCase()} of ${name}. It ends as failed (cancelled by operator).${t.status === "running" ? " The steward stops the agent within a minute." : ""}`;

/** The repo a Fix commits to, when the steward's overview names it. */
export const repoOf = (c: Pick<CandybarRow, "profile">): string | undefined => c.profile?.overview?.source.repo || undefined;

export type ActionKey = "enrich" | "evaluate" | "fix" | "noise" | "enabled" | "archived";

/** What one click will do, asked first for every action that changes something beyond Candybar's own notes. */
export function confirmText(c: Pick<CandybarRow, "name" | "enabled" | "archived" | "profile">, key: ActionKey): string | undefined {
  switch (key) {
    case "fix": {
      const repo = repoOf(c);
      return `Fix ${c.name}?\n\nAn agent reads its recent failures, then commits and pushes a repair straight to main in ${repo ? repo : "the job's repo"}, and runs ${c.name} once to prove it. It works on its own for up to 30 minutes.`;
    }
    case "evaluate":
      return `Evaluate ${c.name}?\n\nAn adversarial review of whether it still earns its place, and its verdict acts on its own: Suboptimal queues a refactor (code or schedule changes, committed and pushed), Drifted queues a fix, Orphaned archives the candybar. A protected candybar (a canary, smoke, watchdog or policy job, a backup, or one named in the scheduling policy) is only flagged for you, never archived.`;
    case "enabled":
      return c.enabled ? `Disable ${c.name}?\n\nIt stops firing until you enable it again. Nothing is deleted.` : undefined;
    case "archived":
      return c.archived ? undefined : `Archive ${c.name}?\n\nIt is disabled and leaves the lists and the schedule. Unarchive from the Archived view brings it back (disabled until you enable it).`;
    default:
      return undefined;
  }
}

/** Where a row lives after a change, for moving focus there when it left the current view. */
export function homeView(c: Pick<CandybarRow, "archived" | "enabled">): Exclude<ViewId, "all" | "failing"> {
  return c.archived ? "archived" : c.enabled ? "active" : "inactive";
}

/** What a successful toggle says (announced, and shown in the panel). */
export function doneNote(name: string, key: "noise" | "enabled" | "archived", value: boolean): string {
  if (key === "noise") return value ? `Marked ${name} as noise.` : `${name} is no longer noise.`;
  if (key === "enabled") return value ? `Enabled ${name}. It fires on schedule again.` : `Disabled ${name}. It no longer fires; it is listed under Inactive.`;
  return value
    ? `Archived ${name}. It left the lists and the schedule; it is in the Archived view.`
    : `Unarchived ${name}. It stays disabled until you enable it; it is listed under Inactive.`;
}

/** A steward 409 for a twin task is information, not a failure: "Already running: Evaluate started 3m ago". */
export function conflictNote(action: TaskAction, twin: Pick<Task, "status" | "createdAt" | "startedAt" | "action"> | undefined, now: number): string {
  if (!twin) return `Already queued or running: ${ACTION_LABEL[action]}.`;
  // A fix is also refused while a refactor is in flight (one change to a job at a time): the twin says which.
  const label = ACTION_LABEL[twin.action ?? action];
  const other = twin.action && twin.action !== action ? " One change to a job at a time." : "";
  if (twin.status === "running") return `Already running: ${label} started ${age(taskAge(twin, now))} ago.${other}`;
  const queued = `Already queued: ${label} queued ${age(taskAge(twin, now))} ago.${other}`;
  return isStaleQueued(twin, now) ? `${queued} The steward may be down; you can cancel it.` : queued;
}

/** What a steward request said when it was queued. */
export const queuedNote = (name: string, action: TaskAction) => `${ACTION_LABEL[action]} of ${name} queued. The steward picks it up shortly.`;

// ---------- one change to a candybar at a time (N7) ----------

export const TOGGLE_KEYS = ["noise", "enabled", "archived"] as const;
export type ToggleKey = (typeof TOGGLE_KEYS)[number];
export const isToggleKey = (key: string): key is ToggleKey => (TOGGLE_KEYS as readonly string[]).includes(key);

/** The state-changing toggle (noise, enable or disable, archive) with a request in flight for this candybar. */
export function toggleInFlight(busy: ReadonlySet<string>, candybarId: string): ToggleKey | undefined {
  return TOGGLE_KEYS.find((k) => busy.has(`${candybarId}:${k}`));
}

const PROGRESS: Record<ToggleKey, [string, string]> = {
  noise: ["Marking noise", "Unmarking noise"],
  enabled: ["Enabling", "Disabling"],
  archived: ["Archiving", "Unarchiving"]
};

/** "Disabling is in progress; one change to a candybar at a time." The reason the other toggles are aria-disabled. */
export function toggleBlockedReason(c: Pick<CandybarRow, "noise" | "enabled" | "archived">, running: ToggleKey): string {
  const on = running === "noise" ? c.noise : running === "enabled" ? c.enabled : c.archived;
  return `${PROGRESS[running][on ? 1 : 0]} is in progress; one change to a candybar at a time.`;
}

/** How long a result stays on the panel: a failure is read once and cleared; the rest linger a little longer. */
export const ERROR_NOTE_MS = 10_000;
export const NOTE_MS = 30_000;
export const noteVisible = (note: { tone: "error" | "info" | "done"; at: number }, now: number) => now - note.at < (note.tone === "error" ? ERROR_NOTE_MS : NOTE_MS);

// ---------- stale steward data (N4) ----------

/** "Profiles and steward tasks are 40s old (Candybar did not answer the last read)." Undefined when both are fresh. */
export function staleNote(stale: CandybarPayload["stale"], generatedAt: string, now: number): string | undefined {
  if (!stale || (stale.profiles === undefined && stale.tasks === undefined)) return undefined;
  const since = secondsSince(generatedAt, now);
  const profiles = stale.profiles === undefined ? undefined : age(stale.profiles + since);
  const tasks = stale.tasks === undefined ? undefined : age(stale.tasks + since);
  const what =
    profiles !== undefined && tasks !== undefined
      ? profiles === tasks ? `Profiles and steward tasks are ${profiles} old` : `Profiles are ${profiles} old and steward tasks are ${tasks} old`
      : profiles !== undefined ? `Profiles are ${profiles} old` : `Steward tasks are ${tasks} old`;
  return `${what} (Candybar did not answer the last read). The buttons use the last good read; Candybar still refuses a duplicate task.`;
}

// ---------- the steward's notes ----------

// Candybar's follow-up statuses are queued, done, flagged (left for the operator: a protected candybar is not
// archived, a refactor that was not applied is not retried) and failed; a child task's own status maps onto them.
const FOLLOW_UP_STATUS: Record<string, string> = {
  queued: "queued",
  running: "running",
  done: "done",
  succeeded: "done",
  failed: "failed",
  skipped: "skipped"
};
const flagged = (followUp: Evaluation["followUp"]) => (followUp === "archive" ? "flagged: protected, not archived" : "flagged for you to decide");

type Kid = Pick<Task, "status" | "parentTaskId" | "outcome"> & { id?: string };
/** The follow-up task of THIS evaluation: named by followUpTaskId, else the one whose parent is the evaluation's task. */
const childOf = (e: Pick<Evaluation, "followUpTaskId" | "taskId">, child?: Kid): Kid | undefined =>
  child && ((e.followUpTaskId && child.id === e.followUpTaskId) || (e.taskId && child.parentTaskId === e.taskId)) ? child : undefined;

/** What a finished follow-up task's own outcome says: the status Candybar would record, and the words for it. */
const CHILD_OUTCOME: Record<string, [status: string, words: string]> = {
  done: ["done", "done"],
  done_proven: ["done", "done"],
  fixed: ["done", "fixed"],
  done_not_proven: ["failed", "done, not proven"],
  not_fixed: ["failed", "not fixed"],
  not_applied: ["flagged", "not applied, flagged for you to decide"]
};

function fromChild(kid: Kid): [status: string, words: string] | undefined {
  if (kid.status === "queued" || kid.status === "running") return [kid.status, kid.status];
  if (kid.status === "failed") return ["failed", "failed"];
  return CHILD_OUTCOME[kid.outcome ?? ""] ?? ["done", "done"];
}

/** The follow-up's status: Candybar's followUpStatus, else what the follow-up task itself says. */
export function followUpStatusOf(e: Pick<Evaluation, "followUp" | "followUpStatus" | "followUpTaskId" | "taskId">, child?: Kid): string | undefined {
  if (e.followUp === "none") return undefined;
  const kid = childOf(e, child);
  return e.followUpStatus ?? (kid ? fromChild(kid)?.[0] : undefined);
}

/**
 * "refactor queued", "refactor done", "archive flagged: protected, not archived"; "none" when nothing follows. Without
 * a stored followUpStatus (an older Candybar), the follow-up task itself says how far it got and with what outcome: a
 * refactor that succeeded but was not applied is flagged for the operator, not done; one not proven is "done, not
 * proven"; a fix reads "fixed" or "not fixed".
 */
export function followUpLabel(e: Pick<Evaluation, "followUp" | "followUpStatus" | "followUpTaskId" | "taskId">, child?: Kid): string {
  if (e.followUp === "none") return "none";
  const kid = childOf(e, child);
  if (e.followUpStatus) {
    if (e.followUpStatus === "flagged") return `${e.followUp} ${e.followUp !== "archive" && kid?.outcome === "not_applied" ? "not applied, flagged for you to decide" : flagged(e.followUp)}`;
    return `${e.followUp} ${FOLLOW_UP_STATUS[e.followUpStatus] ?? e.followUpStatus.replace(/_/g, " ")}`;
  }
  const own = kid ? fromChild(kid) : undefined;
  return own ? `${e.followUp} ${own[1]}` : e.followUp;
}

const OUTCOME_WORD: Record<string, string> = {
  done: "done",
  done_proven: "done, proven by a run",
  done_not_proven: "done, not proven",
  not_applied: "not applied",
  fixed: "fixed",
  not_fixed: "not fixed",
  flagged: "flagged"
};

/** A task outcome in words: evaluation outcomes stay as they are (Suboptimal), the rest lose their underscores. */
export const taskOutcomeLabel = (outcome: string): string => OUTCOME_WORD[outcome] ?? outcome.replace(/_/g, " ");

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const COUNT = new Intl.NumberFormat("en-US");

/** "$0.4213 · 1,540 tokens" when Candybar recorded either; undefined otherwise. */
export function taskSpend(t: Pick<Task, "costUsd" | "tokens">): string | undefined {
  const parts: string[] = [];
  if (t.costUsd !== undefined) parts.push(USD.format(t.costUsd));
  const k = t.tokens;
  const total = k ? k.total ?? (k.input ?? 0) + (k.output ?? 0) + (k.reasoning ?? 0) : undefined;
  if (total) parts.push(`${COUNT.format(total)} tokens`);
  return parts.length ? parts.join(" · ") : undefined;
}

// ---------- the row's accessible name ----------

/** The row button's name, kept short: name, state, next fire. Everything else is its description. */
export function rowName(c: Pick<CandybarRow, "name" | "enabled" | "archived" | "nextFire" | "lastRun">, now: number, windowKnown: boolean): string {
  const state = c.archived ? "archived" : !c.enabled ? "inactive" : c.lastRun?.result === "fail" ? "failing" : "active";
  let next: string;
  if (c.archived || !c.enabled) next = "not scheduled";
  else if (!windowKnown) next = "next fire unknown";
  else if (!c.nextFire) next = "no fire within 24 hours";
  else {
    const s = (Date.parse(c.nextFire) - now) / 1000;
    next = s <= 0 ? "due now" : `next fire in ${age(s)}`;
  }
  return `${c.name}, ${state}, ${next}`;
}

/** The row button's description: what the collapsed row shows beyond its name. */
export function rowDescription(c: CandybarRow, now: number): string {
  const parts: string[] = [];
  if (c.description) parts.push(c.description);
  if (c.lastRun === null) parts.push("Never run.");
  else if (c.lastRun) {
    const word = c.lastRun.result === "success" ? "passed" : c.lastRun.result === "fail" ? "failed" : "is running";
    parts.push(`Last run ${word}.`);
  }
  if (c.history) parts.push(`${summarizeHistory(c.history).label}.`);
  const task = (c.tasks?.active ?? []).find((t) => t.status === "running") ?? c.tasks?.active[0];
  if (task) parts.push(`${taskChipLabel(task, now)}.`);
  if (c.profile?.evaluation) parts.push(`Evaluation: ${c.profile.evaluation.outcome}.`);
  const project = projectOf(c);
  if (project) parts.push(`Project ${project}.`);
  if (c.noise) parts.push("Noise.");
  return parts.join(" ");
}

/** Counts per view. Archived rows belong to Archived alone. */
export function splitViews<T extends Pick<CandybarRow, "archived" | "enabled" | "lastRun">>(rows: T[]) {
  const live = rows.filter((c) => !c.archived);
  return {
    active: live.filter((c) => c.enabled),
    inactive: live.filter((c) => !c.enabled),
    failing: live.filter((c) => c.enabled && c.lastRun?.result === "fail"),
    archived: rows.filter((c) => c.archived)
  };
}

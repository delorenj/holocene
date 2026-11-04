import type { ActionResult } from "./candybar-api";
import {
  ACTION_LABEL,
  cancelConfirm,
  cancelledNote,
  confirmText,
  conflictNote,
  doneNote,
  isToggleKey,
  queuedNote,
  stewardControl,
  toggleBlockedReason,
  toggleInFlight,
  type ActionKey
} from "./candybar-model";
import { actionKey, type ActionStore } from "./action-store";
import type { CandybarRow, Task } from "./types";

// One click on the Definitions action bar, start to finish, with every side effect behind a dependency so it is
// tested without a DOM: the confirm, the request, what the store learns (busy key, queued task, the note and the
// announcement, where focus goes) and the list reload.

export type RunDeps = {
  store: ActionStore;
  post: (candybarId: string, path: string, body: Record<string, unknown>) => Promise<ActionResult>;
  confirm: (text: string) => boolean;
  onChanged: () => void;
  now?: () => number;
};

export type RunOutcome = "sent" | "dismissed" | "busy" | "blocked";

type Row = Pick<CandybarRow, "id" | "name" | "enabled" | "archived" | "noise" | "profile" | "tasks">;

const isStewardKey = (key: ActionKey): key is "enrich" | "evaluate" | "fix" => key === "enrich" || key === "evaluate" || key === "fix";

const TOGGLE_WORD: Record<"noise" | "enabled" | "archived", [string, string]> = {
  noise: ["Mark noise", "Unmark noise"],
  enabled: ["Enable", "Disable"],
  archived: ["Archive", "Unarchive"]
};
/** The verb for a toggle about to set `value`: Mark noise / Unmark noise, Enable / Disable, Archive / Unarchive. */
export const toggleWord = (key: "noise" | "enabled" | "archived", value: boolean) => TOGGLE_WORD[key][value ? 0 : 1];

/** A task from an API body, or undefined when it is not one (the shape is the API's allowlisted Task). */
export function asTask(v: unknown): Task | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Record<string, unknown>;
  const ok = ["id", "candybarId", "action", "status", "createdAt"].every((k) => typeof t[k] === "string");
  return ok ? (t as unknown as Task) : undefined;
}

export async function runRowAction(c: Row, key: ActionKey, deps: RunDeps): Promise<RunOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const k = actionKey(c.id, key);
  if (store.isBusy(k)) return "busy";
  // One state-changing action per candybar at a time (noise, enable or disable, archive): a second one would race the
  // first, and Candybar would answer the loser with a confusing 409. The button says why it is off.
  if (isToggleKey(key)) {
    const running = toggleInFlight(store.get().busy, c.id);
    if (running) {
      store.announce(toggleBlockedReason(c, running));
      return "blocked";
    }
  }
  if (isStewardKey(key)) {
    // A button that is off (aria-disabled, so it still takes the click) says why instead of sending.
    const ctl = stewardControl(c, key, now(), { pending: store.pending(c.id, key) });
    if (ctl.disabled) {
      store.announce(ctl.reason ?? `${ctl.label}.`);
      return "blocked";
    }
  }
  const text = confirmText(c, key);
  if (text && !deps.confirm(text)) return "dismissed";
  // A second click while the confirm was open (or while the first request runs) sends nothing.
  if (isToggleKey(key) && toggleInFlight(store.get().busy, c.id)) return "blocked";
  if (!store.begin(k)) return "busy";
  store.note(c.id, undefined, now());
  const value = key === "noise" ? !c.noise : key === "enabled" ? !c.enabled : key === "archived" ? !c.archived : undefined;
  let r: ActionResult;
  try {
    r = isStewardKey(key) ? await deps.post(c.id, "steward", { action: key }) : await deps.post(c.id, key, { [key]: value });
  } finally {
    store.end(k);
  }

  if (!r.ok) {
    if (isStewardKey(key) && r.status === 409 && typeof r.body.taskId === "string") {
      // A twin already queued or running: information, and the list reloads to show it.
      const twin = asTask(r.body.task);
      if (twin) store.remember(twin);
      const info = conflictNote(key, twin, now());
      store.note(c.id, { tone: "info", text: info }, now());
      store.announce(info);
      deps.onChanged();
      return "sent";
    }
    const label = isStewardKey(key) ? ACTION_LABEL[key] : toggleWord(key, value!);
    const error = `${label} failed: ${r.error}${r.status ? ` (${r.status})` : ""}`;
    store.note(c.id, { tone: "error", text: error }, now());
    store.announce(error, true);
    // Any other 409 means the view is stale (archived meanwhile, say): show what is true now.
    if (r.status === 409) deps.onChanged();
    return "sent";
  }

  if (isStewardKey(key)) {
    const task = asTask(r.body.task);
    if (task) store.remember(task);
    const done = queuedNote(c.name, key);
    store.note(c.id, { tone: "done", text: done }, now());
    store.announce(done);
  } else {
    const done = doneNote(c.name, key, value!);
    store.note(c.id, { tone: "done", text: done }, now());
    store.announce(done);
    // Disable, enable, archive and unarchive move the row to another section (or out of the view): focus follows it.
    store.intendFocus(c.id, key, now());
  }
  deps.onChanged();
  return "sent";
}

export type CancelDeps = Pick<RunDeps, "store" | "confirm" | "onChanged" | "now"> & {
  cancel: (taskId: string) => Promise<ActionResult>;
};

/**
 * Cancels a queued or running steward task, after asking. Candybar settles it as failed ("cancelled by operator"); the
 * steward stops a run in progress within a minute. A 409 means it had already finished: information, and the list
 * reloads. The busy key is the task's, so a second click sends nothing.
 */
export async function runCancel(c: Pick<Row, "id" | "name">, task: Task, deps: CancelDeps): Promise<RunOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const k = actionKey(c.id, "cancel", task.id);
  if (store.isBusy(k)) return "busy";
  if (!deps.confirm(cancelConfirm(c.name, task))) return "dismissed";
  if (!store.begin(k)) return "busy";
  store.note(c.id, undefined, now());
  let r: ActionResult;
  try {
    r = await deps.cancel(task.id);
  } finally {
    store.end(k);
  }
  const verb = ACTION_LABEL[task.action].toLowerCase();
  if (!r.ok) {
    if (r.status === 409) {
      const text = `The ${verb} of ${c.name} had already finished, so there was nothing to cancel.`;
      store.note(c.id, { tone: "info", text }, now());
      store.announce(text);
      store.forget(task.id);
      deps.onChanged();
      return "sent";
    }
    const text = `Cancel ${verb} failed: ${r.error}${r.status ? ` (${r.status})` : ""}`;
    store.note(c.id, { tone: "error", text }, now());
    store.announce(text, true);
    if (r.status === 404) deps.onChanged();
    return "sent";
  }
  store.forget(task.id);
  const text = cancelledNote(c.name, task);
  store.note(c.id, { tone: "done", text }, now());
  store.announce(text);
  deps.onChanged();
  return "sent";
}

"use client";

import { useSyncExternalStore } from "react";
import { postAction, postCancel } from "./candybar-api";
import {
  cancelLabel,
  fixOffered,
  inFlightTasks,
  noteVisible,
  stewardControl,
  stewardUnavailable,
  toggleBlockedReason,
  toggleInFlight,
  type Control,
  type ToggleKey
} from "./candybar-model";
import { actionKey, actionStore, liveText, type ActionState } from "./action-store";
import { runCancel, runRowAction, toggleWord, type RunDeps } from "./row-actions";
import type { CandybarRow, Task } from "./types";

// The expanded panel's action bar. Real buttons, never nested in the row's own button. A button that cannot act is
// aria-disabled, not disabled, so it keeps focus and its place in the tab order and says why. Busy state, the task just
// queued and the last result live in a page-wide store (action-store.ts), so they survive a collapsed panel and a row
// that moved section. Fix, Evaluate, Disable and Archive ask first and say what will happen; results show here and are
// announced by the page's live region. A task in flight carries a Cancel button beside the steward buttons. Noise,
// enable or disable and archive run one at a time per candybar: while one runs the others are aria-disabled and say why.

export function useActions(): ActionState {
  return useSyncExternalStore(actionStore.subscribe, actionStore.get, actionStore.get);
}

/** The page's live regions: one polite, one for failures. Mounted once, so a row that remounts is still heard. */
export function Announcer() {
  const { announcement } = useActions();
  const text = announcement.seq ? liveText(announcement) : "";
  return (
    <>
      <p className="cb-sr-only" role="status" aria-live="polite">{announcement.assertive ? "" : text}</p>
      <p className="cb-sr-only" role="alert">{announcement.assertive ? text : ""}</p>
    </>
  );
}

export function ActionBar({ c, now, onChanged, stale }: { c: CandybarRow; now: number; onChanged: () => void; stale?: string }) {
  const s = useActions();
  const deps: RunDeps = { store: actionStore, post: postAction, confirm: (t) => window.confirm(t), onChanged };
  const reasonId = (k: string) => `cb-act-why-${c.id}-${k}`;
  const unavailable = stewardUnavailable(c);
  const reasons: Array<{ id: string; text: string; warn?: boolean }> = unavailable ? [{ id: reasonId("steward"), text: unavailable }] : [];
  if (stale) reasons.push({ id: reasonId("stale"), text: stale });

  const control = (action: "enrich" | "evaluate" | "fix"): Control => {
    const k = actionKey(c.id, action);
    return stewardControl(c, action, now, { pending: s.queued.get(k), busy: s.busy.has(k) });
  };

  const steward = (action: "enrich" | "evaluate" | "fix") => {
    const ctl = control(action);
    const why = unavailable ? reasonId("steward") : ctl.reason ? reasonId(action) : undefined;
    if (ctl.reason && !unavailable) reasons.push({ id: reasonId(action), text: ctl.reason, warn: ctl.warn });
    return (
      <button
        key={action}
        type="button"
        className={`cb-act${ctl.task ? ` is-${ctl.task.status}` : ""}${ctl.warn ? " is-warn" : ""}`}
        data-action={action}
        aria-disabled={ctl.disabled || undefined}
        aria-busy={ctl.busy || undefined}
        aria-describedby={why}
        onClick={() => void runRowAction(c, action, deps)}
      >
        {ctl.label}
      </button>
    );
  };

  // One change to a candybar at a time: while a toggle runs, the others are off and say why.
  const running: ToggleKey | undefined = toggleInFlight(s.busy, c.id);
  const blockedReason = running ? toggleBlockedReason(c, running) : undefined;
  if (blockedReason) reasons.push({ id: reasonId("toggle"), text: blockedReason });
  const toggle = (key: ToggleKey, on: boolean, busyWords: [string, string]) => {
    const busy = s.busy.has(actionKey(c.id, key));
    const blocked = !busy && running !== undefined;
    return (
      <button
        type="button"
        className="cb-act"
        data-action={key}
        aria-disabled={busy || blocked || undefined}
        aria-busy={busy || undefined}
        aria-describedby={blocked ? reasonId("toggle") : undefined}
        onClick={() => void runRowAction(c, key, deps)}
      >
        {busy ? busyWords[on ? 1 : 0] : toggleWord(key, !on)}
      </button>
    );
  };

  const cancel = (t: Task) => {
    const busy = s.busy.has(actionKey(c.id, "cancel", t.id));
    return (
      <button
        key={t.id}
        type="button"
        className="cb-act cb-act-cancel"
        data-action="cancel"
        data-task-id={t.id}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => void runCancel(c, t, { store: actionStore, cancel: postCancel, confirm: deps.confirm, onChanged })}
      >
        {busy ? "Cancelling…" : cancelLabel(t)}
      </button>
    );
  };

  const note = s.notes.get(c.id);
  const showNote = note && noteVisible(note, now);
  // Fix stays on the bar while its task is queued or running, even if the proving run turned the job green.
  const fixCtl = control("fix");
  const buttons = (
    <>
      {steward("enrich")}
      {steward("evaluate")}
      {fixOffered(c, fixCtl) ? steward("fix") : null}
      {inFlightTasks(c, (a) => s.queued.get(actionKey(c.id, a))).map(cancel)}
    </>
  );

  return (
    <div className="cb-actions" role="group" aria-label={`Actions for ${c.name}`}>
      <div className="cb-actions-row">
        {buttons}
        <span className="cb-actions-sep" aria-hidden="true" />
        {toggle("noise", c.noise, ["Marking…", "Unmarking…"])}
        {!c.archived ? toggle("enabled", c.enabled, ["Enabling…", "Disabling…"]) : null}
        {toggle("archived", c.archived, ["Archiving…", "Unarchiving…"])}
      </div>
      {reasons.map((r) => (
        <p key={r.id} id={r.id} className={`cb-act-why${r.warn ? " is-warn" : ""}`}>{r.text}</p>
      ))}
      {showNote ? (
        <p className={`cb-act-note is-${note.tone}`}>
          <span className="hub-label">{note.tone === "error" ? "Failed" : note.tone === "info" ? "Note" : "Done"}</span>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

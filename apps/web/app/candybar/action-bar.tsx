"use client";

import { useSyncExternalStore } from "react";
import { postAction } from "./candybar-api";
import { canFix, stewardControl, stewardUnavailable, type Control } from "./candybar-model";
import { actionKey, actionStore, liveText, type ActionState } from "./action-store";
import { runRowAction, toggleWord, type RunDeps } from "./row-actions";
import type { CandybarRow } from "./types";

// The expanded panel's action bar. Real buttons, never nested in the row's own button. A button that cannot act is
// aria-disabled, not disabled, so it keeps focus and its place in the tab order and says why. Busy state, the task just
// queued and the last result live in a page-wide store (action-store.ts), so they survive a collapsed panel and a row
// that moved section. Fix, Evaluate, Disable and Archive ask first and say what will happen; results show here and are
// announced by the page's live region.

const NOTE_MS = 30_000;

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

export function ActionBar({ c, now, onChanged }: { c: CandybarRow; now: number; onChanged: () => void }) {
  const s = useActions();
  const deps: RunDeps = { store: actionStore, post: postAction, confirm: (t) => window.confirm(t), onChanged };
  const reasonId = (k: string) => `cb-act-why-${c.id}-${k}`;
  const unavailable = stewardUnavailable(c);
  const reasons: Array<{ id: string; text: string; warn?: boolean }> = unavailable ? [{ id: reasonId("steward"), text: unavailable }] : [];

  const steward = (action: "enrich" | "evaluate" | "fix") => {
    const k = actionKey(c.id, action);
    const ctl: Control = stewardControl(c, action, now, { pending: s.queued.get(k), busy: s.busy.has(k) });
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

  const toggle = (key: "noise" | "enabled" | "archived", on: boolean, busyWords: [string, string]) => {
    const busy = s.busy.has(actionKey(c.id, key));
    return (
      <button
        type="button"
        className="cb-act"
        data-action={key}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => void runRowAction(c, key, deps)}
      >
        {busy ? busyWords[on ? 1 : 0] : toggleWord(key, !on)}
      </button>
    );
  };

  const note = s.notes.get(c.id);
  const showNote = note && (note.tone === "error" || now - note.at < NOTE_MS);
  const buttons = (
    <>
      {steward("enrich")}
      {steward("evaluate")}
      {canFix(c) ? steward("fix") : null}
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

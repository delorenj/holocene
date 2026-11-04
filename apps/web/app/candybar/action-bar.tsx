"use client";

import { useEffect, useRef, useState } from "react";
import { postAction } from "./candybar-api";
import { ACTION_LABEL, activeActions, canFix } from "./candybar-model";
import type { CandybarRow, TaskAction } from "./types";

// The expanded panel's action bar. Real buttons, never nested in the row's own button. Each shows a busy state and is
// disabled while its request or a task of its action runs; Archive and Disable ask first (the house convention is
// window.confirm); a failure stays inline until the next try; the list reloads after a success.

type Key = "enrich" | "evaluate" | "fix" | "noise" | "enabled" | "archived";
const STEWARD: Array<Extract<Key, TaskAction>> = ["enrich", "evaluate", "fix"];
// A task that was just queued takes a moment to show in the list; the button stays off meanwhile.
const SETTLE_MS = 4_000;

export function ActionBar({ c, onChanged }: { c: CandybarRow; onChanged: () => void }) {
  const [busy, setBusy] = useState<Key | null>(null);
  const [settling, setSettling] = useState<Set<Key>>(new Set());
  const [error, setError] = useState<string>();
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const active = activeActions(c);
  const run = async (key: Key, label: string, path: string, body: Record<string, unknown>, confirmText?: string) => {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setError(undefined);
    const r = await postAction(c.id, path, body);
    setBusy(null);
    if (!r.ok) {
      setError(`${label} failed: ${r.error}${r.status ? ` (${r.status})` : ""}`);
      // A twin task or a stale view: show what is true now.
      if (r.status === 409) onChanged();
      return;
    }
    if (STEWARD.includes(key as never)) {
      setSettling((s) => new Set(s).add(key));
      const t = setTimeout(() => {
        timers.current.delete(t);
        setSettling((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }, SETTLE_MS);
      timers.current.add(t);
    }
    onChanged();
  };

  const steward = (action: Extract<Key, TaskAction>) => {
    const running = active.has(action) || settling.has(action);
    const label = ACTION_LABEL[action];
    return (
      <button
        key={action}
        type="button"
        className="cb-act"
        disabled={busy !== null || running}
        aria-busy={busy === action}
        onClick={() => void run(action, label, "steward", { action })}
      >
        {busy === action ? "Queuing…" : running ? `${label} running…` : label}
      </button>
    );
  };

  const toggle = (key: "noise" | "enabled" | "archived", on: boolean, texts: { on: string; off: string; busyOn: string; busyOff: string }, confirmText?: string) => (
    <button
      type="button"
      className="cb-act"
      disabled={busy !== null}
      aria-busy={busy === key}
      onClick={() => void run(key, on ? texts.off : texts.on, key, { [key]: !on }, confirmText)}
    >
      {busy === key ? (on ? texts.busyOff : texts.busyOn) : on ? texts.off : texts.on}
    </button>
  );

  return (
    <div className="cb-actions" role="group" aria-label={`Actions for ${c.name}`}>
      <div className="cb-actions-row">
        {steward("enrich")}
        {steward("evaluate")}
        {canFix(c) ? steward("fix") : null}
        <span className="cb-actions-sep" aria-hidden="true" />
        {toggle("noise", c.noise, { on: "Mark noise", off: "Unmark noise", busyOn: "Marking…", busyOff: "Unmarking…" })}
        {!c.archived
          ? toggle(
              "enabled",
              c.enabled,
              { on: "Enable", off: "Disable", busyOn: "Enabling…", busyOff: "Disabling…" },
              c.enabled ? `Disable ${c.name}?\n\nIt stops firing until you enable it again. Nothing is deleted.` : undefined
            )
          : null}
        {toggle(
          "archived",
          c.archived,
          { on: "Archive", off: "Unarchive", busyOn: "Archiving…", busyOff: "Unarchiving…" },
          c.archived ? undefined : `Archive ${c.name}?\n\nIt is disabled and leaves the lists and the schedule. Unarchive from the Archived view brings it back (disabled until you enable it).`
        )}
      </div>
      {error ? <p className="hub-error cb-act-error" role="alert"><span className="hub-label">Failed</span>{error}</p> : null}
    </div>
  );
}

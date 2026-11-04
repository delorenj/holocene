"use client";

import { isStaleQueued, padHistory, summarizeHistory, taskChipLabel } from "./candybar-model";
import type { CandybarRow, EvaluationOutcome, RunResult, Task } from "./types";

// Small row signals: the 30-run health strip, the in-flight task chip and the evaluation outcome chip.

/** Thirty tiny squares, oldest left. Success is --cleared, fail --broken, running an outlined --working, empty faint. */
export function RunStrip({ history }: { history: RunResult[] | undefined }) {
  if (history === undefined) return null;
  const { label } = summarizeHistory(history);
  return (
    <span className="cb-strip" role="img" aria-label={label} title={label}>
      {padHistory(history).map((r, i) => (
        <span key={i} className={`cb-cell ${r === "success" ? "is-pass" : r === "fail" ? "is-fail" : r === "running" ? "is-run" : "is-empty"}`} />
      ))}
    </span>
  );
}

/** The in-flight task, with its age. Not a live region: it sits inside the row's button (whose name is set on its
 *  own), and the page's announcer reports changes. */
export function TaskChip({ task, now }: { task: Pick<Task, "action" | "status" | "createdAt" | "startedAt">; now: number }) {
  const stale = isStaleQueued(task, now);
  return (
    <span className={`cb-task-chip is-${task.status}${stale ? " is-stale" : ""}`} title={stale ? "Queued for a while: is candybar-steward running?" : undefined}>
      {taskChipLabel(task, now)}
    </span>
  );
}

const OUTCOME_HINT: Record<EvaluationOutcome, string> = {
  Nominal: "Evaluation: working as intended",
  Suboptimal: "Evaluation: works, but could be better",
  Drifted: "Evaluation: no longer does what it was meant to",
  Orphaned: "Evaluation: nothing depends on it"
};

export function OutcomeChip({ outcome }: { outcome: EvaluationOutcome }) {
  return <span className={`cb-outcome is-${outcome.toLowerCase()}`} title={OUTCOME_HINT[outcome]}>{outcome}</span>;
}

/** The task to chip on a collapsed row: the oldest one that is running, else the first queued. */
export function activeTask(c: Pick<CandybarRow, "tasks">): Task | undefined {
  const tasks = c.tasks?.active ?? [];
  return tasks.find((t) => t.status === "running") ?? tasks[0];
}

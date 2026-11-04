"use client";

import { padHistory, summarizeHistory, taskChipLabel } from "./candybar-model";
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

export function TaskChip({ task }: { task: Pick<Task, "action" | "status"> }) {
  return <span className={`cb-task-chip is-${task.status}`} role="status">{taskChipLabel(task)}</span>;
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

import type { CandybarRow, RunResult, Task, TaskAction } from "./types";

// Pure helpers for the Definitions tab's row actions and signals. DOM-free so they are tested directly.

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

export type Group<T> = { key: string; label: string; items: T[] };

export const projectOf = (c: Pick<CandybarRow, "profile">): string | undefined => c.profile?.project?.name || undefined;

/** One group per project, A to Z, "Unclassified" last. Items keep the order they came in. */
export function groupByProject<T extends Pick<CandybarRow, "profile">>(rows: T[]): Array<Group<T>> {
  const groups = new Map<string, Group<T>>();
  for (const row of rows) {
    const name = projectOf(row);
    const key = name ? `p:${name}` : "unclassified";
    const g = groups.get(key) ?? { key, label: name ?? UNCLASSIFIED, items: [] };
    g.items.push(row);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.key === "unclassified" ? 1 : b.key === "unclassified" ? -1 : a.label.localeCompare(b.label)));
}

export const ACTION_LABEL: Record<TaskAction, string> = { enrich: "Enrich", evaluate: "Evaluate", fix: "Fix", refactor: "Refactor" };
const ING: Record<TaskAction, string> = { enrich: "Enriching…", evaluate: "Evaluating…", fix: "Fixing…", refactor: "Refactoring…" };

/** The chip for a task in flight: running ones read "Enriching…", queued ones "Enrich queued". */
export function taskChipLabel(t: Pick<Task, "action" | "status">): string {
  return t.status === "running" ? ING[t.action] : `${ACTION_LABEL[t.action]} queued`;
}

export function activeActions(c: Pick<CandybarRow, "tasks">): Set<TaskAction> {
  return new Set((c.tasks?.active ?? []).map((t) => t.action));
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

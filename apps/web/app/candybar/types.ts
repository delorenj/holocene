// Payload of /api/modules/candybar/list (apps/api/src/candybar.ts), mirrored by hand like the other surfaces.

import type { Source } from "../hub/types";

export type LastRun = {
  result: "success" | "fail" | "running";
  trigger?: string;
  startedAt: string;
  finishedAt?: string;
  runtimeMs?: number;
  errorMessage?: string;
};

export type RunResult = LastRun["result"];

export type TaskAction = "enrich" | "fix" | "evaluate" | "refactor";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
export type Task = {
  id: string;
  candybarId: string;
  action: TaskAction;
  status: TaskStatus;
  model?: string;
  parentTaskId?: string;
  sessionId?: string;
  outcome?: string;
  summary?: string;
  reportKey?: string;
  invocationId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type Overview = {
  summary: string;
  purpose: string;
  behavior: string[];
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  dependencies: string[];
  failureModes: string[];
  verification: string[];
  runbook: string[];
  source: { repo: string | null; paths: string[]; runner: string };
  cadenceNote: string;
};
export type EvaluationOutcome = "Nominal" | "Suboptimal" | "Drifted" | "Orphaned";
export type AxisName = "efficacy" | "cost" | "value" | "usage" | "alternatives";
export type Evaluation = {
  outcome: EvaluationOutcome;
  summary: string;
  axes: Partial<Record<AxisName, { rating: "good" | "fair" | "poor"; finding: string }>>;
  recommendation: string;
  followUp: "none" | "refactor" | "fix" | "archive";
  reportKey: string;
  evaluatedAt?: string;
  taskId?: string;
};
export type Profile = {
  overview: Overview | null;
  templateVersion: number | null;
  project: { id: string; name: string; confidence: number; method: "ledger" | "jev" | "manual" } | null;
  enrichedAt: string | null;
  evaluation: Evaluation | null;
};
export type RowTasks = { active: Task[]; latest: Partial<Record<TaskAction, Task>> };

export type CandybarRow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  schedule: string;
  timezone: string;
  noise: boolean;
  enabled: boolean;
  archived: boolean;
  createdAt: string;
  /** The next fire within the schedule window; null when none falls inside it (or the candybar is disabled). */
  nextFire: string | null;
  /** The newest invocation; null when it has never run. Absent when it could not be read. */
  lastRun?: LastRun | null;
  /** The last (up to) 30 results, oldest first. Absent when they could not be read. */
  history?: RunResult[];
  /** Null: read, none yet. Absent: could not be read (older Candybar, or it is down). */
  profile?: Profile | null;
  tasks?: RowTasks;
};

export type CandybarPayload = {
  generated_at: string;
  source: Source;
  counts: { total: number; active: number; inactive: number; failing: number; archived: number };
  window: { known: boolean; to?: string };
  warnings: string[];
  candybars: CandybarRow[];
};

export type ViewId = "all" | "active" | "inactive" | "failing" | "archived";

// Payload of /api/modules/candybar/schedule (apps/api/src/candybar.ts).

export type ScheduleCandybar = { id: string; name: string; schedule: string; noise: boolean };
/** [candybar index, fireTime as Candybar wrote it, state, lastResult, skipped]. */
export type ScheduleTuple = [number, string, FireState, "success" | "fail" | null, 0 | 1];
export type SchedulePayload = { generated_at: string; from: string; to: string; candybars: ScheduleCandybar[]; rows: ScheduleTuple[] };

export type FireState = "past" | "current" | "upcoming";

/** One row of /schedule and of the stream's `row` (holocene-view-contract.md, "Schedule window"). */
export type WireRow = {
  candybarId: string;
  name: string;
  schedule: string;
  fireTime: string;
  state: FireState;
  lastResult?: "success" | "fail";
  skipped: boolean;
  noise: boolean;
};

export type TabId = "schedule" | "definitions";

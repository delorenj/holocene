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

export type CandybarRow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  schedule: string;
  timezone: string;
  noise: boolean;
  enabled: boolean;
  createdAt: string;
  /** The next fire within the schedule window; null when none falls inside it (or the candybar is disabled). */
  nextFire: string | null;
  /** The newest invocation; null when it has never run. Absent when it could not be read. */
  lastRun?: LastRun | null;
};

export type CandybarPayload = {
  generated_at: string;
  source: Source;
  counts: { total: number; active: number; inactive: number; failing: number };
  window: { known: boolean; to?: string };
  warnings: string[];
  candybars: CandybarRow[];
};

export type ViewId = "all" | "active" | "inactive" | "failing";

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

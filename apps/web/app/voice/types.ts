// Mirrors apps/api/src/voice-memos.ts. The API owns the grouping; this view only draws it.
export type HopId = "uploaded" | "received" | "transcribed" | "dispatched" | "agent_started" | "agent_done" | "replied" | "played";
export type HopStatus = "ok" | "failed" | "waiting" | "stuck" | "pending" | "missing";
export type MemoStatus = "complete" | "failed" | "running" | "stuck";
export type Lane = "interactive" | "batch";

export type JourneyEvent = {
  cursor: number;
  id: string;
  type: string;
  at: string;
  collectedAt: string;
  producer?: string;
  correlationId: string;
  data: Record<string, unknown>;
  envelope: unknown;
};

export type TurnTimeout = { elapsedSeconds?: number; limitSeconds?: number; lane?: string; source?: string; stopped?: boolean };
/** Recording loudness the watcher measured before transcribing (dBFS; silent = no sound reached the file). */
export type AudioLevel = { maxDbfs: number; meanDbfs?: number; durationSeconds?: number; silent: boolean };
/** What the device's own recorder saw (data.capture on the uploaded fact). */
export type CaptureLevel = { peakDbfs?: number; rmsDbfs?: number; silent?: boolean };
export type HopFailure = { eventId: string; at: string; stage?: string; code?: string; message?: string; retryable: boolean; attempt?: number; timeout?: TurnTimeout; audio?: AudioLevel };

export type Hop = {
  id: HopId;
  label: string;
  status: HopStatus;
  at?: string;
  sinceMs?: number;
  budgetSeconds: number;
  waitedSeconds?: number;
  detail: string;
  error?: HopFailure;
  failures: HopFailure[];
  events: JourneyEvent[];
  audio?: AudioLevel;
  capture?: CaptureLevel;
};

export type MemoSummary = {
  memoId: string;
  agent?: string;
  s3Key?: string;
  startedAt: string;
  updatedAt: string;
  totalSeconds: number;
  status: MemoStatus;
  reached?: HopId;
  stageLabel: string;
  stuckAt?: HopId;
  lane?: Lane;
  laneReason?: string;
  transcriptPreview?: string;
  replyPreview?: string;
  error?: string;
  audio?: AudioLevel;
  capture?: CaptureLevel;
};

export type MemoDetail = MemoSummary & { commandId?: string; transcript?: string; replyText?: string; hops: Hop[]; events: JourneyEvent[] };

export type CollectionSource = { state: string; lastEventAt: string | null; catchingUp: boolean; error?: string | null };
export type LaneStatus = { pulling?: boolean; waiting?: number; inFlight?: number; queued?: number; slots?: number; error?: string };
export type WatcherStatus = {
  state: "running" | "stopped" | "unknown";
  heartbeatAt?: string;
  ageSeconds?: number;
  active?: number;
  outbox?: number;
  lane?: Lane;
  lanes?: { interactive?: LaneStatus; batch?: LaneStatus };
  detail: string;
};
export type MemosPayload = { generated_at: string; source: CollectionSource; watcher?: WatcherStatus; memos: MemoSummary[] };
export type MemoPayload = { generated_at: string; source: CollectionSource; watcher?: WatcherStatus; memo: MemoDetail };

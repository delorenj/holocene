// Mirrors apps/api/src/voice-memos.ts. The API owns the grouping; this view only draws it.
export type HopId = "uploaded" | "received" | "transcribed" | "dispatched" | "agent_started" | "agent_done" | "replied" | "played";
export type HopStatus = "ok" | "failed" | "waiting" | "stuck" | "pending" | "missing";
export type MemoStatus = "complete" | "failed" | "running" | "stuck";

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

export type HopFailure = { eventId: string; at: string; stage?: string; code?: string; message?: string; retryable: boolean; attempt?: number };

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
  transcriptPreview?: string;
  replyPreview?: string;
  error?: string;
};

export type MemoDetail = MemoSummary & { commandId?: string; transcript?: string; replyText?: string; hops: Hop[]; events: JourneyEvent[] };

export type CollectionSource = { state: string; lastEventAt: string | null; catchingUp: boolean; error?: string | null };
export type WatcherStatus = { state: "running" | "stopped" | "unknown"; heartbeatAt?: string; ageSeconds?: number; active?: number; outbox?: number; detail: string };
export type MemosPayload = { generated_at: string; source: CollectionSource; watcher?: WatcherStatus; memos: MemoSummary[] };
export type MemoPayload = { generated_at: string; source: CollectionSource; watcher?: WatcherStatus; memo: MemoDetail };

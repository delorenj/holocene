// Mirrors apps/api/src/voice-memos.ts. The API owns the grouping; this view only draws it.
export type HopId =
  | "uploaded" | "received" | "transcribed" | "dispatched" | "agent_started" | "agent_done"
  | "escalated" | "batch_started" | "batch_done"
  | "replied" | "played";
// timed_out: the interactive turn hit its wall clock and the memo was handed to the batch lane (not a failure). cancelled: `memo:cancel` (not an error).
export type HopStatus = "ok" | "failed" | "waiting" | "stuck" | "pending" | "missing" | "timed_out" | "cancelled";
export type MemoStatus = "complete" | "failed" | "running" | "stuck" | "cancelled";
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
/** From the audio.memo.replied fact: spoken late / from the escalated batch turn, and where the full text went next to the audio. */
export type ReplyInfo = { late: boolean; escalated: boolean; earshotKey?: string; earshotTextKey?: string };
/** From an audio.memo.failed fact with data.stage "cancelled". afterDispatch: the agent may still have run. */
export type Cancellation = { eventId: string; at: string; afterDispatch: boolean; message?: string };

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
  reply?: ReplyInfo;
  cancel?: Cancellation;
};

/** One line the agent wrote while working (agent.invocation.progressed). superseded: an escalated memo's first turn. */
export type ProgressLine = { eventId: string; at: string; seq: number; text: string; commandId?: string; elapsedSeconds?: number; superseded: boolean };
/** A progress line the watcher spoke for the car (audio.memo.narrated): progress/<day>/<memo_id>-<n>.ogg. */
export type Narration = { eventId: string; at: string; n: number; seq?: number; key?: string; text?: string; ttsSeconds?: number; engine?: string; elapsedSeconds?: number };
/** One decision of the car's speech queue about the memo (audio.memo.notified), in the device's words. */
export type SpeechDecision = { eventId: string; at: string; deviceAt?: string; utterance: string; decision: string; reason?: string; recording?: boolean; mic?: string };
/** Seconds from the upload to the first ack, heard echo, progress line, narration and playback. */
export type MemoTiming = {
  ackSeconds?: number; heardEchoSeconds?: number; firstProgressSeconds?: number; firstNarrationSeconds?: number;
  progressPlayedSeconds?: number; replyPlayedSeconds?: number;
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
  escalated?: boolean;
  late?: boolean;
  cancelled?: Cancellation;
  transcriptPreview?: string;
  replyPreview?: string;
  error?: string;
  audio?: AudioLevel;
  capture?: CaptureLevel;
  latestProgress?: string;
  progressCount?: number;
  narrationCount?: number;
};

export type MemoDetail = MemoSummary & {
  commandId?: string; escalatedFromCommandId?: string; transcript?: string; replyText?: string; hops: Hop[]; events: JourneyEvent[];
  progress?: ProgressLine[]; narrations?: Narration[]; speech?: SpeechDecision[]; timing?: MemoTiming;
};

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

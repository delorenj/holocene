// Mirrors apps/api/src/voice-memos.ts. The API owns the grouping; this view only draws it.
export type HopId =
  | "uploaded" | "received" | "transcribed"
  // Only on a memo the fast conversation desk decided (audio.memo.routed).
  | "routed"
  | "dispatched" | "agent_started" | "agent_done"
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
export type ReplyInfo = {
  late: boolean; escalated: boolean; earshotKey?: string; earshotTextKey?: string;
  /** The turn ran past the interactive wall clock and ran on (detached); a quick answer that handed off a background plan. */
  detached?: boolean; background?: boolean; backgroundPlan?: string; model?: string; modelApplied?: boolean;
  /** Why the phone copy was left out: car_spoke | car_holds | no_answer (car_live: the older presence rule). */
  earshotSkipped?: string;
  /** Why it went the way it did: car_started | car_holds | claim_failed (left out) or no_car_claim | car_let_go | browser_sender | skip_off (mirrored). */
  earshotReason?: string;
  /** The phone copy landed after the replied fact said it was left to the car (audio.memo.mirrored). */
  phoneLate?: { at: string; afterReleaseSeconds?: number; rounds?: number };
};
/** One rung the fast-model ladder tried (when the routed fact lists them). */
export type RouteAttempt = { route?: string; model?: string; ok?: boolean; error?: string; ms?: number };
/**
 * From the audio.memo.routed fact: what the fast desk decided. fast: it spoke the turn itself (reply | propose | confirm |
 * cancel | end), no agent command for the memo; otherwise (direct) the memo took today's agent path.
 */
export type Routed = {
  eventId: string; at: string; convId: string; turn?: number; action: string; fast: boolean; path?: string;
  modelAnswered?: string; route?: string; attempts?: number; attemptLog?: RouteAttempt[]; latencyMs?: number;
  promptTokens?: number; completionTokens?: number; cachedTokens?: number; fallbackReason?: string; title?: string; target?: string;
};
/** conv id, turn, action and model@route, for the list rows and the header. */
export type ConvChip = Pick<Routed, "convId" | "turn" | "action" | "fast" | "modelAnswered" | "route">;
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
  /** Routed hop: the fast desk's decision. */
  routed?: Routed;
};

/** One line the agent wrote while working (agent.invocation.progressed). superseded: an escalated memo's first turn. */
export type ProgressLine = { eventId: string; at: string; seq: number; text: string; commandId?: string; elapsedSeconds?: number; superseded: boolean };
/** A progress line the watcher spoke for the car (audio.memo.narrated): progress/<day>/<memo_id>-<n>.ogg. */
export type Narration = { eventId: string; at: string; n: number; seq?: number; key?: string; text?: string; ttsSeconds?: number; engine?: string; elapsedSeconds?: number };
/** One decision of the car's speech queue about the memo (audio.memo.notified), in the device's words. */
export type SpeechDecision = { eventId: string; at: string; deviceAt?: string; utterance: string; decision: string; reason?: string; recording?: boolean; mic?: string };
/** Seconds from the upload to the first ack, heard echo, progress line, narration and playback. */
export type MemoTiming = {
  /** The fast conversation desk decided (audio.memo.routed). */
  routedSeconds?: number;
  ackSeconds?: number; heardEchoSeconds?: number; firstProgressSeconds?: number; firstNarrationSeconds?: number;
  progressPlayedSeconds?: number; replyPlayedSeconds?: number;
  /** Chunked speech: the reply's first chunk up, and the full reply file up (since the upload). */
  firstChunkSeconds?: number; replyUpSeconds?: number;
  /** Since the agent finished: first chunk up, full reply up, the car speaking; and the car's lag behind its first audio. */
  agentToFirstChunkSeconds?: number; agentToReplySeconds?: number; agentToCarSeconds?: number; carLagSeconds?: number;
};
/** One sentence-chunk of the reply, uploaded before the full file (audio.memo.voiced). */
export type ReplyChunk = { eventId: string; at: string; n: number; of: number; key?: string; text?: string; ttsSeconds?: number; sinceAgentDoneSeconds?: number };

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
  /** The interactive turn passed the gateway's wall clock and ran on (no kill, no batch re-run). */
  detached?: boolean;
  /** The reply was a quick answer that handed the long part to a background follow-up. */
  background?: boolean;
  followup?: { n: number; status: FollowUp["status"]; seconds?: number; kind?: FollowUp["kind"]; target?: string; title?: string };
  /** The fast conversation desk decided this memo. */
  conv?: ConvChip;
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

/**
 * Answer-then-background: the quick answer's BACKGROUND: plan, run as follow-up n on the same thread and spoken later.
 * kind delegation: a brief the driver confirmed aloud to the fast desk, sent to `target` (the tile's agent, or the one named).
 */
export type FollowUp = {
  n: number; kind?: "followup" | "delegation"; target?: string; targetName?: string; title?: string; briefId?: string; perm?: string; convId?: string;
  commandId?: string; ofCommandId?: string; status: "running" | "spoken" | "failed"; plan?: string; lane?: Lane;
  model?: string; dispatchedAt: string; startedAt?: string; doneAt?: string; repliedAt?: string; replyText?: string;
  replyKey?: string; afterAnswerSeconds?: number; seconds?: number; error?: string;
};
export type Detach = { at: string; elapsedSeconds?: number; ceilingSeconds?: number };

export type MemoDetail = MemoSummary & {
  commandId?: string; escalatedFromCommandId?: string; transcript?: string; replyText?: string; hops: Hop[]; events: JourneyEvent[];
  progress?: ProgressLine[]; narrations?: Narration[]; speech?: SpeechDecision[]; chunks?: ReplyChunk[]; timing?: MemoTiming;
  detach?: Detach; followups?: FollowUp[]; routed?: Routed;
};

export type CollectionSource = { state: string; lastEventAt: string | null; catchingUp: boolean; error?: string | null };
export type LaneStatus = {
  pulling?: boolean; waiting?: number; inFlight?: number; queued?: number; slots?: number; error?: string;
  /** hermes-gateway is draining (restart, stop or maintenance) or still starting: nothing is pulled on purpose and
   * queued memos run when it takes turns again. gateway = the watcher's sentence, gatewayLabel = its short form. */
  draining?: boolean; gateway?: string; gatewayLabel?: string;
};
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

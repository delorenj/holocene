// Pure grouping logic for the Voice memos view. No I/O, no clock: callers pass `now`.
//
// One voice memo is one Bloodbank correlation id. The upload proxy and the inbox watcher publish
// bloodbank.audio.memo.* stage facts with it; the command they dispatch carries it, so the
// gateway's agent.invocation.* and conversation.turn.* facts inherit it. Grouping those facts
// reproduces `mise run memo:trace` (services/inbox-watcher/memo_trace.py) from the collection.

/** The journey's stage facts: a handful per memo, scanned newest-first to find the recent memos. */
export const MEMO_STAGE_TYPES = [
  "bloodbank.audio.memo.uploaded",
  "bloodbank.audio.memo.received",
  "bloodbank.audio.memo.transcribed",
  // The fast in-car conversation layer (services/inbox-watcher converse stage): one routed fact per fast-model decision,
  // one delegated fact per brief the driver confirmed aloud. One each per memo at most, so they are scanned with the stages.
  "bloodbank.audio.memo.routed",
  "bloodbank.audio.memo.dispatched",
  "bloodbank.audio.memo.delegated",
  "bloodbank.audio.memo.replied",
  "bloodbank.audio.memo.played",
  "bloodbank.audio.memo.failed"
] as const;

/**
 * What the driver heard while waiting: narrated = the watcher spoke a progress line for the car, notified = one
 * decision of the car's speech queue (ack, heard echo, progress, reply: start / end / halt / drop / deferred).
 * voiced = one sentence-chunk of the reply went up before the full file, so the car could start speaking it.
 * mirrored = the phone's Earshot copy landed late, in the watcher's background retry, after the replied fact.
 * Many per memo, so they are read by correlation id for the memos on screen, never scanned.
 */
export const MEMO_ANNOTATION_TYPES = ["bloodbank.audio.memo.narrated", "bloodbank.audio.memo.notified", "bloodbank.audio.memo.voiced", "bloodbank.audio.memo.mirrored"] as const;

export const MEMO_TYPES = [...MEMO_STAGE_TYPES, ...MEMO_ANNOTATION_TYPES] as const;

/** One interim assistant message of the memo's running turn (the Hermes gateway publishes every one). */
export const PROGRESS_TYPE = "bloodbank.agent.invocation.progressed";
/** The gateway kept the interactive turn running past its wall clock and gave the slot back (no kill, no re-run). */
export const DETACHED_TYPE = "bloodbank.agent.invocation.detached";

export const AGENT_TYPES = [
  "bloodbank.agent.invocation.started",
  PROGRESS_TYPE,
  DETACHED_TYPE,
  "bloodbank.agent.invocation.completed",
  "bloodbank.agent.invocation.failed",
  "bloodbank.agent.invocation.skipped",
  "bloodbank.conversation.turn.started",
  "bloodbank.conversation.turn.completed",
  "bloodbank.conversation.turn.failed"
] as const;

export type HopId =
  | "uploaded" | "received" | "transcribed"
  // Only on a memo the fast conversation desk decided (an audio.memo.routed fact): what it did, and with which model.
  | "routed"
  | "dispatched" | "agent_started" | "agent_done"
  // Only on an escalated memo: the second dispatch on the batch lane and the batch turn it started.
  | "escalated" | "batch_started" | "batch_done"
  | "replied" | "played";
/**
 * timed_out: the interactive turn hit its wall clock and the watcher handed the memo to the batch lane (not a failure).
 * cancelled: someone ran `memo:cancel` (not an error either).
 */
export type HopStatus = "ok" | "failed" | "waiting" | "stuck" | "pending" | "missing" | "timed_out" | "cancelled";
export type MemoStatus = "complete" | "failed" | "running" | "stuck" | "cancelled";
/** Which gateway lane carried the memo's command: invocation.invoke (interactive) or invocation.start (batch). */
export type Lane = "interactive" | "batch";

/** A collected envelope reduced to what grouping needs, plus the raw envelope for the UI. */
export type JourneyEvent = {
  cursor: number;
  id: string;
  type: string;
  /** Best timestamp: data.occurred_at (ms precision) > envelope.time > collected_at. */
  at: string;
  collectedAt: string;
  producer?: string;
  correlationId: string;
  data: Record<string, unknown>;
  envelope: unknown;
};

type Spec = { id: HopId; label: string; budgetSeconds: number; optional?: boolean };

/**
 * Expected latency of each hop, measured from the previous hop. Tuned to the measured pipeline:
 * large-v3 on CPU int8 takes about 40 s for a short clip, and the watcher gives the agent 600 s.
 */
export const HOPS: readonly Spec[] = [
  { id: "uploaded", label: "Recorded and uploaded", budgetSeconds: 0, optional: true },
  { id: "received", label: "Watcher picked up", budgetSeconds: 30 },
  { id: "transcribed", label: "Transcribed", budgetSeconds: 180 },
  { id: "dispatched", label: "Dispatched to agent", budgetSeconds: 30 },
  { id: "agent_started", label: "Agent started", budgetSeconds: 120 },
  { id: "agent_done", label: "Agent finished", budgetSeconds: 600 },
  { id: "replied", label: "Reply rendered", budgetSeconds: 60 },
  // Reported by the pad itself. Optional: a parked car reports nothing, and that is not a failed memo.
  { id: "played", label: "Played on car", budgetSeconds: 60, optional: true }
];

/** The watcher's MEMO_EARSHOT_HOLD_MAX_S (300 s) plus a margin: how long a reply that is already up may wait for its replied fact. */
export const REPLY_DECISION_BUDGET_SECONDS = 330;

/**
 * When the reply's first audio went up (the first audio.memo.voiced: chunk 1 of a chunked reply, or chunk 1 of 1 for a
 * reply spoken as one file), epoch ms: the car could start from here. Replies from before 2026-10-21 spoken as one file
 * have no voiced fact and count from the agent's finish.
 */
export function firstAudioUpMs(facts: readonly JourneyEvent[]): number | undefined {
  const t = facts.filter((e) => e.type === "bloodbank.audio.memo.voiced").map((e) => ms(e.at)).filter((x): x is number => x !== undefined);
  return t.length ? Math.min(...t) : undefined;
}

/** When the car really started speaking the reply (the pad's played fact, else its speech arbiter's start), epoch ms. */
export function carStartedMs(facts: readonly JourneyEvent[]): number | undefined {
  const t = facts.filter((e) =>
    (e.type === "bloodbank.audio.memo.played" && e.data.phase === "started")
    || (e.type === "bloodbank.audio.memo.notified" && e.data.utterance === "reply" && (e.data.decision === "start" || e.data.decision === "started"))
  ).map((e) => ms(e.at)).filter((x): x is number => x !== undefined);
  return t.length ? Math.min(...t) : undefined;
}

/** The batch lane has no wall clock but queues behind ticket grooming, so the batch turn may wait a long time before it starts. */
export const BATCH_START_BUDGET_SECONDS = 1800;
/** Same as the watcher's MEMO_BATCH_TURN_TIMEOUT_S default: the watcher gives the batch turn this long. */
export const BATCH_TURN_BUDGET_SECONDS = 7200;
/** The gateway's detached_ceiling_seconds default: a detached interactive turn is stopped this long after dispatch. */
export const DETACHED_CEILING_SECONDS = 2700;

/**
 * An escalated memo ran twice: the interactive turn timed out and the watcher re-dispatched the same prompt on the
 * batch lane. The batch dispatch and its turn are their own hops, between the interactive agent hops and the reply.
 */
const ESCALATED_HOPS: readonly Spec[] = (() => {
  const at = HOPS.findIndex((h) => h.id === "agent_done") + 1;
  const interactive = (spec: Spec): Spec => (spec.id === "agent_started" || spec.id === "agent_done" ? { ...spec, label: `Interactive ${spec.label.toLowerCase()}` } : spec);
  return [
    ...HOPS.slice(0, at).map(interactive),
    { id: "escalated", label: "Escalated to batch lane", budgetSeconds: 60 },
    { id: "batch_started", label: "Batch agent started", budgetSeconds: BATCH_START_BUDGET_SECONDS },
    { id: "batch_done", label: "Batch agent finished", budgetSeconds: BATCH_TURN_BUDGET_SECONDS },
    ...HOPS.slice(at)
  ];
})();

/** dispatched fact lane_reason of a memo the watcher re-dispatched on the batch lane after the interactive turn timed out. */
export const ESCALATED_REASON = "turn_timeout_escalated";
/** dispatched fact lane_reason of a background follow-up: the quick answer's BACKGROUND: plan sent back to the same agent. */
export const FOLLOWUP_REASON = "voice_followup";
/** dispatched fact lane_reason of a delegation: the brief the driver confirmed aloud ("send it"), sent as follow-up n. */
export const DELEGATION_REASON = "voice_delegation";

/** A dispatched, voiced or replied fact of a background follow-up (answer-then-background, or a delegation), not of the memo's own turn. */
export function isFollowupFact(d: Record<string, unknown>): boolean {
  return num(d.followup) !== undefined || str(d.lane_reason) === FOLLOWUP_REASON || str(d.lane_reason) === DELEGATION_REASON;
}

/** A follow-up that is a confirmed delegation (the fast desk's brief), not the quick answer's own BACKGROUND: plan. */
export function isDelegationFact(d: Record<string, unknown>): boolean {
  return str(d.lane_reason) === DELEGATION_REASON || str(d.followup_kind) === "delegation" || str(d.kind) === "delegation";
}

// ---- the fast in-car conversation layer (2026-10-22): the watcher's converse stage, between transcribe and speak ----

export const ROUTED_TYPE = "bloodbank.audio.memo.routed";
export const DELEGATED_TYPE = "bloodbank.audio.memo.delegated";
/** The watcher's MEMO_CONVERSE_BUDGET_S: the whole fast-model ladder gets this long before the memo takes the agent path. */
export const ROUTED_BUDGET_SECONDS = 8;
/** The one routed action that hands the memo to today's agent path; every other action is spoken by the fast desk itself. */
export const DIRECT_ACTION = "direct";

/** One rung the fast-model ladder tried, when the routed fact lists them (S11: hyper failures, then a gateway rung). */
export type RouteAttempt = { route?: string; model?: string; ok?: boolean; error?: string; ms?: number };

/** From the audio.memo.routed fact: what the fast desk decided for this memo, and which model answered. */
export type Routed = {
  eventId: string;
  at: string;
  convId: string;
  /** 1..n within the conversation, when the watcher says. */
  turn?: number;
  /** reply | propose | confirm | cancel | end (spoken by the fast desk) or direct (today's agent path). Open set. */
  action: string;
  /** The fast desk spoke this turn itself: no agent command for the memo (a confirm's delegation is a follow-up). */
  fast: boolean;
  /** fast (a model call) | confirm_only / cancel_only (a lexicon short-circuit, no model call) | ... as the watcher names it. */
  path?: string;
  /** The `model` field of the answer that was used (never an Anthropic route). Absent: no model call. */
  modelAnswered?: string;
  /** The ladder rung that answered (r1, r2, r3a, ...). */
  route?: string;
  /** How many rungs were tried. */
  attempts?: number;
  attemptLog?: RouteAttempt[];
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Why the memo went to the agent path instead (all_routes_failed, an exception, ...). */
  fallbackReason?: string;
  /** The draft's or delegation's title and target, when the fact carries them. */
  title?: string;
  target?: string;
};

/** The conversation chips the list and the header draw: conv id, turn, action and model@route. */
export type ConvChip = Pick<Routed, "convId" | "turn" | "action" | "fast" | "modelAnswered" | "route">;

export function routedOf(e: JourneyEvent, ownDispatch = false): Routed | undefined {
  const d = e.data;
  const convId = str(d.conv_id);
  const action = str(d.action);
  if (!convId || !action) return undefined; // both are required by memo.routed.json
  const usage = rec(d.usage);
  const rawLog = [d.attempts, d.attempt_log, d.route_attempts, d.ladder].find(Array.isArray) as unknown[] | undefined;
  // converse.py's ladder: {route, model, outcome: ok | timeout | http_502 | bad_json | forbidden_model | breaker_open |
  // budget_exhausted | host_down | key_unreadable | ..., ms, http_status, answered_model}
  const attemptLog = rawLog?.map(rec).map((a): RouteAttempt => {
    const outcome = str(a.outcome);
    const status = num(a.http_status) ?? num(a.status);
    return {
      route: str(a.route) ?? str(a.id), model: str(a.answered_model) ?? str(a.model),
      ok: typeof a.ok === "boolean" ? a.ok : outcome !== undefined ? outcome === "ok" : undefined,
      error: outcome !== undefined && outcome !== "ok" ? outcome
        : str(a.error) ?? str(a.reason) ?? str(a.code) ?? (outcome === undefined && status !== undefined && status >= 400 ? `HTTP ${status}` : undefined),
      ms: num(a.ms) ?? num(a.latency_ms)
    };
  });
  const path = str(d.path);
  const cached = num(d.cached_tokens) ?? num(rec(usage.prompt_tokens_details).cached_tokens);
  return {
    eventId: e.id, at: e.at, convId, turn: num(d.turn) ?? num(d.conv_turn), action,
    // A shadow decision (if the watcher ever publishes one) only logs: the memo still took the agent path.
    fast: action !== DIRECT_ACTION && path !== "shadow" && !ownDispatch,
    ...(path ? { path } : {}),
    ...(str(d.model_answered) ? { modelAnswered: str(d.model_answered) } : {}),
    ...(str(d.route) ? { route: str(d.route) } : {}),
    ...(num(d.attempts) !== undefined ? { attempts: num(d.attempts) } : attemptLog ? { attempts: attemptLog.length } : {}),
    ...(attemptLog?.length ? { attemptLog } : {}),
    ...(num(d.latency_ms) !== undefined ? { latencyMs: num(d.latency_ms) } : {}),
    ...(num(usage.prompt_tokens) !== undefined ? { promptTokens: num(usage.prompt_tokens) } : {}),
    ...(num(usage.completion_tokens) !== undefined ? { completionTokens: num(usage.completion_tokens) } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(str(d.fallback_reason) ? { fallbackReason: str(d.fallback_reason) } : {}),
    ...(str(d.title) ?? str(d.draft_title) ? { title: str(d.title) ?? str(d.draft_title) } : {}),
    ...(str(d.target) ? { target: str(d.target) } : {})
  };
}

export const convChipOf = (r: Routed): ConvChip => ({
  convId: r.convId, turn: r.turn, action: r.action, fast: r.fast, modelAnswered: r.modelAnswered, route: r.route
});

/** "deepseek-v4.1-flash-1017@r1", or undefined when no model answered (a lexicon short-circuit, or the agent path). */
export function modelAtRoute(r: Pick<Routed, "modelAnswered" | "route">): string | undefined {
  return r.modelAnswered ? `${r.modelAnswered}${r.route ? `@${r.route}` : ""}` : undefined;
}

/** The routed hop's name: what the fast desk did with the memo. */
export function routedLabel(r: Routed): string {
  if (r.path === "shadow") return "Fast model (shadow, not used)";
  if (!r.fast) return "Routed to the full agent";
  return r.modelAnswered ? "Fast model answered" : "Fast desk answered (no model call)";
}

/** "action reply · deepseek-v4.1-flash-1017@r1 · 812 ms · 900+40 tokens · 640 cached", plus the attempts and any fallback. */
export function routedDetail(r: Routed): string {
  const tokens = r.promptTokens !== undefined || r.completionTokens !== undefined ? `${r.promptTokens ?? "?"}+${r.completionTokens ?? "?"} tokens` : undefined;
  return [
    `action ${r.action}`,
    r.path && r.path !== "fast" ? `path ${r.path}` : undefined,
    modelAtRoute(r) ?? (r.fast ? "no model call" : undefined),
    r.attempts !== undefined && r.attempts > 1 ? `${r.attempts} attempts` : undefined,
    r.latencyMs !== undefined ? `${Math.round(r.latencyMs)} ms` : undefined,
    tokens,
    r.cachedTokens !== undefined ? `${r.cachedTokens} cached` : undefined,
    r.fallbackReason ? `fell back: ${r.fallbackReason}` : undefined
  ].filter(Boolean).join(" · ");
}

/** Hops of the memo's own agent turn: a turn the fast desk answered has none (its delegation is a follow-up). */
const AGENT_HOPS = new Set<HopId>(["dispatched", "agent_started", "agent_done", "escalated", "batch_started", "batch_done"]);

/** The routed hop goes right after transcribed. A fast turn drops the agent hops; a direct turn keeps them after it. */
function withRouted(base: readonly Spec[], r: Routed): Spec[] {
  const at = base.findIndex((h) => h.id === "transcribed") + 1;
  const rest = base.slice(at).filter((h) => !r.fast || !AGENT_HOPS.has(h.id));
  return [...base.slice(0, at), { id: "routed", label: routedLabel(r), budgetSeconds: ROUTED_BUDGET_SECONDS }, ...rest];
}

const FAST_DONE: Record<string, string> = {
  reply: "fast reply", propose: "draft read back", confirm: "confirmed", cancel: "draft dropped", end: "conversation ended"
};

/** The memo's interactive turn passed the gateway's wall clock and was let run on, slot released (no kill, no re-run). */
export type Detach = { at: string; elapsedSeconds?: number; ceilingSeconds?: number };

/**
 * Answer-then-background: the quick answer named a BACKGROUND: plan, which went back to the same agent and thread as
 * follow-up n. Its reply is spoken later ("<agent>, follow-up.") into a new reply object of the same memo.
 */
export type FollowUp = {
  n: number;
  /**
   * followup: the quick answer's BACKGROUND: plan, back to the same agent. delegation: a brief the driver confirmed
   * aloud to the fast desk ("send it"), sent to the tile's agent or the one the driver named (target).
   */
  kind: "followup" | "delegation";
  /** Delegation: the agent the brief went to, its spoken name, the draft's title, the brief id and permission level. */
  target?: string;
  targetName?: string;
  title?: string;
  briefId?: string;
  perm?: string;
  convId?: string;
  commandId?: string;
  ofCommandId?: string;
  /** running: dispatched, not spoken yet; spoken: its reply went out; failed: it did not finish, and the car was told. */
  status: "running" | "spoken" | "failed";
  plan?: string;
  lane?: Lane;
  model?: string;
  dispatchedAt: string;
  startedAt?: string;
  doneAt?: string;
  repliedAt?: string;
  replyText?: string;
  replyKey?: string;
  /** Seconds from the quick answer's replied fact to this follow-up's replied fact. */
  afterAnswerSeconds?: number;
  /** Seconds the follow-up has run so far (running) or took from dispatch to its reply. */
  seconds?: number;
  error?: string;
};
/** audio.memo.failed data.stage and error_code of a memo that `memo:cancel` ended. Not an error. */
export const CANCELLED = "cancelled";

/** Watcher StageError.stage -> the hop it was trying to reach. */
const STAGE_HOP: Record<string, HopId> = {
  // Device-side failures (the pad could not record, or the upload never completed) happen before S3 has the memo.
  record: "uploaded",
  upload: "uploaded",
  receive: "received",
  download: "received",
  transcribe: "transcribed",
  converse: "routed",
  dispatch: "dispatched",
  agent: "agent_started",
  agent_reply: "agent_done",
  tts: "replied",
  reply_upload: "replied",
  playback: "played"
};

export type HopFailure = {
  eventId: string;
  at: string;
  stage?: string;
  code?: string;
  message?: string;
  retryable: boolean;
  attempt?: number;
  /** Set when the gateway stopped the agent's turn at its per-turn wall clock (error code turn_timeout). */
  timeout?: TurnTimeout;
  /** Set on transcribe-stage failures that happened after the watcher measured the recording (silent_audio, empty_transcript, ...). */
  audio?: AudioLevel;
};

/** Numbers from a turn_timeout fact (the gateway's invocation.failed, or the watcher's memo.failed copy of it). */
export type TurnTimeout = {
  elapsedSeconds?: number;
  limitSeconds?: number;
  lane?: string;
  /** "lane" = the lane's configured limit; "envelope" = a shorter deadline the command asked for. */
  source?: string;
  /** false: Hermes did not confirm the turn stopped, so it may still be unwinding. */
  stopped?: boolean;
};

export const TURN_TIMEOUT = "turn_timeout";
/** Watcher error code for a recording with no sound in it (the microphone delivered nothing). */
export const SILENT_AUDIO = "silent_audio";
/** Agent Pad's own version, published when the device held a silent recording back (stage record): the file never reached S3. */
export const SILENT_CAPTURE = "silent_capture";
/** Same line as the watcher (MEMO_SILENT_MAX_DBFS): a loudest sample below this is silence. Used only to label a level the watcher did not already judge. */
export const SILENT_MAX_DBFS = -60;

/** How loud a recording is, measured by the watcher (ffmpeg volumedetect) before it spent a transcription. */
export type AudioLevel = { maxDbfs: number; meanDbfs?: number; durationSeconds?: number; silent: boolean };
/** What the recorder on the device itself saw (data.capture on the uploaded fact), before the file left the phone. */
export type CaptureLevel = { peakDbfs?: number; rmsDbfs?: number; silent?: boolean };

export function audioLevelOf(d: Record<string, unknown>): AudioLevel | undefined {
  const max = num(d.audio_max_dbfs);
  if (max === undefined) return undefined;
  return { maxDbfs: max, meanDbfs: num(d.audio_mean_dbfs), durationSeconds: num(d.audio_duration_seconds), silent: max < SILENT_MAX_DBFS };
}

export function captureLevelOf(d: Record<string, unknown>): CaptureLevel | undefined {
  const cap = rec(d.capture);
  const peak = num(cap.peak_dbfs);
  const rms = num(cap.rms_dbfs);
  if (peak === undefined && rms === undefined) return undefined;
  return { peakDbfs: peak, rmsDbfs: rms, silent: (peak ?? rms ?? 0) < SILENT_MAX_DBFS };
}

const dbfs = (v: number) => `${Math.round(v)} dBFS`;

/** "max -73 dBFS · mean -83 dBFS · silent" */
export function audioLevelText(l: AudioLevel): string {
  return [`max ${dbfs(l.maxDbfs)}`, l.meanDbfs !== undefined ? `mean ${dbfs(l.meanDbfs)}` : undefined, l.silent ? "silent" : "audible"].filter(Boolean).join(" · ");
}

/** "device heard peak -70 dBFS, window avg -78 dBFS" (the device's rms_dbfs is the RMS of 100 ms window peaks, not of samples) */
export function captureLevelText(c: CaptureLevel): string {
  const bits = [c.peakDbfs !== undefined ? `peak ${dbfs(c.peakDbfs)}` : undefined, c.rmsDbfs !== undefined ? `window avg ${dbfs(c.rmsDbfs)}` : undefined].filter(Boolean);
  return `device heard ${bits.join(", ")}${c.silent ? " (silent)" : ""}`;
}

export function turnTimeoutOf(d: Record<string, unknown>): TurnTimeout {
  return {
    elapsedSeconds: num(d.elapsed_seconds), limitSeconds: num(d.timeout_seconds), lane: str(d.lane),
    source: str(d.timeout_source), stopped: typeof d.turn_stopped === "boolean" ? d.turn_stopped : undefined
  };
}

/** "agent turn timed out after 20s on interactive lane (limit 20s)": the gateway's own text, else rebuilt from its numbers. */
export function turnTimeoutMessage(d: Record<string, unknown>): string {
  const given = str(d.error_message);
  if (given) return given;
  const t = turnTimeoutOf(d);
  return `agent turn timed out after ${t.elapsedSeconds ?? "?"}s on ${t.lane ?? "interactive"} lane`
    + (t.limitSeconds !== undefined ? ` (limit ${t.limitSeconds}s)` : "");
}

export type Hop = {
  id: HopId;
  label: string;
  status: HopStatus;
  at?: string;
  /** Milliseconds since the previous hop that happened. */
  sinceMs?: number;
  budgetSeconds: number;
  /** For waiting and stuck hops: seconds since the previous hop. */
  waitedSeconds?: number;
  detail: string;
  error?: HopFailure;
  failures: HopFailure[];
  events: JourneyEvent[];
  /** Transcribed hop: how loud the recording was (from the transcribed fact, else the transcribe failure). */
  audio?: AudioLevel;
  /** Uploaded hop: what the device's own recorder measured, when it reported it. */
  capture?: CaptureLevel;
  /** Replied hop: how the reply was spoken (late / escalated) and where its text sidecar went. */
  reply?: ReplyInfo;
  /** Set on the hop a `memo:cancel` stopped the memo at. */
  cancel?: Cancellation;
  /** Routed hop: the fast desk's decision. */
  routed?: Routed;
};

/** From the audio.memo.replied fact. */
export type ReplyInfo = {
  /** Spoken with the "late reply" prefix: the agent finished after the deadline the memo was first given. */
  late: boolean;
  /** The reply came from the batch turn the watcher escalated to after the interactive turn timed out. */
  escalated: boolean;
  /** The turn ran past the interactive wall clock (detached) and this is its late answer. */
  detached?: boolean;
  /** A quick answer: the agent handed the long part to a background follow-up (its plan). */
  background?: boolean;
  backgroundPlan?: string;
  /** The model route the command asked for, and what the gateway did with it ({requested, applied, reason}). */
  model?: string;
  modelApplied?: boolean;
  /** Earshot object of the reply audio (the phone's copy). */
  earshotKey?: string;
  /** Earshot object holding the FULL reply text next to the audio (the spoken digest is shorter). */
  earshotTextKey?: string;
  /** Why the phone copy was left out: car_spoke | car_holds | no_answer (car_live: the older presence rule). */
  earshotSkipped?: string;
  /**
   * Why the phone copy went the way it did: car_started | car_holds | claim_failed (left out, the proxy could not be
   * asked) or no_car_claim | car_let_go | browser_sender | skip_off (mirrored). Absent on a reply from before the claim.
   */
  earshotReason?: string;
  /** The phone copy landed after the replied fact said it was left to the car (audio.memo.mirrored): when, and how long after the release. */
  phoneLate?: { at: string; afterReleaseSeconds?: number; rounds?: number };
};

/** From an audio.memo.failed fact with data.stage "cancelled". */
export type Cancellation = {
  eventId: string;
  at: string;
  /** true: the command had been published, so the agent may still have run (nothing is undone, its reply is not spoken). */
  afterDispatch: boolean;
  message?: string;
};

/** One line the agent wrote while working (agent.invocation.progressed), in the order the gateway saw them. */
export type ProgressLine = {
  eventId: string;
  at: string;
  seq: number;
  text: string;
  commandId?: string;
  /** Seconds since the gateway handed the turn to Hermes. */
  elapsedSeconds?: number;
  /** A line of an earlier turn of an escalated memo (the interactive one that timed out). */
  superseded: boolean;
};

/** A progress line the watcher spoke for the car (audio.memo.narrated). */
export type Narration = {
  eventId: string;
  at: string;
  /** 1..n per memo: progress/<day>/<memo_id>-<n>.ogg. */
  n: number;
  /** The progress line's seq (agent.invocation.progressed) that was spoken. */
  seq?: number;
  key?: string;
  text?: string;
  ttsSeconds?: number;
  engine?: string;
  elapsedSeconds?: number;
};

/** One decision of the car's speech queue about this memo (audio.memo.notified). */
export type SpeechDecision = {
  eventId: string;
  /** Server time; deviceAt is the device's own clock when it sent one. */
  at: string;
  deviceAt?: string;
  /** ack | echo | progress | cue | reply (the device's word). */
  utterance: string;
  /** start | end | halt | drop | deferred (the device's word). */
  decision: string;
  reason?: string;
  recording?: boolean;
  mic?: string;
};

/** One sentence-chunk of the reply, uploaded before the full file (audio.memo.voiced). */
export type ReplyChunk = {
  eventId: string;
  at: string;
  /** 1..of: replies/<day>/<stamp>Z-<agent>-<memo_id>-c<n>of<of>.opus. */
  n: number;
  of: number;
  key?: string;
  text?: string;
  ttsSeconds?: number;
  /** Seconds after the agent finished (the watcher's own clock). */
  sinceAgentDoneSeconds?: number;
};

/** Seconds from the memo's start (its upload) to the first time the driver heard each kind of thing. */
export type MemoTiming = {
  /** The fast conversation desk decided (audio.memo.routed). */
  routedSeconds?: number;
  ackSeconds?: number;
  heardEchoSeconds?: number;
  firstProgressSeconds?: number;
  firstNarrationSeconds?: number;
  progressPlayedSeconds?: number;
  /** The reply's first chunk was up (chunked speech), and the full reply file was up (the replied fact). */
  firstChunkSeconds?: number;
  replyUpSeconds?: number;
  replyPlayedSeconds?: number;
  /** Time to first response once the agent finished: first chunk up, full reply up, the car speaking. */
  agentToFirstChunkSeconds?: number;
  agentToReplySeconds?: number;
  agentToCarSeconds?: number;
  /** The car's own lag: from the first audio it could play (first chunk, else the full reply) to its "started" beacon. */
  carLagSeconds?: number;
};

export type MemoSummary = {
  memoId: string;
  agent?: string;
  s3Key?: string;
  startedAt: string;
  updatedAt: string;
  totalSeconds: number;
  status: MemoStatus;
  /** Furthest hop that happened. */
  reached?: HopId;
  stageLabel: string;
  stuckAt?: HopId;
  /** Lane of the memo's command, from the dispatched fact (absent until dispatch; pre-lane facts read as batch). */
  lane?: Lane;
  /** Why the memo is not on the lane the watcher is configured for, e.g. interactive_consumer_not_pulling. */
  laneReason?: string;
  /** The interactive turn timed out and the memo was re-dispatched on the batch lane (it is not failed). */
  escalated?: boolean;
  /** The reply was spoken late ("<agent>, late reply."). */
  late?: boolean;
  /** The interactive turn passed the gateway's wall clock and ran on (slot released, no kill, no batch re-run). */
  detached?: boolean;
  /** The reply was a quick answer that handed the long part to a background follow-up. */
  background?: boolean;
  /** The newest background follow-up (or delegation) and where it is. */
  followup?: { n: number; status: FollowUp["status"]; seconds?: number; kind?: FollowUp["kind"]; target?: string; title?: string };
  /** The fast conversation desk decided this memo (an audio.memo.routed fact): conv id, turn, action, model@route. */
  conv?: ConvChip;
  /** Set when `memo:cancel` ended the memo. Cancelled is not an error. */
  cancelled?: Cancellation;
  transcriptPreview?: string;
  replyPreview?: string;
  error?: string;
  /** Loudness of the recording as the watcher measured it (absent for memos from before levels existed). */
  audio?: AudioLevel;
  /** Level the device's recorder reported (absent unless the pad / Honda app sends data.capture). */
  capture?: CaptureLevel;
  /** The newest line the agent wrote while working, and how many it wrote (absent when it wrote none). */
  latestProgress?: string;
  progressCount?: number;
  /** How many progress lines were spoken in the car. */
  narrationCount?: number;
};

export type MemoDetail = MemoSummary & {
  commandId?: string;
  /** Escalated memo: the interactive command whose turn timed out (commandId is the batch command). */
  escalatedFromCommandId?: string;
  transcript?: string;
  replyText?: string;
  hops: Hop[];
  events: JourneyEvent[];
  progress: ProgressLine[];
  narrations: Narration[];
  speech: SpeechDecision[];
  chunks: ReplyChunk[];
  timing: MemoTiming;
  /** The detach of the memo's interactive turn, when it ran past the wall clock. */
  detach?: Detach;
  /** Answer-then-background: every follow-up the quick answer handed off (or delegation the driver confirmed), oldest first. */
  followups: FollowUp[];
  /** The fast desk's decision for this memo, when it made one. */
  routed?: Routed;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const ms = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Turn a collected row into a JourneyEvent. Returns undefined for envelopes without a correlation id. */
export function toJourneyEvent(row: { cursor: number; collected_at: string; envelope: unknown }): JourneyEvent | undefined {
  const env = rec(row.envelope);
  const data = rec(env.data);
  const correlationId = str(env.correlationid) ?? str(data.memo_id);
  const type = str(env.type);
  if (!correlationId || !type) return undefined;
  const at = [str(data.occurred_at), str(env.time), row.collected_at].find((t) => ms(t) !== undefined) ?? row.collected_at;
  return {
    cursor: row.cursor,
    id: str(env.id) ?? String(row.cursor),
    type,
    at,
    collectedAt: row.collected_at,
    producer: str(env.producer),
    correlationId,
    data,
    envelope: row.envelope
  };
}

export function groupByMemo(events: JourneyEvent[]): Map<string, JourneyEvent[]> {
  const out = new Map<string, JourneyEvent[]>();
  for (const e of events) {
    const list = out.get(e.correlationId);
    if (list) list.push(e);
    else out.set(e.correlationId, [e]);
  }
  for (const list of out.values()) list.sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.cursor - b.cursor);
  return out;
}

function failureOf(e: JourneyEvent): HopFailure {
  const d = e.data;
  return {
    eventId: e.id,
    at: e.at,
    stage: str(d.stage),
    code: str(d.error_code),
    message: str(d.error_message),
    retryable: d.retryable === true,
    attempt: num(d.attempt),
    ...(str(d.error_code) === TURN_TIMEOUT ? { timeout: turnTimeoutOf(d) } : {}),
    ...(audioLevelOf(d) ? { audio: audioLevelOf(d) } : {})
  };
}

function agentFailure(e: JourneyEvent): HopFailure {
  const d = e.data;
  if (str(d.error_code) === TURN_TIMEOUT) {
    return { eventId: e.id, at: e.at, stage: "agent", code: TURN_TIMEOUT, message: turnTimeoutMessage(d), retryable: false, timeout: turnTimeoutOf(d) };
  }
  return {
    eventId: e.id,
    at: e.at,
    stage: "agent",
    code: str(d.error_code) ?? str(d.skip_code) ?? e.type.split(".").pop(),
    message: str(d.error_message) ?? str(d.reason) ?? str(d.error),
    retryable: false
  };
}

const first = (events: JourneyEvent[], ...types: string[]) => events.find((e) => types.includes(e.type));
const last = (events: JourneyEvent[], ...types: string[]) => {
  for (let i = events.length - 1; i >= 0; i--) if (types.includes(events[i].type)) return events[i];
  return undefined;
};

/** The lane a dispatched fact names: `lane`, else derived from command_subject, else batch (a fact from before lanes). */
export function laneOfDispatch(d: Record<string, unknown>): Lane {
  const lane = str(d.lane);
  if (lane === "interactive" || lane === "batch") return lane;
  const subject = str(d.command_subject);
  return subject?.endsWith(".invocation.invoke") ? "interactive" : "batch";
}

/** The dispatched fact of a re-dispatch on the batch lane after the interactive turn timed out. */
export function isEscalatedDispatch(d: Record<string, unknown>): boolean {
  return str(d.lane_reason) === ESCALATED_REASON || str(d.escalated_from_command_id) !== undefined;
}

/** A memo.failed fact that records `memo:cancel`, not a failure. */
export function isCancelFact(d: Record<string, unknown>): boolean {
  return str(d.stage) === CANCELLED || str(d.error_code) === CANCELLED;
}

export function replyInfoOf(d: Record<string, unknown>): ReplyInfo {
  const skipped = str(d.earshot_skipped);
  const reason = str(d.earshot_reason);
  const mo = rec(d.model_override);
  return { late: d.late === true, escalated: d.escalated === true, earshotKey: str(d.earshot_key), earshotTextKey: str(d.earshot_text_key),
    ...(skipped ? { earshotSkipped: skipped } : {}), ...(reason ? { earshotReason: reason } : {}),
    ...(d.detached === true ? { detached: true } : {}),
    ...(d.background === true ? { background: true, backgroundPlan: str(d.background_plan) } : {}),
    ...(str(d.model) ? { model: str(d.model) } : {}),
    ...(typeof mo.applied === "boolean" ? { modelApplied: mo.applied } : {}) };
}

/**
 * The replied fact says what was decided when it went out. If the phone copy landed afterwards (the watcher's background
 * retry of a reply it first gave back to the car), the audio.memo.mirrored fact is the newer truth: the copy exists now.
 */
export function withLateMirror(reply: ReplyInfo, mirrored: JourneyEvent | undefined): ReplyInfo {
  const key = mirrored ? str(mirrored.data.earshot_key) : undefined;
  if (!mirrored || !key) return reply;
  const { earshotSkipped: _skipped, ...rest } = reply;
  return { ...rest, earshotKey: key, earshotTextKey: str(mirrored.data.earshot_text_key) ?? reply.earshotTextKey, earshotReason: "late_drop",
    phoneLate: { at: mirrored.at, afterReleaseSeconds: num(mirrored.data.after_release_seconds), rounds: num(mirrored.data.rounds) } };
}

/** "command c2 · batch lane · fell back: interactive_consumer_not_pulling", or for an escalation: "... · escalated from command c1 (interactive turn timed out)". */
function dispatchDetail(d: Record<string, unknown>): string {
  const reason = str(d.lane_reason);
  const from = str(d.escalated_from_command_id);
  const why = isEscalatedDispatch(d)
    ? `escalated${from ? ` from command ${from}` : ""} (interactive turn timed out)`
    : reason ? `fell back: ${reason}` : undefined;
  return [str(d.command_id) ? `command ${str(d.command_id)}` : undefined, `${laneOfDispatch(d)} lane`, why].filter(Boolean).join(" · ");
}

function hopDetail(id: HopId, e: JourneyEvent | undefined): string {
  if (!e) return "";
  const d = e.data;
  switch (id) {
    case "uploaded": {
      const cap = captureLevelOf(d);
      return [num(d.bytes) !== undefined ? `${num(d.bytes)} bytes` : undefined, cap ? captureLevelText(cap) : undefined, str(d.client_user_agent)]
        .filter(Boolean).join(" · ");
    }
    case "received":
      return num(d.detect_lag_ms) !== undefined ? `watcher lag ${num(d.detect_lag_ms)} ms` : "";
    case "transcribed": {
      const bits = [
        num(d.word_count) !== undefined ? `${num(d.word_count)} words` : undefined,
        num(d.processing_seconds) !== undefined ? `${num(d.processing_seconds)} s` : undefined,
        str(d.model),
        audioLevelOf(d) ? audioLevelText(audioLevelOf(d)!) : undefined
      ].filter(Boolean);
      return bits.join(" · ");
    }
    case "routed": {
      const r = routedOf(e);
      return r ? routedDetail(r) : "";
    }
    case "dispatched":
    case "escalated":
      return dispatchDetail(d);
    case "agent_started":
    case "batch_started":
      return str(e.producer) ?? "";
    case "agent_done":
    case "batch_done": {
      if (!e.type.endsWith(".completed")) return agentFailure(e).message ?? e.type;
      const mo = rec(d.model_override);
      return [
        "invocation completed",
        d.detached === true ? `detached at the wall clock after ${num(d.detached_after_seconds) ?? "?"} s, ran on (${num(d.elapsed_seconds) ?? "?"} s in all)` : undefined,
        str(mo.requested) ? `model ${str(mo.requested)}${mo.applied === true ? "" : ` not applied (${str(mo.reason) ?? "?"})`}` : undefined
      ].filter(Boolean).join(" · ");
    }
    case "played": {
      const bits = [
        str(d.phase) === "ended" ? "played to the end" : "started playing",
        num(d.reply_age_ms) !== undefined ? `${num(d.reply_age_ms)} ms after rendering` : undefined,
        num(d.played_seconds) !== undefined ? `${num(d.played_seconds)} s of audio` : undefined
      ].filter(Boolean);
      return bits.join(" · ");
    }
    case "replied": {
      const bits = [
        d.late === true ? "late reply" : undefined,
        d.background === true ? "quick answer, the rest runs as a background follow-up" : undefined,
        num(d.tts_seconds) !== undefined ? `tts ${num(d.tts_seconds)} s` : undefined,
        str(d.tts_engine),
        str(d.reply_s3_key)
      ].filter(Boolean);
      return bits.join(" · ");
    }
  }
}

const AGENT_STARTED = ["bloodbank.agent.invocation.started", "bloodbank.conversation.turn.started"];
const AGENT_DONE = [
  "bloodbank.agent.invocation.completed",
  "bloodbank.agent.invocation.failed",
  "bloodbank.agent.invocation.skipped",
  "bloodbank.conversation.turn.completed",
  "bloodbank.conversation.turn.failed"
];

type Side = "first" | "batch";
/** Which command of an escalated memo an event belongs to: by command id, else by whether it came before the escalation. */
type Split = { escalation: JourneyEvent; sideOf: (e: JourneyEvent) => Side };

/** Pick the events that prove each hop, oldest first. An escalated memo splits its dispatch and agent facts between its two commands. */
function hopEvents(events: JourneyEvent[], split?: Split): Record<HopId, JourneyEvent[]> {
  const byType = (...t: string[]) => events.filter((e) => t.includes(e.type));
  // A background follow-up's dispatched and replied facts are its own (MemoDetail.followups), not the memo's hops.
  const mine = (...t: string[]) => byType(...t).filter((e) => !isFollowupFact(e.data));
  const on = (list: JourneyEvent[], side: Side) => (split ? list.filter((e) => split.sideOf(e) === side) : side === "first" ? list : []);
  const dispatches = mine("bloodbank.audio.memo.dispatched");
  return {
    uploaded: byType("bloodbank.audio.memo.uploaded"),
    received: byType("bloodbank.audio.memo.received"),
    transcribed: byType("bloodbank.audio.memo.transcribed"),
    routed: byType(ROUTED_TYPE),
    dispatched: split ? dispatches.filter((e) => e !== split.escalation) : dispatches,
    escalated: split ? [split.escalation] : [],
    agent_started: on(byType(...AGENT_STARTED), "first"),
    agent_done: on(byType(...AGENT_DONE), "first"),
    batch_started: on(byType(...AGENT_STARTED), "batch"),
    batch_done: on(byType(...AGENT_DONE), "batch"),
    replied: mine("bloodbank.audio.memo.replied"),
    played: byType("bloodbank.audio.memo.played")
  };
}

const AGENT_FAILED = ["bloodbank.agent.invocation.failed", "bloodbank.agent.invocation.skipped", "bloodbank.conversation.turn.failed"];
/** Facts that show the watcher moving a memo along (see `movedPast`); the `received` ones include its revive marker. */
const STAGE_FACTS = ["received", "transcribed", "routed", "dispatched", "replied"].map((t) => `bloodbank.audio.memo.${t}`);

const preview = (text: string | undefined, max: number) => {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Every background follow-up of a memo, oldest first: its dispatched fact (lane_reason voice_followup or voice_delegation,
 * data.followup = n), the gateway's facts for its command, and the replied fact the watcher published for it
 * (data.followup = n). A delegation's audio.memo.delegated fact (same command id) names its target, brief and permission;
 * one that arrives before its dispatched fact still shows the delegation, as running.
 */
export function followupsOf(events: JourneyEvent[], answer: JourneyEvent | undefined, now: number, cancelledAt?: string): FollowUp[] {
  const out: FollowUp[] = [];
  const dispatched = events.filter((e) => e.type === "bloodbank.audio.memo.dispatched" && isFollowupFact(e.data));
  const delegated = events.filter((e) => e.type === DELEGATED_TYPE);
  const heads: { d?: JourneyEvent; dl?: JourneyEvent; at: string }[] = dispatched.map((d) => {
    const cid = str(d.data.command_id);
    return { d, dl: cid ? delegated.find((x) => str(x.data.command_id) === cid) : undefined, at: d.at };
  });
  for (const dl of delegated) {
    const cid = str(dl.data.command_id);
    if (!heads.some((h) => h.dl === dl || (cid !== undefined && str(h.d?.data.command_id) === cid))) heads.push({ dl, at: dl.at });
  }
  heads.sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
  for (const { d, dl, at } of heads) {
    const dd = d?.data ?? {};
    const ld = dl?.data ?? {};
    const cid = str(dd.command_id) ?? str(ld.command_id);
    const of = (types: string[]) => events.filter((e) => types.includes(e.type) && cid !== undefined && str(e.data.command_id) === cid);
    const started = of(AGENT_STARTED)[0];
    const done = of(AGENT_DONE).find((e) => e.type.endsWith(".completed")) ?? of(AGENT_DONE)[0];
    const rep = events.find((e) => e.type === "bloodbank.audio.memo.replied" && isFollowupFact(e.data) && cid !== undefined && str(e.data.command_id) === cid);
    const gone = !rep && cancelledAt !== undefined && (ms(cancelledAt) ?? 0) >= (ms(at) ?? 0);
    const status: FollowUp["status"] = rep ? (rep.data.followup_failed === true ? "failed" : "spoken") : gone ? "failed" : "running";
    const t0 = ms(at);
    const t1 = ms(rep?.at) ?? (gone ? ms(cancelledAt) : undefined) ?? now;
    const a = ms(answer?.at), r = ms(rep?.at);
    const delegation = dl !== undefined || isDelegationFact(dd);
    const pick = (...keys: string[]) => keys.map((k) => str(ld[k]) ?? str(dd[k])).find(Boolean);
    out.push({
      n: num(dd.followup) ?? num(ld.followup) ?? out.length + 1,
      kind: delegation ? "delegation" : "followup",
      ...(delegation ? {
        // the delegated fact names the agent the brief went to; a dispatched fact alone says it as its target
        target: str(ld.target_agent_id) ?? str(dd.delegate_target) ?? str(dd.target_agent_id),
        targetName: pick("target_display_name", "display_name", "followup_display_name", "delegate_display_name"),
        title: pick("title", "followup_title", "delegation_title", "brief_title"),
        briefId: pick("brief_id"), perm: pick("perm"), convId: pick("conv_id")
      } : {}),
      commandId: cid, ofCommandId: str(dd.followup_of_command_id), status,
      plan: str(dd.followup_plan), lane: d ? laneOfDispatch(dd) : str(ld.lane) === "interactive" ? "interactive" : "batch",
      model: str(dd.model), dispatchedAt: at,
      startedAt: started?.at, doneAt: done?.at, repliedAt: rep?.at, replyText: str(rep?.data.reply_text), replyKey: str(rep?.data.reply_s3_key),
      afterAnswerSeconds: a !== undefined && r !== undefined ? Math.round((r - a) / 100) / 10 : undefined,
      seconds: t0 !== undefined && t1 !== undefined ? Math.max(0, Math.round((t1 - t0) / 100) / 10) : undefined,
      error: gone ? "cancelled by memo:cancel: not spoken" : done && AGENT_FAILED.includes(done.type) ? agentFailure(done).message : undefined
    });
  }
  return out;
}

/** Build the full journey for one memo from every fact that carries its correlation id. */
export function buildMemoDetail(memoId: string, input: JourneyEvent[], now: number): MemoDetail | undefined {
  const events = input.filter((e) => e.correlationId === memoId).sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.cursor - b.cursor);
  const memoFacts = events.filter((e) => e.type.startsWith("bloodbank.audio.memo."));
  if (!memoFacts.length) return undefined;

  // A retried memo is dispatched again under a fresh command id (and may pick another lane): the NEWEST
  // dispatched fact is the live command, the same one memo:trace reports. A background follow-up's dispatch is not: it
  // comes after the quick answer and is reported in `followups`.
  const dispatches = events.filter((e) => e.type === "bloodbank.audio.memo.dispatched" && !isFollowupFact(e.data));
  const dispatched = dispatches.at(-1);
  const commandId = str(dispatched?.data.command_id)
    ?? str(events.filter((e) => e.type === "bloodbank.audio.memo.replied" && !isFollowupFact(e.data)).at(-1)?.data.command_id);

  // An escalated memo's live command is the batch re-dispatch of the interactive command whose turn timed out.
  // Both commands' agent facts belong to the memo; the escalation splits them into two sets of hops.
  const escalation = dispatched && isEscalatedDispatch(dispatched.data) ? dispatched : undefined;
  const escalatedAt = ms(escalation?.at) ?? 0;
  const firstCommandId = escalation
    ? str(escalation.data.escalated_from_command_id)
      ?? str(dispatches.filter((d) => d !== escalation && (ms(d.at) ?? 0) <= escalatedAt).at(-1)?.data.command_id)
    : undefined;
  const sideOf = (e: JourneyEvent): Side => {
    if (!escalation) return "first";
    const cid = str(e.data.command_id);
    if (cid) return cid === commandId ? "batch" : "first";
    return (ms(e.at) ?? 0) >= escalatedAt ? "batch" : "first";
  };
  const ours = new Set([commandId, firstCommandId].filter((c): c is string => c !== undefined));
  // A follow-up's (or delegation's) command is its own record (`followups`), never the memo's turn: a turn the fast desk
  // answered has no command of its own, so without this its delegation's agent facts would read as the memo's.
  const followupCommands = new Set(events.filter((e) => (e.type === "bloodbank.audio.memo.dispatched" && isFollowupFact(e.data)) || e.type === DELEGATED_TYPE)
    .map((e) => str(e.data.command_id)).filter((c): c is string => c !== undefined && !ours.has(c)));
  // Agent facts must belong to this memo's command(s) when the ids are known.
  const relevant = events.filter((e) => {
    if (e.type.startsWith("bloodbank.audio.memo.")) return true;
    const cid = str(e.data.command_id);
    if (cid && followupCommands.has(cid)) return false;
    return !ours.size || !cid || ours.has(cid);
  });
  // The gateway's detach of the live command (its own fact, a progressed fact flagged detached, or the terminal fact).
  const ofLive = (e: JourneyEvent) => !commandId || str(e.data.command_id) === commandId;
  const detachedFact = relevant.find((e) => ofLive(e) && (e.type === DETACHED_TYPE || (e.type === PROGRESS_TYPE && e.data.detached === true)));
  const detachedDone = relevant.find((e) => ofLive(e) && AGENT_DONE.includes(e.type) && e.data.detached === true);
  const detach: Detach | undefined = detachedFact
    ? { at: detachedFact.at, elapsedSeconds: num(detachedFact.data.elapsed_seconds), ceilingSeconds: num(detachedFact.data.ceiling_seconds) }
    : detachedDone ? { at: detachedDone.at, elapsedSeconds: num(detachedDone.data.detached_after_seconds) } : undefined;

  // The fast desk's decision (the newest, should a restarted stage publish it again). A fast turn has no agent hops.
  const routedFact = memoFacts.filter((e) => e.type === ROUTED_TYPE).at(-1);
  const routed = routedFact ? routedOf(routedFact, dispatches.length > 0) : undefined;
  const specs = routed ? withRouted(escalation ? ESCALATED_HOPS : HOPS, routed) : escalation ? ESCALATED_HOPS : HOPS;
  const proof = hopEvents(relevant, escalation ? { escalation, sideOf } : undefined);

  // `memo:cancel` is a verdict, not a failure: it is kept apart from the failed facts.
  const cancelEvent = relevant.filter((e) => e.type === "bloodbank.audio.memo.failed" && isCancelFact(e.data)).at(-1);
  const cancelMs = ms(cancelEvent?.at) ?? 0;
  const cancelAfterDispatch = cancelEvent
    ? typeof cancelEvent.data.after_dispatch === "boolean" ? cancelEvent.data.after_dispatch : dispatches.some((d) => (ms(d.at) ?? 0) <= cancelMs)
    : false;
  // An explicit `memo:retry` revives a cancelled memo: any stage fact after the cancel supersedes it. A dispatched fact
  // after an after-dispatch cancel is only the watcher's late bookkeeping, not a revival.
  const revival = ["received", "transcribed", ...(cancelAfterDispatch ? [] : ["dispatched"]), "replied"].map((t) => `bloodbank.audio.memo.${t}`);
  const cancelled: Cancellation | undefined = cancelEvent && !memoFacts.some((e) => revival.includes(e.type) && (ms(e.at) ?? 0) > cancelMs)
    ? { eventId: cancelEvent.id, at: cancelEvent.at, afterDispatch: cancelAfterDispatch, message: str(cancelEvent.data.error_message) }
    : undefined;

  // A failure the memo has moved past is history, not its verdict: any stage fact after it (a retry's received, transcribed
  // or dispatched, a late reply) says the watcher took the memo up again. The watcher marks a revive that produces no stage
  // fact for a while (a retry at await_agent, a revived cancel) with a `received` fact carrying revived: true.
  const stageFacts = memoFacts.filter((e) => STAGE_FACTS.includes(e.type));
  const movedPast = (f: HopFailure) => stageFacts.some((e) => (ms(e.at) ?? 0) > (ms(f.at) ?? 0));

  const failureSide = new Map<string, Side>();
  const failedFacts: HopFailure[] = [];
  for (const e of relevant) {
    if (e.type !== "bloodbank.audio.memo.failed" || isCancelFact(e.data)) continue;
    const f = failureOf(e);
    failedFacts.push(f);
    failureSide.set(f.eventId, sideOf(e));
  }
  const hopOfFailure = (f: HopFailure): HopId | undefined => {
    const batch = failureSide.get(f.eventId) === "batch";
    let hop = (f.stage && STAGE_HOP[f.stage]) || undefined;
    if (batch && hop === "agent_started") hop = "batch_started";
    if (batch && hop === "agent_done") hop = "batch_done";
    // The watcher times out on "no completed turn"; when the agent never even started (the gateway dropped the
    // command, or it is still queued) the hop that failed is "Agent started", not "Agent finished".
    if (f.stage === "agent_reply" && f.code === "timeout" && (batch ? proof.batch_started : proof.agent_started).length === 0) {
      hop = batch ? "batch_started" : "agent_started";
    }
    return hop;
  };
  const failuresByHop = new Map<HopId, HopFailure[]>();
  const unplaced: HopFailure[] = [];
  for (const f of failedFacts) {
    const hop = hopOfFailure(f);
    // A fast turn has no agent hops: a failure aimed at one is shown on the first hop that did not happen instead.
    if (!hop || !specs.some((s) => s.id === hop)) unplaced.push(f);
    else failuresByHop.set(hop, [...(failuresByHop.get(hop) ?? []), f]);
  }

  const hops: Hop[] = specs.map((spec) => {
    const evs = proof[spec.id];
    const failures = failuresByHop.get(spec.id) ?? [];
    // A device-side silent_capture is superseded by any upload after it ("send anyway"): the pad let it go, the watcher judges it from here.
    const supersededByUpload = (f: HopFailure) =>
      f.code === SILENT_CAPTURE && f.stage === "record" && proof.uploaded.some((e) => (ms(e.at) ?? 0) >= (ms(f.at) ?? 0));
    const isDone = spec.id === "agent_done" || spec.id === "batch_done";
    const agentBad = isDone ? evs.find((e) => AGENT_FAILED.includes(e.type)) : undefined;
    const happened = isDone ? evs.find((e) => e.type === "bloodbank.agent.invocation.completed") ?? agentBad ?? evs[0] : evs[0];
    // On an escalated memo the interactive turn's timeout is the reason for the escalation, not the memo's verdict.
    const timedOut = escalation && spec.id === "agent_done" && !happened?.type.endsWith(".completed")
      ? agentBad ? (str(agentBad.data.error_code) === TURN_TIMEOUT ? agentFailure(agentBad) : undefined) : failures.find((f) => f.code === TURN_TIMEOUT)
      : undefined;
    const terminal = failures.filter((f) => !f.retryable && !supersededByUpload(f) && f !== timedOut && !movedPast(f)).at(-1);
    const out: Hop = {
      id: spec.id, label: spec.label, status: "pending", budgetSeconds: spec.budgetSeconds,
      at: happened?.at,
      detail: hopDetail(spec.id, spec.id === "played" ? evs.find((e) => str(e.data.phase) === "ended") ?? happened : happened),
      failures, events: evs
    };
    if (spec.id === "uploaded") out.capture = memoFacts.map((e) => captureLevelOf(e.data)).find(Boolean);
    if (spec.id === "routed" && routed) out.routed = routed;
    if (spec.id === "replied" && evs[0]) out.reply = withLateMirror(replyInfoOf(evs[0].data), memoFacts.filter((e) => e.type === "bloodbank.audio.memo.mirrored").at(-1));
    if (spec.id === "transcribed") {
      out.audio = (evs[0] ? audioLevelOf(evs[0].data) : undefined) ?? failures.map((f) => f.audio).filter(Boolean).at(-1);
      // The watcher fails a silent recording before it transcribes: that failure IS the transcribed hop's verdict, with the level as evidence.
      if (out.audio && !evs[0]) out.detail = audioLevelText(out.audio);
    }
    if (timedOut) {
      out.status = "timed_out";
      out.error = timedOut;
      out.detail = "not a failure: the watcher re-dispatched the same prompt on the batch lane";
      // Only the watcher's copy of the timeout may be collected so far: it still places the hop in time.
      const fact = relevant.find((e) => e.id === timedOut.eventId);
      if (fact && !evs.includes(fact)) out.events = [...evs, fact];
      out.at ??= timedOut.at;
    } else if (agentBad && !happened?.type.endsWith(".completed")) {
      out.status = "failed";
      out.error = agentFailure(agentBad);
    } else if (terminal) {
      out.status = "failed";
      out.error = terminal;
      if (happened) out.detail = `${out.detail}${out.detail ? " · " : ""}happened at ${happened.at}, after the watcher gave up`;
    } else if (happened) {
      out.status = "ok";
    } else if (spec.id === "played" && failures.length) {
      // Playback problems are retryable annotations on the pad's side: the hop shows them, the memo stays complete.
      out.status = "failed";
      out.error = failures.at(-1);
      out.detail = "the pad reported it could not play the reply";
    }
    return out;
  });
  // Failure facts we could not place on a hop (unknown stage) go on the first hop that did not happen.
  if (unplaced.length) {
    const target = hops.find((h) => h.status !== "ok") ?? hops.at(-1)!;
    target.failures = [...target.failures, ...unplaced];
    const terminal = unplaced.filter((f) => !f.retryable && !movedPast(f)).at(-1);
    if (terminal && target.status !== "failed") {
      target.status = "failed";
      target.error = terminal;
    }
  }

  // Latency since the previous hop that happened, in time order of the pipeline.
  let prev: Hop | undefined;
  for (const hop of hops) {
    if (hop.at && (hop.status === "ok" || hop.events.length)) {
      const a = ms(hop.at);
      const b = ms(prev?.at);
      if (a !== undefined && b !== undefined) hop.sinceMs = Math.max(0, a - b);
      prev = hop;
    }
  }

  const replied = hops.find((h) => h.id === "replied")!;
  const playedHop = hops.find((h) => h.id === "played")!;
  const failedHop = hops.find((h) => h.status === "failed" && h.id !== "played");
  const reachedIdx = hops.reduce((acc, h, i) => (h.at && h.events.length ? i : acc), -1);
  let status: MemoStatus;
  let stuckAt: HopId | undefined;

  // The first hop with no proof that comes after the last one that happened is the one we are waiting on.
  const lastHappened = hops[reachedIdx];
  const nextIdx = reachedIdx + 1;
  if (cancelled) {
    // The cancel is the verdict. It lands on the hop the memo had not reached yet, which keeps the later hops "not reached".
    status = "cancelled";
    const target = hops.slice(nextIdx).find((h) => h.status === "pending") ?? hops.at(-1)!;
    const at = ms(cancelled.at);
    const before = ms(lastHappened?.at);
    target.status = "cancelled";
    target.cancel = cancelled;
    target.at = cancelled.at;
    target.detail = cancelled.afterDispatch
      ? "cancelled after the command was published: the agent may still run, nothing is undone, and its reply will not be spoken"
      : "cancelled before dispatch: nothing was sent to an agent";
    target.events = [...target.events, cancelEvent!];
    if (at !== undefined && before !== undefined) target.sinceMs = Math.max(0, at - before);
  } else if (replied.status === "ok" && !failedHop) {
    status = "complete";
  } else if (failedHop) {
    status = "failed";
  } else {
    const waiting = hops[nextIdx];
    let since = ms(lastHappened?.at);
    let budget = waiting?.budgetSeconds ?? 0;
    // The replied fact waits for the watcher's phone decision (a car that holds the reply keeps it for minutes), so it is
    // the wrong clock for "is the reply rendered?": once the first audio is up (voiced chunk 1) the reply is rendered and
    // the car can speak it. The wait is then counted from that audio, with the decision's own allowance, and a car that
    // really started the reply (the pad's played fact, or its speech arbiter's start) is not waiting on anything.
    let carHasIt = false;
    let audioUpAt: number | undefined;
    if (waiting?.id === "replied") {
      audioUpAt = firstAudioUpMs(memoFacts.filter((e) => !isFollowupFact(e.data)));
      if (audioUpAt !== undefined) {
        since = Math.max(since ?? 0, audioUpAt);
        budget += REPLY_DECISION_BUDGET_SECONDS;
      }
      carHasIt = carStartedMs(memoFacts) !== undefined;
    }
    // A detached turn runs on until the gateway's ceiling: waiting on it that long is not "stuck".
    if (detach && waiting?.id === "agent_done") {
      budget = Math.max(budget, detach.ceilingSeconds ?? DETACHED_CEILING_SECONDS);
      waiting.detail = `detached at the wall clock${detach.elapsedSeconds !== undefined ? ` after ${Math.round(detach.elapsedSeconds)} s` : ""}: the turn runs on (no kill, no re-run) and its reply is spoken late`;
    }
    const waited = since !== undefined ? Math.max(0, (now - since) / 1000) : 0;
    status = "running";
    if (waiting) {
      waiting.status = waited > budget && !carHasIt ? "stuck" : "waiting";
      waiting.waitedSeconds = waited;
      if (carHasIt) waiting.detail = "the car is speaking this reply; the replied fact waits for the watcher's phone decision";
      else if (audioUpAt !== undefined && waiting.id === "replied") waiting.detail = "the reply is rendered and the car can speak it (a live car may hold it behind a recording); the replied fact waits for the watcher's phone-or-car decision";
      if (waiting.failures.length) {
        const last = waiting.failures.at(-1)!;
        waiting.error = last;
        waiting.detail = `attempt ${last.attempt ?? waiting.failures.length} failed, retrying`;
      }
      if (waiting.status === "stuck") {
        status = "stuck";
        stuckAt = waiting.id;
      }
    }
  }
  if (status === "complete" && playedHop.status === "pending") {
    playedHop.detail = "no playback report from the pad yet (replies reach it over the push channel /upload/events, with a 6 s poll behind it while that is live, else 2 s for 10 min after a send and 15 s after that; only the pad that sent the memo plays it; a parked car reports nothing)";
  }
  // Hops behind the frontier that never happened (not the optional first one) are holes in the record.
  for (const [i, hop] of hops.entries()) {
    if (hop.status === "pending" && i < reachedIdx) hop.status = "missing";
  }

  const startedAt = hops.find((h) => h.at)?.at ?? events[0].at;
  const terminalAt = status === "cancelled" ? cancelled?.at : failedHop?.error?.at ?? (status === "complete" ? replied.at : undefined);
  const endMs = (terminalAt ? ms(terminalAt) : undefined) ?? now;
  const startMs = ms(startedAt) ?? now;
  const updatedAt = events.reduce((acc, e) => ((ms(e.at) ?? 0) > (ms(acc) ?? 0) ? e.at : acc), startedAt);

  const lane = dispatched ? laneOfDispatch(dispatched.data) : undefined;
  const laneReason = str(dispatched?.data.lane_reason);
  const transcribed = first(relevant, "bloodbank.audio.memo.transcribed");
  const repliedEvent = relevant.find((e) => e.type === "bloodbank.audio.memo.replied" && !isFollowupFact(e.data));
  const transcript = str(transcribed?.data.transcript_text);
  const replyText = str(repliedEvent?.data.reply_text);
  const agent = memoFacts.map((e) => str(e.data.target_agent_id)).find(Boolean);
  const s3Key = memoFacts.map((e) => str(e.data.s3_key)).find(Boolean);
  const reply = repliedEvent ? withLateMirror(replyInfoOf(repliedEvent.data), memoFacts.filter((e) => e.type === "bloodbank.audio.memo.mirrored").at(-1)) : undefined;
  const escalated = escalation !== undefined || reply?.escalated === true;
  const followups = followupsOf(events, repliedEvent, now, cancelled?.at);
  const fu = followups.at(-1);

  let stageLabel: string;
  if (status === "cancelled") stageLabel = `Cancelled ${cancelled?.afterDispatch ? "after" : "before"} dispatch`;
  else if (status === "complete" && fu?.kind === "delegation") {
    stageLabel = fu.status === "running" ? `Sent to ${fu.targetName ?? fu.target ?? "the agent"} · running`
      : fu.status === "spoken" ? "Complete · delegated result spoken" : "Complete · delegation failed";
  } else if (status === "complete" && fu) {
    stageLabel = fu.status === "running" ? "Answered · follow-up running"
      : fu.status === "spoken" ? "Complete · follow-up spoken" : "Complete · follow-up failed";
  } else if (status === "complete" && routed?.fast) stageLabel = `Complete · ${FAST_DONE[routed.action] ?? routed.action}`;
  else if (status === "complete") stageLabel = reply?.late ? "Complete · late reply" : "Complete";
  else if (status === "failed" && failedHop?.error?.timeout) {
    const secs = failedHop.error.timeout.elapsedSeconds;
    stageLabel = `${failedHop.id === "batch_done" ? "Batch agent" : "Agent"} turn timed out${secs !== undefined ? ` after ${Math.round(secs)}s` : ""}`;
  } else if (status === "failed" && (failedHop?.error?.code === SILENT_AUDIO || failedHop?.error?.code === SILENT_CAPTURE)) {
    stageLabel = "Silent microphone";
  } else if (status === "failed" && failedHop?.id === "transcribed" && failedHop.error?.code === "empty_transcript" && failedHop.error.audio) {
    stageLabel = "No words recognised";
  } else if (status === "failed") stageLabel = `Failed at ${(failedHop?.label ?? "unknown").toLowerCase()}`;
  else if (status === "stuck") stageLabel = `Stuck before ${(hops.find((h) => h.id === stuckAt)?.label ?? "").toLowerCase()}`;
  else stageLabel = hops[nextIdx] ? `Waiting for ${hops[nextIdx].label.toLowerCase()}` : "Running";
  // The interactive turn timed out and the batch turn is carrying the memo: say so, it is in progress and not failed.
  if (escalation && (status === "running" || status === "stuck")) stageLabel = `Escalated to batch · ${stageLabel.charAt(0).toLowerCase()}${stageLabel.slice(1)}`;
  // The interactive turn ran past its wall clock and runs on: it is not stuck, its reply will be a late one.
  if (detach && !escalation && (status === "running" || status === "stuck")) stageLabel = `Detached, running on · ${stageLabel.charAt(0).toLowerCase()}${stageLabel.slice(1)}`;
  // Nothing happened yet, so no hop to name; a failure that carries its own label (the pad's silent_capture) keeps it.
  if (status !== "complete" && status !== "cancelled" && reachedIdx < 0 && stageLabel !== "Silent microphone") stageLabel = "Unknown";

  // The raw failure facts belong to the hop they failed, so the UI can show their envelopes too.
  // This runs after every state decision above, which read `events` as proof that a hop happened.
  for (const hop of hops) {
    for (const f of hop.failures) {
      const ev = relevant.find((e) => e.id === f.eventId);
      if (ev && !hop.events.includes(ev)) hop.events = [...hop.events, ev];
    }
    hop.events = [...hop.events].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.cursor - b.cursor);
  }

  // While the agent worked: its own lines, the ones spoken in the car, and every decision of the car's speech queue.
  const progress: ProgressLine[] = relevant.filter((e) => e.type === PROGRESS_TYPE && typeof e.data.seq === "number")
    .map((e) => ({
      eventId: e.id, at: e.at, seq: e.data.seq as number, text: str(e.data.text) ?? "", commandId: str(e.data.command_id),
      elapsedSeconds: num(e.data.elapsed_seconds), superseded: escalation !== undefined && sideOf(e) === "first"
    }))
    .sort((a, b) => Number(a.superseded === false) - Number(b.superseded === false) || a.seq - b.seq);
  const narrations: Narration[] = memoFacts.filter((e) => e.type === "bloodbank.audio.memo.narrated")
    .map((e) => ({
      eventId: e.id, at: e.at, n: num(e.data.narration) ?? 0, seq: num(e.data.seq), key: str(e.data.progress_s3_key),
      text: str(e.data.spoken_text), ttsSeconds: num(e.data.tts_seconds), engine: str(e.data.tts_engine),
      elapsedSeconds: num(e.data.elapsed_seconds)
    }));
  const speech: SpeechDecision[] = memoFacts.filter((e) => e.type === "bloodbank.audio.memo.notified")
    .map((e) => ({
      eventId: e.id, at: e.at, deviceAt: str(e.data.device_at), utterance: str(e.data.utterance) ?? "unknown",
      decision: str(e.data.decision) ?? "unknown", reason: str(e.data.reason),
      recording: typeof e.data.recording === "boolean" ? e.data.recording : undefined, mic: str(e.data.mic)
    }));
  // The reply chunk by chunk (first announcement per chunk: a stage retry re-uploads under the same key).
  const chunks: ReplyChunk[] = [];
  // A follow-up's chunks are its own (older watchers did not flag them: they are known by the follow-up's command id).
  const followupCmds = new Set(followups.map((f) => f.commandId).filter((c): c is string => c !== undefined));
  for (const e of memoFacts.filter((x) => x.type === "bloodbank.audio.memo.voiced" && !isFollowupFact(x.data)
    && !followupCmds.has(str(x.data.command_id) ?? ""))) {
    const n = num(e.data.chunk);
    if (n === undefined || chunks.some((c) => c.n === n)) continue;
    chunks.push({
      eventId: e.id, at: e.at, n, of: num(e.data.chunks) ?? n, key: str(e.data.chunk_s3_key), text: str(e.data.spoken_text),
      ttsSeconds: num(e.data.tts_seconds), sinceAgentDoneSeconds: num(e.data.since_agent_done_seconds)
    });
  }
  chunks.sort((a, b) => a.n - b.n);
  // A fast turn has no agent: its answer is the routed decision, so "after the agent finished" counts from there.
  const agentDone = routed?.fast ? routed.at : [...hops].reverse().find((h) => (h.id === "batch_done" || h.id === "agent_done") && h.status === "ok")?.at;
  const playedStarted = memoFacts.find((e) => e.type === "bloodbank.audio.memo.played" && e.data.phase === "started")?.at;
  const timing = memoTiming(startedAt, progress, narrations, speech,
    // reply_up_at: the replied fact waits for the phone decision, so the reply was up (and the car could start) before it
    // A reply spoken as one file has no first chunk: its voiced fact (chunk 1 of 1) is the moment the whole reply was up.
    { firstChunkAt: chunks[0] && chunks[0].of > 1 ? chunks[0].at : undefined,
      repliedAt: (repliedEvent && str(repliedEvent.data.reply_up_at)) ?? (chunks[0] && chunks[0].of === 1 ? chunks[0].at : undefined) ?? repliedEvent?.at,
      agentDoneAt: agentDone, playedAt: playedStarted, routedAt: routed?.at });
  const latest = [...progress].reverse().find((p) => !p.superseded) ?? progress.at(-1);

  const summary: MemoSummary = {
    memoId, agent, s3Key, startedAt, updatedAt,
    totalSeconds: Math.max(0, (endMs - startMs) / 1000),
    status,
    reached: reachedIdx >= 0 ? hops[reachedIdx].id : undefined,
    stageLabel,
    stuckAt,
    lane, laneReason,
    ...(escalated ? { escalated } : {}),
    ...(reply?.late ? { late: true } : {}),
    ...(detach || reply?.detached ? { detached: true } : {}),
    ...(reply?.background ? { background: true } : {}),
    ...(fu ? { followup: { n: fu.n, status: fu.status, seconds: fu.seconds,
      ...(fu.kind === "delegation" ? { kind: fu.kind, target: fu.targetName ?? fu.target, title: fu.title } : {}) } } : {}),
    ...(routed ? { conv: convChipOf(routed) } : {}),
    ...(cancelled ? { cancelled } : {}),
    audio: hops.find((h) => h.id === "transcribed")?.audio,
    capture: hops.find((h) => h.id === "uploaded")?.capture,
    transcriptPreview: preview(transcript, 140),
    replyPreview: preview(replyText, 140),
    // A cancelled memo is not an error, whatever else its hops recorded.
    error: status !== "cancelled" && (failedHop ?? (playedHop.status === "failed" ? playedHop : undefined))?.error
      ? `${(failedHop ?? playedHop).error!.code ?? "failed"}: ${(failedHop ?? playedHop).error!.message ?? ""}`.trim()
      : undefined,
    ...(latest ? { latestProgress: preview(latest.text, 140), progressCount: progress.length } : {}),
    ...(narrations.length ? { narrationCount: narrations.length } : {})
  };
  return {
    ...summary, commandId, ...(escalation && firstCommandId ? { escalatedFromCommandId: firstCommandId } : {}), transcript, replyText,
    hops, events: relevant, progress, narrations, speech, chunks, timing, ...(detach ? { detach } : {}), followups,
    ...(routed ? { routed } : {})
  };
}

/** The car's words (SpeechArbiter: ack | echo | progress | reply, start) and the schema's examples (heard, started). */
const SPOKEN: Record<string, string[]> = { ack: ["ack"], heard: ["echo", "heard"], progress: ["progress"], reply: ["reply"] };
const STARTED = ["start", "started"];

/** Seconds from the memo's start to the first ack, heard echo, progress line, narration and playback the driver got. */
export type ReplyTimes = { firstChunkAt?: string; repliedAt?: string; agentDoneAt?: string; playedAt?: string; routedAt?: string };
export function memoTiming(startedAt: string, progress: ProgressLine[], narrations: Narration[], speech: SpeechDecision[], reply: ReplyTimes = {}): MemoTiming {
  const t0 = ms(startedAt);
  const since = (iso: string | undefined) => {
    const t = ms(iso);
    return t0 !== undefined && t !== undefined ? Math.round((t - t0) / 100) / 10 : undefined;
  };
  const firstOf = (isos: (string | undefined)[]) => isos.filter((x): x is string => ms(x) !== undefined).sort((a, b) => ms(a)! - ms(b)!)[0];
  // On the server's clock (when the proxy got the decision), like every other figure here: the device's own clock is
  // not comparable with server facts (the sim's ran 1.3 s behind; the car's skew is unknown).
  const started = (what: keyof typeof SPOKEN) =>
    firstOf(speech.filter((d) => SPOKEN[what].includes(d.utterance) && STARTED.includes(d.decision)).map((d) => d.at ?? d.deviceAt));
  const between = (from: string | undefined, to: string | undefined) => {
    const a = ms(from), b = ms(to);
    return a !== undefined && b !== undefined ? Math.round((b - a) / 100) / 10 : undefined;
  };
  // The car speaking, on the server's clock like the agent's finish: the pad's "started" beacon, else the arbiter's own
  // start (device clock, only when no beacon arrived).
  const carAt = reply.playedAt ?? started("reply");
  const out: MemoTiming = {
    routedSeconds: since(reply.routedAt),
    ackSeconds: since(started("ack")),
    heardEchoSeconds: since(started("heard")),
    firstProgressSeconds: since(firstOf(progress.map((p) => p.at))),
    firstNarrationSeconds: since(firstOf(narrations.map((n) => n.at))),
    progressPlayedSeconds: since(started("progress")),
    firstChunkSeconds: since(reply.firstChunkAt),
    replyUpSeconds: since(reply.repliedAt),
    replyPlayedSeconds: since(started("reply")) ?? since(reply.playedAt),
    agentToFirstChunkSeconds: between(reply.agentDoneAt, reply.firstChunkAt),
    agentToReplySeconds: between(reply.agentDoneAt, reply.repliedAt),
    agentToCarSeconds: between(reply.agentDoneAt, carAt),
    // both server clocks: the beacon arrival against the fact that made the audio available
    carLagSeconds: between(reply.firstChunkAt ?? reply.repliedAt, reply.playedAt)
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as MemoTiming;
}

export function toSummary(detail: MemoDetail): MemoSummary {
  return {
    memoId: detail.memoId, agent: detail.agent, s3Key: detail.s3Key, startedAt: detail.startedAt, updatedAt: detail.updatedAt,
    totalSeconds: detail.totalSeconds, status: detail.status, reached: detail.reached, stageLabel: detail.stageLabel,
    stuckAt: detail.stuckAt, lane: detail.lane, laneReason: detail.laneReason, escalated: detail.escalated, late: detail.late, cancelled: detail.cancelled,
    audio: detail.audio, capture: detail.capture, transcriptPreview: detail.transcriptPreview, replyPreview: detail.replyPreview, error: detail.error,
    latestProgress: detail.latestProgress, progressCount: detail.progressCount, narrationCount: detail.narrationCount,
    detached: detail.detached, background: detail.background, followup: detail.followup, conv: detail.conv
  };
}

/** Newest-first summaries for every memo present in `events`. */
export function buildMemoSummaries(events: JourneyEvent[], now: number, limit = 25): MemoSummary[] {
  const groups = groupByMemo(events.filter((e) => e.type.startsWith("bloodbank.audio.memo.") || AGENT_TYPES.includes(e.type as (typeof AGENT_TYPES)[number])));
  const out: MemoSummary[] = [];
  for (const [memoId, list] of groups) {
    const detail = buildMemoDetail(memoId, list, now);
    if (!detail) continue;
    out.push(toSummary(detail));
  }
  out.sort((a, b) => (ms(b.startedAt) ?? 0) - (ms(a.startedAt) ?? 0));
  return out.slice(0, limit);
}

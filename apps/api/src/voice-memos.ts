// Pure grouping logic for the Voice memos view. No I/O, no clock: callers pass `now`.
//
// One voice memo is one Bloodbank correlation id. The upload proxy and the inbox watcher publish
// bloodbank.audio.memo.* stage facts with it; the command they dispatch carries it, so the
// gateway's agent.invocation.* and conversation.turn.* facts inherit it. Grouping those facts
// reproduces `mise run memo:trace` (services/inbox-watcher/memo_trace.py) from the collection.

export const MEMO_TYPES = [
  "bloodbank.audio.memo.uploaded",
  "bloodbank.audio.memo.received",
  "bloodbank.audio.memo.transcribed",
  "bloodbank.audio.memo.dispatched",
  "bloodbank.audio.memo.replied",
  "bloodbank.audio.memo.played",
  "bloodbank.audio.memo.failed"
] as const;

export const AGENT_TYPES = [
  "bloodbank.agent.invocation.started",
  "bloodbank.agent.invocation.completed",
  "bloodbank.agent.invocation.failed",
  "bloodbank.agent.invocation.skipped",
  "bloodbank.conversation.turn.started",
  "bloodbank.conversation.turn.completed",
  "bloodbank.conversation.turn.failed"
] as const;

export type HopId = "uploaded" | "received" | "transcribed" | "dispatched" | "agent_started" | "agent_done" | "replied" | "played";
export type HopStatus = "ok" | "failed" | "waiting" | "stuck" | "pending" | "missing";
export type MemoStatus = "complete" | "failed" | "running" | "stuck";
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

/** Watcher StageError.stage -> the hop it was trying to reach. */
const STAGE_HOP: Record<string, HopId> = {
  // Device-side failures (the pad could not record, or the upload never completed) happen before S3 has the memo.
  record: "uploaded",
  upload: "uploaded",
  receive: "received",
  download: "received",
  transcribe: "transcribed",
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
  transcriptPreview?: string;
  replyPreview?: string;
  error?: string;
  /** Loudness of the recording as the watcher measured it (absent for memos from before levels existed). */
  audio?: AudioLevel;
  /** Level the device's recorder reported (absent unless the pad / Honda app sends data.capture). */
  capture?: CaptureLevel;
};

export type MemoDetail = MemoSummary & {
  commandId?: string;
  transcript?: string;
  replyText?: string;
  hops: Hop[];
  events: JourneyEvent[];
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
    case "dispatched": {
      const reason = str(d.lane_reason);
      return [
        str(d.command_id) ? `command ${str(d.command_id)}` : undefined,
        `${laneOfDispatch(d)} lane`,
        reason ? `fell back: ${reason}` : undefined
      ].filter(Boolean).join(" · ");
    }
    case "agent_started":
      return str(e.producer) ?? "";
    case "agent_done":
      return e.type.endsWith(".completed") ? "invocation completed" : (agentFailure(e).message ?? e.type);
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
        num(d.tts_seconds) !== undefined ? `tts ${num(d.tts_seconds)} s` : undefined,
        str(d.tts_engine),
        str(d.reply_s3_key)
      ].filter(Boolean);
      return bits.join(" · ");
    }
  }
}

/** Pick the events that prove each hop, oldest first. */
function hopEvents(events: JourneyEvent[]): Record<HopId, JourneyEvent[]> {
  const byType = (...t: string[]) => events.filter((e) => t.includes(e.type));
  return {
    uploaded: byType("bloodbank.audio.memo.uploaded"),
    received: byType("bloodbank.audio.memo.received"),
    transcribed: byType("bloodbank.audio.memo.transcribed"),
    dispatched: byType("bloodbank.audio.memo.dispatched"),
    agent_started: byType("bloodbank.agent.invocation.started", "bloodbank.conversation.turn.started"),
    agent_done: byType(
      "bloodbank.agent.invocation.completed",
      "bloodbank.agent.invocation.failed",
      "bloodbank.agent.invocation.skipped",
      "bloodbank.conversation.turn.completed",
      "bloodbank.conversation.turn.failed"
    ),
    replied: byType("bloodbank.audio.memo.replied"),
    played: byType("bloodbank.audio.memo.played")
  };
}

const AGENT_FAILED = ["bloodbank.agent.invocation.failed", "bloodbank.agent.invocation.skipped", "bloodbank.conversation.turn.failed"];

const preview = (text: string | undefined, max: number) => {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Build the full journey for one memo from every fact that carries its correlation id. */
export function buildMemoDetail(memoId: string, input: JourneyEvent[], now: number): MemoDetail | undefined {
  const events = input.filter((e) => e.correlationId === memoId).sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.cursor - b.cursor);
  const memoFacts = events.filter((e) => e.type.startsWith("bloodbank.audio.memo."));
  if (!memoFacts.length) return undefined;

  // A retried memo is dispatched again under a fresh command id (and may pick another lane): the NEWEST
  // dispatched fact is the live command, the same one memo:trace reports.
  const dispatched = last(events, "bloodbank.audio.memo.dispatched");
  const commandId = str(dispatched?.data.command_id) ?? str(last(events, "bloodbank.audio.memo.replied")?.data.command_id);
  // Agent facts must belong to this memo's command when both ids are known.
  const relevant = events.filter((e) => {
    if (e.type.startsWith("bloodbank.audio.memo.")) return true;
    const cid = str(e.data.command_id);
    return !commandId || !cid || cid === commandId;
  });

  const proof = hopEvents(relevant);
  const failedFacts = relevant.filter((e) => e.type === "bloodbank.audio.memo.failed").map(failureOf);
  const failuresByHop = new Map<HopId, HopFailure[]>();
  for (const f of failedFacts) {
    let hop = (f.stage && STAGE_HOP[f.stage]) || undefined;
    // The watcher times out on "no completed turn"; when the agent never even started (the gateway dropped the
    // command, or it is still queued) the hop that failed is "Agent started", not "Agent finished".
    if (f.stage === "agent_reply" && f.code === "timeout" && proof.agent_started.length === 0) hop = "agent_started";
    if (!hop) continue;
    failuresByHop.set(hop, [...(failuresByHop.get(hop) ?? []), f]);
  }
  const unplaced = failedFacts.filter((f) => !f.stage || !STAGE_HOP[f.stage]);

  const hops: Hop[] = HOPS.map((spec) => {
    const evs = proof[spec.id];
    const failures = failuresByHop.get(spec.id) ?? [];
    // A device-side silent_capture is superseded by any upload after it ("send anyway"): the pad let it go, the watcher judges it from here.
    const supersededByUpload = (f: HopFailure) =>
      f.code === SILENT_CAPTURE && f.stage === "record" && proof.uploaded.some((e) => (ms(e.at) ?? 0) >= (ms(f.at) ?? 0));
    const terminal = failures.filter((f) => !f.retryable && !supersededByUpload(f)).at(-1);
    const agentBad = spec.id === "agent_done" ? evs.find((e) => AGENT_FAILED.includes(e.type)) : undefined;
    const happened = spec.id === "agent_done" ? evs.find((e) => e.type === "bloodbank.agent.invocation.completed") ?? agentBad ?? evs[0] : evs[0];
    const out: Hop = {
      id: spec.id, label: spec.label, status: "pending", budgetSeconds: spec.budgetSeconds,
      at: happened?.at,
      detail: hopDetail(spec.id, spec.id === "played" ? evs.find((e) => str(e.data.phase) === "ended") ?? happened : happened),
      failures, events: evs
    };
    if (spec.id === "uploaded") out.capture = memoFacts.map((e) => captureLevelOf(e.data)).find(Boolean);
    if (spec.id === "transcribed") {
      out.audio = (evs[0] ? audioLevelOf(evs[0].data) : undefined) ?? failures.map((f) => f.audio).filter(Boolean).at(-1);
      // The watcher fails a silent recording before it transcribes: that failure IS the transcribed hop's verdict, with the level as evidence.
      if (out.audio && !evs[0]) out.detail = audioLevelText(out.audio);
    }
    if (agentBad && !happened?.type.endsWith(".completed")) {
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
    const terminal = unplaced.filter((f) => !f.retryable).at(-1);
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
  if (replied.status === "ok" && !failedHop) {
    status = "complete";
  } else if (failedHop) {
    status = "failed";
  } else {
    const waiting = hops[nextIdx];
    const since = ms(lastHappened?.at);
    const waited = since !== undefined ? Math.max(0, (now - since) / 1000) : 0;
    status = "running";
    if (waiting) {
      waiting.status = waited > waiting.budgetSeconds ? "stuck" : "waiting";
      waiting.waitedSeconds = waited;
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
    playedHop.detail = "no playback report from the pad yet (it polls every 2 s for 10 min after a send, else 15 s; a parked car reports nothing)";
  }
  // Hops behind the frontier that never happened (not the optional first one) are holes in the record.
  for (const [i, hop] of hops.entries()) {
    if (hop.status === "pending" && i < reachedIdx) hop.status = "missing";
  }

  const startedAt = hops.find((h) => h.at)?.at ?? events[0].at;
  const terminalAt = failedHop?.error?.at ?? (status === "complete" ? replied.at : undefined);
  const endMs = (terminalAt ? ms(terminalAt) : undefined) ?? now;
  const startMs = ms(startedAt) ?? now;
  const updatedAt = events.reduce((acc, e) => ((ms(e.at) ?? 0) > (ms(acc) ?? 0) ? e.at : acc), startedAt);

  const lane = dispatched ? laneOfDispatch(dispatched.data) : undefined;
  const laneReason = str(dispatched?.data.lane_reason);
  const transcribed = first(relevant, "bloodbank.audio.memo.transcribed");
  const repliedEvent = first(relevant, "bloodbank.audio.memo.replied");
  const transcript = str(transcribed?.data.transcript_text);
  const replyText = str(repliedEvent?.data.reply_text);
  const agent = memoFacts.map((e) => str(e.data.target_agent_id)).find(Boolean);
  const s3Key = memoFacts.map((e) => str(e.data.s3_key)).find(Boolean);

  let stageLabel: string;
  if (status === "complete") stageLabel = "Complete";
  else if (status === "failed" && failedHop?.error?.timeout) {
    const secs = failedHop.error.timeout.elapsedSeconds;
    stageLabel = `Agent turn timed out${secs !== undefined ? ` after ${Math.round(secs)}s` : ""}`;
  } else if (status === "failed" && (failedHop?.error?.code === SILENT_AUDIO || failedHop?.error?.code === SILENT_CAPTURE)) {
    stageLabel = "Silent microphone";
  } else if (status === "failed" && failedHop?.id === "transcribed" && failedHop.error?.code === "empty_transcript" && failedHop.error.audio) {
    stageLabel = "No words recognised";
  } else if (status === "failed") stageLabel = `Failed at ${(failedHop?.label ?? "unknown").toLowerCase()}`;
  else if (status === "stuck") stageLabel = `Stuck before ${(hops.find((h) => h.id === stuckAt)?.label ?? "").toLowerCase()}`;
  else stageLabel = hops[nextIdx] ? `Waiting for ${hops[nextIdx].label.toLowerCase()}` : "Running";
  // Nothing happened yet, so no hop to name; a failure that carries its own label (the pad's silent_capture) keeps it.
  if (status !== "complete" && reachedIdx < 0 && stageLabel !== "Silent microphone") stageLabel = "Unknown";

  // The raw failure facts belong to the hop they failed, so the UI can show their envelopes too.
  // This runs after every state decision above, which read `events` as proof that a hop happened.
  for (const hop of hops) {
    for (const f of hop.failures) {
      const ev = relevant.find((e) => e.id === f.eventId);
      if (ev && !hop.events.includes(ev)) hop.events = [...hop.events, ev];
    }
    hop.events = [...hop.events].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.cursor - b.cursor);
  }

  const summary: MemoSummary = {
    memoId, agent, s3Key, startedAt, updatedAt,
    totalSeconds: Math.max(0, (endMs - startMs) / 1000),
    status,
    reached: reachedIdx >= 0 ? hops[reachedIdx].id : undefined,
    stageLabel,
    stuckAt,
    lane, laneReason,
    audio: hops.find((h) => h.id === "transcribed")?.audio,
    capture: hops.find((h) => h.id === "uploaded")?.capture,
    transcriptPreview: preview(transcript, 140),
    replyPreview: preview(replyText, 140),
    error: (failedHop ?? (playedHop.status === "failed" ? playedHop : undefined))?.error
      ? `${(failedHop ?? playedHop).error!.code ?? "failed"}: ${(failedHop ?? playedHop).error!.message ?? ""}`.trim()
      : undefined
  };
  return { ...summary, commandId, transcript, replyText, hops, events: relevant };
}

export function toSummary(detail: MemoDetail): MemoSummary {
  return {
    memoId: detail.memoId, agent: detail.agent, s3Key: detail.s3Key, startedAt: detail.startedAt, updatedAt: detail.updatedAt,
    totalSeconds: detail.totalSeconds, status: detail.status, reached: detail.reached, stageLabel: detail.stageLabel,
    stuckAt: detail.stuckAt, lane: detail.lane, laneReason: detail.laneReason, audio: detail.audio, capture: detail.capture, transcriptPreview: detail.transcriptPreview, replyPreview: detail.replyPreview, error: detail.error
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

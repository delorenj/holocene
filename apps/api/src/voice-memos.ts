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
};

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
    attempt: num(d.attempt)
  };
}

function agentFailure(e: JourneyEvent): HopFailure {
  const d = e.data;
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
    case "uploaded":
      return [num(d.bytes) !== undefined ? `${num(d.bytes)} bytes` : undefined, str(d.client_user_agent)].filter(Boolean).join(" · ");
    case "received":
      return num(d.detect_lag_ms) !== undefined ? `watcher lag ${num(d.detect_lag_ms)} ms` : "";
    case "transcribed": {
      const bits = [
        num(d.word_count) !== undefined ? `${num(d.word_count)} words` : undefined,
        num(d.processing_seconds) !== undefined ? `${num(d.processing_seconds)} s` : undefined,
        str(d.model)
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

  const dispatched = first(events, "bloodbank.audio.memo.dispatched");
  const commandId = str(dispatched?.data.command_id) ?? str(first(events, "bloodbank.audio.memo.replied")?.data.command_id);
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
    const terminal = failures.filter((f) => !f.retryable).at(-1);
    const agentBad = spec.id === "agent_done" ? evs.find((e) => AGENT_FAILED.includes(e.type)) : undefined;
    const happened = spec.id === "agent_done" ? evs.find((e) => e.type === "bloodbank.agent.invocation.completed") ?? agentBad ?? evs[0] : evs[0];
    const out: Hop = {
      id: spec.id, label: spec.label, status: "pending", budgetSeconds: spec.budgetSeconds,
      at: happened?.at,
      detail: hopDetail(spec.id, spec.id === "played" ? evs.find((e) => str(e.data.phase) === "ended") ?? happened : happened),
      failures, events: evs
    };
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
    playedHop.detail = "no playback report from the pad yet (it polls every 15 s; a parked car reports nothing)";
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
  else if (status === "failed") stageLabel = `Failed at ${(failedHop?.label ?? "unknown").toLowerCase()}`;
  else if (status === "stuck") stageLabel = `Stuck before ${(hops.find((h) => h.id === stuckAt)?.label ?? "").toLowerCase()}`;
  else stageLabel = hops[nextIdx] ? `Waiting for ${hops[nextIdx].label.toLowerCase()}` : "Running";
  if (status !== "complete" && reachedIdx < 0) stageLabel = "Unknown";

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
    stuckAt: detail.stuckAt, lane: detail.lane, laneReason: detail.laneReason, transcriptPreview: detail.transcriptPreview, replyPreview: detail.replyPreview, error: detail.error
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

// Deckard's agent state vocabulary and reconciliation, mirrored for the hub.
//
// Source of truth: deckard `docs/deck-modes.md` section 3 and `docs/visual-language.md`
// (five states, worst wins), `deckard-approve` `Activity::from_type` (what a bus event
// means) and `deckard-daemon` `agents.rs` (how long a declaration is held).
//
// The rule the hub used to break: presence is not work. A live process, or a stored
// `working` flag, proves nothing. A tile pulses only while a working event is fresh,
// shows a check only after the agent published a finished turn, and a missing terminal
// event leaves it dark once the evidence ends. It never becomes a manufactured check.
//
// Pure: no clock, no IO. Callers pass `nowMs`.

export type DeckardState = "idle" | "done" | "active" | "error" | "hitl";

const RANK: Record<DeckardState, number> = { idle: 0, done: 1, active: 2, error: 3, hitl: 4 };

/** Idle < Done < Active < Error < Hitl. One agent finishing never hides another still working. */
export const rankOf = (s: DeckardState) => RANK[s];
export function worst(...states: DeckardState[]): DeckardState {
  return states.reduce<DeckardState>((a, b) => (RANK[b] > RANK[a] ? b : a), "idle");
}

/** What a bus event says the agent is doing (deckard-approve `Activity`). */
export type Activity = "working" | "failed" | "turn-ended" | "session-started" | "session-ended";

/**
 * Port of `Activity::from_type`. Matched on the last three dotted tokens so
 * `bloodbank.agent.tool.requested` and the older `bloodbank.v1.agent.tool.requested` agree.
 *
 * A tool or subagent completing is still work: the turn is running. Only an explicit
 * `outcome: failed` on a turn, or `invocation.failed`, is an error. Antigravity binds its
 * per-turn Stop to `session.ended`, so for it that type is a finished turn.
 */
export function activityOf(type: string, cli?: string, outcome?: string): Activity | undefined {
  const tokens = type.split(".");
  if (tokens.length < 3) return undefined;
  const [domain, entity, action] = tokens.slice(-3);
  if (domain === "conversation" && entity === "turn") {
    if (action === "started") return "working";
    if (action === "completed") return outcome?.toLowerCase() === "failed" ? "failed" : "turn-ended";
    return undefined;
  }
  if (domain !== "agent") return undefined;
  if (entity === "tool" && ["requested", "invoked", "completed"].includes(action)) return "working";
  if (entity === "invocation") {
    if (["start", "started", "completed"].includes(action)) return "working";
    if (action === "failed") return "failed";
    return undefined; // `skipped` is n8n pipeline noise
  }
  if (entity === "session") {
    if (action === "started") return "session-started";
    if (action === "ended") return cli?.toLowerCase() === "antigravity" ? "turn-ended" : "session-ended";
  }
  return undefined;
}

// Freshness windows. The hub cannot see a process, so it uses the rules Deckard applies to
// agents it cannot prove alive (deck-modes section 3, "Every agent, not just the ones with a tab").
/** Working evidence with no newer event decays to Idle after this long. */
export const WORKING_WINDOW_MS = 10 * 60_000;
/**
 * The ceiling Deckard puts on a re-stamped pulse. The hub applies it only while a subagent or
 * worker is open, because it has no process table to prove a quiet agent is still running.
 */
export const HELD_WINDOW_MS = 30 * 60_000;
/** A finished turn leaves after two hours unseen. */
export const DONE_WINDOW_MS = 2 * 3600_000;
/** `state.hook_grace_secs`: a failure stops reading as red after this long. */
export const ERROR_WINDOW_MS = 120_000;

export type Declared = { at: number; activity: Activity; type?: string };

/** The evidence one agent has left on the bus, folded event by event. */
export type Latch = {
  state: DeckardState;
  /** Time of the event that set `state`. */
  at: number;
  /** Time of the newest working event, kept across a failure so a retry can resume. */
  workingAt: number;
  /** When the current state began. */
  since?: number;
  /** Newest declaring event, whatever it said. 0 when there is none. */
  lastMs: number;
  lastType?: string;
};

export const emptyLatch = (): Latch => ({ state: "idle", at: 0, workingAt: 0, lastMs: 0 });

export type Reading = {
  state: DeckardState;
  /** When the current state began. Absent for Idle. */
  sinceMs?: number;
  lastMs: number;
  lastType?: string;
};

function lapsed(latch: Latch, t: number, hold: boolean): boolean {
  switch (latch.state) {
    case "active":
      return t - latch.workingAt > (hold ? HELD_WINDOW_MS : WORKING_WINDOW_MS);
    case "done":
      return t - latch.at > DONE_WINDOW_MS;
    case "error":
      return t - latch.at > ERROR_WINDOW_MS;
    default:
      return false;
  }
}

/**
 * Fold one event into a latch and return the new one. Decay is applied between events too, so a
 * pulse that lapsed before the next burst starts a new run instead of extending the old one.
 * Events must arrive oldest first.
 */
export function foldEvent(prior: Latch, e: Declared): Latch {
  const base: Latch = lapsed(prior, e.at, false) ? { ...emptyLatch(), lastMs: prior.lastMs, lastType: prior.lastType } : prior;
  const next: Latch = { ...base, lastMs: Math.max(base.lastMs, e.at), lastType: e.type ?? base.lastType };
  switch (e.activity) {
    case "working":
      return { ...next, state: "active", at: e.at, workingAt: e.at, since: base.state === "active" ? base.since : e.at };
    case "failed":
      return { ...next, state: "error", at: e.at, since: e.at };
    case "turn-ended":
      return { ...next, state: "done", at: e.at, since: e.at };
    case "session-started":
      // Presence only. The same session starting again (compaction, resume) must not blank a pulse or a check.
      return next;
    case "session-ended":
      return { ...emptyLatch(), lastMs: next.lastMs, lastType: next.lastType };
  }
}

/**
 * What the latch reads as at `nowMs`. `hold` is true while the agent has an open subagent or
 * worker, which extends the working window to the held ceiling.
 */
export function readLatch(latch: Latch, nowMs: number, hold = false): Reading {
  const live = lapsed(latch, nowMs, hold) ? "idle" : latch.state;
  return { state: live, sinceMs: live === "idle" ? undefined : latch.since, lastMs: latch.lastMs, lastType: latch.lastType };
}

/** One agent's declared state at `nowMs`, from its events in any order. */
export function reconcile(events: Declared[], nowMs: number, hold = false): Reading {
  const latch = [...events].sort((a, b) => a.at - b.at).reduce(foldEvent, emptyLatch());
  return readLatch(latch, nowMs, hold);
}

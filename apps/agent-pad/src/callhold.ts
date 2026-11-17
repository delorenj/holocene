// Quiet on a call (operator rule, 2026-11-16): "If the phone is on a call, mute, then defer until I hang up."
// One operator-on-call signal for every voice surface: Earshot on the phone sends `call` on its heartbeat beacon while
// the phone rings or is in a call, the upload proxy keeps the latest per device (GET /upload/operator, and a `call`
// event on the push stream at every transition and on connect), and the proxy refuses the car's claims (hold, start)
// while the call lasts with {ok:false, on_call:true}. This page is the car's half:
//
// - While on a call nothing STARTS: no reply, no chunk, no progress or hold-cue clip.
// - The call starting MUTES what plays: a reply is stopped at once (the host's stopReply, else the <audio> is paused)
//   and goes back to the HEAD of the queue, to be said again from the start after the hang-up; a progress or hold-cue
//   clip is dropped (it is news about a moment that passed). A call stop is not a play failure: no strike, no watchdog,
//   no release to the phone, nothing marked heard.
// - The hang-up resumes the queue as usual (the proxy's claim says yes again).
// - A claim refused with on_call is "wait, keep it at the head", never a strike or a skip.
//
// Fail-open: nothing known (an old proxy without the endpoint, a stream that never says `call`) is "not on a call",
// and the pad behaves exactly as before. A call the pad stopped hearing about (the proxy went quiet mid-call) is trusted
// for CALL_TRUST_MS past its last confirmation, then forgotten; while on a call the pad re-reads the endpoint every
// CALL_RECHECK_MS, so a live proxy keeps confirming it and a missed hang-up event is caught within seconds. It re-reads
// it at that pace too while its push stream is not live, so a call that starts then is still caught. A read that a
// newer report overtook (the push event, a claim refusal) is not applied: reports are applied in order.
// Pure rules, so they are tested.

/** While on a call the pad re-reads GET /upload/operator this often (also catches a hang-up event it missed). */
export const CALL_RECHECK_MS = 10_000
/** How long a call is believed without a fresh confirmation (four missed rechecks and a bit): then fail-open. */
export const CALL_TRUST_MS = 45_000
/** How long a progress clip handed to the host may still be sounding (its PROGRESS_WAIT_MS 30 s, plus the clip). */
export const PROGRESS_CUT_MS = 45_000
/** How long the boot / reconnect read of the endpoint may take. */
export const CALL_FETCH_MS = 2_500

const KIND = /^[a-z][a-z_]{0,31}$/

/** One report of the operator's call state: the push stream's `call` event or the endpoint's body. */
export type CallInfo = { onCall: boolean; call: string | null; since: number | null; gate?: boolean }

/**
 * What the pad believes. `at`: when it was last confirmed (0: never). `gate`: the proxy's kill switch
 * (OPERATOR_CALL_GATE=0 records and reports the call but holds nothing); the push event does not carry it, so the
 * last known value stands, and a proxy that never said is taken to hold.
 */
export type CallState = { onCall: boolean; call: string | null; since: number | null; gate: boolean; at: number }

export const CALL_UNKNOWN: CallState = { onCall: false, call: null, since: null, gate: true, at: 0 }

/** The `call` event's data (a JSON string or an object) or the endpoint's body; null when it is not one to trust. */
export function parseCall(data: unknown): CallInfo | null {
  let o = data
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  const e = o as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.on_call !== 'boolean') return null
  const call = typeof e.call === 'string' && KIND.test(e.call) ? e.call : null
  const since = typeof e.since === 'number' && Number.isFinite(e.since) && e.since > 0 ? e.since : null
  const out: CallInfo = { onCall: e.on_call, call: e.on_call ? call : null, since: e.on_call ? since : null }
  if (typeof e.gate === 'boolean') out.gate = e.gate
  return out
}

/** A report replaces what the pad believed; a report without the kill switch keeps the last known one. */
export function noteCall(prev: CallState, info: CallInfo, now: number): CallState {
  return { onCall: info.onCall, call: info.call, since: info.since, gate: info.gate ?? prev.gate, at: now }
}

/** A claim the proxy refused with on_call:true: it is on a call now, and its gate is on (it refused). */
export function noteCallRefusal(prev: CallState, now: number): CallState {
  return { onCall: true, call: prev.onCall ? prev.call : null, since: prev.onCall ? prev.since : null, gate: true, at: now }
}

/** Is the pad holding everything for a call right now? Unknown, stale, gate off or off a call: no (fail-open). */
export function holding(s: CallState, now: number): boolean {
  return s.onCall && s.gate && s.at > 0 && now - s.at < CALL_TRUST_MS
}

/** start: the call began (mute and hold). end: it ended (resume the queue). null: nothing changed. */
export function callShift(before: boolean, after: boolean): 'start' | 'end' | null {
  if (before === after) return null
  return after ? 'start' : 'end'
}

/**
 * Is the endpoint re-read now? While the pad believes in a call, every CALL_RECHECK_MS (a missed hang-up). And while the
 * push stream is not live (down, half-open, reconnecting: `pushOk` false), at the same pace: then the `call` event cannot
 * reach the pad, and a reply already sounding renews no claim the proxy could refuse, so this read is what mutes it.
 */
export function recheckDue(s: CallState, lastAsked: number, now: number, pushOk = true): boolean {
  return (s.onCall || !pushOk) && now - lastAsked >= CALL_RECHECK_MS
}

/**
 * What the call's start does to what is sounding. requeue: a reply, stopped and put back at the head of the queue to
 * be said from the start after the hang-up (not a failure, not heard). drop: a progress or hold-cue clip, cut and
 * forgotten. none: nothing plays.
 */
export function onCallStart(playing: 'reply' | 'progress' | null): 'requeue' | 'drop' | 'none' {
  if (playing === 'reply') return 'requeue'
  if (playing === 'progress') return 'drop'
  return 'none'
}

/** The queue with `key` at its head (it was stopped by a call: it is said first after the hang-up). */
export function requeueHead(queue: string[], key: string): string[] {
  return [key, ...queue.filter((k) => k !== key)]
}

/**
 * Progress clips handed to the host that may still be sounding or waiting in its speech queue: the memos to cut at the
 * call's start (the host has no stop for a single clip; its memo-final drop is the cut). `handed`: memo id -> when its
 * newest clip went to the host.
 */
export function progressToCut(handed: Map<string, number>, now: number): string[] {
  return [...handed].filter(([, at]) => now - at < PROGRESS_CUT_MS).map(([memo]) => memo)
}

/**
 * How long before the pad learns of a call a reply's play failure is taken to be the call's doing. The ring takes the
 * car's audio at once (the host reports focus_lost, or a plain error), while the call reaches the pad only through
 * Earshot's beacon, the proxy and the push stream: a few seconds later.
 */
export const CALL_FAIL_GRACE_MS = 15_000

/** Replies whose last play failure came just before the call's start (`failedAt`: key -> when): their failure counts
 *  start over, as a call stop's do (no strike from the call). */
export function failsToForgive(failedAt: Record<string, number>, now: number): string[] {
  return Object.entries(failedAt).filter(([, at]) => now - at < CALL_FAIL_GRACE_MS).map(([key]) => key)
}

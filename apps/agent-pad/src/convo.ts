// The fast in-car conversation desk (the watcher's converse stage) as the pad sees it: which reply units are a fast
// turn's own answer, and what a barge-in does to one. Pure, so the rule is tested.
//
// A fast turn answers in a few seconds. When the driver starts a new note over that answer, the note IS the driver's
// next turn: replaying the old answer after it would put stale speech in front of the answer to the new note. So a
// fast-turn answer the driver barged into (it had started playing) is finished as skipped (barged_in), not put back at
// the head of the queue. Its car claim stays (the start claimed it), so the phone never says it either.
//
// Everything else replays after the note as before: a delegated agent's result (a follow-up: its own reply key), a
// direct turn's agent answer, any reply of a memo the desk did not decide, and a fast answer that had not started yet.

import type { Conv } from './status.ts'
import { parseReplyKey } from './replies.ts'

export type BargeVerdict = 'skip' | 'requeue'

/** The reply unit of the fast desk's own answer to that turn, or null (no reply key yet, a direct turn, or not a reply key). */
export function convReplyUnit(conv: Conv | null | undefined): string | null {
  if (!conv || !conv.reply_key || conv.action === 'direct') return null
  return parseReplyKey(conv.reply_key)?.unit ?? null
}

/**
 * Why the host's speech queue (SpeechArbiter.kt) handed a reply back that means a note is starting: the mic preempted it
 * (recording), or the page stopped it to record (stopped). Neither a focus loss (a call, the car's own assistant) nor a
 * reset (SpeechArbiter.reset: the page was torn down, the pad hidden) is the driver speaking over it: that reply plays
 * again, because the car's claim stays on a skipped reply and a torn-down page would otherwise leave nobody to play it.
 */
export const BARGE_REASONS = ['recording', 'stopped']

/**
 * What to do with a reply the host's speech queue deferred (or the pad stopped) because a note is starting. 'skip': it
 * is the fast turn's own answer, it had started playing and a note cut it (the driver barged in); 'requeue': it plays
 * again after the note, as every reply did before the desk.
 */
export function onDeferred(unitKey: string, conv: Conv | null | undefined, how: { started?: boolean; reason?: string } = {}): BargeVerdict {
  const { started = true, reason = 'recording' } = how
  if (!started) return 'requeue' // never heard: dropping it would leave the driver with no answer at all
  if (!BARGE_REASONS.includes(reason)) return 'requeue'
  return convReplyUnit(conv) === unitKey ? 'skip' : 'requeue'
}

/** Fast-turn answers the pad has learned of (unit key -> its conv), newest last, bounded. */
export const FAST_TURNS_MAX = 64

/** Remember a status object's conv by the reply unit it names. Returns the same map (mutated), oldest dropped first. */
export function noteConv(known: Map<string, Conv>, conv: Conv | null | undefined): Map<string, Conv> {
  const unit = convReplyUnit(conv)
  if (!unit || !conv) return known
  known.delete(unit)
  known.set(unit, conv)
  while (known.size > FAST_TURNS_MAX) known.delete(known.keys().next().value as string)
  return known
}

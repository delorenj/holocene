// How fast the pad gets a fast reply into the car's speech queue once it is up, and what the driver hears in between.
// Pure, so the rules are tested.
//
// Audio focus: the host's player asks for transient focus before each reply. A refusal (focus_denied: a call, the
// car's own assistant listening, another app's prompt) or a loss mid-reply (focus_lost) says nothing about the reply
// itself: the next offer usually gets focus a moment later. So such a failure is retried quickly (300 ms, then 1 s,
// 2 s, 4 s, 8 s, then every 10 s) and does not count toward the strikes that drop a reply that cannot play. The host's
// SpeechArbiter still serialises every offer, so a retry can never overlap a recording or another utterance. After
// FOCUS_FREE_TRIES refusals in a row (about a minute and a half of refusals) a focus failure counts as a strike again,
// so a car whose focus never comes back still gives the reply up (and the phone may take it).

/** Retry delays after an audio-focus refusal; the last one repeats. */
export const FOCUS_RETRY_MS = [300, 1000, 2000, 4000, 8000, 10_000]
/** Focus refusals in a row that are free (do not count as a strike). */
export const FOCUS_FREE_TRIES = 12
/** The retry after any other playback failure (a bad file, a host player error). */
export const PLAY_RETRY_MS = 5000
/** Strikes that drop a reply. */
export const PLAY_STRIKES = 3

/** A host playback error that is about audio focus, not about the reply. */
export function isFocusFailure(detail: string): boolean {
  return /^focus_(denied|lost)\b/.test(detail.trim())
}

export type RetryPlan = { delay: number; strike: boolean }

/**
 * What a playback failure does. `focusTries`: focus failures in a row for this reply, this one included. A strike counts
 * toward PLAY_STRIKES; the caller drops the reply once it has that many.
 */
export function retryPlan(focus: boolean, focusTries: number): RetryPlan {
  if (focus && focusTries <= FOCUS_FREE_TRIES) {
    return { delay: FOCUS_RETRY_MS[Math.min(Math.max(focusTries, 1), FOCUS_RETRY_MS.length) - 1], strike: false }
  }
  return { delay: PLAY_RETRY_MS, strike: true }
}

/**
 * The agent name sent with 'stopped' (the host says "Got it, <name>'s on it." for a name, "Got it, sending." for none).
 * In the car the name was already said at the start ("Recording for X"), and with the fast desk on the desk answers,
 * not the agent: the short ack is said instead, so the STOP ack the reply has to wait behind is about a second shorter
 * (the host plays the note's acks before anything else ready). A browser has no spoken ack; it keeps the name.
 */
export function stopAckName(hostKind: 'car' | 'browser', name: string | undefined): string | undefined {
  return hostKind === 'car' ? '' : name
}

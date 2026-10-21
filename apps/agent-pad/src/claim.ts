// Who speaks a reply in the cabin: this car, or the phone's Earshot copy. The upload proxy decides (POST /upload/claim),
// atomically, because both ask it. A car HOLDS a reply it means to play on a lease (CLAIM_LEASE_MS) that it renews while
// the reply waits in its queue (behind a recording, another reply), and claims its START when it plays it. The inbox
// watcher TAKES the reply for the phone only when no car started it or holds it about 12 s after its audio was up: a car
// switched off right after the agent finished never claims it, or lets its lease lapse, and the phone speaks it.
// A reply the phone took is the phone's: the car skips it (a paired phone plays through the car's own speakers, so the
// same reply twice, or one over a recording, would break "nothing speaks over anything"). The car is the one that gives
// way because this page is deployed live; Earshot plays whatever lands in its channel.
// No answer (an older proxy, the network) is no refusal: the car plays, as before claims. Pure rules, so they are tested.

/** The proxy's hold lease (its CLAIM_LEASE_S). */
export const CLAIM_LEASE_MS = 20_000
/** A reply that waits renews its hold this often. */
export const CLAIM_RENEW_MS = 5_000
/** A hold this close to its end is not trusted to cover the start: the start is claimed, and its answer awaited, first. */
export const CLAIM_MARGIN_MS = 4_000
/** How long a claim may take before the car goes ahead without its answer. */
export const CLAIM_WAIT_MS = 2_500

/** car: this car holds (or started) the reply. phone: the phone took it, leave it. none: no answer. */
export type ClaimAnswer = 'car' | 'phone' | 'none'
export type Claim = { answer: ClaimAnswer; at: number }

/** The proxy's answer to a claim: HTTP status and JSON body. */
export function claimAnswer(status: number, body: unknown): ClaimAnswer {
  const b = (body && typeof body === 'object' ? body : {}) as { ok?: unknown; owner?: unknown }
  if (status !== 200) return 'none'
  if (b.ok === true) return 'car'
  return b.ok === false && b.owner === 'phone' ? 'phone' : 'none'
}

/** A newer answer replaces the old one; no answer never forgets a refusal or a live hold. */
export function noteClaim(prev: Claim | undefined, answer: ClaimAnswer, now: number): Claim | undefined {
  if (answer === 'none') return prev
  return { answer, at: now }
}

/**
 * What the car does when the reply's turn comes. skip: the phone has it. play: a live hold covers the start (which is
 * claimed on the side). claim: no live hold: the start is claimed and its answer awaited (no answer plays anyway).
 */
export function startPlan(c: Claim | undefined, now: number): 'play' | 'claim' | 'skip' {
  if (c?.answer === 'phone') return 'skip'
  if (c?.answer === 'car' && now - c.at < CLAIM_LEASE_MS - CLAIM_MARGIN_MS) return 'play'
  return 'claim'
}

/** Is a hold due for a reply that waits (never claimed, or its last hold is CLAIM_RENEW_MS old)? */
export function holdDue(c: Claim | undefined, now: number): boolean {
  if (c?.answer === 'phone') return false
  return !c || now - c.at >= CLAIM_RENEW_MS
}

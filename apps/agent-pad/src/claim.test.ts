import test from 'node:test'
import assert from 'node:assert/strict'
import { CLAIM_CONFIRM_MAX_MS, CLAIM_LEASE_MS, CLAIM_MARGIN_MS, CLAIM_RENEW_MS, claimAnswer, confirmDue, holdDue, noteClaim, startPlan, startVerdict } from './claim.ts'

const T = 1_000_000

test('the proxy answer: ok is the car, a refusal by the phone is the phone, anything else is no answer', () => {
  assert.equal(claimAnswer(200, { ok: true, owner: 'car' }), 'car')
  assert.equal(claimAnswer(200, { ok: false, owner: 'phone' }), 'phone')
  assert.equal(claimAnswer(200, { ok: false, owner: 'car' }), 'none')
  assert.equal(claimAnswer(404, { ok: false, owner: 'phone' }), 'none', 'an older proxy without claims')
  assert.equal(claimAnswer(200, null), 'none')
})

test('a car that holds the reply plays it at once; a stale or missing hold claims the start first', () => {
  const held = noteClaim(undefined, 'car', T)
  assert.equal(startPlan(held, T + 1000), 'play')
  assert.equal(startPlan(held, T + CLAIM_LEASE_MS - CLAIM_MARGIN_MS), 'claim', 'too close to the end of the lease')
  assert.equal(startPlan(undefined, T), 'claim')
})

test('a reply the phone took is skipped, and no later non-answer forgets that', () => {
  let c = noteClaim(noteClaim(undefined, 'car', T), 'phone', T + 30_000)
  assert.equal(startPlan(c, T + 31_000), 'skip')
  c = noteClaim(c, 'none', T + 32_000)
  assert.equal(startPlan(c, T + 33_000), 'skip')
  assert.equal(holdDue(c, T + 60_000), false)
})

test('a waiting reply renews its hold every few seconds, well inside the lease', () => {
  assert.equal(holdDue(undefined, T), true)
  const c = noteClaim(undefined, 'car', T)
  assert.equal(holdDue(c, T + CLAIM_RENEW_MS - 1), false)
  assert.equal(holdDue(c, T + CLAIM_RENEW_MS), true)
  // renewals are looked at every CLAIM_RENEW_MS / 2: a healthy hold is at most 1.5 renewals old when its turn comes
  assert.ok(CLAIM_RENEW_MS * 1.5 < CLAIM_LEASE_MS - CLAIM_MARGIN_MS, 'a healthy waiting reply still plays on its hold')
  assert.ok(CLAIM_MARGIN_MS >= 4 * (CLAIM_RENEW_MS / 2), 'a start sent on the hold gets four re-sends before the lease ends')
})

test('no answer is no yes: without a live hold the reply waits for the proxy, on a live hold it plays', () => {
  // The review's double play: a claim with no answer used to play, while the watcher mirrored after failed polls.
  assert.equal(startVerdict('claim', 'none'), 'wait')
  assert.equal(startVerdict('claim', 'car'), 'play')
  assert.equal(startVerdict('claim', 'phone'), 'skip')
  assert.equal(startVerdict('play', 'none'), 'play', 'the live hold keeps the phone out; the start is re-sent')
  assert.equal(startVerdict('play', 'car'), 'play')
  assert.equal(startVerdict('play', 'phone'), 'skip', 'the proxy lost the hold and the phone has it: never both')
})

test('a hold older than the margin is not trusted with the start, even a minute later after an outage', () => {
  const held = noteClaim(undefined, 'car', T)
  assert.equal(startPlan(held, T + CLAIM_LEASE_MS - CLAIM_MARGIN_MS - 1), 'play')
  assert.equal(startPlan(held, T + CLAIM_LEASE_MS - CLAIM_MARGIN_MS), 'claim')
  // renewals that got no answer (the proxy is down) never refresh it
  assert.equal(startPlan(noteClaim(held, 'none', T + 15_000), T + 15_000), 'claim')
})

test('an unanswered start made on a hold is re-sent for ten minutes', () => {
  assert.equal(confirmDue(T, T), true)
  assert.equal(confirmDue(T, T + CLAIM_CONFIRM_MAX_MS - 1), true)
  assert.equal(confirmDue(T, T + CLAIM_CONFIRM_MAX_MS), false)
})

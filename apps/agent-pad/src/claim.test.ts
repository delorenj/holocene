import test from 'node:test'
import assert from 'node:assert/strict'
import { CLAIM_LEASE_MS, CLAIM_MARGIN_MS, CLAIM_RENEW_MS, claimAnswer, holdDue, noteClaim, startPlan } from './claim.ts'

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
  assert.ok(CLAIM_RENEW_MS * 3 < CLAIM_LEASE_MS - CLAIM_MARGIN_MS, 'two missed renewals still leave the lease alive')
})

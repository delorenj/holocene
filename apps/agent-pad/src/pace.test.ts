import test from 'node:test'
import assert from 'node:assert/strict'
import { FOCUS_FREE_TRIES, FOCUS_RETRY_MS, PLAY_RETRY_MS, isFocusFailure, retryPlan, stopAckName } from './pace.ts'

test('a focus refusal is retried quickly and is not a strike', () => {
  assert.deepEqual(retryPlan(true, 1), { delay: 300, strike: false })
  assert.deepEqual(retryPlan(true, 2), { delay: 1000, strike: false })
  assert.deepEqual(retryPlan(true, 3), { delay: 2000, strike: false })
  assert.deepEqual(retryPlan(true, 6), { delay: 10_000, strike: false })
  assert.deepEqual(retryPlan(true, FOCUS_FREE_TRIES), { delay: 10_000, strike: false }, 'the last delay repeats')
})

test('focus refusals are bounded: after the free tries they are strikes again', () => {
  assert.deepEqual(retryPlan(true, FOCUS_FREE_TRIES + 1), { delay: PLAY_RETRY_MS, strike: true })
  let waited = 0
  for (let i = 1; i <= FOCUS_FREE_TRIES; i++) waited += retryPlan(true, i).delay
  assert.ok(waited >= 60_000 && waited <= 120_000, `free focus retries span ${waited} ms`)
  assert.ok(FOCUS_RETRY_MS.every((d) => d >= 300), 'never a hot loop')
})

test('any other playback failure keeps the 5 s retry and counts', () => {
  assert.deepEqual(retryPlan(false, 0), { delay: 5000, strike: true })
  assert.deepEqual(retryPlan(false, 3), { delay: 5000, strike: true })
})

test('focus failures are told apart from reply failures', () => {
  assert.equal(isFocusFailure('focus_denied'), true)
  assert.equal(isFocusFailure('focus_lost'), true)
  assert.equal(isFocusFailure('media 1/-1004'), false)
  assert.equal(isFocusFailure('chunk_timeout'), false)
  assert.equal(isFocusFailure('no_chunk_played'), false)
  assert.equal(isFocusFailure('focus_denied_by_policy'), false)
  assert.equal(isFocusFailure(''), false)
})

test('the car says the short stop ack; a browser keeps the name', () => {
  assert.equal(stopAckName('car', 'Holocene PM'), '')
  assert.equal(stopAckName('car', undefined), '')
  assert.equal(stopAckName('browser', 'Holocene PM'), 'Holocene PM')
})

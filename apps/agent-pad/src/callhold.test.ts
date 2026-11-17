import test from 'node:test'
import assert from 'node:assert/strict'
import { CALL_FAIL_GRACE_MS, CALL_RECHECK_MS, CALL_TRUST_MS, CALL_UNKNOWN, PROGRESS_CUT_MS, callShift, failsToForgive, holding, noteCall, noteCallRefusal, onCallStart, parseCall, progressToCut, recheckDue, requeueHead } from './callhold.ts'
import { claimAnswer, noteClaim, startPlan, startVerdict } from './claim.ts'
import { parsePush } from './push.ts'

const T = 1_700_000_000_000

test('the call event and the endpoint body parse; junk does not', () => {
  assert.deepEqual(parseCall('{"on_call":true,"call":"in_call","since":1763300000}'), { onCall: true, call: 'in_call', since: 1763300000 })
  assert.deepEqual(parseCall({ on_call: true, call: 'ringing', since: 1763300000, device: 'S26', age_s: 3, gate: false }),
    { onCall: true, call: 'ringing', since: 1763300000, gate: false })
  assert.deepEqual(parseCall({ on_call: false, call: null, since: null }), { onCall: false, call: null, since: null })
  assert.deepEqual(parseCall({ on_call: false, call: 'in_call', since: 5 }), { onCall: false, call: null, since: null }, 'off a call carries no kind')
  assert.deepEqual(parseCall({ on_call: true, call: 'In Call!', since: -1 }), { onCall: true, call: null, since: null }, 'a bad kind or time is dropped, the flag kept')
  assert.equal(parseCall('not json'), null)
  assert.equal(parseCall({ call: 'in_call' }), null, 'no on_call flag')
  assert.equal(parseCall({ on_call: 'yes' }), null)
  assert.equal(parseCall(null), null)
})

test('the call event never reads as a memo fact (the memo parser is untouched)', () => {
  assert.equal(parsePush('{"on_call":true,"call":"in_call","since":1}'), null)
})

test('fail-open: nothing known, an old report or a call the proxy stopped confirming holds nothing', () => {
  assert.equal(holding(CALL_UNKNOWN, T), false)
  const on = noteCall(CALL_UNKNOWN, { onCall: true, call: 'in_call', since: 1 }, T)
  assert.equal(holding(on, T + 1000), true)
  assert.equal(holding(on, T + CALL_TRUST_MS - 1), true)
  assert.equal(holding(on, T + CALL_TRUST_MS), false, 'unconfirmed for CALL_TRUST_MS: forgotten')
  assert.equal(holding(noteCall(on, { onCall: false, call: null, since: null }, T + 5000), T + 5001), false)
})

test('the kill switch: a proxy that reports gate off is not obeyed by the pad; a push event without it keeps it', () => {
  const off = noteCall(CALL_UNKNOWN, { onCall: false, call: null, since: null, gate: false }, T)
  const on = noteCall(off, { onCall: true, call: 'in_call', since: 1 }, T + 1000)
  assert.equal(on.gate, false)
  assert.equal(holding(on, T + 1001), false)
  assert.equal(holding(noteCall(on, { onCall: true, call: 'in_call', since: 1, gate: true }, T + 2000), T + 2001), true)
})

test('an on-call claim refusal starts the hold even before the push event, and keeps a known kind', () => {
  const r = noteCallRefusal(CALL_UNKNOWN, T)
  assert.equal(holding(r, T + 1), true)
  assert.equal(r.call, null)
  const known = noteCall(CALL_UNKNOWN, { onCall: true, call: 'ringing', since: 9 }, T)
  assert.equal(noteCallRefusal(known, T + 1000).call, 'ringing')
  // a refusal means the gate is on, whatever the pad last heard
  assert.equal(noteCallRefusal({ ...known, gate: false }, T + 1000).gate, true)
})

test('transitions: start mutes, end resumes, nothing else fires', () => {
  assert.equal(callShift(false, true), 'start')
  assert.equal(callShift(true, false), 'end')
  assert.equal(callShift(true, true), null)
  assert.equal(callShift(false, false), null)
})

test('the endpoint is re-read only while a call is believed, every CALL_RECHECK_MS', () => {
  const on = noteCall(CALL_UNKNOWN, { onCall: true, call: 'in_call', since: 1 }, T)
  assert.equal(recheckDue(on, T, T + CALL_RECHECK_MS - 1), false)
  assert.equal(recheckDue(on, T, T + CALL_RECHECK_MS), true)
  assert.equal(recheckDue(CALL_UNKNOWN, 0, T), false, 'not on a call: the push stream and the reconnect read are enough')
  // the push stream is down or half-open: its call event cannot arrive, so the endpoint is read at the same pace
  assert.equal(recheckDue(CALL_UNKNOWN, T, T + CALL_RECHECK_MS, false), true)
  assert.equal(recheckDue(CALL_UNKNOWN, T, T + CALL_RECHECK_MS - 1, false), false)
})

test('play failures just before the call event are the call\'s; older ones stand', () => {
  assert.deepEqual(failsToForgive({ a: T - 1000, b: T - CALL_FAIL_GRACE_MS - 1 }, T), ['a'])
  assert.deepEqual(failsToForgive({}, T), [])
})

test('the call start: a reply is requeued at the head, a progress clip is dropped, silence is left alone', () => {
  assert.equal(onCallStart('reply'), 'requeue')
  assert.equal(onCallStart('progress'), 'drop')
  assert.equal(onCallStart(null), 'none')
  assert.deepEqual(requeueHead(['replies/b', 'replies/a', 'replies/c'], 'replies/a'), ['replies/a', 'replies/b', 'replies/c'])
  assert.deepEqual(requeueHead(['replies/b'], 'replies/a'), ['replies/a', 'replies/b'], 'a reply no longer queued goes back on')
  assert.deepEqual(requeueHead(['replies/a', 'replies/b'], 'replies/a'), ['replies/a', 'replies/b'])
})

test('only progress clips that may still sound are cut in the host', () => {
  const handed = new Map([['m-recent', T - 1000], ['m-old', T - PROGRESS_CUT_MS - 1]])
  assert.deepEqual(progressToCut(handed, T), ['m-recent'])
  assert.deepEqual(progressToCut(new Map(), T), [])
})

test('a claim refused for the call is wait-at-the-head: never a skip, never a play, never forgets the phone', () => {
  assert.equal(claimAnswer(200, { ok: false, on_call: true, owner: 'car' }), 'call')
  assert.equal(claimAnswer(200, { ok: false, on_call: true, owner: 'phone' }), 'call', 'the owner is settled after the hang-up')
  assert.equal(claimAnswer(200, { ok: false, on_call: false, owner: 'phone' }), 'phone')
  assert.equal(claimAnswer(200, { ok: true, on_call: true }), 'car', 'a yes (gate off) is a yes')
  assert.equal(startVerdict('play', 'call'), 'call', 'even on a live hold: the proxy refused it')
  assert.equal(startVerdict('claim', 'call'), 'call')
  // a refusal replaces a live hold: no start is made on a hold the proxy did not renew
  const held = noteClaim(undefined, 'car', T)
  const refused = noteClaim(held, 'call', T + 1000)
  assert.equal(refused?.answer, 'call')
  assert.equal(startPlan(refused, T + 1500), 'claim')
  // the phone's take stands
  const phone = noteClaim(undefined, 'phone', T)
  assert.equal(noteClaim(phone, 'call', T + 1000), phone)
  assert.equal(startPlan(noteClaim(phone, 'call', T + 1000), T + 2000), 'skip')
})

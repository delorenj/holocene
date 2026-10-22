import test from 'node:test'
import assert from 'node:assert/strict'
import { FAST_TURNS_MAX, convReplyUnit, noteConv, onDeferred } from './convo.ts'
import { normStatus, type Conv } from './status.ts'

const M = '11111111-1111-5111-8111-111111111111'
const UNIT = `replies/2026/10/22/101500Z-holocene-pm-${M}.ogg`
const FOLLOWUP = `replies/2026/10/22/102230Z-holocene-pm-${M}.ogg` // a delegated result: a new reply_stamp, a new unit
const conv = (over: Partial<Conv> = {}): Conv => ({ sid: 'c-1', turn: 2, action: 'reply', reply_key: UNIT, draft_title: '', ...over })

test('a barged fast-turn answer is skipped, everything else replays after the note', () => {
  assert.equal(onDeferred(UNIT, conv()), 'skip')
  assert.equal(onDeferred(UNIT, conv({ action: 'propose' })), 'skip', 'a read-back is a fast turn too')
  assert.equal(onDeferred(FOLLOWUP, conv()), 'requeue', "a delegated result has its own reply key and still replays")
  assert.equal(onDeferred(UNIT, conv({ action: 'direct' })), 'requeue', "a direct turn's agent answer still replays")
  assert.equal(onDeferred(UNIT, null), 'requeue', 'a memo the desk did not decide')
  assert.equal(onDeferred(UNIT, conv({ reply_key: '' })), 'requeue', 'no reply key yet')
  assert.equal(onDeferred(UNIT, conv(), { started: false }), 'requeue', 'a fast answer that never started is not dropped unheard')
})

test('only a note starting is a barge-in: a call taking the audio focus replays the answer', () => {
  assert.equal(onDeferred(UNIT, conv(), { reason: 'recording' }), 'skip')
  assert.equal(onDeferred(UNIT, conv(), { reason: 'reset' }), 'skip')
  assert.equal(onDeferred(UNIT, conv(), { reason: 'stopped' }), 'skip', 'the page stopped it to record')
  assert.equal(onDeferred(UNIT, conv(), { reason: 'focus_loss_transient' }), 'requeue')
  assert.equal(onDeferred(UNIT, conv(), { reason: 'focus_taken_for_good' }), 'requeue')
})

test("the conv's reply key may name a chunk: it is matched by its unit", () => {
  const chunk = `replies/2026/10/22/101500Z-holocene-pm-${M}-c01of03.opus`
  assert.equal(convReplyUnit(conv({ reply_key: chunk })), UNIT)
  assert.equal(onDeferred(UNIT, conv({ reply_key: chunk })), 'skip')
  assert.equal(convReplyUnit(conv({ reply_key: 'inbox/holocene-pm/2026/10/22/a.ogg' })), null)
})

test('fast turns are remembered by reply unit, bounded, newest kept', () => {
  const known = new Map<string, Conv>()
  noteConv(known, conv())
  noteConv(known, null)
  noteConv(known, conv({ action: 'direct' }))
  assert.deepEqual([...known.keys()], [UNIT])
  for (let i = 0; i < FAST_TURNS_MAX + 5; i++) {
    const mid = `${String(i).padStart(8, '0')}-1111-5111-8111-111111111111`
    noteConv(known, conv({ reply_key: `replies/2026/10/22/1015${String(i % 60).padStart(2, '0')}Z-holocene-pm-${mid}.ogg` }))
  }
  assert.equal(known.size, FAST_TURNS_MAX)
  assert.ok(!known.has(UNIT), 'the oldest is dropped first')
})

test('a status object with a conv block feeds the barge rule end to end', () => {
  const s = normStatus({ memo_id: M, stage: 'working', heard: null, conv: { sid: 'c-1', turn: 3, action: 'reply', reply_key: UNIT } }, M)!
  assert.equal(s.heard, '', 'the watcher sends heard=null during a fast turn: no echo')
  assert.equal(onDeferred(UNIT, s.conv), 'skip')
})

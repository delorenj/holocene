import test from 'node:test'
import assert from 'node:assert/strict'
import { clockText, elapsedSeconds, isFinal, keyDay, newestProgress, normStatus, shorten, statusKey, statusLine } from './status.ts'

const M = '11111111-1111-5111-8111-111111111111'

test('a status object is parsed defensively', () => {
  const s = normStatus(JSON.stringify({ memo_id: M, agent: 'holocene-pm', stage: 'working', heard: 'check the build', progress: 'Reading   the log', progress_seq: 3, started_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:01:00Z', elapsed_s: 60 }), M)
  assert.ok(s)
  assert.equal(s.stage, 'working')
  assert.equal(s.progress, 'Reading the log')
  assert.equal(s.progress_seq, 3)
  assert.equal(s.started_at, Date.parse('2026-10-20T12:00:00Z'))
  assert.equal(normStatus({ memo_id: 'other', stage: 'working' }, M), null, 'another memo is never shown')
  assert.equal(normStatus({ stage: 'thinking' }, M), null, 'an unknown stage is not guessed')
  assert.equal(normStatus('nope', M), null)
  assert.equal(normStatus({ stage: 'heard', heard: 'x'.repeat(500) }, M)?.heard.length, 200)
})

test('final stages stop progress', () => {
  assert.equal(isFinal('replying'), true)
  assert.equal(isFinal('done'), true)
  assert.equal(isFinal('failed'), true)
  assert.equal(isFinal('working'), false)
})

test('the day folder comes from the inbox key', () => {
  assert.equal(keyDay('inbox/holocene-pm/2026/10/20/120000Z.ogg'), '2026/10/20')
  assert.equal(keyDay('replies/2026/10/20/x.ogg'), null)
  assert.equal(statusKey('2026/10/20', M), `status/2026/10/20/${M}.json`)
})

test('the newest unplayed progress clip wins', () => {
  const p = `progress/2026/10/20/${M}-`
  const keys = [`${p}1.ogg`, `${p}4.ogg`, `${p}2.ogg`, `${p}x.ogg`, `progress/2026/10/20/${M}-3.txt`]
  assert.deepEqual(newestProgress(keys, '2026/10/20', M, 0), { key: `${p}4.ogg`, seq: 4 })
  assert.equal(newestProgress(keys, '2026/10/20', M, 4), null)
  assert.equal(newestProgress([`progress/2026/10/20/${M}-10.ogg`], '2026/10/20', M, 9)?.seq, 10)
})

test('tile line is short and static', () => {
  const base = normStatus({ stage: 'working', progress: 'Reading the build log on big-chungus to see why the deploy failed' }, M)!
  assert.equal(statusLine(base, 80, 28), 'Working 1:20 · Reading the build log on…')
  assert.equal(statusLine(base, 80, 0), 'Working 1:20')
  assert.equal(statusLine({ ...base, progress: '' }, 5, 28), 'Working 0:05')
  assert.equal(statusLine(null, 3, 28), 'Sent 0:03')
  assert.equal(statusLine({ ...base, stage: 'transcribing' }, 7, 28), 'Transcribing 0:07')
  assert.equal(statusLine({ ...base, stage: 'done' }, 7, 28), null)
  assert.equal(statusLine({ ...base, stage: 'failed' }, 7, 28), 'Failed')
  assert.equal(clockText(3725), '1:02:05')
  assert.equal(shorten('short', 28), 'short')
})

test('elapsed time uses the watcher clock, not the device clock', () => {
  const s = normStatus({ stage: 'working', elapsed_s: 60, started_at: '2000-01-01T00:00:00Z' }, M)!
  assert.equal(elapsedSeconds(s, 1000, 0, 3000), 62)
  assert.equal(elapsedSeconds({ ...s, elapsed_s: null }, 0, 0, Date.parse('2000-01-01T00:00:10Z')), 10)
  assert.equal(elapsedSeconds(null, 0, 1000, 6000), 5)
})

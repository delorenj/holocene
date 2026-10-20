import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_RETRY_MS, REPLY_DUE_WINDOW_MS, REPLY_POLL_FAST_MS, REPLY_POLL_IDLE_MS, avatarRetryDelay, driveTiles, normRoster, replyAgent, replyPollMs, sameRoster, speakNext, step, type Agent } from './roster.ts'

const A = (id: string, avatar?: string): Agent => ({ id, name: id.toUpperCase(), color: '#112233', ...(avatar ? { avatar } : {}) })

test('a roster keeps order and drops rows it cannot trust', () => {
  const r = normRoster(JSON.stringify({
    agents: [
      { id: 'holocene-pm', name: 'Holocene', color: '#9b59b6', avatar: '/roster/avatars/holocene-pm.AQAD-x_1.jpg' },
      { id: '33god-pm', name: ' Grolf ', color: 'red', avatar: 'https://evil.example/x.jpg' },
      { id: 'Bad Id', name: 'x' },
      { id: 'holocene-pm', name: 'dupe' },
      { id: 'no-name-pm', name: '' },
      { id: 'flume-pm', name: 'Flume', avatar: null },
    ],
  }))
  assert.deepEqual(r, [
    { id: 'holocene-pm', name: 'Holocene', color: '#9b59b6', avatar: '/roster/avatars/holocene-pm.AQAD-x_1.jpg' },
    { id: '33god-pm', name: 'Grolf', color: '#5a6275' },
    { id: 'flume-pm', name: 'Flume', color: '#5a6275' },
  ])
})

test('garbage is no roster at all, so the pad keeps what it had', () => {
  for (const raw of ['', 'not json', '{}', '{"agents":[]}', '{"agents":[{"id":"x"}]}', null, 42]) assert.equal(normRoster(raw), null)
})

test('driving shows the most recent five and always the selected agent', () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => A(x))
  assert.deepEqual(driveTiles(all, undefined, 5).map((a) => a.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(driveTiles(all, 'c', 5).map((a) => a.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(driveTiles(all, 'g', 5).map((a) => a.id), ['a', 'b', 'c', 'd', 'g'])
  assert.deepEqual(driveTiles(all, 'gone', 5).map((a) => a.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(driveTiles(all.slice(0, 2), 'b', 5).map((a) => a.id), ['a', 'b'])
})

test('the wheel walks the whole list and wraps', () => {
  const all = ['a', 'b', 'c'].map((x) => A(x))
  assert.equal(step(all, undefined, 1)?.id, 'a')
  assert.equal(step(all, undefined, -1)?.id, 'c')
  assert.equal(step(all, 'c', 1)?.id, 'a')
  assert.equal(step(all, 'a', -1)?.id, 'c')
  assert.equal(step(all, 'gone', 1)?.id, 'a')
  assert.equal(step([], 'a', 1), undefined)
})

test('an identical roster is not a change', () => {
  const a = [A('a', '/roster/avatars/a.1.jpg'), A('b')]
  assert.ok(sameRoster(a, a.map((x) => ({ ...x }))))
  assert.ok(!sameRoster(a, [a[1], a[0]]))
  assert.ok(!sameRoster(a, [A('a', '/roster/avatars/a.2.jpg'), A('b')]))
})

test('a failed avatar retries on a backoff, then keeps the letter', () => {
  assert.equal(avatarRetryDelay(0), null)
  assert.deepEqual([1, 2, 3].map(avatarRetryDelay), AVATAR_RETRY_MS)
  assert.equal(avatarRetryDelay(AVATAR_RETRY_MS.length + 1), null)
})

test('a reply names its agent', () => {
  assert.equal(replyAgent('replies/2026/10/19/213608Z-holocene-pm-620cf87f-5a03-53e2-acff-c3bbf2af82c8.ogg'), 'holocene-pm')
  assert.equal(replyAgent('replies/2026/10/19/215631Z-green-in-between-pm-441bce90-c87c-5f8a-85f3-250e189e8351.ogg'), 'green-in-between-pm')
  assert.equal(replyAgent('replies/2026101-legacy.ogg'), null)
})

test('replies are polled fast while one is due, slowly otherwise', () => {
  const now = 1_000_000_000
  assert.equal(replyPollMs(0, now), REPLY_POLL_IDLE_MS)
  assert.equal(replyPollMs(now - 30_000, now), REPLY_POLL_FAST_MS)
  assert.equal(replyPollMs(now - REPLY_DUE_WINDOW_MS - 1, now), REPLY_POLL_IDLE_MS)
})

test('driving always shows the selected agent and the one replying', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => A(x))
  assert.deepEqual(driveTiles(list, 'g', 3, 'f').map((a) => a.id), ['a', 'f', 'g'])
  assert.deepEqual(driveTiles(list, 'b', 3, 'g').map((a) => a.id), ['a', 'b', 'g'])
  assert.deepEqual(driveTiles(list, 'a', 3, 'a').map((a) => a.id), ['a', 'b', 'c'])
  assert.deepEqual(driveTiles(list, undefined, 3).map((a) => a.id), ['a', 'b', 'c'])
})

test('the reply cue: set on start, cleared by every ending, set again on a replay', () => {
  const k = 'replies/2026/10/19/213608Z-holocene-pm-620cf87f-5a03-53e2-acff-c3bbf2af82c8.ogg'
  let s = speakNext(null, { t: 'started', key: k })
  assert.deepEqual(s, { key: k, agent: 'holocene-pm' })
  assert.equal(speakNext(s, { t: 'interrupted' }), null)
  s = speakNext(null, { t: 'started', key: k }) // the replay after the note
  assert.equal(speakNext(s, { t: 'ended', key: 'replies/other.ogg' }), s, 'another reply ending leaves this one')
  assert.equal(speakNext(s, { t: 'ended', key: k }), null)
  assert.equal(speakNext(s, { t: 'failed', key: k }), null)
  assert.equal(speakNext(s, { t: 'watchdog' }), null)
})

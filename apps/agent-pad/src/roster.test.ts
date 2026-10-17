import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driveTiles, normRoster, sameRoster, step, type Agent } from './roster.ts'

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

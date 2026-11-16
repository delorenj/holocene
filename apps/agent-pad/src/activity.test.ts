import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTIVITY_TTL_MS, activityOrder, driveTiles, fetchActivity, hiddenWorking, liveActivity, normRoster, rankAgents, readActivity, restoreSelection, type Agent } from './roster.ts'

const now = Date.parse('2026-11-16T20:00:00Z')
const date = new Date(now).toUTCString()
const agents: Agent[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, name: id, color: '#112233' }))
const ids = (rows: Agent[]) => rows.map((a) => a.id)
const row = (id: string, signal = 'working', lastActiveAt: unknown = '2026-11-16T19:59:00Z') => ({ id, signal, active: true, lastActiveAt })
const payload = (rows = [row('a'), row('b'), row('c')]) => ({
  generatedAt: new Date(now - 1000).toISOString(),
  sources: [
    { name: 'events', ageSeconds: 1, maxSeconds: 120 },
    { name: 'asm' }, { name: 'agents registry' }, { name: 'pjangler' },
  ],
  agents: rows,
})
const read = (p = payload()) => readActivity(p, date, now, 100)!

test('network boundary never returns cached thinking on offline, HTTP, JSON or fetch failures', async () => {
  const controller = new AbortController()
  const good: typeof fetch = async (_url, options) => {
    assert.equal(options?.cache, 'no-store')
    return new Response(JSON.stringify(payload()), { headers: { date } })
  }
  const load = (fetcher: typeof fetch, online = () => true) =>
    fetchActivity(fetcher, controller.signal, online, () => now, () => 100)
  assert.ok((await load(good))?.rows.get('a')?.working)
  assert.equal(await load(async () => { throw new Error('offline') }), null)
  assert.equal(await load(async () => new Response('', { status: 503 })), null)
  assert.equal(await load(async () => new Response('<html>SPA fallback</html>')), null)
  assert.equal(await load(async () => { assert.fail('offline must not fetch') }, () => false), null)
  let online = true
  assert.equal(await load(async () => { online = false; return new Response(JSON.stringify(payload()), { headers: { date } }) }, () => online), null)
  controller.abort()
  assert.equal(await load(good), null)
})

test('three concurrent workers rank first by precise work time; each settles independently', () => {
  let state = read(payload([
    row('d', 'working', '2026-11-16T19:59:00.003Z'),
    row('e', 'working', '2026-11-16T19:59:00.005Z'),
    row('f', 'working', '2026-11-16T19:59:00.004Z'),
    row('not-routable'),
  ]))
  assert.deepEqual(ids(rankAgents(agents, state.rows)), ['e', 'f', 'd', 'a', 'b', 'c', 'g'])
  state = read(payload([row('d'), row('e', 'idle'), row('f'), row('a', 'failed')]))
  assert.deepEqual([...state.rows].filter(([, a]) => a.working).map(([id]) => id), ['d', 'f'])
  assert.deepEqual(ids(rankAgents(agents, state.rows).slice(0, 2)), ['d', 'f'])
  assert.ok(!rankAgents(agents, state.rows).some((a) => a.id === 'not-routable'))
  state = read(payload([row('d', 'awaiting_human'), row('e', 'idle'), row('f', 'working')]))
  assert.deepEqual([...state.rows].filter(([, a]) => a.working).map(([id]) => id), ['f'])
})

test('recency uses precise milliseconds, missing/invalid timestamps last, ties use registry order', () => {
  const state = read(payload([
    row('b', 'idle', '2026-11-16T19:59:00.001Z'),
    row('c', 'idle', '2026-11-16T19:59:00.099Z'),
    row('e', 'idle', '2026-11-16T19:59:00.099Z'),
    row('d', 'failed', 'not-a-date'), row('f', 'idle', null),
    row('g', 'idle', '2099-01-01T00:00:00Z'),
  ]))
  assert.deepEqual(ids(rankAgents(agents, state.rows)), ['c', 'e', 'b', 'a', 'd', 'f', 'g'])
})

test('freshness fails closed for stale/missing/future stamps, required sources, and offline null', () => {
  for (const stamp of ['', 'bad', new Date(now - ACTIVITY_TTL_MS).toISOString(), new Date(now + 5000).toISOString()]) {
    assert.equal(read({ ...payload(), generatedAt: stamp }), null)
  }
  for (const name of ['events', 'asm', 'agents registry', 'pjangler']) {
    const p = payload()
    assert.equal(read({ ...p, sources: p.sources.map((s) => s.name === name ? { ...s, down: true } : s) }), null)
    assert.equal(read({ ...p, sources: p.sources.filter((s) => s.name !== name) }), null)
  }
  const p = payload()
  p.sources[0].ageSeconds = 121
  assert.equal(read(p), null)
  assert.equal(readActivity(payload(), null, now, 100), null)
  assert.equal(liveActivity(null, 100), null)
  assert.deepEqual(rankAgents(agents, null), agents)
})

test('server Date handles fast/slow device clocks; monotonic expiry rejects backwards clock', () => {
  for (const device of [now - 3600_000, now + 3600_000]) {
    const snapshot = readActivity(payload(), date, device, 100)!
    assert.ok(liveActivity(snapshot, 101)?.get('a')?.working)
    assert.equal(liveActivity(snapshot, 100 + snapshot.validFor), null)
    assert.equal(liveActivity(snapshot, 99), null)
  }
})

test('source-age budget expires even before the client snapshot TTL', () => {
  const p = payload()
  p.sources[0].ageSeconds = 118
  const snapshot = read(p)
  assert.equal(snapshot.validFor, 1000, 'source age plus one-second-old snapshot')
  assert.ok(liveActivity(snapshot, 1099))
  assert.equal(liveActivity(snapshot, 1100), null)
  p.sources[0].ageSeconds = 120
  assert.equal(read(p), null)
})

test('driving overflow retains selected and reply under strict cap; count covers displaced workers', () => {
  const activity = read(payload(agents.slice(0, 5).map((a) => row(a.id)))).rows
  const ranked = rankAgents(agents, activity)
  const visible = driveTiles(ranked, 'g', 5, 'f')
  assert.equal(visible.length, 5)
  assert.ok(visible.some((a) => a.id === 'g'))
  assert.ok(visible.some((a) => a.id === 'f'))
  assert.equal(hiddenWorking(ranked, visible, activity), 2)
  assert.deepEqual(ids(driveTiles(ranked, 'g', 1, 'f')), ['g'])
  assert.deepEqual(driveTiles(ranked, 'g', 0, 'f'), [])
  assert.equal(hiddenWorking(ranked, ranked, activity), 0, 'parked has all workers')
})

test('cache strips activity; selected and captured recording identity survive live ranking and independent clear', () => {
  const restored = normRoster({ agents: agents.map((a) => ({ ...a, working: true, signal: 'working', lastActiveAt: date })) })!
  assert.deepEqual(restored, agents)
  const selected = restoreSelection(restored, 'f', false).pick!
  const recordingTarget = selected
  const previous = rankAgents(restored, read(payload([row('c')])).rows)
  const next = read(payload([row('g'), row('c', 'failed')])).rows
  assert.equal(activityOrder(restored, next, true, previous), previous)
  assert.equal(recordingTarget.id, 'f')
  assert.equal(restoreSelection(activityOrder(restored, next, false, previous), selected.id, true).pick, selected)
  assert.deepEqual(ids(activityOrder(restored, next, false, previous)).slice(0, 2), ['g', 'c'])
})

test('UI wires offline clearing, independent per-agent cue, static restrictions and existing record snapshot', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  assert.match(source, /addEventListener\('offline', offline\)/)
  assert.match(source, /activity\?\.get\(a\.id\)\?\.working/)
  assert.match(source, /prefers-reduced-motion: reduce\).*?thinking-label/s)
  assert.match(source, /\.still \*.*?animation:none !important/s)
  assert.match(source, /const agent = selected/)
  assert.match(source, /onClick=\{\(\) => chooseAgent\(a\)\}/)
  const proxy = readFileSync(new URL('../deploy/hub-agents.nginx.conf', import.meta.url), 'utf8')
  assert.match(proxy, /location = \/api\/modules\/hub\/agents/)
  assert.match(proxy, /Cache-Control "no-store" always/)
  assert.match(proxy, /limit_except GET/)
})

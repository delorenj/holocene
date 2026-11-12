import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { isFinal, newestProgress, normStatus, progressPrefix } from './status.ts'

test('actual pollFlight selects only announced audio, filtering orphan keys before choosing newest', async () => {
  const page = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const start = page.indexOf('const pollFlight =')
  const end = page.indexOf('  // A push said this memo moved on', start)
  assert.ok(start >= 0 && end > start)
  const code = stripTypeScriptTypes(`${page.slice(start, end)}\nglobalThis.run = pollFlight;`, { mode: 'strip' })
  const memo = '11111111-1111-5111-8111-111111111111'
  const prefix = progressPrefix('2026/11/12', memo)
  const cases = [
    { name: 'announced hold 1 beats orphan 2', status: { spoken_seq: 1 }, keys: [`${prefix}2.ogg`, `${prefix}1h.ogg`], expected: `${prefix}1h.ogg` },
    { name: 'null audio announcement does not fall back to gateway seq 2', status: { spoken_seq: null }, keys: [`${prefix}2.ogg`, `${prefix}1.ogg`], expected: null },
    { name: 'absent audio announcement does not fall back to gateway seq 2', status: {}, keys: [`${prefix}2.ogg`], expected: null },
    { name: 'ordinary announced progress remains playable', status: { spoken_seq: 1 }, keys: [`${prefix}1.ogg`], expected: `${prefix}1.ogg` },
  ]
  for (const scenario of cases) {
    const picks: { key: string; seq: number; hold?: true }[] = []
    let listings = 0
    const ctx = vm.createContext({
      Date, readStatus: async () => normStatus({ memo_id: memo, stage: 'working', heard: 'Text only.',
        heard_delivery: 'text_only', progress_seq: 2, ...scenario.status }, memo),
      noteConv() {}, fastTurns: { current: {} }, isFinal,
      flightFinal() { throw Error('unexpected final') }, PROGRESS_LIST_MS: 0,
      listPage: async () => { listings++; return { keys: scenario.keys } }, progressPrefix, newestProgress,
      sayProgress: async (_flight: unknown, pick: typeof picks[number]) => { picks.push(pick) },
    })
    vm.runInContext(code, ctx)
    await ctx.run({ memoId: memo, day: '2026/11/12', progressSeq: 0, listedAt: 0, finalAt: 0 })
    assert.deepEqual(picks.map((p) => p.key), scenario.expected === null ? [] : [scenario.expected], scenario.name)
    if (scenario.expected === null) assert.equal(listings, 0, scenario.name)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { durableGet, durableSet, type Kv } from './durable.ts'

const mem = (): Kv & { m: Map<string, string> } => {
  const m = new Map<string, string>()
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
}
const hostPrefs = () => {
  const m = new Map<string, string>()
  return { m, getPref: (k: string) => m.get(k) ?? '', setPref: (k: string, v: string) => { m.set(k, v); return true } }
}

test('the host value wins and survives a cold start where localStorage came back empty', () => {
  const host = hostPrefs()
  durableSet('agentpad.lastDoneReply', 'replies/x.ogg', host, mem())
  assert.equal(durableGet('agentpad.lastDoneReply', host, mem()), 'replies/x.ogg') // fresh, empty localStorage
})

test('without the bridge it is plain localStorage (browser, old host)', () => {
  const ls = mem()
  durableSet('k', 'v', undefined, ls)
  assert.equal(ls.m.get('k'), 'v')
  assert.equal(durableGet('k', undefined, ls), 'v')
  assert.equal(durableGet('k', {}, ls), 'v')
})

test('a host with no value yet falls back to what localStorage has (first run after the upgrade)', () => {
  const ls = mem(); ls.setItem('k', 'old')
  assert.equal(durableGet('k', hostPrefs(), ls), 'old')
})

test('a throwing bridge or blocked storage never throws into the page', () => {
  const bad = { getPref: () => { throw new Error('x') }, setPref: () => { throw new Error('x') } }
  const blocked: Kv = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(durableGet('k', bad, blocked), '')
  assert.doesNotThrow(() => durableSet('k', 'v', bad, blocked))
})

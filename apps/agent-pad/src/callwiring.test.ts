// Quiet on a call: the page's own wiring (main.tsx), not only the pure rules in callhold.ts. The real closures are cut
// out of main.tsx and run in a sandbox (as heard.test.ts does), with the host, the proxy and the clock faked, so a change
// that makes a call stop count as a failure, release a reply to the phone or forget an owed start fails here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import * as callhold from './callhold.ts'
import { CALL_FAIL_GRACE_MS, CALL_UNKNOWN } from './callhold.ts'
import { CLAIM_CONFIRM_MAX_MS, CLAIM_RENEW_MS, CLAIM_WAIT_MS, claimAnswer, confirmDue, holdDue, noteClaim, phoneRecheckDue, PHONE_RECHECK_MAX_MS, startPlan, startVerdict } from './claim.ts'
import { PLAY_STRIKES, isFocusFailure, retryPlan } from './pace.ts'
import { pushLive } from './push.ts'

const page = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const cut = (start: string, end: string) => {
  const a = page.indexOf(start)
  const b = page.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `main.tsx no longer has ${start} ... ${end}`)
  return page.slice(a, b)
}
const code = stripTypeScriptTypes([
  cut('const onCallNow = ', '  const refreshFlights = '),
  cut('pump.current = async () => {', '  // Browser (no host speech queue)'),
  cut('const passGate = async', '  // A waiting reply renews'),
  cut('let tick = Date.now()', '    return () => window.clearInterval(t)'),
  cut('const playFailed = ', '  // The host\'s native player reports'),
  cut(';(window as any).__hnPlayback = ', '    return () => { delete (window as any).__hnPlayback }'),
  cut('const callStopped = ', '  const askOperatorRef = '),
  'globalThis.api = { claimReply, passGate, playFailed, callStopped, muteForCall, evalCall, askOperator, applyCallRef, callEvent, onCallNow };',
].join('\n'), { mode: 'strip' })

const A = 'replies/2026/11/16/aaaa.ogg'
const B = 'replies/2026/11/16/bbbb.ogg'

type Proxy = { claim: (body: { action: string; reply_key: string }) => unknown; operator: () => unknown }

function sandbox(host: 'car' | 'browser' = 'car') {
  let now = 1_700_000_000_000
  const sent: { action: string; reply_key: string }[] = []
  const timers: (() => void)[] = []
  let interval: (() => void) | null = null
  const proxy: Proxy = { claim: () => ({ ok: true }), operator: () => ({ on_call: false, call: null, since: null, gate: true }) }
  let operatorGate: Promise<void> = Promise.resolve()
  const native = { stops: 0, plays: [] as string[], stopReply() { this.stops++ }, playReply(k: string) { this.plays.push(k) } }
  const audio = { paused: 0, src: '', pause() { this.paused++ }, play: async () => {} }
  const ctx: Record<string, unknown> = {
    Date: { now: () => now }, URL: { createObjectURL: () => 'blob:x' },
    window: {
      setTimeout: (f: () => void) => { timers.push(f); return timers.length },
      setInterval: (f: () => void) => { interval = f; return 1 },
      clearInterval() {}, clearTimeout() {},
    },
    useRef: (v: unknown) => ({ current: v }),
    HOST_KIND: host, DEVICE: { id: 'car-1' }, BUCKET_BASE: 'http://fixture.invalid',
    CLAIM_WAIT_MS, CLAIM_RENEW_MS, CALL_FETCH_MS: callhold.CALL_FETCH_MS, PLAY_STRIKES, PHONE_RECHECK_MAX_MS,
    ...callhold, claimAnswer, noteClaim, startPlan, startVerdict, confirmDue, holdDue, phoneRecheckDue, isFocusFailure, retryPlan, pushLive,
    fetchWithin: async (url: string, _ms: number, read: (r: unknown) => Promise<unknown>, init: { body?: string } = {}) => {
      let body: unknown
      if (url.startsWith('/upload/claim')) {
        const b = JSON.parse(init.body || '{}')
        sent.push({ action: b.action, reply_key: b.reply_key })
        body = await proxy.claim(b)
      } else if (url.startsWith('/upload/operator')) {
        await operatorGate
        body = proxy.operator()
      } else throw Error(`unexpected fetch ${url}`)
      if (body === undefined) throw Error('no answer')
      return read({ status: 200, json: async () => body })
    },
    // refs
    callState: { current: CALL_UNKNOWN }, callHeld: { current: false }, callAsked: { current: 0 },
    callEventAt: { current: 0 }, callReadAsked: { current: 0 },
    playingKey: { current: '' }, playingProgress: { current: false }, streaming: { current: null },
    startedKeys: { current: new Set<string>() }, units: { current: new Map([[A, {}], [B, {}]]) },
    queue: { current: [B] }, progressQ: { current: [] }, progressHanded: { current: new Map() },
    audioRef: { current: audio }, focusFails: { current: {} }, loadFails: { current: {} }, failedAt: { current: {} },
    claims: { current: new Map() }, unconfirmed: { current: new Map<string, number>() }, holdInflight: { current: new Map() },
    recordingRef: { current: false }, arming: { current: false }, unlockedRef: { current: true },
    beaconsSent: { current: new Set() }, replyBytes: { current: 0 }, phoneTook: { current: new Map() },
    pump: { current: () => { log.push('pump') } },
    // the rest of the page, faked
    setOnCall() {}, setLastReply() {}, setStatus: (s: string) => log.push(`status:${s}`),
    speak: (e: { t: string }) => log.push(`speak:${e.t}`), report: (p: string) => log.push(`report:${p}`),
    finish: (k: string) => log.push(`finish:${k}`), park: (k: string) => log.push(`park:${k}`),
    leaveToPhone: (k: string) => log.push(`phone:${k}`), waitForProxy: (k: string) => log.push(`wait:${k}`),
    dropBarged: () => false, beacon() {}, feedStream() {}, playProgress() {}, forgetPhoneTake() {}, lookAtPhoneTake() {},
    nativeSpeech: () => null, nativeChunks: () => null, nativeReply: () => (host === 'car' ? native : null),
    nextUnit: (q: string[]) => (q.length ? { key: q[0], plan: 'file' } : null),
    getBlob: async () => ({ size: 10 }), blobToBase64: async () => 'eA==', replyExt: () => 'ogg',
  }
  const log: string[] = []
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  // the cut assigns the real pump: kept for the browser test, and a recorder stands in so a resume is seen
  const pump = ctx.pump as { current: () => unknown }
  const realPump = pump.current
  pump.current = () => { log.push('pump') }
  const api = ctx.api as {
    claimReply: (k: string, a: string) => Promise<string>; passGate: (k: string, g: unknown) => Promise<boolean>
    callStopped: (k: string) => void; muteForCall: () => void; evalCall: () => void; askOperator: () => Promise<void>
    applyCallRef: { current: (s: unknown) => void }; callEvent: (s: unknown) => void; onCallNow: () => boolean; playFailed: (k: string, t: string, d?: string) => void
  }
  const r = <T,>(name: string) => (ctx[name] as { current: T })
  const call = (onCall: boolean) => api.callEvent(callhold.noteCall(r<callhold.CallState>('callState').current, { onCall, call: onCall ? 'in_call' : null, since: onCall ? 1 : null }, now))
  const flush = () => new Promise((res) => setImmediate(res))
  return {
    ctx, api, r, log, realPump, sent, timers, native, audio, proxy, call, flush,
    tick: () => interval?.(), advance: (ms: number) => { now += ms }, get now() { return now },
    holdOperator: () => { let open = () => {}; operatorGate = new Promise((res) => { open = res }); return () => open() },
    hn: (k: string, phase: string, detail = '') => (ctx.window as { __hnPlayback: (k: string, p: string, d: string) => void }).__hnPlayback(k, phase, detail),
  }
}

test('a call stops the playing reply: back at the head, no strike, no release, its start forgotten, its tries back', () => {
  const s = sandbox()
  s.r<string>('playingKey').current = A
  s.r<Set<string>>('startedKeys').current.add(A)
  s.r<Record<string, number>>('loadFails').current[A] = 1 // the ring's error landed before the call event
  s.r<Record<string, number>>('focusFails').current[A] = 4
  s.call(true)
  assert.equal(s.native.stops, 1, 'muted through the host')
  assert.deepEqual(s.r<string[]>('queue').current, [A, B], 'back at the head of the queue')
  assert.equal(s.r<string>('playingKey').current, '', 'the speaking tile clears (the watchdog is disarmed with it)')
  assert.equal(s.r<Set<string>>('startedKeys').current.has(A), false, 'its replay claims its start again')
  assert.equal(s.r<Record<string, number>>('loadFails').current[A], undefined, 'no strike carried past the call')
  assert.equal(s.r<Record<string, number>>('focusFails').current[A], undefined)
  assert.deepEqual(s.sent, [], 'nothing released to the phone')
  assert.ok(!s.log.some((l) => l.startsWith('finish:') || l.startsWith('report:')), 'not finished, not marked heard')
  // the hang-up pumps the queue again
  s.log.length = 0
  s.call(false)
  assert.ok(s.log.includes('pump'))
})

test('the host\'s error while on a call is a call stop, not a failure', () => {
  const s = sandbox()
  s.call(true)
  s.r<string>('playingKey').current = A
  s.hn(A, 'error', 'focus_lost')
  assert.equal(s.r<Record<string, number>>('loadFails').current[A], undefined)
  assert.equal(s.r<Record<string, number>>('focusFails').current[A], undefined)
  assert.deepEqual(s.r<string[]>('queue').current, [A, B])
  assert.deepEqual(s.sent, [])
  assert.ok(!s.log.some((l) => l.includes('play failed')))
})

test('failures counted just before the call event (the ring came first) are forgiven at the call start', () => {
  const s = sandbox()
  s.r<string>('playingKey').current = A
  s.api.playFailed(A, 'play failed: host player', 'error') // a plain error: a strike, retried later
  assert.equal(s.r<Record<string, number>>('loadFails').current[A], 1)
  s.r<string>('playingKey').current = '' // waiting for its retry, so nothing plays when the call event lands
  s.advance(CALL_FAIL_GRACE_MS - 1000)
  s.call(true)
  assert.equal(s.r<Record<string, number>>('loadFails').current[A], undefined, 'the strike was the call\'s')
  // an old failure is the reply's own and stands
  const t = sandbox()
  t.r<string>('playingKey').current = A
  t.api.playFailed(A, 'play failed: host player', 'error')
  t.advance(CALL_FAIL_GRACE_MS + 1000)
  t.call(true)
  assert.equal(t.r<Record<string, number>>('loadFails').current[A], 1)
})

test('browser: a call pausing play() mid-start (AbortError) is no strike', async () => {
  const s = sandbox('browser')
  s.r<string[]>('queue').current = [A, B]
  let reject: (e: Error) => void = () => {}
  s.audio.play = () => new Promise<void>((_, rej) => { reject = rej })
  const running = s.realPump() as Promise<void>
  await s.flush()
  assert.equal(s.r<string>('playingKey').current, A, 'play() is out')
  s.call(true)
  reject(Object.assign(new Error('The play() request was interrupted by a call to pause()'), { name: 'AbortError' }))
  await running
  assert.equal(s.r<Record<string, number>>('loadFails').current[A], undefined)
  assert.ok(!s.log.some((l) => l.includes('play failed')), 'no failure line')
  assert.deepEqual(s.r<string[]>('queue').current, [A, B])
})

test('an owed start the proxy refuses for the call stays owed, and its clock stops during the call', async () => {
  const s = sandbox()
  s.r<string[]>('queue').current = []
  const owed = s.r<Map<string, number>>('unconfirmed').current
  // played on a live hold while the proxy was down: its start went unanswered
  s.proxy.claim = () => undefined
  await s.api.claimReply(A, 'start')
  assert.ok(owed.has(A))
  // the proxy is back, but the phone rings: the re-send is refused for the call
  s.proxy.claim = () => ({ ok: false, on_call: true, owner: 'car' })
  await s.api.claimReply(A, 'start')
  assert.ok(owed.has(A), 'a call refusal settles nothing')
  assert.equal(s.api.onCallNow(), true, 'and the pad holds for the call')
  // a long call: the re-send stops, and the owed start does not age out
  const since = owed.get(A)!
  for (let i = 0; i < 6; i++) { s.advance(CLAIM_CONFIRM_MAX_MS / 4); s.call(true); s.tick() }
  assert.ok(owed.has(A), 'still owed after a call longer than CLAIM_CONFIRM_MAX_MS')
  assert.ok(owed.get(A)! > since)
  // the hang-up: re-sent, and the proxy's yes settles it
  s.call(false)
  s.proxy.claim = () => ({ ok: true })
  s.sent.length = 0
  s.tick()
  await s.flush()
  assert.deepEqual(s.sent, [{ action: 'start', reply_key: A }], 're-sent once the call is over')
  assert.equal(owed.has(A), false)
})

test('a start refused for the call while its audio still plays is owed; one the call cut is not', async () => {
  for (const crossed of [true, false]) {
    const s = sandbox()
    s.r<string[]>('queue').current = []
    let answer: (b: unknown) => void = () => {}
    s.proxy.claim = () => new Promise((res) => { answer = res })
    s.r<string>('playingKey').current = A
    s.r<Set<string>>('startedKeys').current.add(A)
    const p = s.api.claimReply(A, 'start')
    s.advance(5)
    if (crossed) s.call(false) // the hang-up report lands while the start is out: the refusal is old news
    answer({ ok: false, on_call: true })
    await p
    const owed = s.r<Map<string, number>>('unconfirmed').current.has(A)
    if (crossed) {
      assert.equal(s.api.onCallNow(), false, 'the crossed refusal is not taken as a call')
      assert.equal(s.native.stops, 0, 'so the audio goes on')
      assert.equal(owed, true, 'and its start is re-sent until the proxy records it')
    } else {
      assert.equal(s.api.onCallNow(), true)
      assert.equal(s.native.stops, 1, 'the refusal mutes it')
      assert.equal(owed, false, 'the cut reply claims its replay\'s start itself')
      assert.deepEqual(s.r<string[]>('queue').current, [A])
    }
  }
})

test('a call verdict the pad did not take as a call asks again shortly; one it did waits for the hang-up', async () => {
  const s = sandbox()
  s.r<string>('playingKey').current = A
  assert.equal(await s.api.passGate(A, { answer: Promise.resolve('call'), plan: 'claim' }), false)
  assert.equal(s.timers.length, 1, 'not on a call (the refusal crossed the hang-up): pumped again shortly')
  s.timers[0]()
  assert.ok(s.log.includes('pump'))
  const t = sandbox()
  t.call(true)
  t.r<string>('playingKey').current = A
  assert.equal(await t.api.passGate(A, { answer: Promise.resolve('call'), plan: 'play' }), false)
  assert.equal(t.timers.length, 0, 'on a call: the hang-up pumps')
  assert.equal(t.r<string>('playingKey').current, '')
})

test('an endpoint read that a newer push report overtook is not applied', async () => {
  const s = sandbox()
  s.call(true)
  s.proxy.operator = () => ({ on_call: true, call: 'in_call', since: 1, gate: true }) // what the proxy said when asked
  const open = s.holdOperator()
  s.advance(10)
  const read = s.api.askOperator()
  s.advance(10)
  s.call(false) // the hang-up event lands while the read is out
  s.r<string>('playingKey').current = A // the queue resumed
  open()
  await read
  assert.equal(s.api.onCallNow(), false, 'the stale "on" read does not undo the hang-up')
  assert.equal(s.native.stops, 0, 'the resumed reply is not cut')
  // a read that nothing overtook is applied
  s.proxy.operator = () => ({ on_call: true, call: 'ringing', since: 2, gate: true })
  await s.api.askOperator()
  assert.equal(s.api.onCallNow(), true)
})

test('two endpoint reads overlapping are applied in the order they were sent, not the order they landed', async () => {
  const s = sandbox()
  s.proxy.operator = () => ({ on_call: true, call: 'in_call', since: 1, gate: true })
  const openOld = s.holdOperator()
  s.advance(10)
  const older = s.api.askOperator() // R1: asked while the call was on
  s.advance(10)
  s.proxy.operator = () => ({ on_call: false, call: null, since: null, gate: true })
  const openNew = s.holdOperator()
  const newer = s.api.askOperator() // R2: asked after the hang-up
  openNew()
  await newer
  assert.equal(s.api.onCallNow(), false, 'the newer read says off')
  s.proxy.operator = () => ({ on_call: true, call: 'in_call', since: 1, gate: true })
  openOld()
  await older
  assert.equal(s.api.onCallNow(), false, 'the older read landing last does not bring the call back')
  // and the reverse: the older lands first and is applied, the newer still lands after it and is applied too
  const t = sandbox()
  const g1 = t.holdOperator()
  const r1 = t.api.askOperator()
  t.advance(10)
  const g2 = t.holdOperator()
  const r2 = t.api.askOperator()
  t.proxy.operator = () => ({ on_call: true, call: 'in_call', since: 1, gate: true })
  g1()
  await r1
  assert.equal(t.api.onCallNow(), true)
  t.advance(10)
  t.proxy.operator = () => ({ on_call: false, call: null, since: null, gate: true })
  g2()
  await r2
  assert.equal(t.api.onCallNow(), false, 'a read sent after an applied one is applied even though callState moved')
})

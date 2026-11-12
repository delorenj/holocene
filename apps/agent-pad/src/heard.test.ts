import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { isFinal, mayPlayProgress, newestProgress, normStatus, progressPrefix } from './status.ts'

test('heard transcript stays observable but the page never sends agent-attributed text to native TTS', () => {
  const memo = '11111111-1111-5111-8111-111111111111'
  const status = normStatus({ memo_id: memo, stage: 'working', heard: 'Check the build.', heard_delivery: 'text_only', spoken_seq: null }, memo)
  assert.equal(status?.heard, 'Check the build.')
  assert.equal(status?.spoken_seq, null)
  const page = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /\b(?:n|nativeSpeech\(\))\??\.speechEcho\s*\(/)
  assert.match(page, /speechProgress\(f\.memoId,/)
  const key = `progress/2026/11/12/${memo}-1.ogg`
  assert.deepEqual(newestProgress([key], '2026/11/12', memo, 0), { key, seq: 1 })
  assert.equal(newestProgress([key], '2026/11/12', memo, 1), null, 'normal progress still deduplicates')
})

test('actual page closures keep transcript-only acknowledgements silent without muting normal progress', async () => {
  const page = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const cut = (start: string, end: string) => {
    const a = page.indexOf(start)
    const b = page.indexOf(end, a)
    assert.ok(a >= 0 && b > a)
    return page.slice(a, b)
  }
  const code = stripTypeScriptTypes([
    cut('function nativeSpeech()', '// A memo is followed'),
    cut('const pollFlight =', '  // A push said this memo moved on'),
    cut('const sayProgress =', '  const pollFlightsRef ='),
    'globalThis.run = pollFlight;',
  ].join('\n'), { mode: 'strip' })
  const memo = '11111111-1111-5111-8111-111111111111'
  const key = `progress/2026/11/12/${memo}-1.ogg`
  for (const origin of ['car-feedback-off', 'quiet-browser', 'unknown']) {
    const calls: unknown[][] = []
    let withProgress = false
    const bridge = {
      speechEcho: (...args: unknown[]) => calls.push(['native-echo-attempt', ...args]),
      speechProgress: (...args: unknown[]) => calls.push(['progress', ...args]),
      speechMemoFinal: (...args: unknown[]) => calls.push(['final', ...args]),
    }
    const ctx = {
      window: { HoloceneNative: origin === 'car-feedback-off' ? bridge : undefined }, Date, Blob,
      readStatus: async () => normStatus({ memo_id: memo, stage: 'working', heard: 'Private transcript.',
        heard_delivery: 'text_only', spoken_seq: withProgress ? 1 : null }, memo),
      noteConv() {}, fastTurns: { current: {} }, isFinal,
      flightFinal() { throw Error('unexpected final') }, PROGRESS_LIST_MS: 0,
      listPage: async () => ({ keys: withProgress ? [key] : [] }), progressPrefix,
      newestProgress, recordingRef: { current: false }, arming: { current: false }, mayPlayProgress,
      getBlob: async () => { calls.push(['fetch-progress']); return new Blob(['INERT FIXTURE NOT AUDIO']) },
      BUCKET_BASE: 'http://fixture.invalid', blobToBase64: async () => 'SU5FUlQ=', replyExt: () => 'ogg',
      progressQ: { current: [] }, pump: { current() { calls.push(['browser-progress']) } },
    }
    const context = vm.createContext(ctx)
    vm.runInContext(code, context)
    const flight = { memoId: memo, agentName: 'Holocene PM', day: '2026/11/12', progressSeq: 0, listedAt: 0, finalAt: 0 }
    await (context.run as (f: typeof flight) => Promise<void>)(flight)
    assert.deepEqual(calls, [], `${origin}: text acknowledgement must not reach any speech/download path`)
    if (origin === 'car-feedback-off') {
      withProgress = true
      await (context.run as (f: typeof flight) => Promise<void>)(flight)
      assert.equal(calls.filter(([kind]) => kind === 'progress').length, 1, 'ordinary progress is not muted')
      assert.equal(calls.filter(([kind]) => kind === 'native-echo-attempt').length, 0)
    }
  }
})

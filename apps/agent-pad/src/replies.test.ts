import test from 'node:test'
import assert from 'node:assert/strict'
import { UNIT_WAIT_MS, addRef, newUnit, parseReplyKey, planUnit, readyChunks } from './replies.ts'
import { PUSH_STALE_MS, parsePush, pushBackoff, pushLive } from './push.ts'

const M = 'f753985b-d3fb-5836-9db4-f9fb8e7dbe6b'
const FULL = `replies/2026/10/20/192041Z-holocene-pm-${M}.ogg`
const c = (i: number, n = 3) => `replies/2026/10/20/192041Z-holocene-pm-${M}-c${String(i).padStart(2, '0')}of${String(n).padStart(2, '0')}.opus`

test('a chunk key names its reply, its place and its count; a full key is its own reply', () => {
  assert.deepEqual(parseReplyKey(c(2)), { unit: FULL, key: c(2), chunk: { i: 2, n: 3 } })
  assert.deepEqual(parseReplyKey(FULL), { unit: FULL, key: FULL, chunk: null })
  assert.equal(parseReplyKey(c(4, 3)), null, 'chunk 4 of 3')
  assert.equal(parseReplyKey(c(1, 1)), null, 'one chunk is not a chunked reply')
  assert.equal(parseReplyKey('replies/2026101912.ogg'), null, 'a legacy flat key never counts')
  assert.equal(parseReplyKey(`progress/2026/10/20/${M}-1.ogg`), null)
  assert.equal(parseReplyKey(`replies/2026/10/20/192041Z-holocene-pm-${M}-c01of03.ogg`), null, 'a chunk is always .opus')
  // the listing order a pad sees: the chunks, then the full file
  assert.deepEqual([FULL, c(3), c(1), c(2)].sort(), [c(1), c(2), c(3), FULL])
})

test('a unit collects its chunks and its full file, once each', () => {
  const u = newUnit(FULL, 0)
  assert.equal(addRef(u, parseReplyKey(c(2))!), true)
  assert.equal(addRef(u, parseReplyKey(c(2))!), false, 'seen already')
  assert.deepEqual(readyChunks(u, 1), [], 'chunk 1 is missing: nothing can play in order')
  addRef(u, parseReplyKey(c(1))!)
  assert.deepEqual(readyChunks(u, 1), [1, 2])
  assert.deepEqual(readyChunks(u, 3), [])
  assert.equal(addRef(u, parseReplyKey(`replies/2026/10/20/192041Z-holocene-pm-${M}-c03of04.opus`)!), false, 'another count')
  assert.equal(addRef(u, parseReplyKey(FULL)!), true)
  assert.equal(addRef(u, parseReplyKey(`replies/2026/10/20/192041Z-other-${M}.ogg`)!), false, 'another reply')
  assert.equal(u.full, true)
})

test('the full file wins when it is there; a chunk host starts on chunk 1; others wait, then let go', () => {
  const u = newUnit(FULL, 1000)
  assert.equal(planUnit(u, true, 1000), 'wait')
  addRef(u, parseReplyKey(c(2))!)
  assert.equal(planUnit(u, true, 1000), 'wait', 'no chunk 1 yet')
  addRef(u, parseReplyKey(c(1))!)
  assert.equal(planUnit(u, true, 1000), 'chunks')
  assert.equal(planUnit(u, false, 1000), 'wait', 'an older host waits for the full file')
  assert.equal(planUnit(u, false, 1000 + UNIT_WAIT_MS + 1), 'give_up', 'a reply that never completes (cancelled) is let go')
  addRef(u, parseReplyKey(FULL)!)
  assert.equal(planUnit(u, true, 1000), 'full')
  assert.equal(planUnit(u, false, 1000 + UNIT_WAIT_MS + 1), 'full')
})

test('push events are parsed defensively', () => {
  const ev = parsePush(JSON.stringify({ fact: 'voiced', memo_id: M, chunk: 1, chunks: 3, chunk_s3_key: c(1), reply_s3_key: FULL, extra: 'x' }))
  assert.deepEqual(ev, { fact: 'voiced', memo_id: M, chunk: 1, chunks: 3, chunk_s3_key: c(1), reply_s3_key: FULL })
  assert.equal(parsePush('{nope'), null)
  assert.equal(parsePush({ fact: 'replied', memo_id: 'x' }), null)
  assert.equal(parsePush({ fact: 'replied', memo_id: M, reply_s3_key: 'inbox/../x.ogg' })?.reply_s3_key, undefined)
  assert.equal(parsePush({ fact: 'narrated', memo_id: M, progress_s3_key: 'replies/x.ogg' })?.progress_s3_key, undefined)
  assert.equal(parsePush({ fact: 'narrated', memo_id: M, narration: -1 })?.narration, undefined)
})

test('the push channel is live only while it speaks and NATS is behind it', () => {
  assert.equal(pushLive(1000, true, 1000 + PUSH_STALE_MS - 1), true)
  assert.equal(pushLive(1000, true, 1000 + PUSH_STALE_MS), false)
  assert.equal(pushLive(1000, false, 1001), false)
  assert.equal(pushLive(0, true, 1), false)
  assert.deepEqual([0, 1, 2, 5, 9].map(pushBackoff), [1000, 2000, 4000, 30_000, 30_000])
})

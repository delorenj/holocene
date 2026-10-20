import test from 'node:test'
import assert from 'node:assert/strict'
import { InFlight, UploadRejected, isPermanentStatus, rejectionReason, rejectionText, replyExt, retryable, stripDataUrl } from './flight.ts'

test('a recording being sent is not picked up by the retry timer', () => {
  const f = new InFlight()
  assert.equal(f.begin('inbox/a/1.ogg'), true)
  assert.equal(f.begin('inbox/a/1.ogg'), false, 'a second send of the same key must be refused')
  const outbox = [{ key: 'inbox/a/1.ogg' }, { key: 'inbox/a/0.ogg' }]
  assert.deepEqual(f.idle(outbox), [{ key: 'inbox/a/0.ogg' }])
  f.end('inbox/a/1.ogg')
  assert.deepEqual(f.idle(outbox), outbox, 'once the send ends, the outbox owns it again')
})

test('reply extension and data url helpers', () => {
  assert.equal(replyExt('replies/2026/10/16/120000Z-x.OGG'), 'ogg')
  assert.equal(replyExt('replies/noext'), 'bin')
  assert.equal(stripDataUrl('data:audio/ogg;base64,QUJD'), 'QUJD')
  assert.equal(stripDataUrl('nonsense'), '')
})

test('a 4xx is permanent except 408 and 429; 5xx is retryable', () => {
  for (const s of [400, 401, 403, 404, 409, 413, 422, 451, 499]) assert.equal(isPermanentStatus(s), true, String(s))
  for (const s of [408, 429, 500, 502, 503, 504, 200, 302]) assert.equal(isPermanentStatus(s), false, String(s))
})

test('the proxy reason comes from a JSON body and is bounded', () => {
  assert.equal(rejectionReason('{"reason":"agent not routable"}'), 'agent not routable')
  assert.equal(rejectionReason('{"error":" no such agent "}'), 'no such agent')
  assert.equal(rejectionReason('{"detail":"x"}'), 'x')
  assert.equal(rejectionReason('{"reason":"' + 'y'.repeat(500) + '"}').length, 120)
  for (const b of ['', 'Forbidden', '<html>', '{}', '{"reason":5}', 'null']) assert.equal(rejectionReason(b), '', b)
  assert.equal(rejectionText(403, 'agent not routable'), 'HTTP 403: agent not routable')
  assert.equal(rejectionText(404, ''), 'HTTP 404')
  const e = new UploadRejected(422, 'bad agent')
  assert.ok(e instanceof Error)
  assert.deepEqual([e.status, e.reason], [422, 'bad agent'])
})

test('rejected recordings stay in the outbox but the retry timer skips them', () => {
  const rows = [{ key: 'a' }, { key: 'b', rejected: { status: 403, reason: 'x' } }, { key: 'c' }]
  assert.deepEqual(retryable(rows).map((r) => r.key), ['a', 'c'])
})

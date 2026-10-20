import test from 'node:test'
import assert from 'node:assert/strict'
import { InFlight, UploadRejected, isFinalRefusal, nagRejected, newestRejectedAt, rejectionCode, rejectionReason, rejectionText, replyExt, retryable, stripDataUrl, REJECTED_NAG_MS } from './flight.ts'

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

test('only a refusal the proxy itself authored is final: 422/413 with a JSON error body', () => {
  const json = 'application/json'
  assert.equal(isFinalRefusal(422, json, '{"error":"unroutable_agent","reason":"no route for zz"}'), true)
  assert.equal(isFinalRefusal(422, `${json}; charset=utf-8`, '{"error":"unroutable_agent"}'), true)
  assert.equal(isFinalRefusal(413, json, '{"error":"too_large"}'), true)
  // an edge answering in the proxy's place (proxy down, route elsewhere) is retryable, whatever the status
  assert.equal(isFinalRefusal(405, 'text/html', '<html><body>405 Not Allowed</body></html>'), false)
  for (const s of [400, 401, 403, 404, 405, 410, 500, 502, 503]) assert.equal(isFinalRefusal(s, json, '{"error":"x"}'), false, String(s))
  // a 422 that is not the proxy's JSON error body is retryable too
  assert.equal(isFinalRefusal(422, 'text/html', '<html>422</html>'), false)
  assert.equal(isFinalRefusal(422, json, '{"reason":"unprocessable"}'), false, 'no error key')
  assert.equal(isFinalRefusal(422, json, 'not json'), false)
  assert.equal(isFinalRefusal(422, '', '{"error":"x"}'), false, 'no JSON content type')
})

test('the proxy reason and code come from a JSON body and are bounded', () => {
  assert.equal(rejectionReason('{"reason":"agent not routable"}'), 'agent not routable')
  assert.equal(rejectionReason('{"error":" no such agent "}'), 'no such agent')
  assert.equal(rejectionReason('{"detail":"x"}'), 'x')
  assert.equal(rejectionReason('{"reason":"' + 'y'.repeat(500) + '"}').length, 120)
  for (const b of ['', 'Forbidden', '<html>', '{}', '{"reason":5}', 'null']) assert.equal(rejectionReason(b), '', b)
  assert.equal(rejectionCode('{"error":"unroutable_agent","reason":"no route"}'), 'unroutable_agent')
  for (const b of ['', 'Forbidden', '<html>', '{}', '{"error":5}', 'null']) assert.equal(rejectionCode(b), '', b)
  assert.equal(rejectionText(403, 'agent not routable'), 'HTTP 403: agent not routable')
  assert.equal(rejectionText(404, ''), 'HTTP 404')
  const e = new UploadRejected(422, 'bad agent', 'unroutable_agent')
  assert.ok(e instanceof Error)
  assert.deepEqual([e.status, e.reason, e.code], [422, 'bad agent', 'unroutable_agent'])
  assert.equal(new UploadRejected(413, 'too big').code, '', 'no code when the body had none')
})

test('rejected recordings stay in the outbox but the fast retry timer skips them', () => {
  const rows = [{ key: 'a' }, { key: 'b', rejected: { status: 403, reason: 'x' } }, { key: 'c' }]
  assert.deepEqual(retryable(rows).map((r) => r.key), ['a', 'c'])
})

test('the driving hero nags only while a refusal is fresh news', () => {
  const now = 10_000_000
  const rows = [
    { key: 'a', rejected: { status: 422, reason: 'x', at: now - 60_000 } },
    { key: 'b', rejected: { status: 422, reason: 'y', at: now - 120_000 } },
    { key: 'c' },
  ]
  assert.equal(newestRejectedAt(rows), now - 60_000)
  assert.equal(newestRejectedAt([{ key: 'a' }]), 0)
  assert.equal(newestRejectedAt([{ key: 'a', rejected: { status: 422, reason: 'x' } }]), 0, 'a legacy row without a stamp never nags')
  assert.equal(nagRejected(2, now - 60_000, 0, now), true)
  assert.equal(nagRejected(2, now - REJECTED_NAG_MS - 1, 0, now), false, 'older than ~30 min: the parked count keeps it')
  assert.equal(nagRejected(2, now - 60_000, now - 30_000, now), false, 'a successful send after the refusal clears the note')
  assert.equal(nagRejected(0, now - 60_000, 0, now), false)
  assert.equal(nagRejected(1, 0, 0, now), false)
})

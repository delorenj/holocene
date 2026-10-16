import test from 'node:test'
import assert from 'node:assert/strict'
import { InFlight, replyExt, stripDataUrl } from './flight.ts'

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

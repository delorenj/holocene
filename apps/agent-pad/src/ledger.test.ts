import test from 'node:test'
import assert from 'node:assert/strict'
import { OPEN_KEEP_MS, OWNED_KEEP_MS, PHONE_KEEP_MS, closeUnit, leaveToPhone, takeBackFromPhone, emptyLedger, forThisDevice, isOpen, memoOfReply, mergeLedgers, newDeviceId, normLedger, openUnit, own, parkUnit, validDeviceId } from './ledger.ts'
import { addRef, newUnit, nextUnit, parseReplyKey, type Unit } from './replies.ts'

const MINE = 'f753985b-d3fb-5836-9db4-f9fb8e7dbe6b'
const OTHER = 'cacc736b-cf5d-584c-96c7-13861b48ab83'
const reply = (memo: string, hms = '192041') => `replies/2026/10/20/${hms}Z-holocene-pm-${memo}.ogg`
const T = Date.UTC(2026, 9, 20, 20, 0, 0)

test('a pad plays the replies to the memos it sent, not every reply in the bucket', () => {
  const l = own(emptyLedger(), MINE, T)
  assert.equal(forThisDevice(l, reply(MINE), false), true)
  assert.equal(forThisDevice(l, reply(OTHER), false), false, 'the sim must not play the car\'s replies (or the other way round)')
  assert.equal(forThisDevice(l, reply(OTHER), true), true, '?replies=all opts back in')
  assert.equal(forThisDevice(l, 'replies/2026/10/20/192041Z-broadcast.ogg', false), true, 'a reply that names no memo plays everywhere')
  assert.equal(memoOfReply(reply(MINE)), MINE)
})

test('owned memos are kept a day, the newest first when there are too many', () => {
  let l = own(emptyLedger(), MINE, T)
  l = own(l, OTHER, T + 1000)
  assert.deepEqual(Object.keys(normLedger(JSON.stringify(l), T + OWNED_KEEP_MS - 1).owned).sort(), [MINE, OTHER].sort())
  assert.deepEqual(Object.keys(normLedger(JSON.stringify(l), T + OWNED_KEEP_MS + 500).owned), [OTHER])
  assert.equal(own(emptyLedger(), 'not-a-memo', T).owned['not-a-memo'], undefined)
})

test('a stored ledger is cleaned, never trusted: bad entries are dropped, garbage reads as empty', () => {
  assert.deepEqual(normLedger('not json', T), emptyLedger())
  assert.deepEqual(normLedger(null, T), emptyLedger())
  const l = normLedger({ owned: { [MINE]: T, x: T, [OTHER]: 'yesterday' }, open: { [reply(MINE)]: { seenAt: T, parked: true }, 'replies/../x.ogg': { seenAt: T }, 'inbox/a.ogg': { seenAt: T } } }, T)
  assert.deepEqual(l, { owned: { [MINE]: T }, open: { [reply(MINE)]: { seenAt: T, parked: true } }, phone: {} })
})

test('a unit stays open (owed across a cold start) until it is settled, and not past the reply age limit', () => {
  let l = openUnit(emptyLedger(), reply(MINE), T)
  assert.equal(isOpen(l, reply(MINE)), true)
  l = parkUnit(l, reply(MINE), T + 5000)
  assert.deepEqual(l.open[reply(MINE)], { seenAt: T, parked: true }, 'parking keeps when it was first seen')
  assert.equal(isOpen(normLedger(JSON.stringify(l), T + OPEN_KEEP_MS + 1), reply(MINE)), false, 'too old to be worth playing')
  assert.equal(isOpen(closeUnit(l, reply(MINE)), reply(MINE)), false)
  assert.equal(isOpen(openUnit(emptyLedger(), 'replies/not-dated.ogg', T), 'replies/not-dated.ogg'), false)
})

test('the localStorage and IndexedDB copies merge (a cold start in the car keeps only the IndexedDB one)', () => {
  const a = openUnit(own(emptyLedger(), MINE, T), reply(MINE), T)
  const b = parkUnit(own(emptyLedger(), OTHER, T), reply(MINE, '192100'), T)
  const m = mergeLedgers(a, b, T)
  assert.deepEqual(Object.keys(m.owned).sort(), [MINE, OTHER].sort())
  assert.deepEqual(Object.keys(m.open).sort(), [reply(MINE), reply(MINE, '192100')].sort())
})

test('a device id is random and well formed', () => {
  const a = newDeviceId(), b = newDeviceId()
  assert.notEqual(a, b)
  assert.ok(validDeviceId(a))
  assert.ok(validDeviceId(newDeviceId(() => 0.5)))
  assert.equal(validDeviceId('x'), false)
  assert.equal(validDeviceId('a b c d e f g h'), false)
})

test('a short reply that is ready does not wait behind a long one still waiting for its full file', () => {
  const units = new Map<string, Unit>()
  const long = newUnit(reply(MINE, '192000'), T)
  addRef(long, parseReplyKey(`replies/2026/10/20/192000Z-holocene-pm-${MINE}-c01of03.opus`)!)
  const short = newUnit(reply(OTHER, '192030'), T)
  addRef(short, parseReplyKey(reply(OTHER, '192030'))!)
  units.set(long.key, long)
  units.set(short.key, short)
  const q = [long.key, short.key]
  // a host that cannot play chunks (the real car's app today): the short one goes first
  assert.deepEqual(nextUnit(q, (k) => units.get(k), false, T + 1000), { key: short.key, plan: 'full' })
  // a host with the chunk player starts the long one from its first chunk, in order
  assert.deepEqual(nextUnit(q, (k) => units.get(k), true, T + 1000), { key: long.key, plan: 'chunks' })
  // nothing playable: null; a unit that waited too long is given up wherever it sits
  assert.equal(nextUnit([long.key], (k) => units.get(k), false, T + 1000), null)
  assert.deepEqual(nextUnit([short.key, long.key].slice(1), (k) => units.get(k), false, T + 4 * 60 * 1000), { key: long.key, plan: 'give_up' })
})

test('a reply left to the phone survives a reload and a cold start, and is forgotten when it is taken back or too old', () => {
  const u = reply(MINE)
  let l = leaveToPhone(own(emptyLedger(), MINE, T), u, T)
  assert.equal(l.phone[u], T)
  assert.equal(leaveToPhone(l, u, T + 5000).phone[u], T, 'the first time it was left counts')
  // through the stored JSON, as localStorage / IndexedDB hand it back
  const back = normLedger(JSON.stringify(l), T + 10 * 60_000)
  assert.equal(back.phone[u], T)
  assert.equal(normLedger(JSON.stringify(l), T + PHONE_KEEP_MS).phone[u], undefined, 'too old to be worth playing')
  assert.equal(takeBackFromPhone(l, u).phone[u], undefined)
  assert.equal(takeBackFromPhone(l, 'replies/2026/10/20/x.ogg'), l)
  assert.equal(leaveToPhone(l, 'inbox/not-a-reply.ogg', T), l)
  // the two stored copies merge: either one remembers it
  const merged = mergeLedgers(emptyLedger(), l, T + 1000)
  assert.equal(merged.phone[u], T)
  // an older ledger without the field reads fine
  assert.deepEqual(normLedger({ owned: { [MINE]: T }, open: {} }, T).phone, {})
  // closing or opening other units leaves the list alone
  assert.equal(closeUnit(openUnit(l, u, T), u).phone[u], T)
})

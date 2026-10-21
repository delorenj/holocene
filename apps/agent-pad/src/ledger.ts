// Which replies this pad plays, and which ones it still owes, across cold starts. Pure, so the rules are tested.
//
// Owned: a pad plays the replies to the memos IT sent, not every reply in replies/. Before this, every pad played
// every reply: the sim's test replies played again in the real car (pushed within 0.3 s once the car opened its
// stream), and the car's played on the sim. A reply key names its memo (replies/...-<memo_id>.ogg), so the pad keeps
// the ids of the memos it uploaded and plays only those. A reply key with no memo id (another producer) still plays
// everywhere, as before; a browser can opt back into "every reply" with ?replies=all.
//
// Open: lastDone (the persisted marker) is a high-water mark, every reply key at or below it is settled. A unit the pad
// has seen but not settled yet (queued behind another, a chunked reply parked until its full file lands) is kept
// here too, so a cold start (every ignition) picks it up again instead of losing it under a marker that moved past it.

// Left to the phone: a reply the phone took (the proxy refused this car's hold) is not played here, but the watcher may give
// the take back (its Earshot drop failed, or nobody claimed a released reply), and then this car plays it after all. That
// can come minutes later, after a page reload or the car's cold start, so which replies were left to the phone is kept
// here (unit key -> when it was left) with the rest of what the pad owes, and looked at again until PHONE_KEEP_MS is up.

export type OpenUnit = { seenAt: number; parked?: boolean }
export type Ledger = { owned: Record<string, number>; open: Record<string, OpenUnit>; phone: Record<string, number> }

/** A memo's reply is still wanted this long after the memo was sent (a late batch reply can take most of an hour). */
export const OWNED_KEEP_MS = 24 * 3600 * 1000
export const OWNED_MAX = 400
/** A unit stays open as long as a reply is worth playing at all (main.tsx MAX_REPLY_AGE_MS). */
export const OPEN_KEEP_MS = 30 * 60 * 1000
export const OPEN_MAX = 100
/** A reply left to the phone is looked at again for as long as a reply is worth playing at all (MAX_REPLY_AGE_MS). */
export const PHONE_KEEP_MS = 30 * 60 * 1000
export const PHONE_MAX = 50

const MEMO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REPLY_MEMO = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]+$/
const UNIT = /^replies\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.(ogg|webm|m4a|mp3)$/

export function emptyLedger(): Ledger {
  return { owned: {}, open: {}, phone: {} }
}

/** The memo id a reply (unit) key names, or null. */
export function memoOfReply(key: string): string | null {
  return REPLY_MEMO.exec(key)?.[1] ?? null
}

/** A stored ledger (JSON text or an object), cleaned: bad entries are dropped, old ones pruned. Never throws. */
export function normLedger(raw: unknown, now: number): Ledger {
  let o = raw
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return emptyLedger() }
  }
  const l = emptyLedger()
  const r = (o && typeof o === 'object' ? o : {}) as { owned?: unknown; open?: unknown; phone?: unknown }
  if (r.owned && typeof r.owned === 'object') {
    for (const [k, v] of Object.entries(r.owned as Record<string, unknown>)) {
      if (MEMO.test(k) && typeof v === 'number' && Number.isFinite(v)) l.owned[k] = v
    }
  }
  if (r.open && typeof r.open === 'object') {
    for (const [k, v] of Object.entries(r.open as Record<string, unknown>)) {
      const u = v as { seenAt?: unknown; parked?: unknown } | null
      if (UNIT.test(k) && !k.split('/').includes('..') && u && typeof u.seenAt === 'number' && Number.isFinite(u.seenAt)) {
        l.open[k] = { seenAt: u.seenAt, ...(u.parked === true ? { parked: true } : {}) }
      }
    }
  }
  if (r.phone && typeof r.phone === 'object') {
    for (const [k, v] of Object.entries(r.phone as Record<string, unknown>)) {
      if (UNIT.test(k) && !k.split('/').includes('..') && typeof v === 'number' && Number.isFinite(v)) l.phone[k] = v
    }
  }
  return prune(l, now)
}

/** Two copies (localStorage, IndexedDB) of the same ledger: the union, newest stamps win. */
export function mergeLedgers(a: Ledger, b: Ledger, now: number): Ledger {
  const l = emptyLedger()
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src.owned)) l.owned[k] = Math.max(l.owned[k] ?? 0, v)
    for (const [k, v] of Object.entries(src.open)) {
      const cur = l.open[k]
      l.open[k] = { seenAt: Math.min(cur?.seenAt ?? v.seenAt, v.seenAt), ...((cur?.parked || v.parked) ? { parked: true } : {}) }
    }
    for (const [k, v] of Object.entries(src.phone)) l.phone[k] = Math.min(l.phone[k] ?? v, v)
  }
  return prune(l, now)
}

function prune(l: Ledger, now: number): Ledger {
  const owned = Object.entries(l.owned).filter(([, at]) => now - at < OWNED_KEEP_MS).sort((x, y) => y[1] - x[1]).slice(0, OWNED_MAX)
  const open = Object.entries(l.open).filter(([, u]) => now - u.seenAt < OPEN_KEEP_MS).sort((x, y) => y[1].seenAt - x[1].seenAt).slice(0, OPEN_MAX)
  const phone = Object.entries(l.phone).filter(([, at]) => now - at < PHONE_KEEP_MS).sort((x, y) => y[1] - x[1]).slice(0, PHONE_MAX)
  return { owned: Object.fromEntries(owned), open: Object.fromEntries(open), phone: Object.fromEntries(phone) }
}

/** This pad sent the memo: its reply is this pad's to play. */
export function own(l: Ledger, memoId: string, now: number): Ledger {
  if (!MEMO.test(memoId)) return l
  return prune({ ...l, owned: { ...l.owned, [memoId]: now } }, now)
}

/** Does this pad play the reply `unitKey`? Its own memos' replies, a reply that names no memo, or every one (opt-in). */
export function forThisDevice(l: Ledger, unitKey: string, playAll: boolean): boolean {
  if (playAll) return true
  const memo = memoOfReply(unitKey)
  return memo === null || memo in l.owned
}

export function openUnit(l: Ledger, unitKey: string, now: number): Ledger {
  if (!UNIT.test(unitKey) || l.open[unitKey]) return l
  return prune({ ...l, open: { ...l.open, [unitKey]: { seenAt: now } } }, now)
}

export function parkUnit(l: Ledger, unitKey: string, now: number): Ledger {
  if (!UNIT.test(unitKey)) return l
  return prune({ ...l, open: { ...l.open, [unitKey]: { seenAt: l.open[unitKey]?.seenAt ?? now, parked: true } } }, now)
}

export function closeUnit(l: Ledger, unitKey: string): Ledger {
  if (!l.open[unitKey]) return l
  const open = { ...l.open }
  delete open[unitKey]
  return { ...l, open }
}

/** This car left the reply to the phone (the phone took it): remembered across a reload and a cold start. */
export function leaveToPhone(l: Ledger, unitKey: string, now: number): Ledger {
  if (!UNIT.test(unitKey)) return l
  return prune({ ...l, phone: { ...l.phone, [unitKey]: l.phone[unitKey] ?? now } }, now)
}

/** The reply is no longer left to the phone (released and reclaimed, or settled another way). */
export function takeBackFromPhone(l: Ledger, unitKey: string): Ledger {
  if (!(unitKey in l.phone)) return l
  const phone = { ...l.phone }
  delete phone[unitKey]
  return { ...l, phone }
}

/** Is `unitKey` still owed (seen, not settled), whatever the marker says? */
export function isOpen(l: Ledger, unitKey: string): boolean {
  return !!l.open[unitKey]
}

/** A device id: random, stable for this install of the pad (stored next to the ledger). */
export function newDeviceId(rand: () => number = Math.random): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch { /* no crypto */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(rand() * 16)
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function validDeviceId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v)
}

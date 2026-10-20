// The push channel: GET /upload/events (Server-Sent Events from the upload proxy, fed from the Bloodbank memo facts).
// It only makes the pad early: polling stays the fallback, and a stale or absent channel changes nothing but speed.
// Pure parsing and liveness rules, so they are tested.

const MEMO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type PushEvent = {
  /** received | transcribed | dispatched | narrated | voiced | replied | failed | progressed */
  fact: string
  memo_id: string
  agent?: string
  at?: string
  reply_s3_key?: string
  chunk_s3_key?: string
  progress_s3_key?: string
  chunk?: number
  chunks?: number
  narration?: number
  seq?: number
  stage?: string
}

const str = (v: unknown, prefix?: string) =>
  typeof v === 'string' && v.length <= 300 && (!prefix || v.startsWith(prefix)) && !v.split('/').includes('..') ? v : undefined
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)

/** One `memo` event's data, or null when it is not one we can trust. */
export function parsePush(data: unknown): PushEvent | null {
  let o = data
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  const e = o as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.fact !== 'string' || typeof e.memo_id !== 'string' || !MEMO.test(e.memo_id)) return null
  const out: PushEvent = { fact: e.fact.slice(0, 20), memo_id: e.memo_id }
  const set = <K extends keyof PushEvent>(k: K, v: PushEvent[K] | undefined) => { if (v !== undefined) out[k] = v }
  set('agent', str(e.agent))
  set('at', str(e.at))
  set('reply_s3_key', str(e.reply_s3_key, 'replies/'))
  set('chunk_s3_key', str(e.chunk_s3_key, 'replies/'))
  set('progress_s3_key', str(e.progress_s3_key, 'progress/'))
  set('chunk', int(e.chunk))
  set('chunks', int(e.chunks))
  set('narration', int(e.narration))
  set('seq', int(e.seq))
  set('stage', str(e.stage))
  return out
}

// The proxy sends a beat every 15 s; three missed ones mean the stream is dead even if the socket says otherwise
// (a Cloudflare edge can keep a half-open connection): the pad drops it and reconnects.
export const PUSH_STALE_MS = 45_000

/** The channel is live: it spoke recently and NATS is behind it. */
export function pushLive(lastHeardAt: number, natsUp: boolean, now: number): boolean {
  return natsUp && lastHeardAt > 0 && now - lastHeardAt < PUSH_STALE_MS
}

/** Reconnect delay after the stream was closed for good (an error status, a dead edge): 1 s doubling to 30 s. */
export function pushBackoff(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(failures, 5)))
}

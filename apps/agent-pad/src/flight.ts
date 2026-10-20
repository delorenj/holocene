// Keys of recordings whose upload is running right now. The outbox (IndexedDB) holds every recording from the
// moment it is stopped until it is on the server, so a retry timer must skip the ones a live send still owns.
export class InFlight {
  private keys = new Set<string>()
  begin(key: string): boolean {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }
  end(key: string) { this.keys.delete(key) }
  has(key: string): boolean { return this.keys.has(key) }
  /** What the retry timer may touch / count. */
  idle<T extends { key: string }>(items: T[]): T[] { return items.filter((i) => !this.keys.has(i.key)) }
}

// Extension of a reply object key, handed to the host so it can name its temp file.
export function replyExt(key: string): string {
  const m = key.match(/\.([a-z0-9]{1,5})$/i)
  return m ? m[1].toLowerCase() : 'bin'
}

// base64 of a blob without the data: prefix (the host bridge takes plain base64).
export function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(',')
  return i < 0 ? '' : dataUrl.slice(i + 1)
}

// A refusal is final only when the proxy itself authored it: a 422 or 413 with a JSON body carrying an 'error' key
// (the proxy answers {"error":"unroutable_agent","reason":"..."}). Every other 4xx — 400/401/403/404/405/410, any
// HTML body — can come from an edge answering in the proxy's place (nginx 405 while the proxy is down, Traefik 404),
// so it stays retryable with the normal backoff, as do 5xx and every network failure. The recording itself is never
// dropped: it stays in the outbox, marked rejected, and the slow timer gives it another try about hourly.
export function isFinalRefusal(status: number, contentType: string, body: string): boolean {
  if (status !== 422 && status !== 413) return false
  if (!/application\/json/i.test(contentType)) return false
  try {
    const o = JSON.parse(body) as Record<string, unknown> | null
    return !!o && typeof o === 'object' && 'error' in o
  } catch { return false }
}
export class UploadRejected extends Error {
  readonly status: number
  readonly reason: string
  readonly code: string
  constructor(status: number, reason: string, code = '') {
    super(`PUT rejected: ${status}${reason ? ` ${reason}` : ''}`)
    this.status = status
    this.reason = reason
    this.code = code
  }
}
/** The human reason from a JSON error body ({reason|error|detail|message}), or ''. */
export function rejectionReason(body: string): string {
  try {
    const o = JSON.parse(body) as Record<string, unknown> | null
    for (const k of ['reason', 'error', 'detail', 'message']) {
      const v = o?.[k]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
    }
  } catch { /* not JSON */ }
  return ''
}
/** The machine code from a JSON error body ({error}), or ''. */
export function rejectionCode(body: string): string {
  try {
    const v = (JSON.parse(body) as Record<string, unknown> | null)?.error
    return typeof v === 'string' ? v : ''
  } catch { /* not JSON */ }
  return ''
}
export const rejectionText = (status: number, reason: string) => `HTTP ${status}${reason ? `: ${reason}` : ''}`

/** The outbox rows the fast retry timer may send: not rejected. (Rejected ones get the slow timer, counted apart.) */
export function retryable<T extends { rejected?: unknown }>(items: T[]): T[] { return items.filter((i) => !i.rejected) }

// A rejected row is tried again once at pad start and about hourly: a refusal classified wrong (an edge answered in
// the proxy's place, an agent that is routable again) then clears itself instead of sitting on the device forever.
export const REJECTED_RETRY_MS = 60 * 60 * 1000
// The driving hero nags about a refused note only while the refusal is fresh news: younger than ~30 min and not yet
// followed by a successful send. The parked status line keeps the full count.
export const REJECTED_NAG_MS = 30 * 60 * 1000

/** Newest rejection time across outbox rows (0 when none or none stamped). */
export function newestRejectedAt<T extends { rejected?: { at?: number } }>(rows: T[]): number {
  return rows.reduce((m, r) => Math.max(m, r.rejected?.at ?? 0), 0)
}
export function nagRejected(count: number, newestAt: number, lastSentAt: number, now: number): boolean {
  return count > 0 && newestAt > 0 && newestAt > lastSentAt && now - newestAt < REJECTED_NAG_MS
}

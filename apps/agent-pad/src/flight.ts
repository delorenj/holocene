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

// A PUT the proxy answers with a 4xx (not routable, bad key, refused) will get the same answer next time: retrying it
// forever helps nobody. 408 and 429 are the proxy asking to try again later, so they stay retryable, as do 5xx and
// every network failure. The recording itself is never dropped: it stays in the outbox, marked rejected.
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}
export class UploadRejected extends Error {
  readonly status: number
  readonly reason: string
  constructor(status: number, reason: string) {
    super(`PUT rejected: ${status}${reason ? ` ${reason}` : ''}`)
    this.status = status
    this.reason = reason
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
export const rejectionText = (status: number, reason: string) => `HTTP ${status}${reason ? `: ${reason}` : ''}`

/** The outbox rows the retry timer may send: not rejected. (Rejected ones stay on the device, counted apart.) */
export function retryable<T extends { rejected?: unknown }>(items: T[]): T[] { return items.filter((i) => !i.rejected) }

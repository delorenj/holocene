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

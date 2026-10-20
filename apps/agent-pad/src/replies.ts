// Replies as the pad plays them. A reply is one "unit", named by its full key
// replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>.ogg. A long reply also arrives as chunks first: the watcher voices
// it sentence by sentence and uploads replies/...-<memo_id>-c<ii>of<nn>.opus while it renders the rest, then the full
// file (the chunks joined) last. A chunk key sorts just before its full key, and names its count, so a pad that only
// lists (no push) still knows when it has them all. Pure, so the rules are tested.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FULL = /^replies\/\d{4}\/\d{2}\/\d{2}\/(?![^/]*-c\d{2}of\d{2}\.)[^/]+\.(ogg|webm|m4a|mp3)$/ // never a chunk-shaped name
const CHUNK = new RegExp(`^(replies/\\d{4}/\\d{2}/\\d{2}/[^/]+-${UUID})-c(\\d{2})of(\\d{2})\\.opus$`)

export type ReplyRef = { unit: string; key: string; chunk: { i: number; n: number } | null }

/** The unit a reply key belongs to (its full key) and, for a chunk, which one of how many. Null: not a reply key. */
export function parseReplyKey(key: string): ReplyRef | null {
  const c = CHUNK.exec(key)
  if (c) {
    const i = Number(c[2]), n = Number(c[3])
    if (n < 2 || i < 1 || i > n) return null
    return { unit: `${c[1]}.ogg`, key, chunk: { i, n } }
  }
  return FULL.test(key) ? { unit: key, key, chunk: null } : null
}

export type Unit = {
  key: string
  /** How many chunks the reply has (0: none seen, it is a one-file reply so far). */
  n: number
  /** Chunk index -> its key. */
  chunks: Record<number, string>
  /** The full file is up. */
  full: boolean
  /** When the pad first heard of it (device clock): a reply that never completes is let go. */
  seenAt: number
}

export function newUnit(key: string, now: number): Unit {
  return { key, n: 0, chunks: {}, full: false, seenAt: now }
}

/** Record one key of the unit. True when it told the pad something new. */
export function addRef(u: Unit, ref: ReplyRef): boolean {
  if (ref.unit !== u.key) return false
  if (!ref.chunk) {
    if (u.full) return false
    u.full = true
    return true
  }
  if (u.n && u.n !== ref.chunk.n) return false // a count that changed: not this reply's chunk set
  if (u.chunks[ref.chunk.i] === ref.key) return false
  u.n = ref.chunk.n
  u.chunks[ref.chunk.i] = ref.key
  return true
}

/** The chunks that can be handed to the player now, in order from `from`: up to the first one still missing. */
export function readyChunks(u: Unit, from: number): number[] {
  const out: number[] = []
  for (let i = from; i <= u.n && u.chunks[i]; i++) out.push(i)
  return out
}

// A unit at the head of the queue that cannot play (no full file, and chunks this host cannot use or no chunk 1) waits
// this long, then is let go: a cancelled memo takes its chunks back and never uploads the full file.
export const UNIT_WAIT_MS = 3 * 60 * 1000

export type Plan = 'full' | 'chunks' | 'wait' | 'give_up'

/**
 * How to play the unit at the head of the queue. The full file is simplest and gapless, so it wins whenever it is up
 * before playback starts. A host with the chunk player (speechVersion 2) starts on chunk 1 as soon as it is there;
 * any other host (an older car app, a plain browser) waits for the full file.
 */
export function planUnit(u: Unit, chunkHost: boolean, now: number): Plan {
  if (u.full) return 'full'
  if (chunkHost && u.n > 1 && u.chunks[1]) return 'chunks'
  return now - u.seenAt > UNIT_WAIT_MS ? 'give_up' : 'wait'
}

/**
 * Which queued unit plays now. The head, when it can; when the head is still waiting for its audio (no full file yet on
 * a host that cannot play chunks, or no chunk 1), the first later unit that can play now goes first, so a short reply
 * that is ready does not wait 10-15 s behind a long one's full file. A unit that waited too long is given up wherever it
 * sits. Null: nothing can play yet.
 */
export function nextUnit(queue: string[], get: (key: string) => Unit | undefined, chunkHost: boolean, now: number): { key: string; plan: Plan } | null {
  for (const key of queue) {
    const u = get(key)
    const plan: Plan = u ? planUnit(u, chunkHost, now) : 'full'
    if (plan !== 'wait') return { key, plan }
  }
  return null
}

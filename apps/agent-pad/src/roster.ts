// The agent list comes from /roster/roster.json (services/pad-roster): every agent the gateway can route a memo to,
// most recently talked to first, each with its Telegram avatar. The built-in list is the fallback for a first start
// with no network; the last good roster is kept across cold starts so the car never falls back to it after that.
export type Agent = { id: string; name: string; color: string; avatar?: string }

export const ROSTER_URL = '/roster/roster.json'
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const AVATAR = /^\/roster\/avatars\/[a-z0-9-]+\.[A-Za-z0-9_-]+\.jpg$/

/** A usable agent list from roster JSON (parsed or raw), or null. Bad rows are dropped, never trusted. */
export function normRoster(raw: unknown): Agent[] | null {
  let o = raw
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  const rows = (o as { agents?: unknown } | null)?.agents
  if (!Array.isArray(rows)) return null
  const seen = new Set<string>()
  const out: Agent[] = []
  for (const r of rows) {
    const a = r as Partial<Agent> | null
    if (!a || typeof a.id !== 'string' || !ID.test(a.id) || seen.has(a.id)) continue
    if (typeof a.name !== 'string' || !a.name.trim()) continue
    seen.add(a.id)
    out.push({
      id: a.id,
      name: a.name.trim().slice(0, 40),
      color: typeof a.color === 'string' && COLOR.test(a.color) ? a.color : '#5a6275',
      ...(typeof a.avatar === 'string' && AVATAR.test(a.avatar) ? { avatar: a.avatar } : {}),
    })
  }
  return out.length ? out : null
}

/** Same agents, same order, same names and pictures: nothing to re-render. */
export function sameRoster(a: Agent[], b: Agent[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.color === b[i].color && x.avatar === b[i].avatar)
}

/**
 * The tiles the driving layout shows: the `n` most recent agents, with the selected one always on screen (it takes
 * the last slot when it is further down the list), so the hero, the spoken name and a lit tile always agree.
 */
export function driveTiles(agents: Agent[], selectedId: string | undefined, n: number, alsoId?: string): Agent[] {
  // The most recent n, always including the selected agent and the one whose reply is playing (it must be on
  // screen to show the cue); they take the last slots so the order of the rest is kept.
  const size = Math.max(1, n)
  const musts = [selectedId, alsoId].filter((id, i, arr): id is string => !!id && arr.indexOf(id) === i)
    .map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a).slice(0, size)
  const rest = agents.filter((a) => !musts.includes(a))
  const out = agents.slice(0, size)
  if (musts.every((m) => out.includes(m))) return out
  const keep = rest.slice(0, size - musts.length)
  return agents.filter((a) => keep.includes(a) || musts.includes(a)).slice(0, size)
}

/** Wheel next/prev over the whole list (wrapping); with nothing selected, next starts at the top. */
export function step(agents: Agent[], selectedId: string | undefined, dir: 1 | -1): Agent | undefined {
  const n = agents.length
  if (!n) return undefined
  const i = selectedId ? agents.findIndex((a) => a.id === selectedId) : -1
  return agents[i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n]
}

// How old the list is. The pad keeps the last good roster across cold starts, so without this a roster of any age was
// shown as if it were current. generated_at is the server's own stamp; "failed" is the last fetch not producing a roster.
// This is the age of the LIST, never a claim that any agent is up: the roster says who a memo can be routed to.
export const ROSTER_STALE_MS = 15 * 60 * 1000
export type RosterMeta = { generatedAt: number | null; failed: boolean }
export type Staleness = { why: 'failed' | 'old'; ageMs: number | null }

/** roster.json's generated_at as epoch ms (parsed or raw JSON), or null when absent or unreadable. */
export function rosterGeneratedAt(raw: unknown): number | null {
  let o = raw
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  const g = (o as { generated_at?: unknown } | null)?.generated_at
  const t = typeof g === 'string' ? Date.parse(g) : NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Null while the list can be trusted, else why not. A list with no stamp that has not failed is not flagged: it is
 * either still loading or from before the stamp was kept, and a fresh fetch replaces it within two minutes.
 */
export function rosterStaleness(m: RosterMeta, now: number): Staleness | null {
  const ageMs = m.generatedAt === null ? null : Math.max(0, now - m.generatedAt)
  if (m.failed) return { why: 'failed', ageMs }
  return ageMs !== null && ageMs > ROSTER_STALE_MS ? { why: 'old', ageMs } : null
}

export function ageText(ms: number | null): string {
  if (ms === null) return 'age unknown'
  const min = Math.floor(ms / 60000)
  if (min < 60) return `updated ${Math.max(1, min)} min ago`
  const h = Math.floor(min / 60)
  return h < 48 ? `updated ${h} h ago` : `updated ${Math.floor(h / 24)} days ago`
}

/** Parked: the status line. Driving (short): a few big words, no age. */
export function stalenessText(s: Staleness, short = false): string {
  if (short) return s.why === 'failed' ? 'List not refreshing' : 'List may be out of date'
  return s.why === 'failed' ? `Agent list could not refresh (${ageText(s.ageMs)})` : `Agent list may be out of date (${ageText(s.ageMs)})`
}

// The selected agent is kept across cold starts the same way (IndexedDB). It comes back as a selection only: nothing
// records until a button is pressed. A saved agent the roster no longer lists is dropped, but only on a roster the
// server just answered: a cached or built-in list that merely lacks it proves nothing.
export function savedAgentId(raw: unknown): string {
  return typeof raw === 'string' && ID.test(raw) ? raw : ''
}
export function restoreSelection(agents: Agent[], savedId: string, authoritative: boolean): { pick: Agent | null; drop: boolean } {
  if (!savedId) return { pick: null, drop: false }
  const pick = agents.find((a) => a.id === savedId) ?? null
  return { pick, drop: !pick && authoritative }
}

// A tile whose picture failed to load tries again after these delays (a cold start in the car on a flaky link must
// not leave letter tiles for the whole drive), then gives up and keeps the letter.
export const AVATAR_RETRY_MS = [15_000, 60_000, 240_000]
export function avatarRetryDelay(failures: number): number | null {
  return failures >= 1 && failures <= AVATAR_RETRY_MS.length ? AVATAR_RETRY_MS[failures - 1] : null
}

// Which agent a reply belongs to: the watcher names reply objects replies/YYYY/MM/DD/HHMMSSZ-<agent>-<memo uuid>.ogg.
const REPLY_NAME = /^\d{6}Z-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/
export function replyAgent(key: string): string | null {
  const m = REPLY_NAME.exec(key.split('/').pop() || '')
  return m ? m[1] : null
}

// How often to look for replies: fast while one is due (a note went out in the last few minutes), slow otherwise.
// The listing is one small anonymous S3 request, so 2 s costs little and takes up to 13 s off every round trip.
export const REPLY_POLL_FAST_MS = 2000
export const REPLY_POLL_IDLE_MS = 15000
export const REPLY_DUE_WINDOW_MS = 10 * 60 * 1000
export function replyPollMs(lastSentAt: number, now: number): number {
  return lastSentAt > 0 && now - lastSentAt < REPLY_DUE_WINDOW_MS ? REPLY_POLL_FAST_MS : REPLY_POLL_IDLE_MS
}

// The reply now playing, for the tile cue and the hero. One small state machine so every path that ends a reply
// (finished, failed, cut off by a note, a host that went silent) clears it, and a replay sets it again.
export type Speaking = { key: string; agent: string } | null
export type SpeakEvent = { t: 'started'; key: string } | { t: 'ended' | 'failed'; key: string } | { t: 'interrupted' | 'watchdog' }
export function speakNext(cur: Speaking, ev: SpeakEvent): Speaking {
  switch (ev.t) {
    case 'started': return { key: ev.key, agent: replyAgent(ev.key) || '' }
    case 'ended': case 'failed': return cur && cur.key !== ev.key ? cur : null
    default: return null
  }
}

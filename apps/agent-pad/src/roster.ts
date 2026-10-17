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
export function driveTiles(agents: Agent[], selectedId: string | undefined, n: number): Agent[] {
  const top = agents.slice(0, Math.max(1, n))
  if (!selectedId || top.some((a) => a.id === selectedId)) return top
  const sel = agents.find((a) => a.id === selectedId)
  return sel ? [...top.slice(0, top.length - 1), sel] : top
}

/** Wheel next/prev over the whole list (wrapping); with nothing selected, next starts at the top. */
export function step(agents: Agent[], selectedId: string | undefined, dir: 1 | -1): Agent | undefined {
  const n = agents.length
  if (!n) return undefined
  const i = selectedId ? agents.findIndex((a) => a.id === selectedId) : -1
  return agents[i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n]
}

// The watcher's per-memo status object (status/<yyyy>/<mm>/<dd>/<memo_id>.json in the holocene-auto bucket) and the
// progress narration clips beside it (progress/<yyyy>/<mm>/<dd>/<memo_id>-<seq>.ogg). Pure, so the parsing and the
// tile wording are tested.

export type Stage = 'received' | 'transcribing' | 'heard' | 'working' | 'replying' | 'done' | 'failed'
const STAGES: Stage[] = ['received', 'transcribing', 'heard', 'working', 'replying', 'done', 'failed']
/**
 * The fast in-car conversation desk's turn (the watcher's converse stage), when it decided this memo: the session id, the
 * turn, the action (reply | propose | confirm | cancel | end, spoken by the desk itself; direct: the agent path) and the
 * reply key of the desk's own answer (replies/<day>/<HHMMSS>Z-<agent>-<memo_id>.ogg), so the pad knows which reply is a
 * fast-turn answer. Absent on a watcher from before the desk, or a memo it did not decide.
 */
export type Conv = { sid: string; turn: number | null; action: string; reply_key: string; draft_title: string }
export type MemoStatus = {
  memo_id: string
  stage: Stage
  heard: string
  progress: string
  progress_seq: number
  /** Optional: the newest seq that has a clip (progress/...-<seq>.ogg). Absent: every progress_seq may have one. */
  spoken_seq: number | null
  started_at: number | null
  updated_at: number | null
  elapsed_s: number | null
  error: string
  conv: Conv | null
}

const MEMO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const validMemoId = (id: string) => MEMO.test(id)

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(t) ? t : null
}

/** The conv block of a status object, or null: it needs a session id and an action; everything else is optional. */
export function normConv(raw: unknown): Conv | null {
  const c = raw as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const sid = str(c.sid, 80)
  const action = str(c.action, 20)
  if (!sid || !action) return null
  const turn = num(c.turn)
  return { sid, turn: turn !== null && turn >= 0 ? Math.floor(turn) : null, action, reply_key: str(c.reply_key, 300), draft_title: str(c.draft_title, 160) }
}

/** A status object we can trust, or null. An unknown stage is not guessed at. */
export function normStatus(raw: unknown, memoId: string): MemoStatus | null {
  let o = raw
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return null }
  }
  const s = o as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return null
  if (typeof s.memo_id === 'string' && s.memo_id !== memoId) return null
  const stage = STAGES.find((x) => x === s.stage)
  if (!stage) return null
  const seq = num(s.progress_seq)
  return {
    memo_id: memoId,
    stage,
    heard: str(s.heard, 200),
    progress: str(s.progress, 500),
    progress_seq: seq !== null && seq > 0 ? Math.floor(seq) : 0,
    spoken_seq: num(s.spoken_seq),
    started_at: time(s.started_at),
    updated_at: time(s.updated_at),
    elapsed_s: num(s.elapsed_s),
    error: str(s.error, 200),
    conv: normConv(s.conv),
  }
}

export const isFinal = (s: Stage) => s === 'replying' || s === 'done' || s === 'failed'

/** The UTC day folder (yyyy/mm/dd) of an inbox key: inbox/<agent>/<yyyy>/<mm>/<dd>/<stamp>.<ext>. */
export function keyDay(key: string): string | null {
  const m = /^inbox\/[^/]+\/(\d{4}\/\d{2}\/\d{2})\//.exec(key)
  return m ? m[1] : null
}

export const statusKey = (day: string, memoId: string) => `status/${day}/${memoId}.json`
export const progressPrefix = (day: string, memoId: string) => `progress/${day}/${memoId}-`

/** The newest progress clip after `playedSeq` among listed keys, or null. Only <memo>-<seq>.<audio ext> counts. */
export function newestProgress(keys: string[], day: string, memoId: string, playedSeq: number): { key: string; seq: number } | null {
  const prefix = progressPrefix(day, memoId)
  let best: { key: string; seq: number } | null = null
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue
    const m = /^(\d{1,6})\.(ogg|opus|mp3|m4a|webm|wav)$/.exec(k.slice(prefix.length))
    if (!m) continue
    const seq = Number(m[1])
    if (seq > playedSeq && (!best || seq > best.seq)) best = { key: k, seq }
  }
  return best
}

export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Shorten at a word boundary, with an ellipsis when cut. */
export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (max <= 0 || t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * Seconds the memo has been in flight: the watcher's own elapsed_s advanced by how long ago we read it (so a skewed
 * head-unit clock does not matter), else from started_at, else from when it was sent.
 */
export function elapsedSeconds(s: MemoStatus | null, fetchedAt: number, sentAt: number, now: number): number {
  if (s && s.elapsed_s !== null) return s.elapsed_s + Math.max(0, now - fetchedAt) / 1000
  if (s && s.started_at !== null) return Math.max(0, now - s.started_at) / 1000
  return Math.max(0, now - sentAt) / 1000
}

/**
 * The one static line on the target agent's tile: "Working 1:20 · reading the build log". Null once the memo is done
 * (the reply speaks for itself). `maxProgress` 0 leaves the narration out (driving with text restricted).
 */
export function statusLine(s: MemoStatus | null, elapsed: number, maxProgress: number): string | null {
  const clock = clockText(elapsed)
  if (!s) return `Sent ${clock}`
  switch (s.stage) {
    case 'received': return `Sent ${clock}`
    case 'transcribing': return `Transcribing ${clock}`
    case 'replying': return `Replying ${clock}`
    case 'done': return null
    case 'failed': return 'Failed'
    default: {
      const p = maxProgress > 0 && s.progress ? shorten(s.progress, maxProgress) : ''
      return p ? `Working ${clock} · ${p}` : `Working ${clock}`
    }
  }
}

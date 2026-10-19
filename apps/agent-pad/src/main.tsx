import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { durableGet, durableSet } from './durable'
import { type Capture, meter01, normCapture, round1, silenceAction, toDb } from './capture'
import { InFlight, replyExt, stripDataUrl } from './flight'
import { type Agent, ROSTER_URL, avatarRetryDelay, driveTiles, normRoster, sameRoster, step } from './roster'

// First-start fallback only: the live list is the roster (see roster.ts), cached across cold starts.
const FALLBACK_AGENTS: Agent[] = [
  { id: '33god-pm', name: 'Grolf', color: '#4f8cff' },
  { id: 'holocene-pm', name: 'Holocene', color: '#9b59b6' },
  { id: 'client-portal-pm', name: 'Client Portal', color: '#e67e22' },
  { id: 'heyma-pm', name: 'HeyMa', color: '#2ecc71' },
  { id: 'bloodbank-pm', name: 'Bloodbank', color: '#e74c3c' },
]

const BUCKET_BASE = 'https://s3.delo.sh/holocene-auto'
const INBOX_PREFIX = 'inbox'
const REPLIES_PREFIX = 'replies'

function dayPrefix(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}

function todayPrefix(): string {
  return dayPrefix(0)
}

function ts(): string {
  const d = new Date()
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
}

// ---- storage helpers: every read/write is wrapped, the pad must work with storage blocked ----
const LS_LAST_DONE = 'agentpad.lastDoneReply'
const LS_EVENTS = 'agentpad.pendingEvents'
function lsGet(k: string): string {
  try { return localStorage.getItem(k) || '' } catch { return '' }
}
// The last-played-reply marker lives in the host's SharedPreferences when there is one (localStorage is wiped by a cold start).
function safeLs(): Storage | undefined {
  try { return localStorage } catch { return undefined }
}
const markerGet = () => durableGet(LS_LAST_DONE, (window as any).HoloceneNative, safeLs())
const markerSet = (v: string) => durableSet(LS_LAST_DONE, v, (window as any).HoloceneNative, safeLs())
function lsSet(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* storage blocked */ }
}

// Browser-side level reader for the getUserMedia path (a normal browser, or the WebView fallback).
function startAnalyser(stream: MediaStream, onLevel: (l: number) => void): { stop(): Capture | undefined } | null {
  const AC = window.AudioContext || (window as any).webkitAudioContext
  if (!AC) return null
  try {
    const ctx: AudioContext = new AC()
    void ctx.resume?.()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    src.connect(an) // deliberately not to the destination: no speaker feedback
    const buf = new Float32Array(an.fftSize)
    let peak = 0, sumSq = 0, n = 0, polls = 0
    const t = window.setInterval(() => {
      an.getFloatTimeDomainData(buf)
      let p = 0
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; if (Math.abs(v) > p) p = Math.abs(v); sumSq += v * v }
      n += buf.length
      polls++
      if (p > peak) peak = p
      onLevel(meter01(toDb(p)))
    }, 50)
    return {
      stop() {
        window.clearInterval(t)
        const running = ctx.state === 'running' // a suspended context reads all zeros: that is "unknown", not "silent"
        try { src.disconnect(); void ctx.close() } catch { /* already closed */ }
        if (!running || polls === 0) return undefined
        return { peak_dbfs: round1(toDb(peak)), rms_dbfs: round1(toDb(Math.sqrt(sumSq / Math.max(1, n)))), samples: polls, source: 'analyser' }
      },
    }
  } catch {
    return null
  }
}

// ---- memo id: the same uuid5(URL, "s3://holocene-auto/<key>") the proxy and the watcher derive ----
async function memoIdFor(key: string): Promise<string | null> {
  try {
    const ns = '6ba7b8119dad11d180b400c04fd430c8'.match(/../g)!.map((h) => parseInt(h, 16))
    const name = new TextEncoder().encode(`s3://holocene-auto/${key}`)
    const buf = new Uint8Array(ns.length + name.length)
    buf.set(ns, 0)
    buf.set(name, ns.length)
    const h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf)).slice(0, 16)
    h[6] = (h[6] & 0x0f) | 0x50
    h[8] = (h[8] & 0x3f) | 0x80
    const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
  } catch {
    return null
  }
}

type ListPage = { keys: string[]; next: string | null }
async function listPage(prefix: string, startAfter: string, token: string | null): Promise<ListPage> {
  let url = `${BUCKET_BASE}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
  if (token) url += `&continuation-token=${encodeURIComponent(token)}`
  else if (startAfter) url += `&start-after=${encodeURIComponent(startAfter)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`LIST ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
  const keys = Array.from(doc.querySelectorAll('Contents > Key')).map((k) => k.textContent || '')
  const trunc = doc.querySelector('IsTruncated')?.textContent === 'true'
  return { keys, next: trunc ? doc.querySelector('NextContinuationToken')?.textContent || null : null }
}

// Every reply key after `startAfter`, in order. S3 lists ascending, so paging (not a max-keys cap)
// is what keeps the newest replies visible after a busy day.
async function listRepliesAfter(startAfter: string): Promise<string[]> {
  const out: string[] = []
  let token: string | null = null
  for (let page = 0; page < 5; page++) {
    const r: ListPage = await listPage(`${REPLIES_PREFIX}/`, startAfter, token)
    out.push(...r.keys)
    if (!r.next) break
    token = r.next
  }
  return out
}

async function putObject(key: string, blob: Blob, capture?: Capture): Promise<void> {
  // Upload via the proxy (same origin) so credentials stay server-side
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 90000)
  try {
    const res = await fetch(`/upload/${key}`, {
      method: 'PUT',
      body: blob,
      // The capture levels ride along as a header; the proxy puts them in audio.memo.uploaded data.capture.
      headers: { 'Content-Type': blob.type || 'application/octet-stream', ...(capture ? { 'X-Holocene-Capture': JSON.stringify(capture) } : {}) },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

async function getBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
  return res.blob()
}

// ---- upload outbox (IndexedDB): a recording that could not be sent is KEPT and retried ----
type Pending = { key: string; agentName: string; blob: Blob; attempts: number; at: number; capture?: Capture }
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('agentpad', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('uploads', { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await idb()
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction('uploads', mode).objectStore('uploads'))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  } catch {
    return null
  }
}
const outboxPut = (p: Pending) => idbRun('readwrite', (s) => s.put(p))
const outboxAll = async () => ((await idbRun<Pending[]>('readonly', (s) => s.getAll() as IDBRequest<Pending[]>)) || [])
const outboxDel = (key: string) => idbRun('readwrite', (s) => s.delete(key))

// The last good roster, in its own database (never in the outbox's store, which is read whole as pending uploads).
// IndexedDB is what survives a cold start in the car: localStorage is emptied and the native prefs take one key.
function rosterDb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('agentpad-roster', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onerror = () => resolve(null)
      req.onsuccess = () => {
        try {
          const r = fn(req.result.transaction('kv', mode).objectStore('kv'))
          r.onsuccess = () => resolve(r.result)
          r.onerror = () => resolve(null)
        } catch { resolve(null) }
      }
    } catch { resolve(null) }
  })
}
const rosterDbGet = async () => normRoster(await rosterDb<unknown>('readonly', (s) => s.get('roster')))
const rosterDbSet = (list: Agent[]) => rosterDb('readwrite', (s) => s.put({ agents: list }, 'roster'))

// ---- client events: what only the device can see (record start/stop/failure, upload failure) ----
// The proxy logs each one; failures also become audio.memo.failed(stage record|upload) facts keyed by the
// key the memo would have had, so a memo that never reached S3 still shows up in memo:trace and /voice.
type ClientEvent = { event: string; key: string; error?: string; code?: string; bytes?: number; duration_ms?: number; attempts?: number; retryable?: boolean; capture?: Capture }
function postEvent(ev: ClientEvent): Promise<boolean> {
  return fetch('/upload/client-event', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
  }).then((r) => r.ok || r.status === 202, () => false)
}
function clientEvent(ev: ClientEvent) {
  void postEvent(ev).then((ok) => {
    if (ok) return
    // network is down: keep the event and send it when it is back
    try {
      const q = JSON.parse(lsGet(LS_EVENTS) || '[]') as ClientEvent[]
      q.push(ev)
      lsSet(LS_EVENTS, JSON.stringify(q.slice(-50)))
    } catch { /* ignore */ }
  })
}
async function flushEvents() {
  let q: ClientEvent[] = []
  try { q = JSON.parse(lsGet(LS_EVENTS) || '[]') } catch { q = [] }
  if (!q.length) return
  const left: ClientEvent[] = []
  for (const ev of q) if (!(await postEvent(ev))) left.push(ev)
  lsSet(LS_EVENTS, JSON.stringify(left))
}

// Playback beacon: the pad is the only place that knows whether the driver was actually spoken to.
// The upload proxy logs it and publishes bloodbank.audio.memo.played / failed(stage=playback).
// Fire and forget: a failed beacon must never affect playback.
type Phase = 'started' | 'ended' | 'blocked' | 'error' | 'skipped'
function beacon(replyKey: string, phase: Phase, extra: { seconds?: number; error?: string } = {}) {
  try {
    fetch('/upload/played', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply_key: replyKey, phase, ...extra }),
    }).catch(() => {})
  } catch {
    // ignore
  }
}

const REPLY_STAMP = /(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})Z/
const MAX_REPLY_AGE_MS = 30 * 60 * 1000 // a reply older than this is stale news for a driver
function renderedAt(key: string): number {
  const m = key.match(REPLY_STAMP)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0
}

// ---- host bridge (Holocene Auto app): layout flag, steering-wheel control, spoken feedback ----
// The page stays the single source of truth for selection and recording. The Android host drives it through
// window.__hnControl({action}) (wheel / rotary) and learns what happened through HoloceneNative.padEvent(json),
// which it speaks ("Holocene", "Recording for Holocene", "Sent to Holocene"). Every call is feature-detected:
// in a normal browser or an old host nothing here does anything.
type HostInfo = { driving: boolean; noVideo: boolean; noText: boolean; maxLabel: number; maxItems: number }
const PARKED_HOST: HostInfo = { driving: false, noVideo: false, noText: false, maxLabel: 0, maxItems: 0 }
function normHost(h: unknown): HostInfo {
  const o = (h || {}) as Partial<HostInfo>
  return {
    driving: !!o.driving, noVideo: !!o.noVideo, noText: !!o.noText,
    maxLabel: typeof o.maxLabel === 'number' ? o.maxLabel : 0,
    maxItems: typeof o.maxItems === 'number' ? o.maxItems : 0,
  }
}
function readHost(): HostInfo {
  try {
    const raw = (window as any).HoloceneNative?.hostState?.()
    if (raw) return normHost(JSON.parse(raw))
  } catch { /* old host or bad json */ }
  try {
    // ?driving=1 previews the driving layout in a normal browser.
    if (new URLSearchParams(location.search).get('driving') === '1') return { driving: true, noVideo: true, noText: true, maxLabel: 0, maxItems: 0 }
  } catch { /* no location */ }
  return PARKED_HOST
}
type PadEventMsg = { t: string; id?: string; name?: string; reason?: string }
function emitHost(e: PadEventMsg) {
  try { (window as any).HoloceneNative?.padEvent?.(JSON.stringify(e)) } catch { /* host bridge absent */ }
}
// Replies play through the host's native player (assistant speech, transient may-duck focus) when it has one: the
// WebView <audio> element takes permanent music focus, which stops the car radio and may never give it back.
type NativeReply = { playReply(id: string, b64: string, ext: string): void; stopReply?(): void }
function nativeReply(): NativeReply | null {
  const n = (window as any).HoloceneNative
  return n && typeof n.playReply === 'function' ? (n as NativeReply) : null
}
function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(stripDataUrl(String(r.result)))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}
type PadPhase = 'idle' | 'arming' | 'recording' | 'sending' | 'sent' | 'queued' | 'silent' | 'cancelled' | 'error'
const PHASE_LABEL: Record<PadPhase, string> = {
  idle: 'READY', arming: 'STARTING', recording: 'RECORDING', sending: 'SENDING', sent: 'SENT',
  queued: 'SAVED, RETRYING', silent: 'NO SOUND, NOT SENT', cancelled: 'CANCELLED', error: 'MIC ERROR',
}
const LS_AGENT = 'agentpad.agent'
const LS_ROSTER = 'agentpad.roster'
const ROSTER_POLL_MS = 120_000
const DRIVE_TILES = 5 // the driving layout's one row of big tiles
const ROSTER_WAIT_MS = 2500 // how long a start with no cached roster waits for it before showing the fallback list
// localStorage answers synchronously (a browser keeps it); in the car a cold start empties it, so the IndexedDB copy
// (rosterDbGet) is read next, and only a first-ever start with no network waits for the fallback list.
const rosterGet = () => normRoster(lsGet(LS_ROSTER))
const rosterSet = (list: Agent[]) => { lsSet(LS_ROSTER, JSON.stringify({ agents: list })); void rosterDbSet(list) }

// The bot's Telegram picture when the roster has one (and it loads), its initial on its colour otherwise.
function Swatch({ a }: { a: Agent }) {
  const [failures, setFailures] = useState(0)
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false); setFailures(0) }, [a.avatar])
  // A failed load shows the letter, then retries on a backoff; the failure count keys the <img> so the browser
  // re-requests instead of reusing the failed element.
  useEffect(() => {
    if (!broken) return
    const wait = avatarRetryDelay(failures)
    if (wait === null) return
    const t = setTimeout(() => setBroken(false), wait)
    return () => clearTimeout(t)
  }, [broken, failures])
  return (
    <span className={`swatch${a.avatar && !broken ? ' pic' : ''}`}>
      {a.avatar && !broken
        ? <img key={failures} src={a.avatar} alt="" draggable={false} decoding="async"
            onError={() => { setFailures((f) => f + 1); setBroken(true) }} />
        : a.name.charAt(0)}
    </span>
  )
}

function App() {
  const [cachedRoster] = useState(rosterGet)
  const [agents, setAgents] = useState<Agent[]>(() => cachedRoster || FALLBACK_AGENTS)
  const [rosterReady, setRosterReady] = useState(!!cachedRoster)
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const [selected, setSelected] = useState<Agent | null>(() => agents.find((a) => a.id === lsGet(LS_AGENT)) || null)
  const [host, setHost] = useState<HostInfo>(readHost)
  const drivingRef = useRef(host.driving) // read when a recording ends: the car may have started moving mid-note
  drivingRef.current = host.driving
  const [phase, setPhase] = useState<PadPhase>('idle')
  const arming = useRef(false)
  const discardRef = useRef(false)
  const selectedRef = useRef<Agent | null>(null)
  const recordingRef = useRef(false)
  const controlRef = useRef<(c: { action?: string; via?: string }) => void>(() => {})
  const [recording, setRecording] = useState(false)
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [memoShort, setMemoShort] = useState<string | null>(null)
  const [outboxCount, setOutboxCount] = useState(0)
  const [soundUnlocked, setSoundUnlocked] = useState(false)
  const [level, setLevel] = useState(0) // live input level 0..1 while recording
  const [meterOn, setMeterOn] = useState(false) // true once the host or the analyser reports levels
  const [heard, setHeard] = useState(false) // some sound (> -60 dBFS) arrived during this recording
  const [waited, setWaited] = useState(false) // 2 s of recording have passed
  const [silentHold, setSilentHold] = useState<{ agent: Agent; key: string; blob: Blob; capture: Capture; ms: number } | null>(null)
  const analyser = useRef<{ stop(): Capture | undefined } | null>(null)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const nativeActive = useRef(false)
  const recStart = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const unlockedRef = useRef(false)
  const stopEmitted = useRef(false) // the host heard 'stopped' for the current note
  const flight = useRef(new InFlight()).current

  // ---- playback: an ordered queue of every unseen reply, played one after the other ----
  // lastDone is the newest reply key whose playback finished, failed or was skipped. It is persisted, so a
  // restart (the car app restarts at every ignition) resumes from there instead of dropping or replaying.
  const lastDone = useRef<string>(markerGet())
  const queue = useRef<string[]>([])
  const enqueued = useRef<Set<string>>(new Set())
  const loadFails = useRef<Record<string, number>>({})
  const playingKey = useRef<string>('') // reply loaded in the audio element ('' while the silent unlock clip plays)
  const beaconsSent = useRef<Set<string>>(new Set())
  const pump = useRef<() => void>(() => {})

  const report = useCallback((phase: Phase, extra: { seconds?: number; error?: string } = {}) => {
    const key = playingKey.current
    if (!key || beaconsSent.current.has(`${key}:${phase}`)) return
    beaconsSent.current.add(`${key}:${phase}`)
    beacon(key, phase, extra)
  }, [])

  const finish = useCallback((key: string) => {
    if (key > lastDone.current) {
      lastDone.current = key
      markerSet(key)
    }
    queue.current = queue.current.filter((k) => k !== key)
    playingKey.current = ''
    pump.current()
  }, [])

  pump.current = async () => {
    const el = audioRef.current
    if (!el || playingKey.current || queue.current.length === 0) return
    // A reply must never play into the microphone: wait until the note is done.
    if (recordingRef.current || arming.current) return
    const key = queue.current[0]
    if (!unlockedRef.current) {
      if (!beaconsSent.current.has(`${key}:blocked`)) {
        beaconsSent.current.add(`${key}:blocked`)
        beacon(key, 'blocked')
      }
      setStatus('reply waiting — tap to play')
      return
    }
    playingKey.current = key // claim before any await so a second pump cannot start another reply
    try {
      const blob = await getBlob(`${BUCKET_BASE}/${key}`)
      if (recordingRef.current || arming.current) { playingKey.current = ''; return } // a note began while it downloaded
      setLastReply(key)
      const np = nativeReply()
      if (np) {
        np.playReply(key, await blobToBase64(blob), replyExt(key)) // the host answers through __hnPlayback
        return
      }
      el.src = URL.createObjectURL(blob)
      await el.play()
    } catch (e) {
      playFailed(key, `play failed: ${String((e as Error)?.message || e)}`)
    }
  }

  // A reply that could not be played: retry a couple of times, then give it up so it never blocks the queue.
  const playFailed = (key: string, text: string) => {
    const n = (loadFails.current[key] = (loadFails.current[key] || 0) + 1)
    const msg = text.replace('play failed:', `play failed (try ${n}):`).slice(0, 200)
    if (n >= 3) {
      report('error', { error: msg })
      setStatus('reply could not play')
      finish(key)
    } else {
      playingKey.current = ''
      setStatus(msg)
      window.setTimeout(() => pump.current(), 5000)
    }
  }

  // The host's native player reports back here (started / ended / error), keyed by the reply it was given.
  useEffect(() => {
    ;(window as any).__hnPlayback = (key: string, phase: string, detail: string) => {
      if (key !== playingKey.current) return // a reply we already moved on from
      if (phase === 'started') { report('started'); setStatus('playing reply') }
      else if (phase === 'ended') { report('ended', { seconds: Number(detail) || undefined }); setStatus('reply played'); finish(key) }
      else playFailed(key, `play failed: ${detail || 'host player'}`)
    }
    return () => { delete (window as any).__hnPlayback }
  })

  // Stop whatever reply is playing (a note is about to be recorded): it stays at the head of the queue and plays
  // again when the note is done.
  const interruptReply = () => {
    if (!playingKey.current) return
    try { nativeReply()?.stopReply?.() } catch { /* host bridge absent */ }
    try { audioRef.current?.pause() } catch { /* nothing playing */ }
    playingKey.current = ''
  }

  // Unlock audio on first user gesture (browser autoplay policy)
  const unlockAudio = useCallback(async () => {
    if (!audioRef.current || nativeReply()) return
    try {
      audioRef.current.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
      await audioRef.current.play()
      unlockedRef.current = true
      setSoundUnlocked(true)
      setStatus('sound on')
      pump.current()
    } catch {
      setStatus('tap again to enable sound')
    }
  }, [])

  // Silent unlock on mount: succeeds inside the Holocene Auto WebView (no gesture required),
  // fails quietly in normal browsers where the "Tap to enable sound" button stays.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    // The native player needs no autoplay unlock, and the silent clip would take (and keep) audio focus from the radio.
    if (nativeReply()) { unlockedRef.current = true; setSoundUnlocked(true); return }
    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
    el.play().then(() => { unlockedRef.current = true; setSoundUnlocked(true); setStatus('sound on') }, () => {})
  }, [])

  // Poll for replies newer than lastDone (across UTC midnight and any number of keys), queue the fresh ones in
  // order, and say so (beacon 'skipped') about any recent reply the pad chooses not to play.
  useEffect(() => {
    const tick = async () => {
      try {
        // First run on this device (nothing stored): old replies are history, not missed news. Skip them
        // silently instead of publishing a 'skipped' fact for memos that finished long ago.
        const firstRun = !lastDone.current
        const after = lastDone.current || `${REPLIES_PREFIX}/${dayPrefix(-1)}/`
        // Only dated reply keys count: legacy flat keys (replies/2026101...) sort AFTER every dated key and would
        // otherwise pin lastDone past all future replies.
        const keys = (await listRepliesAfter(after)).filter((k) => /^replies\/\d{4}\/\d{2}\/\d{2}\//.test(k) && ['.ogg', '.webm', '.m4a', '.mp3'].some((x) => k.endsWith(x)))
        for (const key of keys.sort()) {
          if (key <= lastDone.current || enqueued.current.has(key)) continue
          enqueued.current.add(key)
          const age = Date.now() - renderedAt(key)
          if (age > MAX_REPLY_AGE_MS) {
            if (!firstRun && age < 6 * 3600 * 1000) {
              beacon(key, 'skipped', { error: `stale: rendered ${Math.round(age / 60000)} min before the pad saw it` })
            }
            if (key > lastDone.current) { lastDone.current = key; markerSet(key) }
            continue
          }
          queue.current.push(key)
        }
        pump.current()
      } catch {
        // network blip, next poll
      }
    }
    const t = window.setInterval(tick, 15000)
    tick()
    return () => window.clearInterval(t)
  }, [])

  // Live level from whichever capture source is active (native host callback or browser analyser).
  const onLevel = useCallback((l: number) => {
    setMeterOn(true)
    setLevel(l)
    if (l > 0) setHeard(true)
  }, [])
  useEffect(() => {
    ;(window as any).__hnLevel = onLevel
    return () => { delete (window as any).__hnLevel }
  }, [onLevel])
  useEffect(() => {
    if (!recording) return
    setWaited(false)
    const t = window.setTimeout(() => setWaited(true), 2000)
    return () => window.clearTimeout(t)
  }, [recording])

  // ---- upload outbox: retry everything that could not be sent, on a timer and when the network returns ----
  const flushOutbox = useCallback(async () => {
    const all = flight.idle(await outboxAll()) // a recording a live send still owns is not "waiting"
    setOutboxCount(all.length)
    for (const p of all) {
      if (!flight.begin(p.key)) continue
      try {
        await putObject(p.key, p.blob, p.capture)
        await outboxDel(p.key)
        clientEvent({ event: 'upload_recovered', key: p.key, attempts: p.attempts + 1 })
        setStatus(`sent → ${p.agentName} (after a retry)`)
        emitHost({ t: 'sent', name: p.agentName })
      } catch (e) {
        await outboxPut({ ...p, attempts: p.attempts + 1 })
        void e
      } finally {
        flight.end(p.key)
      }
    }
    if (all.length) setOutboxCount(flight.idle(await outboxAll()).length)
    await flushEvents()
  }, [flight])
  useEffect(() => {
    void flushOutbox()
    const t = window.setInterval(() => void flushOutbox(), 30000)
    const on = () => void flushOutbox()
    window.addEventListener('online', on)
    return () => { window.clearInterval(t); window.removeEventListener('online', on) }
  }, [flushOutbox])

  // Send a finished recording: a few quick retries holding the blob; if the network is really gone, keep it
  // in the outbox (IndexedDB) and say so, so nothing recorded in the car is ever thrown away silently.
  const sendRecording = useCallback(async (agent: Agent, key: string, blob: Blob, capture?: Capture) => {
    if (!flight.begin(key)) return
    setPhase('sending')
    // The outbox is written BEFORE the first attempt and cleared on success: if the app is backgrounded, killed or
    // loses the network mid-send, the recording is still on disk and the retry timer finishes the job.
    await outboxPut({ key, agentName: agent.name, blob, attempts: 0, at: Date.now(), capture })
    try {
      const memo = await memoIdFor(key)
      setMemoShort(memo ? memo.slice(0, 8) : null)
      const delays = [0, 1500, 4000, 10000, 20000]
      let lastErr = ''
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) {
          setStatus(`upload failed, retrying (${i}/${delays.length - 1})…`)
          await new Promise((r) => setTimeout(r, delays[i]))
        }
        try {
          await putObject(key, blob, capture)
          await outboxDel(key)
          setStatus(`sent → ${agent.name}`)
          setPhase('sent')
          emitHost({ t: 'sent', id: agent.id, name: agent.name })
          if (i > 0) clientEvent({ event: 'upload_recovered', key, attempts: i + 1 })
          return
        } catch (e) {
          lastErr = (e as Error).message || String(e)
        }
      }
      await outboxPut({ key, agentName: agent.name, blob, attempts: delays.length, at: Date.now(), capture })
      setOutboxCount((await outboxAll()).length)
      setStatus(`NOT sent (${lastErr.replace(/^PUT \S+: /, 'HTTP ').slice(0, 40)}) - saved, retrying`)
      setPhase('queued')
      emitHost({ t: 'queued', id: agent.id, name: agent.name })
      clientEvent({ event: 'upload_failed', key, error: lastErr, attempts: delays.length, retryable: true })
    } finally {
      flight.end(key)
    }
  }, [flight])

  // A finished recording: hold it back if no sound ever reached the mic, else send it with its capture levels.
  const finishRecording = useCallback(async (agent: Agent, key: string, blob: Blob, capture: Capture | undefined, ms: number) => {
    setLevel(0)
    const action = silenceAction(capture, drivingRef.current)
    if (capture && action === 'advisory') {
      // Driving: the device's silence verdict is advisory only. Upload it and let the watcher's ffmpeg decide.
      capture = { ...capture, sent_anyway: true }
    }
    if (capture && action === 'hold') {
      setSilentHold({ agent, key, blob, capture, ms })
      setStatus('not sent')
      setPhase('silent')
      emitHost({ t: 'silent', id: agent.id, name: agent.name })
      clientEvent({ event: 'record_silent', key, bytes: blob.size, duration_ms: ms, capture, code: 'silent_capture', retryable: false,
        error: `no sound reached the microphone (peak ${capture.peak_dbfs} dBFS)` })
      return
    }
    clientEvent({ event: 'record_stopped', key, bytes: blob.size, duration_ms: ms, capture })
    await sendRecording(agent, key, blob, capture)
  }, [sendRecording])

  const sendAnyway = useCallback(async () => {
    const h = silentHold
    if (!h) return
    setSilentHold(null)
    const capture = { ...h.capture, sent_anyway: true }
    clientEvent({ event: 'record_stopped', key: h.key, bytes: h.blob.size, duration_ms: h.ms, capture })
    await sendRecording(h.agent, h.key, h.blob, capture)
  }, [silentHold, sendRecording])

  const startRecording = useCallback(async () => {
    if (!selected) return
    const agent = selected
    interruptReply()
    stopEmitted.current = false
    setMemoShort(null)
    setSilentHold(null)
    setLevel(0)
    setHeard(false)
    setMeterOn(false)
    // One key per recording, minted at the button press, so every device-side event and the upload share it.
    const mk = (ext: string) => `${INBOX_PREFIX}/${agent.id}/${todayPrefix()}/${ts()}.${ext}`
    // Inside the Holocene Auto app the WebView's own mic capture is unreliable on car audio stacks,
    // so the host injects a native recorder. Same upload path, different capture source.
    const native = (window as any).HoloceneNative as { start(): void; startFor?(name: string): void; stop(): void; micClosed?(): void } | undefined
    if (native) {
      const key = mk('ogg')
      const w = window as any
      arming.current = true
      discardRef.current = false
      setPhase('arming')
      const started = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        w.__hnStarted = (ok: boolean, err: string) => resolve({ ok, err })
        // startFor names the agent so the host can say "Recording for X" before the mic opens (never recorded).
        if (native.startFor) native.startFor(agent.name)
        else native.start()
      })
      arming.current = false
      if (!started.ok) {
        setPhase(started.err === 'interrupted' ? 'idle' : 'error')
        if (started.err !== 'interrupted') emitHost({ t: 'failed', reason: started.err || 'mic' })
        setStatus(`mic unavailable: ${started.err || 'unknown'}`)
        clientEvent({ event: 'record_failed', key, error: `native recorder start failed: ${started.err || 'unknown'}`, code: 'mic_unavailable', retryable: false })
        return
      }
      nativeActive.current = true
      recStart.current = Date.now()
      clientEvent({ event: 'record_started', key })
      w.__hnStopped = async (b64: string, mime: string, cap?: unknown) => {
        nativeActive.current = false
        setRecording(false)
        noteEnded(agent)
        const ms = Date.now() - recStart.current
        if (discardRef.current) {
          discardRef.current = false
          setPhase('cancelled')
          setStatus('cancelled')
          return
        }
        if (!b64) {
          setStatus('no audio captured')
          clientEvent({ event: 'record_failed', key, error: 'native recorder returned no audio', code: 'empty_capture', duration_ms: ms, retryable: false, capture: normCapture(cap, 'native') })
          return
        }
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: mime })
        // Old hosts pass no capture summary: unknown levels are never treated as silence.
        await finishRecording(agent, key, blob, normCapture(cap, 'native'), ms)
      }
      setRecording(true)
      setPhase('recording')
      emitHost({ t: 'recording', id: agent.id, name: agent.name })
      setStatus(`🔴 recording for ${agent.name}… tap Stop to send`)
      return
    }
    let stream: MediaStream
    const kBrowser = mk('webm')
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setStatus(`mic unavailable: ${(e as Error).name}`)
      clientEvent({ event: 'record_failed', key: kBrowser, error: `getUserMedia: ${(e as Error).name}`, code: 'mic_unavailable', retryable: false })
      return
    }
    // Tell the Android host when the stream closes so it knows no mic is open (no-op in a browser).
    const closeStream = () => {
      stream.getTracks().forEach((t) => t.stop())
      try { (window as any).HoloceneNative?.micClosed?.() } catch { /* host bridge absent */ }
    }
    // Chrome/Android support webm; Safari supports mp4. Pick the first that works.
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    let mimeType = ''
    for (const t of mimeTypes) {
      if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break }
    }
    if (!mimeType) {
      setStatus('no supported audio format on this browser')
      clientEvent({ event: 'record_failed', key: kBrowser, error: 'no supported MediaRecorder mime type', code: 'no_format', retryable: false })
      closeStream()
      return
    }
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const key = mk(ext)
    const mr = new MediaRecorder(stream, { mimeType })
    mediaRecorder.current = mr
    chunks.current = []
    recStart.current = Date.now()
    clientEvent({ event: 'record_started', key })
    analyser.current = startAnalyser(stream, onLevel)
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(chunks.current, { type: mimeType })
      const capture = analyser.current?.stop()
      analyser.current = null
      closeStream()
      setRecording(false)
      noteEnded(agent)
      if (discardRef.current) {
        discardRef.current = false
        setPhase('cancelled')
        setStatus('cancelled')
        return
      }
      if (blob.size === 0) {
        setStatus('no audio captured')
        clientEvent({ event: 'record_failed', key, error: 'MediaRecorder produced 0 bytes', code: 'empty_capture', retryable: false })
        return
      }
      await finishRecording(agent, key, blob, capture, Date.now() - recStart.current)
    }
    discardRef.current = false
    mr.start()
    setRecording(true)
    setPhase('recording')
    emitHost({ t: 'recording', id: agent.id, name: agent.name })
    setStatus(`🔴 recording for ${agent.name}… tap Stop to send`)
  }, [selected, finishRecording, onLevel])

  // The note ended without the driver asking (max length, or the app was backgrounded mid-note): the host never
  // heard 'stopped', so its recording lock would stay on. Tell it once.
  const noteEnded = (agent: Agent) => {
    if (stopEmitted.current) return
    stopEmitted.current = true
    emitHost({ t: 'stopped', id: agent.id, name: agent.name, reason: 'auto' })
  }

  const stopRecording = useCallback(() => {
    stopEmitted.current = true
    emitHost({ t: 'stopped', name: selectedRef.current?.name })
    if (nativeActive.current) { (window as any).HoloceneNative.stop(); return }
    mediaRecorder.current?.stop()
  }, [])

  // Throw the note away (wheel: hold play/pause, or the stop key). Goes through the normal stop path, which drops it.
  const cancelRecording = useCallback(() => {
    discardRef.current = true
    stopEmitted.current = true
    emitHost({ t: 'cancelled', name: selectedRef.current?.name })
    if (nativeActive.current) { (window as any).HoloceneNative.stop(); return }
    mediaRecorder.current?.stop()
  }, [])

  // The one place a choice of agent is made (tile tap or wheel); the host hears it and says the name.
  const chooseAgent = useCallback((a: Agent) => {
    // The memo goes to the agent snapshotted at record start: a tap while the mic is opening or open must not
    // change what the screen and the host say.
    if (recordingRef.current || arming.current) return
    setSelected(a)
    lsSet(LS_AGENT, a.id)
    if (phase !== 'idle') setPhase('idle')
    emitHost({ t: 'selected', id: a.id, name: a.name })
  }, [phase])

  // Wheel / rotary / media-key control. Switching agent while recording is refused: the target is snapshotted at
  // record start, and a spoken name that does not match the memo would be worse than no switch.
  controlRef.current = (c) => {
    const a = c.action
    if (a === 'select_next' || a === 'select_prev') {
      if (recordingRef.current || arming.current) { emitHost({ t: 'refused', reason: 'recording' }); return }
      const next = step(agentsRef.current, selectedRef.current?.id, a === 'select_next' ? 1 : -1)
      if (next) chooseAgent(next)
    } else if (a === 'toggle_record') {
      if (recordingRef.current) stopRecording()
      else if (arming.current) return
      else if (!selectedRef.current) emitHost({ t: 'refused', reason: 'no_agent' })
      else void startRecording()
    } else if (a === 'cancel') {
      if (recordingRef.current) cancelRecording()
    } else if (a === 'stop') {
      // The app was backgrounded mid-note: finish and send it (never start one).
      if (recordingRef.current) stopRecording()
    }
  }
  useEffect(() => {
    const w = window as any
    w.__hnControl = (c: { action?: string; via?: string }) => controlRef.current(c)
    w.__hnHost = (h: unknown) => setHost(normHost(h))
    return () => { delete w.__hnControl; delete w.__hnHost }
  }, [])

  // ---- roster: refreshed on start, every 2 minutes and on return to the foreground. A new order is applied only
  // between notes: the memo target is snapshotted at record start and the tiles must not move under a finger mid-note.
  const pendingRoster = useRef<{ list: Agent[]; cached?: boolean } | null>(null)
  const rosterSeen = useRef(false) // a fetched roster has been applied: a late cache read must not undo it
  const applyRoster = useCallback(() => {
    const p = pendingRoster.current
    if (!p || recordingRef.current || arming.current) return
    pendingRoster.current = null
    if (p.cached && rosterSeen.current) return
    if (!p.cached) { rosterSeen.current = true; rosterSet(p.list) }
    setRosterReady(true)
    if (sameRoster(agentsRef.current, p.list)) return
    setAgents(p.list)
    // The selected agent keeps its selection with its new name and picture; one that left the roster stays
    // selected (its memos still route until the registry says otherwise), it is just no longer listed.
    setSelected((s) => (s ? p.list.find((x) => x.id === s.id) ?? s : p.list.find((x) => x.id === lsGet(LS_AGENT)) ?? null))
  }, [])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(ROSTER_URL, { cache: 'no-cache' })
        if (!r.ok) return
        const list = normRoster(await r.text())
        if (!alive || !list) return
        pendingRoster.current = { list }
        applyRoster()
      } catch { /* offline: keep the cached roster */ }
    }
    void rosterDbGet().then((list) => {
      // A fetched roster that already landed wins over the cached one.
      if (!alive || !list || pendingRoster.current || rosterSeen.current) return
      pendingRoster.current = { list, cached: true }
      applyRoster()
    })
    void load()
    const wait = window.setTimeout(() => setRosterReady(true), ROSTER_WAIT_MS)
    const t = window.setInterval(load, ROSTER_POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; window.clearTimeout(wait); window.clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [applyRoster])
  useEffect(() => {
    if (!recording && phase !== 'arming') applyRoster()
  }, [recording, phase, applyRoster])

  // Parked, the tiles scroll: keep the lit one in view when the wheel or a roster update moves it.
  const tilesRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (host.driving || !selected) return
    const el = tilesRef.current?.querySelector<HTMLElement>(`[data-agent="${selected.id}"]`)
    try { el?.scrollIntoView({ block: 'nearest' }) } catch { /* old WebView */ }
  }, [selected?.id, agents, host.driving, rosterReady])

  selectedRef.current = selected
  recordingRef.current = recording
  // A reply that waited for the note to finish (or a retry that was gated) plays once the mic is closed.
  useEffect(() => {
    if (!recording && phase !== 'arming') pump.current()
  }, [recording, phase])
  const canRecord = !!selected
  const label = (n: string) => (host.maxLabel > 0 && n.length > host.maxLabel ? n.slice(0, host.maxLabel) : n)
  const statusText = recording ? `Recording for ${selected?.name ?? ''}…` : status
  const tiles = !rosterReady ? [] : host.driving ? driveTiles(agents, selected?.id, host.maxItems > 0 ? Math.min(DRIVE_TILES, host.maxItems) : DRIVE_TILES) : agents

  return (
    <div className={`pad${host.driving ? ' drive' : ''}${host.noVideo || host.driving ? ' still' : ''}`}>
      <style>{CSS}</style>
      {host.driving && (
        <div className="hero" data-phase={phase} style={{ ['--c' as string]: selected?.color ?? '#5a6275' }} aria-live="polite">
          <div className="hname">{selected ? label(selected.name) : 'Pick an agent'}</div>
          <div className="hstate">{PHASE_LABEL[phase]}</div>
          {recording && <div className="hsound">{heard ? 'Sound heard' : waited ? 'No sound yet' : ''}</div>}
        </div>
      )}
      {!soundUnlocked && !host.driving && (
        <button className="unlock" onClick={unlockAudio}>
          🔊 Tap to enable sound
        </button>
      )}
      <div className="tiles" role="radiogroup" aria-label="Agent" ref={tilesRef}>
        {tiles.map((a) => {
          const on = selected?.id === a.id
          return (
            <button
              key={a.id}
              data-agent={a.id}
              role="radio"
              aria-checked={on}
              className={`tile${on ? ' on' : ''}`}
              disabled={(recording || phase === 'arming') && !on}
              onClick={() => chooseAgent(a)}
              style={{ ['--c' as string]: a.color }}
            >
              <Swatch a={a} />
              <span className="name">{label(a.name)}</span>
              {on && <span className="check" aria-hidden="true">✓</span>}
            </button>
          )
        })}
      </div>
      {recording && meterOn && !host.noVideo && !host.driving && (
        <div className={`meterwrap${waited && !heard ? ' dead' : ''}`}>
          <div
            className="meter"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={Number(level.toFixed(2))}
          >
            <div className="fill" style={{ width: `${Math.round(level * 100)}%`, background: level > 0.85 ? '#e74c3c' : level > 0.65 ? '#f1c40f' : '#2ecc71' }} />
          </div>
          <div className="mlabel">{waited && !heard ? 'No sound yet — speak up or check the mic' : 'Mic level'}</div>
        </div>
      )}
      {silentHold && !host.driving && (
        <div className="silent" role="alert">
          <strong>No sound reached the microphone — nothing to send</strong>
          <span>The recording is digital silence (peak {silentHold.capture.peak_dbfs} dBFS). Check the mic, then record again.</span>
          <button className="linkbtn" onClick={() => void sendAnyway()}>send anyway</button>
        </div>
      )}
      <div className="bar">
        <button
          className={`rec${recording ? ' live' : ''}`}
          onClick={recording ? stopRecording : startRecording}
          disabled={!canRecord}
          style={{ ['--c' as string]: selected?.color ?? '#444' }}
        >
          {recording && <span className="dot" />}
          {recording ? 'Stop & Send' : selected ? `Record for ${label(selected.name)}` : 'Pick an agent'}
        </button>
        <div className="status" aria-live="polite">
          {statusText}
          {outboxCount > 0 && <small className="warn">{outboxCount} recording{outboxCount > 1 ? 's' : ''} waiting to upload</small>}
          {memoShort && <small>memo {memoShort} · mise run memo:trace {memoShort}</small>}
          {lastReply && <small>last reply: {lastReply.split('/').pop()}</small>}
        </div>
      </div>
      <audio
        ref={audioRef}
        style={{ display: 'none' }}
        onPlaying={() => { if (playingKey.current) { report('started'); setStatus('playing reply') } }}
        onEnded={(e) => {
          const key = playingKey.current
          if (!key) return
          report('ended', { seconds: (e.currentTarget as HTMLAudioElement).duration })
          setStatus('reply played')
          finish(key)
        }}
        onError={(e) => {
          const key = playingKey.current
          if (!key) return
          const err = (e.currentTarget as HTMLAudioElement).error
          report('error', { error: `media error ${err?.code ?? '?'} ${err?.message ?? ''}`.trim().slice(0, 200) })
          finish(key)
        }}
      />
    </div>
  )
}

// Sized for the Honda head unit (1280x720 @160dpi, ~1135x590 usable): touch targets >= 76px,
// text >= 24px. Below 900px wide (phones) tiles wrap and everything scales down via clamp().
const CSS = `
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
.pad { display:flex; flex-direction:column; height:100%; box-sizing:border-box; padding:clamp(10px,2vw,20px); gap:clamp(10px,2vw,18px); overflow:auto; }
.unlock { min-height:64px; padding:0 24px; border-radius:16px; border:3px solid #4f8cff; background:#141a24; color:#4f8cff; font-weight:700; font-size:clamp(18px,2.2vw,26px); cursor:pointer; }
.tiles { display:grid; grid-template-columns:repeat(2,1fr); grid-auto-rows:max-content; align-content:start; gap:clamp(8px,1.4vw,16px); flex:1 1 auto; min-height:0; max-height:400px; overflow-y:auto; overscroll-behavior:contain; padding:2px; }
@media (min-width:600px) { .tiles { grid-template-columns:repeat(3,1fr); } }
@media (min-width:900px) { .tiles { grid-template-columns:repeat(5,1fr); } }
.tile { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:clamp(8px,1.6vw,18px); min-height:120px; padding:8px; border-radius:20px; border:2px solid #2a3140; background:#141a24; color:#e6e6e6; cursor:pointer; transition:background .12s, border-color .12s, transform .08s; }
.tile:active { transform:scale(.97); }
.tile:disabled { opacity:.35; cursor:not-allowed; }
.tile .swatch { flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:clamp(56px,8vw,92px); height:clamp(56px,8vw,92px); border-radius:22px; background:var(--c); color:#fff; font-size:clamp(30px,4.6vw,54px); font-weight:800; text-shadow:0 2px 6px rgba(0,0,0,.35); }
.tile .name { font-size:clamp(20px,2.4vw,30px); font-weight:700; line-height:1.15; text-align:center; overflow-wrap:anywhere; }
.tile.on { border:5px solid var(--c); background:color-mix(in srgb, var(--c) 22%, #141a24); padding:5px; }
.tile .swatch.pic { padding:0; overflow:hidden; border-radius:50%; background:#0b1020; text-shadow:none; }
.tile .swatch.pic img { width:100%; height:100%; object-fit:cover; display:block; }
.tile .check { position:absolute; top:8px; right:12px; font-size:30px; font-weight:800; color:var(--c); }
.bar { display:flex; align-items:center; gap:clamp(12px,2vw,24px); flex-wrap:wrap; flex:0 0 auto; }
.rec { display:flex; align-items:center; justify-content:center; gap:14px; flex:1 1 320px; min-height:88px; padding:0 28px; border-radius:44px; border:none; background:var(--c); color:#fff; font-size:clamp(24px,3vw,36px); font-weight:800; cursor:pointer; }
.rec:disabled { background:#3a3f4b; color:#9aa0ab; cursor:not-allowed; }
.rec.live { background:#e74c3c; }
.rec .dot { width:20px; height:20px; border-radius:50%; background:#fff; animation:pulse 1s ease-in-out infinite; }
.status { flex:1 1 240px; font-size:clamp(20px,2.4vw,28px); font-weight:600; line-height:1.2; opacity:.85; }
.status small { display:block; margin-top:6px; font-size:clamp(18px,2vw,24px); font-weight:500; opacity:.9; color:#b8c2d6; overflow-wrap:anywhere; }
.status small.warn { color:#ffb454; font-weight:700; }
.meterwrap { flex:0 0 auto; display:flex; align-items:center; gap:clamp(12px,2vw,24px); flex-wrap:wrap; }
.meter { flex:1 1 320px; height:48px; border-radius:24px; background:#141a24; border:2px solid #2a3140; overflow:hidden; }
.meter .fill { height:100%; min-width:0; transition:width .09s linear, background-color .09s; }
.mlabel { flex:1 1 240px; font-size:clamp(20px,2.4vw,28px); font-weight:700; color:#b8c2d6; }
.meterwrap.dead .meter { border-color:#ffb454; }
.meterwrap.dead .mlabel { color:#ffb454; }
.silent { flex:0 0 auto; display:flex; flex-direction:column; gap:8px; padding:14px 18px; border-radius:16px; border:3px solid #ffb454; background:#2a2112; color:#ffd9a0; font-size:clamp(20px,2.4vw,28px); line-height:1.25; }
.silent strong { color:#ffb454; font-size:clamp(24px,3vw,34px); }
.still *, .still *::before, .still *::after { animation:none !important; transition:none !important; }
/* Driving layout (UX restricted): five big tiles, one giant record toggle, state readable at a glance, no scrolling,
   no motion, no text beyond agent names. */
.pad.drive { overflow:hidden; gap:clamp(8px,1.6vh,16px); padding:clamp(8px,1.6vh,16px) clamp(10px,2vw,20px); }
.drive .hero { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 24px; padding:clamp(6px,1.4vh,14px) 24px; border-radius:20px; border:5px solid var(--c); background:color-mix(in srgb, var(--c) 28%, #0b1020); }
.drive .hname { font-size:clamp(34px,7vh,68px); font-weight:800; line-height:1.05; }
.drive .hstate { font-size:clamp(34px,7vh,68px); font-weight:900; letter-spacing:.04em; line-height:1.05; }
.drive .hsound { flex:1 0 100%; font-size:clamp(20px,3.2vh,30px); font-weight:700; color:#b8c2d6; }
.hero[data-phase="recording"] { background:#7a1d16; border-color:#ff5b4d; }
.hero[data-phase="sent"] { background:#12361f; border-color:#2ecc71; }
.hero[data-phase="queued"], .hero[data-phase="silent"], .hero[data-phase="error"] { background:#3a2a0e; border-color:#ffb454; }
.drive .tiles { grid-template-columns:repeat(5,1fr); grid-auto-rows:1fr; align-content:stretch; max-height:none; overflow:hidden; padding:6px; flex:1 1 0; min-height:0; }
.drive .tile { min-height:0; padding:4px; border-radius:18px; }
.drive .tile:not(.on) { opacity:.78; }
.drive .tile.on { opacity:1; border-width:9px; padding:0; box-shadow:0 0 0 5px color-mix(in srgb, var(--c) 45%, transparent); }
.drive .tile .swatch { width:clamp(64px,16vh,140px); height:clamp(64px,16vh,140px); font-size:clamp(30px,7vh,64px); }
.drive .tile .name { font-size:clamp(24px,4.4vh,38px); font-weight:800; }
.drive .bar { flex:1.25 1 0; min-height:0; }
.drive .rec { flex:1 1 100%; height:100%; min-height:0; border-radius:36px; font-size:clamp(36px,9vh,84px); }
.drive .rec.live { background:#d93a2b; }
.drive .status, .drive .unlock, .drive .silent { display:none; }
.linkbtn { align-self:flex-start; background:none; border:none; padding:10px 0; min-height:48px; color:#8ab4ff; font-size:clamp(18px,2vw,24px); text-decoration:underline; cursor:pointer; }
`

createRoot(document.getElementById('root')!).render(<App />)

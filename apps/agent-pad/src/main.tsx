import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

type Agent = { id: string; name: string; color: string }

const AGENTS: Agent[] = [
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
function lsSet(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* storage blocked */ }
}

// ---- capture level: did any sound reach the microphone? (the same -60 dBFS line the watcher uses) ----
// A recording whose loudest moment stays under SILENCE_DBFS is digital silence (a stuck emulator capture stream,
// a muted or unplugged mic), not speech. It is held back instead of uploaded: the driver hears about it now,
// not as an "empty_transcript" 40 seconds later.
const SILENCE_DBFS = -60
const FLOOR_DBFS = -96
type Capture = { peak_dbfs: number; rms_dbfs: number; samples?: number; source?: string; sent_anyway?: boolean }
const toDb = (x: number) => (x > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(x)) : FLOOR_DBFS)
const meter01 = (db: number) => Math.min(1, Math.max(0, (db - SILENCE_DBFS) / -SILENCE_DBFS))
const round1 = (x: number) => Math.round(x * 10) / 10
function normCapture(c: unknown, source: string): Capture | undefined {
  const o = c as Partial<Capture> | null
  if (!o || typeof o.peak_dbfs !== 'number' || typeof o.rms_dbfs !== 'number' || !isFinite(o.peak_dbfs) || !isFinite(o.rms_dbfs)) return undefined
  return { peak_dbfs: round1(o.peak_dbfs), rms_dbfs: round1(o.rms_dbfs), samples: typeof o.samples === 'number' ? o.samples : undefined, source: o.source || source, sent_anyway: o.sent_anyway }
}
const isSilent = (c?: Capture) => !!c && c.peak_dbfs < SILENCE_DBFS

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

function App() {
  const [selected, setSelected] = useState<Agent | null>(null)
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

  // ---- playback: an ordered queue of every unseen reply, played one after the other ----
  // lastDone is the newest reply key whose playback finished, failed or was skipped. It is persisted, so a
  // restart (the car app restarts at every ignition) resumes from there instead of dropping or replaying.
  const lastDone = useRef<string>(lsGet(LS_LAST_DONE))
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
      lsSet(LS_LAST_DONE, key)
    }
    queue.current = queue.current.filter((k) => k !== key)
    playingKey.current = ''
    pump.current()
  }, [])

  pump.current = async () => {
    const el = audioRef.current
    if (!el || playingKey.current || queue.current.length === 0) return
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
      el.src = URL.createObjectURL(blob)
      setLastReply(key)
      await el.play()
    } catch (e) {
      const n = (loadFails.current[key] = (loadFails.current[key] || 0) + 1)
      const msg = `play failed (try ${n}): ${String((e as Error)?.message || e)}`.slice(0, 200)
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
  }

  // Unlock audio on first user gesture (browser autoplay policy)
  const unlockAudio = useCallback(async () => {
    if (!audioRef.current) return
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
            if (key > lastDone.current) { lastDone.current = key; lsSet(LS_LAST_DONE, key) }
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
    const all = await outboxAll()
    setOutboxCount(all.length)
    for (const p of all) {
      try {
        await putObject(p.key, p.blob, p.capture)
        await outboxDel(p.key)
        clientEvent({ event: 'upload_recovered', key: p.key, attempts: p.attempts + 1 })
        setStatus(`sent → ${p.agentName} (after a retry)`)
      } catch (e) {
        await outboxPut({ ...p, attempts: p.attempts + 1 })
        void e
      }
    }
    if (all.length) setOutboxCount((await outboxAll()).length)
    await flushEvents()
  }, [])
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
        setStatus(`sent → ${agent.name}`)
        if (i > 0) clientEvent({ event: 'upload_recovered', key, attempts: i + 1 })
        return
      } catch (e) {
        lastErr = (e as Error).message || String(e)
      }
    }
    await outboxPut({ key, agentName: agent.name, blob, attempts: delays.length, at: Date.now(), capture })
    setOutboxCount((await outboxAll()).length)
    setStatus(`NOT sent (${lastErr.replace(/^PUT \S+: /, 'HTTP ').slice(0, 40)}) - saved, retrying`)
    clientEvent({ event: 'upload_failed', key, error: lastErr, attempts: delays.length, retryable: true })
  }, [])

  // A finished recording: hold it back if no sound ever reached the mic, else send it with its capture levels.
  const finishRecording = useCallback(async (agent: Agent, key: string, blob: Blob, capture: Capture | undefined, ms: number) => {
    setLevel(0)
    if (capture && isSilent(capture)) {
      setSilentHold({ agent, key, blob, capture, ms })
      setStatus('not sent')
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
    setMemoShort(null)
    setSilentHold(null)
    setLevel(0)
    setHeard(false)
    setMeterOn(false)
    // One key per recording, minted at the button press, so every device-side event and the upload share it.
    const mk = (ext: string) => `${INBOX_PREFIX}/${agent.id}/${todayPrefix()}/${ts()}.${ext}`
    // Inside the Holocene Auto app the WebView's own mic capture is unreliable on car audio stacks,
    // so the host injects a native recorder. Same upload path, different capture source.
    const native = (window as any).HoloceneNative as { start(): void; stop(): void; micClosed?(): void } | undefined
    if (native) {
      const key = mk('ogg')
      const w = window as any
      const started = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        w.__hnStarted = (ok: boolean, err: string) => resolve({ ok, err })
        native.start()
      })
      if (!started.ok) {
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
        const ms = Date.now() - recStart.current
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
      if (blob.size === 0) {
        setStatus('no audio captured')
        clientEvent({ event: 'record_failed', key, error: 'MediaRecorder produced 0 bytes', code: 'empty_capture', retryable: false })
        return
      }
      await finishRecording(agent, key, blob, capture, Date.now() - recStart.current)
    }
    mr.start()
    setRecording(true)
    setStatus(`🔴 recording for ${agent.name}… tap Stop to send`)
  }, [selected, finishRecording, onLevel])

  const stopRecording = useCallback(() => {
    if (nativeActive.current) { (window as any).HoloceneNative.stop(); return }
    mediaRecorder.current?.stop()
  }, [])

  const canRecord = !!selected
  const statusText = recording ? `Recording for ${selected?.name ?? ''}…` : status

  return (
    <div className="pad">
      <style>{CSS}</style>
      {!soundUnlocked && (
        <button className="unlock" onClick={unlockAudio}>
          🔊 Tap to enable sound
        </button>
      )}
      <div className="tiles" role="radiogroup" aria-label="Agent">
        {AGENTS.map((a) => {
          const on = selected?.id === a.id
          return (
            <button
              key={a.id}
              role="radio"
              aria-checked={on}
              className={`tile${on ? ' on' : ''}`}
              disabled={recording && !on}
              onClick={() => setSelected(a)}
              style={{ ['--c' as string]: a.color }}
            >
              <span className="swatch">{a.name.charAt(0)}</span>
              <span className="name">{a.name}</span>
              {on && <span className="check" aria-hidden="true">✓</span>}
            </button>
          )
        })}
      </div>
      {recording && meterOn && (
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
      {silentHold && (
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
          {recording ? 'Stop & Send' : selected ? `Record for ${selected.name}` : 'Pick an agent'}
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
.tiles { display:grid; grid-template-columns:repeat(2,1fr); grid-auto-rows:minmax(120px,1fr); gap:clamp(8px,1.4vw,16px); flex:1 1 auto; min-height:0; max-height:400px; }
@media (min-width:600px) { .tiles { grid-template-columns:repeat(3,1fr); } }
@media (min-width:900px) { .tiles { grid-template-columns:repeat(5,1fr); } }
.tile { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:clamp(8px,1.6vw,18px); min-height:120px; padding:8px; border-radius:20px; border:2px solid #2a3140; background:#141a24; color:#e6e6e6; cursor:pointer; transition:background .12s, border-color .12s, transform .08s; }
.tile:active { transform:scale(.97); }
.tile:disabled { opacity:.35; cursor:not-allowed; }
.tile .swatch { display:flex; align-items:center; justify-content:center; width:clamp(56px,8vw,92px); height:clamp(56px,8vw,92px); border-radius:22px; background:var(--c); color:#fff; font-size:clamp(30px,4.6vw,54px); font-weight:800; text-shadow:0 2px 6px rgba(0,0,0,.35); }
.tile .name { font-size:clamp(20px,2.4vw,30px); font-weight:700; line-height:1.15; text-align:center; overflow-wrap:anywhere; }
.tile.on { border:5px solid var(--c); background:color-mix(in srgb, var(--c) 22%, #141a24); padding:5px; }
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
.linkbtn { align-self:flex-start; background:none; border:none; padding:10px 0; min-height:48px; color:#8ab4ff; font-size:clamp(18px,2vw,24px); text-decoration:underline; cursor:pointer; }
`

createRoot(document.getElementById('root')!).render(<App />)

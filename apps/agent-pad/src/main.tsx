import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { durableGet, durableSet } from './durable'
import { type Capture, meter01, normCapture, round1, silenceAction, toDb } from './capture'
import { InFlight, UploadRejected, isFinalRefusal, nagRejected, newestRejectedAt, rejectionCode, rejectionReason, rejectionText, replyExt, retryable, stripDataUrl, REJECTED_RETRY_MS } from './flight'
import { type Agent, type RosterMeta, type SpeakEvent, type Speaking, ROSTER_URL, avatarRetryDelay, driveTiles, normRoster, replyPollMs, restoreSelection, rosterGeneratedAt, rosterStaleness, sameRoster, savedAgentId, serverClockOffset, speakNext, step, stalenessText } from './roster'
import { type Conv, type MemoStatus, elapsedSeconds, isFinal, keyDay, mayPlayProgress, newestProgress, normStatus, progressPrefix, statusKey, statusLine } from './status'
import { convReplyUnit, noteConv, onDeferred } from './convo'
import { type ReplyRef, type Unit, addRef, newUnit, nextUnit, parseReplyKey, readyChunks } from './replies'
import { type Ledger, closeUnit, forThisDevice, isOpen, leaveToPhone as ledgerLeaveToPhone, memoOfReply, mergeLedgers, newDeviceId, normLedger, openUnit, own, parkUnit, takeBackFromPhone, validDeviceId } from './ledger'
import { type PushEvent, PUSH_STALE_MS, parsePush, pushBackoff, pushLive } from './push'
import { PLAY_STRIKES, isFocusFailure, retryPlan, stopAckName } from './pace'
import { type Claim, type ClaimAction, type ClaimAnswer, CLAIM_RENEW_MS, CLAIM_WAIT_MS, claimAnswer, confirmDue, holdDue, noteClaim, PHONE_RECHECK_MAX_MS, phoneRecheckDue, phoneStillHas, startPlan, startVerdict } from './claim'

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

type Gate = { answer: Promise<ClaimAnswer>; plan: 'play' | 'claim' }
type ListPage = { keys: string[]; next: string | null }
// A request that hangs on a flaky car link must fail, so the next poll runs instead of waiting minutes for it. The
// deadline covers the body too: headers can arrive and the body then stall.
async function fetchWithin<T>(url: string, ms: number, read: (r: Response) => Promise<T>, init: RequestInit = {}): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`)
    return await read(res)
  } finally {
    clearTimeout(timer)
  }
}

async function listPage(prefix: string, startAfter: string, token: string | null): Promise<ListPage> {
  let url = `${BUCKET_BASE}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
  if (token) url += `&continuation-token=${encodeURIComponent(token)}`
  else if (startAfter) url += `&start-after=${encodeURIComponent(startAfter)}`
  const text = await fetchWithin(url, 10000, (r) => r.text())
  const doc = new DOMParser().parseFromString(text, 'application/xml')
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

// Who sent a memo: this pad's device id (random, kept beside the ledger) and whether it runs in the car app. The proxy
// stores both with the memo, so the watcher can tell that a live car will speak the reply itself and skip the Earshot
// phone copy (the phone plays through the car's speakers when it is paired: the same reply twice, or into a recording).
const DEVICE = { id: '' }
const HOST_KIND = (window as any).HoloceneNative ? 'car' : 'browser'
function deviceHeaders(): Record<string, string> {
  return DEVICE.id ? { 'X-Holocene-Device': DEVICE.id, 'X-Holocene-Host': HOST_KIND } : { 'X-Holocene-Host': HOST_KIND }
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
      headers: { 'Content-Type': blob.type || 'application/octet-stream', ...deviceHeaders(), ...(capture ? { 'X-Holocene-Capture': JSON.stringify(capture) } : {}) },
      signal: ctl.signal,
    })
    if (!res.ok) {
      // Only a refusal the proxy itself authored (422/413 with a JSON error body) is final: carry its reason and
      // code so the pad can say why. Anything else may be an edge answering while the proxy is down and stays retryable.
      const body = await res.text().catch(() => '')
      if (isFinalRefusal(res.status, res.headers.get('content-type') || '', body)) {
        throw new UploadRejected(res.status, rejectionReason(body), rejectionCode(body))
      }
      throw new Error(`PUT ${key}: ${res.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function getBlob(url: string): Promise<Blob> {
  return fetchWithin(url, 30000, (r) => r.blob())
}

// ---- upload outbox (IndexedDB): a recording that could not be sent is KEPT and retried ----
// `rejected`: the proxy refused this PUT for good (a final refusal). The audio stays here; the 30 s retry timer
// leaves it alone, but a slow timer (hourly, and once at pad start) tries it again so a wrong classification or an
// agent that became routable clears itself. `at` stamps the first rejection: the driving hero note fades after it.
type Pending = { key: string; agentName: string; blob: Blob; attempts: number; at: number; capture?: Capture; rejected?: { status: number; reason: string; at?: number } }
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
const rosterDbGet = async () => {
  const raw = await rosterDb<unknown>('readonly', (s) => s.get('roster'))
  const list = normRoster(raw)
  return list ? { list, generatedAt: rosterGeneratedAt(raw) } : null
}
const rosterDbSet = (list: Agent[], generatedAt: number | null) =>
  rosterDb('readwrite', (s) => s.put({ agents: list, ...(generatedAt !== null ? { generated_at: new Date(generatedAt).toISOString() } : {}) }, 'roster'))
// The selected agent id, beside the roster: the WebView's localStorage is empty after a cold start, IndexedDB is not.
const agentDbGet = async () => savedAgentId(await rosterDb<unknown>('readonly', (s) => s.get('agent')))
const agentDbSet = (id: string) => rosterDb('readwrite', (s) => s.put(id, 'agent'))
// The reply ledger (ledger.ts) and the device id, in the same IndexedDB store (it survives the car's cold start) and in
// localStorage (a browser answers synchronously).
const LS_LEDGER = 'agentpad.ledger'
const LS_DEVICE = 'agentpad.device'
const LEDGER_WAIT_MS = 5000
const ledgerDbGet = async () => normLedger(await rosterDb<unknown>('readonly', (s) => s.get('ledger')), Date.now())
const ledgerSave = (l: Ledger) => { lsSet(LS_LEDGER, JSON.stringify(l)); void rosterDb('readwrite', (s) => s.put(l, 'ledger')) }
const deviceDbGet = async () => { const v = await rosterDb<unknown>('readonly', (s) => s.get('device')); return validDeviceId(v) ? v : '' }
const deviceDbSet = (id: string) => rosterDb('readwrite', (s) => s.put(id, 'device'))
// ?replies=all (remembered in this browser): play every reply in the bucket, as every pad did before replies were
// scoped to the device that sent the memo. ?replies=mine undoes it.
function playAllReplies(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('replies')
    if (q === 'all' || q === 'mine') lsSet('agentpad.replies', q)
  } catch { /* no location */ }
  return lsGet('agentpad.replies') === 'all'
}

// ---- client events: what only the device can see (record start/stop/failure, upload failure) ----
// The proxy logs each one; failures also become audio.memo.failed(stage record|upload) facts keyed by the
// key the memo would have had, so a memo that never reached S3 still shows up in memo:trace and /voice.
type ClientEvent = { event: string; key: string; error?: string; code?: string; bytes?: number; duration_ms?: number; attempts?: number; retryable?: boolean; capture?: Capture; speech?: unknown }
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

// Every decision of the host's speech queue (start / end / halt / drop / deferred, with device timestamps), so an
// overlap can be audited from the server. Fire and forget, never queued: the outbox of events is for failures.
function speechEvent(key: string, d: unknown) {
  void postEvent({ event: 'speech', key, speech: d })
}

// Playback beacon: the pad is the only place that knows whether the driver was actually spoken to.
// The upload proxy logs it and publishes bloodbank.audio.memo.played / failed(stage=playback).
// Fire and forget: a failed beacon must never affect playback.
type Phase = 'started' | 'ended' | 'blocked' | 'error' | 'skipped'
function beacon(replyKey: string, phase: Phase, extra: { seconds?: number; error?: string; chunks?: number } = {}) {
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
// speechVersion 2: the host's speech queue plays a chunked reply (chunk after chunk, one reply, nothing between them).
// Without it the pad waits for the reply's full file, as before chunking.
type NativeChunks = { playReplyChunk(id: string, index: number, total: number, b64: string, ext: string): void }
function nativeChunks(): NativeChunks | null {
  const n = (window as any).HoloceneNative
  return n && typeof n.playReplyChunk === 'function' ? (n as NativeChunks) : null
}
// The host's one speech queue (SpeechArbiter): heard echo, progress narration, and "this memo is final". Absent on an
// older host; then progress plays through the page's own single audio element (no echo, no overlap either way).
type NativeSpeech = {
  speechEcho(memoId: string, name: string, heard: string): void
  speechProgress(memoId: string, seq: number, b64: string, ext: string): void
  speechMemoFinal(memoId: string): void
}
function nativeSpeech(): NativeSpeech | null {
  const n = (window as any).HoloceneNative
  return n && typeof n.speechProgress === 'function' && typeof n.speechEcho === 'function' ? (n as NativeSpeech) : null
}
// A memo is followed (status line, echo, progress) for this long after it was sent, and a failed one stays on its
// tile for a minute.
const FLIGHT_MAX_MS = 20 * 60 * 1000
const FAILED_SHOW_MS = 60 * 1000
const PROGRESS_LIST_MS = 4000 // at most one listing of a memo's progress clips this often
type Flight = {
  memoId: string; agentId: string; agentName: string; key: string; day: string; sentAt: number
  status: MemoStatus | null; fetchedAt: number; echoed: boolean; progressSeq: number; listedAt: number; finalAt: number
}
type FlightView = { memoId: string; status: MemoStatus | null; fetchedAt: number; sentAt: number }
function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(stripDataUrl(String(r.result)))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}
type PadPhase = 'idle' | 'arming' | 'recording' | 'sending' | 'sent' | 'queued' | 'rejected' | 'silent' | 'cancelled' | 'error'
// The hero's state while a reply plays: REPLY, plus the agent's name when it is not the one selected.
function replyLabel(agentId: string, selectedId: string | undefined, agents: Agent[], label: (n: string) => string): string {
  if (!agentId || agentId === selectedId) return 'REPLY'
  const a = agents.find((x) => x.id === agentId)
  return a ? `REPLY · ${label(a.name)}` : 'REPLY'
}

const PHASE_LABEL: Record<PadPhase, string> = {
  idle: 'READY', arming: 'STARTING', recording: 'RECORDING', sending: 'SENDING', sent: 'SENT',
  queued: 'SAVED, RETRYING', rejected: 'NOT SENT, SAVED', silent: 'NO SOUND, NOT SENT', cancelled: 'CANCELLED', error: 'MIC ERROR',
}
const LS_AGENT = 'agentpad.agent'
const LS_ROSTER = 'agentpad.roster'
const ROSTER_POLL_MS = 120_000
const DRIVE_TILES = 5 // the driving layout's one row of big tiles
const ROSTER_WAIT_MS = 2500 // how long a start with no cached roster waits for it before showing the fallback list
// localStorage answers synchronously (a browser keeps it); in the car a cold start empties it, so the IndexedDB copy
// (rosterDbGet) is read next, and only a first-ever start with no network waits for the fallback list.
const rosterGet = () => normRoster(lsGet(LS_ROSTER))
const rosterSet = (list: Agent[], generatedAt: number | null) => {
  lsSet(LS_ROSTER, JSON.stringify({ agents: list, ...(generatedAt !== null ? { generated_at: new Date(generatedAt).toISOString() } : {}) }))
  void rosterDbSet(list, generatedAt)
}
const ROSTER_CLOCK_MS = 60_000 // how often the age of the list is re-read between fetches

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
  // How old the list is: the cached copy's own stamp until a fetch answers, then the fetched one. `failures` counts
  // consecutive fetches that did not produce a roster (one blip on a young list is not flagged); `clockOffset` is the
  // server clock minus the device clock from the last fetch's Date header. The clock re-reads the age between fetches.
  const [rosterMeta, setRosterMeta] = useState<RosterMeta>(() => ({ generatedAt: rosterGeneratedAt(lsGet(LS_ROSTER)), failures: 0, clockOffset: 0 }))
  const [clock, setClock] = useState(Date.now)
  const fetchedMeta = useRef(false) // a fetch has answered: a late cache read must not overwrite its stamp
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  // The remembered agent id: localStorage, else IndexedDB (read below), restored as a selection only.
  const savedAgent = useRef(savedAgentId(lsGet(LS_AGENT)))
  const [selected, setSelected] = useState<Agent | null>(() => agents.find((a) => a.id === savedAgent.current) || null)
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
  const [rejectedCount, setRejectedCount] = useState(0) // recordings the proxy refused for good: kept, retried hourly
  const [rejectedAt, setRejectedAt] = useState(0) // newest rejection stamp: the driving hero note fades ~30 min after it
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

  // ---- which replies are this pad's, and which ones it still owes (ledger.ts) ----
  const ledger = useRef<Ledger>(normLedger(lsGet(LS_LEDGER), Date.now()))
  const playAll = useRef(playAllReplies())
  const setLedger = (l: Ledger) => { if (l !== ledger.current) { ledger.current = l; ledgerSave(l) } }
  // The IndexedDB copy (all the car has after a cold start: its localStorage is empty) and the device id are read
  // before the first reply is judged and before the push stream opens. A store that does not answer within
  // LEDGER_WAIT_MS (or fails) is not trusted to say what is NOT this pad's: the pad then plays every reply, as every pad
  // did before replies were scoped, rather than drop its own. The device id is fixed once chosen: the PUTs and the push
  // stream must name the same one (the presence check pairs them).
  const ready = useRef<Promise<void> | null>(null)
  if (!ready.current) {
    let read = false
    ready.current = Promise.race([
      (async () => {
        const [stored, dev] = await Promise.all([ledgerDbGet(), deviceDbGet()])
        setLedger(mergeLedgers(ledger.current, stored, Date.now()))
        if (!DEVICE.id) {
          DEVICE.id = (validDeviceId(lsGet(LS_DEVICE)) ? lsGet(LS_DEVICE) : dev) || newDeviceId()
          lsSet(LS_DEVICE, DEVICE.id)
          if (DEVICE.id !== dev) void deviceDbSet(DEVICE.id)
        }
        read = true
      })().catch(() => { /* storage blocked */ }),
      new Promise<void>((r) => setTimeout(r, LEDGER_WAIT_MS)),
    ]).then(() => {
      // Replies this car left to the phone before a reload or a cold start: looked at again, so a take the watcher gives
      // back later still reaches this car (the in-memory list below is empty after either).
      for (const [key, at] of Object.entries(ledger.current.phone)) if (!phoneTook.current.has(key)) phoneTook.current.set(key, { at, checkedAt: 0 })
      if (!read) playAll.current = true // the ledger is unknown: never drop a reply that may be this pad's own
      if (!DEVICE.id) {
        DEVICE.id = validDeviceId(lsGet(LS_DEVICE)) ? lsGet(LS_DEVICE) : newDeviceId()
        lsSet(LS_DEVICE, DEVICE.id)
        void deviceDbSet(DEVICE.id)
      }
    })
  }
  // A memo this pad sent: its reply is this pad's to play (recorded before the first upload attempt, so a reply that
  // comes back fast, or a send that only succeeds from the outbox later, is still known).
  const ownMemo = async (key: string) => {
    const memo = await memoIdFor(key)
    if (memo) setLedger(own(ledger.current, memo, Date.now()))
  }

  // ---- playback: an ordered queue of every unseen reply, played one after the other ----
  // lastDone is the newest reply key whose playback finished, failed or was skipped. It is persisted, so a
  // restart (the car app restarts at every ignition) resumes from there instead of dropping or replaying.
  const lastDone = useRef<string>(markerGet())
  const queue = useRef<string[]>([])
  const enqueued = useRef<Set<string>>(new Set())
  const loadFails = useRef<Record<string, number>>({})
  const focusFails = useRef<Record<string, number>>({}) // audio-focus refusals in a row, per reply (pace.ts)
  const playingKey = useRef<string>('') // reply loaded in the audio element ('' while the silent unlock clip plays)
  const beaconsSent = useRef<Set<string>>(new Set())
  const pump = useRef<() => void>(() => {})
  const [speaking, setSpeakingState] = useState<Speaking>(null) // the reply playing: its agent's tile shows it
  const speak = useCallback((ev: SpeakEvent) => setSpeakingState((cur) => speakNext(cur, ev)), [])
  const lastSentAt = useRef(0) // last successful upload: replies are polled fast for a while after it
  const pollNow = useRef<() => void>(() => {})
  const replyBytes = useRef(0) // size of the reply now playing: bounds how long it can legitimately play
  const noteSent = () => { lastSentAt.current = Date.now(); pollNow.current() }

  // ---- memos in flight: the watcher's status object drives the tile line, the heard echo and progress narration ----
  // Followed on the reply poll's cadence (2 s for ten minutes after a send). Everything audible goes to the host's
  // speech queue; without one, progress clips wait in the page's own queue (one audio element, after any reply).
  const flights = useRef<Map<string, Flight>>(new Map())
  const [flightView, setFlightView] = useState<Record<string, FlightView>>({})
  const progressQ = useRef<{ memoId: string; seq: number; key: string; blob: Blob }[]>([])
  // The fast conversation desk's own answers this pad has learned of from the status objects (reply unit -> its conv):
  // one the driver barges into is not replayed after the note (convo.ts). Kept past the flight, which is forgotten as
  // soon as its reply lands.
  const fastTurns = useRef<Map<string, Conv>>(new Map())
  // ---- replies as units (replies.ts): the full file, or its chunks first (a long reply, voiced sentence by sentence) ----
  const units = useRef<Map<string, Unit>>(new Map())
  const chunkBlobs = useRef<Map<string, Blob>>(new Map()) // downloaded chunks, kept until the reply is done (a replay after a note)
  // The unit the host is playing chunk by chunk, and which chunks it has been handed.
  const streaming = useRef<{ unit: string; offered: Set<number>; busy: boolean; again: boolean; fails: number; gate: Gate | null } | null>(null)
  const push = useRef({ heardAt: 0, nats: false })
  // Chunked replies that stopped short (a chunk never came: vox failed mid-reply, a cancel took them back): parked, not
  // done. Their chunks are ignored from here on, and the full file plays when (if) it lands. Unit key -> parked at.
  const parked = useRef<Map<string, { at: number; checkedAt: number }>>(new Map())
  const playingProgress = useRef(false) // the audio element is on a progress clip, not a reply
  // ---- who speaks a reply in the cabin: this car, or the phone's Earshot copy (claim.ts). Cars only: a browser is not
  // in the cabin, and the watcher mirrors a browser's memo at once. Unit key -> the proxy's last answer.
  const claims = useRef<Map<string, Claim>>(new Map())
  // Starts this car made on a live hold that the proxy never answered (it was down): re-sent until it has them, so the
  // phone cannot take the lapsed hold once the proxy is back. Unit key -> first sent.
  const unconfirmed = useRef<Map<string, number>>(new Map())
  // Replies the audio of which really started (the host's 'started', the audio element's 'playing'): their hold is no
  // longer renewed (the start is the claim), and a failure after this is not a release.
  const startedKeys = useRef<Set<string>>(new Set())
  // Replies this car left to the phone (it took them): looked at again until the phone really has them (the watcher gives a
  // take back when its Earshot drop failed on every try, and pushes `released`). Unit key -> when left, last looked at.
  const phoneTook = useRef<Map<string, { at: number; checkedAt: number }>>(new Map())
  // The hold made when a reply joined the queue, while its answer is out: the pump reuses it instead of asking again.
  const holdInflight = useRef<Map<string, Promise<ClaimAnswer>>>(new Map())
  const holdFor = (key: string): Promise<ClaimAnswer> => {
    const cur = holdInflight.current.get(key)
    if (cur) return cur
    const p = claimReply(key, 'hold').finally(() => { if (holdInflight.current.get(key) === p) holdInflight.current.delete(key) })
    holdInflight.current.set(key, p)
    return p
  }
  const claimReply = async (key: string, action: ClaimAction): Promise<ClaimAnswer> => {
    if (HOST_KIND !== 'car') return 'none'
    const sent = Date.now() // the lease runs from the proxy's receipt: counting it from the send is on the safe side
    let answer: ClaimAnswer = 'none'
    try {
      answer = await fetchWithin('/upload/claim', CLAIM_WAIT_MS, async (r) => claimAnswer(r.status, await r.json()), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: 'car', action, reply_key: key, ...(DEVICE.id ? { device: DEVICE.id } : {}) }),
      })
    } catch { /* no answer is no yes: the proxy is down, or the network */ }
    if (action === 'release') { // gave the reply up before any audio: no hold of ours is left to count on
      claims.current.delete(key)
      return answer
    }
    if (action === 'start') {
      // The start is claimed when the audio really starts. One the proxy never answered (it was down) is re-sent until it
      // has it, so the phone cannot take the lapsed hold once the proxy is back.
      if (answer !== 'none') unconfirmed.current.delete(key)
      else if (!unconfirmed.current.has(key)) unconfirmed.current.set(key, Date.now())
    }
    if (units.current.has(key)) { // a reply this page is done with keeps no claim
      const c = noteClaim(claims.current.get(key), answer, sent)
      if (c) claims.current.set(key, c)
    }
    return answer
  }
  const refreshFlights = () => {
    const now = Date.now()
    const view: Record<string, FlightView> = {}
    for (const f of [...flights.current.values()]) {
      // Done (the reply speaks for itself) or too old: forgotten. Failed: says so on its tile for a minute.
      const failed = f.status?.stage === 'failed'
      if (now - f.sentAt > FLIGHT_MAX_MS || (f.finalAt && (!failed || now - f.finalAt > FAILED_SHOW_MS))) {
        flights.current.delete(f.memoId)
        continue
      }
      const cur = view[f.agentId]
      if (!cur || cur.sentAt < f.sentAt) view[f.agentId] = { memoId: f.memoId, status: f.status, fetchedAt: f.fetchedAt, sentAt: f.sentAt }
    }
    setFlightView(view)
  }
  const trackMemo = async (agentId: string, agentName: string, key: string) => {
    const memoId = await memoIdFor(key)
    const day = keyDay(key)
    if (!memoId || !day || flights.current.has(memoId)) return
    flights.current.set(memoId, { memoId, agentId, agentName, key, day, sentAt: Date.now(), status: null, fetchedAt: 0, echoed: false, progressSeq: 0, listedAt: 0, finalAt: 0 })
    refreshFlights()
  }
  const flightFinal = (memoId: string) => {
    const f = flights.current.get(memoId)
    if (f && !f.finalAt) f.finalAt = Date.now()
    progressQ.current = progressQ.current.filter((p) => p.memoId !== memoId)
    try { nativeSpeech()?.speechMemoFinal(memoId) } catch { /* host bridge absent */ }
  }
  // The status object is dated by the memo's inbox key; a watcher that dates it by the day it ran is found too.
  const readStatus = async (f: Flight): Promise<MemoStatus | null> => {
    const days = [f.day, todayPrefix()].filter((d, i, a) => a.indexOf(d) === i)
    for (const day of days) {
      try {
        const text = await fetchWithin(`${BUCKET_BASE}/${statusKey(day, f.memoId)}`, 8000, (r) => r.text(), { cache: 'no-store' })
        f.day = day
        return normStatus(text, f.memoId)
      } catch { /* not there (yet) */ }
    }
    return null
  }
  const pollFlights = async () => {
    for (const f of [...flights.current.values()]) await pollFlight(f)
    refreshFlights()
  }
  // One memo in flight: its status object (tile line, heard echo, final), then its newest progress clip if one is due.
  const pollFlight = async (f: Flight) => {
    if (f.finalAt) return
    const st = await readStatus(f)
    if (!st) return
    f.status = st
    f.fetchedAt = Date.now()
    noteConv(fastTurns.current, st.conv)
    const n = nativeSpeech()
    if (isFinal(st.stage)) { flightFinal(f.memoId); return }
    if (st.heard && !f.echoed) {
      f.echoed = true
      try { n?.speechEcho(f.memoId, f.agentName, st.heard) } catch { /* host bridge absent */ }
    }
    const due = (st.spoken_seq ?? st.progress_seq) > f.progressSeq
    if (!due || Date.now() - f.listedAt < PROGRESS_LIST_MS) return
    f.listedAt = Date.now()
    try {
      const pick = newestProgress((await listPage(progressPrefix(f.day, f.memoId), '', null)).keys, f.day, f.memoId, f.progressSeq)
      if (pick) await sayProgress(f, pick)
    } catch { /* next poll */ }
  }
  // A push said this memo moved on: re-read just its status object, a moment later (the watcher publishes the fact
  // just before its status writer uploads the new document), and once more after that in case the first was early.
  const flightSoon = useRef<Map<string, number>>(new Map())
  const pollFlightSoon = (memoId: string) => {
    if (flightSoon.current.has(memoId)) return
    const run = async (again: boolean) => {
      const f = flights.current.get(memoId)
      if (f && !f.finalAt) { try { await pollFlight(f) } catch { /* next poll */ } refreshFlights() }
      if (again) flightSoon.current.set(memoId, window.setTimeout(() => void run(false), 1500))
      else flightSoon.current.delete(memoId)
    }
    flightSoon.current.set(memoId, window.setTimeout(() => void run(true), 700))
  }
  // One progress clip for a memo in flight (from the listing above, or straight from the push channel's narrated event).
  const sayProgress = async (f: Flight, pick: { key: string; seq: number; hold?: true }) => {
    if (pick.seq <= f.progressSeq) return
    f.progressSeq = pick.seq
    // A hold cue ("One sec.") is never said over the driver's own note, and not after it either: dropped here (the number is
    // spent, the next clip is newer). Real progress narration is deferred by the speech queue as before.
    if (!mayPlayProgress(pick, { recording: recordingRef.current, arming: arming.current })) return
    const blob = await getBlob(`${BUCKET_BASE}/${pick.key}`)
    if (f.finalAt) return // the reply landed while the clip downloaded
    const n = nativeSpeech()
    if (n) n.speechProgress(f.memoId, pick.seq, await blobToBase64(blob), replyExt(pick.key))
    else {
      // Newest wins: an older clip for the same memo that has not played yet is dropped.
      progressQ.current = [...progressQ.current.filter((p) => p.memoId !== f.memoId), { memoId: f.memoId, seq: pick.seq, key: pick.key, blob }]
      pump.current()
    }
  }
  const pollFlightsRef = useRef(pollFlights)
  pollFlightsRef.current = pollFlights
  // One more read of a memo's status object for its conv block alone (no echo, no progress: the reply is here).
  const learnConv = async (f: Flight) => {
    const st = await readStatus(f)
    if (st) noteConv(fastTurns.current, st.conv)
  }

  const report = useCallback((phase: Phase, extra: { seconds?: number; error?: string } = {}) => {
    const key = playingKey.current
    if (key && phase === 'started') speak({ t: 'started', key }) // before the dedupe: a replay after a note bounces again
    if (!key || beaconsSent.current.has(`${key}:${phase}`)) return
    beaconsSent.current.add(`${key}:${phase}`)
    if (phase === 'started') { // the audio really started: only now is the reply claimed as spoken
      startedKeys.current.add(key)
      void claimReply(key, 'start')
    }
    const st = streaming.current
    beacon(key, phase, st && st.unit === key ? { ...extra, chunks: units.current.get(key)?.n } : extra)
  }, [])

  // A reply the pad is done with (played, failed for good, skipped, or not this pad's): the marker moves up to it and it
  // is no longer owed. Units still owed below the marker stay in the ledger's open set.
  const settle = (key: string) => {
    if (key > lastDone.current) {
      lastDone.current = key
      markerSet(key)
    }
    setLedger(closeUnit(ledger.current, key))
  }
  // pump false: the reply was dropped because a note is starting, and the note's end pumps the queue itself.
  const finish = useCallback((key: string, pump_ = true) => {
    settle(key)
    queue.current = queue.current.filter((k) => k !== key)
    claims.current.delete(key)
    startedKeys.current.delete(key)
    delete focusFails.current[key]
    playingKey.current = ''
    const u = units.current.get(key)
    if (u) for (const ck of Object.values(u.chunks)) chunkBlobs.current.delete(ck)
    units.current.delete(key)
    if (streaming.current?.unit === key) streaming.current = null
    speak({ t: 'ended', key })
    if (pump_) pump.current()
  }, [])

  // The driver started a note over the fast desk's own answer to their last turn: the note is their next turn, so that
  // answer is done (a 'skipped' beacon, error barged_in), not replayed after it (convo.ts). It had started, so its car
  // claim stays and the phone never says it either. A follow-up result, a direct turn's agent answer and any other reply
  // go back to the head of the queue as before. True: it was dropped.
  const dropBarged = (key: string, reason: string): boolean => {
    if (onDeferred(key, fastTurns.current.get(key), { started: startedKeys.current.has(key), reason }) !== 'skip') return false
    fastTurns.current.delete(key)
    if (!beaconsSent.current.has(`${key}:skipped`)) {
      beaconsSent.current.add(`${key}:skipped`)
      beacon(key, 'skipped', { error: 'barged_in' })
    }
    setStatus('reply skipped: you spoke over it')
    finish(key, false)
    return true
  }

  // Park a chunked reply that cannot finish from its chunks: off the queue without moving lastDone, so its full file is
  // still taken when it lands (push, or the per-unit check in the poll tick). Says so once in a playback-failed fact.
  const park = (key: string, why: string) => {
    if (playingKey.current === key) {
      report('error', { error: `${why}; waiting for the full reply` })
      playingKey.current = ''
      speak({ t: 'failed', key })
    } else beacon(key, 'error', { error: `${why}; waiting for the full reply` })
    if (!startedKeys.current.has(key)) void claimReply(key, 'release') // nothing was heard: the phone may take it now
    queue.current = queue.current.filter((k) => k !== key)
    const u = units.current.get(key)
    if (u) for (const ck of Object.values(u.chunks)) chunkBlobs.current.delete(ck)
    units.current.delete(key)
    if (streaming.current?.unit === key) streaming.current = null
    parked.current.set(key, { at: Date.now(), checkedAt: Date.now() })
    setLedger(parkUnit(ledger.current, key, Date.now())) // still owed after a cold start: its full file plays if it lands
    pump.current()
  }
  const checkParked = async () => {
    for (const [key, p] of [...parked.current]) {
      if (Date.now() - p.at > MAX_REPLY_AGE_MS) { parked.current.delete(key); setLedger(closeUnit(ledger.current, key)); continue }
      if (Date.now() - p.checkedAt < 10_000) continue
      p.checkedAt = Date.now()
      try {
        const page = await listPage(key.slice(0, -'.ogg'.length), '', null)
        if (page.keys.includes(key) && ingestReply(key)) pump.current()
      } catch { /* next tick */ }
    }
  }

  // One reply key from the listing or the push channel: it joins its unit (a new unit is queued in key order). A unit the
  // pad already finished, or one older than lastDone that it does not still owe, is ignored; a stale one is skipped as
  // before; a reply to a memo another device sent is not this pad's (ledger.ts) and is passed over silently. True: news.
  const ingestReply = (key: string, firstRun = false): boolean => {
    const ref: ReplyRef | null = parseReplyKey(key)
    if (!ref) return false
    if (parked.current.has(ref.unit)) {
      if (ref.chunk) return false // its chunks failed once: only the full file brings it back
      parked.current.delete(ref.unit)
      enqueued.current.delete(ref.unit)
    } else if (ref.unit <= lastDone.current && !units.current.has(ref.unit) && !isOpen(ledger.current, ref.unit)) return false
    let u = units.current.get(ref.unit)
    if (!u) {
      if (enqueued.current.has(ref.unit)) return false // played (or skipped) already
      enqueued.current.add(ref.unit)
      const mine = forThisDevice(ledger.current, ref.unit, playAll.current)
      const age = Date.now() - renderedAt(ref.unit)
      if (age > MAX_REPLY_AGE_MS || !mine) {
        if (mine && !firstRun && age < 6 * 3600 * 1000) {
          beacon(ref.unit, 'skipped', { error: `stale: rendered ${Math.round(age / 60000)} min before the pad saw it` })
        }
        settle(ref.unit)
        return false
      }
      u = newUnit(ref.unit, Date.now())
      units.current.set(ref.unit, u)
      setLedger(openUnit(ledger.current, ref.unit, Date.now()))
      queue.current = [...queue.current, ref.unit].sort()
      void holdFor(ref.unit) // this car means to say it: the phone leaves it alone while the hold lives
      const memo = memoOfReply(ref.unit)
      const f = memo ? flights.current.get(memo) : undefined
      if (f) {
        // A fast turn's answer can land before the pad read the status object that names it: read it once more, so a
        // barge-in into this answer is known for what it is (the flight itself stops being polled now).
        if (convReplyUnit(f.status?.conv) !== ref.unit) void learnConv(f)
        flightFinal(f.memoId)
      }
    }
    const news = addRef(u, ref)
    if (news && streaming.current?.unit === ref.unit) void feedStream()
    return news
  }

  // After a cold start: the units the ledger says are still owed (queued behind another reply, or parked until their full
  // file lands) are picked up again, though the marker may have moved past them. Once per page; again if it failed.
  const reopened = useRef(false)
  const reopenOwed = async () => {
    if (reopened.current) return
    reopened.current = true
    for (const [key, o] of Object.entries(ledger.current.open)) {
      if (units.current.has(key) || parked.current.has(key)) continue
      if (Date.now() - renderedAt(key) > MAX_REPLY_AGE_MS) { setLedger(closeUnit(ledger.current, key)); continue }
      if (o.parked) { parked.current.set(key, { at: o.seenAt, checkedAt: 0 }); continue }
      try {
        const page = await listPage(key.slice(0, key.lastIndexOf('.')), '', null)
        for (const k of page.keys.sort()) ingestReply(k)
      } catch { reopened.current = false } // the next tick tries again
    }
  }

  // Hand the playing unit's chunks to the host in order, each as soon as it is downloaded. A download that fails is
  // retried by the next poll tick or push; the host holds the reply (and the queue) while it waits for a chunk.
  const feedStream = async () => {
    const st = streaming.current
    if (!st) return
    if (st.busy) { st.again = true; return }
    st.busy = true
    try {
      do {
        st.again = false
        const u = units.current.get(st.unit)
        const host = nativeChunks()
        if (!u || !host) return
        let from = 1
        while (st.offered.has(from)) from++
        for (const i of readyChunks(u, from)) {
          const ck = u.chunks[i]
          let blob = chunkBlobs.current.get(ck)
          if (!blob) {
            blob = await getBlob(`${BUCKET_BASE}/${ck}`)
            chunkBlobs.current.set(ck, blob)
          }
          if (streaming.current !== st || recordingRef.current || arming.current) return // stopped meanwhile
          if (st.gate) { // chunk 1: the start claimed on the live hold is answered before any audio
            const gate = st.gate
            st.gate = null
            if (!(await passGate(st.unit, gate)) || streaming.current !== st || recordingRef.current || arming.current) return
          }
          host.playReplyChunk(st.unit, i, u.n, await blobToBase64(blob), 'opus')
          st.offered.add(i)
          st.fails = 0
          replyBytes.current += blob.size
        }
      } while (st.again && streaming.current === st)
    } catch {
      // Next tick or push retries. Nothing handed to the host yet means nothing will ever end this attempt: after a few
      // failed downloads of chunk 1 (taken back by a cancel, or a dead link) it is parked so the queue moves on. Once a
      // chunk is playing, the host's own chunk wait ends it.
      if (streaming.current === st && st.offered.size === 0 && ++st.fails >= 3) park(st.unit, 'its first chunk could not be downloaded')
    } finally {
      st.busy = false
    }
  }

  pump.current = async () => {
    const el = audioRef.current
    if (!el || playingKey.current) return
    // A reply must never play into the microphone: wait until the note is done.
    if (recordingRef.current || arming.current) return
    if (queue.current.length === 0) { playProgress(el); return }
    // The head, or (while the head still waits for its first chunk or its full file) the first later reply that is ready.
    const pick = nextUnit(queue.current, (k) => units.current.get(k), !!nativeChunks(), Date.now())
    if (!pick) return // the next tick or push brings the audio
    const { key, plan } = pick
    if (plan === 'give_up') {
      // A chunked reply that never completed (vox failed mid-reply, or a cancel took its chunks back) must not hold
      // the queue; its full file still plays if it lands later.
      park(key, nativeChunks() ? 'its first chunk never came' : 'no full file yet, and this host cannot play chunks')
      return
    }
    if (!unlockedRef.current) {
      if (!beaconsSent.current.has(`${key}:blocked`)) {
        beaconsSent.current.add(`${key}:blocked`)
        beacon(key, 'blocked')
      }
      setStatus('reply waiting — tap to play')
      return
    }
    playingKey.current = key // claim before any await so a second pump cannot start another reply
    let gate: Gate | null = null
    if (HOST_KIND === 'car') {
      // Exactly one of this car and the phone says it, and neither without the proxy's yes. A live hold is one: the hold is
      // renewed alongside the download and its answer looked at before the audio starts (passGate). Without one the hold
      // is claimed first: the phone's (this car was off, or out of reach, when it was up) is left to the phone, and no
      // answer leaves it at the head of the queue until the proxy answers (waitForProxy). The START is claimed when the
      // audio really starts (report 'started'), and the hold is renewed until then (the interval below).
      const how = startPlan(claims.current.get(key), Date.now())
      if (how === 'skip') { leaveToPhone(key); return }
      // No live hold yet (a fresh reply: its first hold is still out): the same answer is awaited, but alongside the
      // download instead of before it, with the 'claim' verdict (no answer = wait, not play) applied by passGate.
      gate = { answer: how === 'claim' ? holdFor(key) : claimReply(key, 'hold'), plan: how === 'claim' ? 'claim' : 'play' }
      if (playingKey.current !== key) return // interrupted while the claim was out
      if (recordingRef.current || arming.current) { playingKey.current = ''; return } // a note began meanwhile
    }
    if (plan === 'chunks') {
      // The host plays chunk after chunk as ONE reply and answers through __hnPlayback (started on chunk 1, ended
      // after the last). Recording stops all of it; the next pump offers it again, the full file if it is up by then.
      replyBytes.current = 0
      setLastReply(key)
      streaming.current = { unit: key, offered: new Set(), busy: false, again: false, fails: 0, gate }
      void feedStream()
      return
    }
    try {
      const blob = await getBlob(`${BUCKET_BASE}/${key}`)
      replyBytes.current = blob.size
      if (gate && !(await passGate(key, gate))) { if (playingKey.current === key) playingKey.current = ''; return }
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

  // Browser (no host speech queue): a progress clip plays in the same audio element, only when no reply is waiting.
  const playProgress = (el: HTMLAudioElement) => {
    if (!unlockedRef.current || nativeReply()) return
    const p = progressQ.current.shift()
    if (!p) return
    if (flights.current.get(p.memoId)?.finalAt) { pump.current(); return }
    playingKey.current = p.key
    playingProgress.current = true
    el.src = URL.createObjectURL(p.blob)
    el.play().catch(() => endProgress())
  }
  const endProgress = () => {
    playingKey.current = ''
    playingProgress.current = false
    pump.current()
  }

  // The phone took this reply (this car did not hold it in time): it is the phone's to say, never this car's as well.
  const leaveToPhone = (key: string) => {
    playingKey.current = ''
    setStatus('reply left to the phone')
    phoneTook.current.set(key, { at: Date.now(), checkedAt: Date.now() })
    setLedger(ledgerLeaveToPhone(ledger.current, key, Date.now())) // durable: a reload or a cold start keeps looking
    finish(key)
  }
  // The reply is settled as far as the phone list goes (reclaimed, claimed by a car, or too old to matter).
  const forgetPhoneTake = (key: string) => {
    phoneTook.current.delete(key)
    setLedger(takeBackFromPhone(ledger.current, key))
  }
  // The watcher gave the phone's take back (its Earshot drop failed): the reply is this car's again. It is taken up the way
  // a fresh reply is: the ledger owes it, its objects are listed, and the hold at ingest says whether it is the car's.
  const reclaimFromPhone = async (key: string) => {
    const left = phoneTook.current.get(key)?.at ?? ledger.current.phone[key]
    if (left === undefined) return
    forgetPhoneTake(key)
    enqueued.current.delete(key)
    claims.current.delete(key)
    setLedger(openUnit(ledger.current, key, Date.now()))
    try {
      const page = await listPage(key.slice(0, key.lastIndexOf('.')), '', null)
      for (const k of page.keys.sort()) ingestReply(k)
      setStatus('reply is the car\'s again')
    } catch { // the next look tries again
      phoneTook.current.set(key, { at: left, checkedAt: 0 })
      setLedger(ledgerLeaveToPhone(ledger.current, key, left))
    }
    pump.current()
  }
  const lookAtPhoneTake = async (key: string) => {
    const memo = memoOfReply(key)
    const t = phoneTook.current.get(key)
    if (!memo || !t) return
    t.checkedAt = Date.now()
    let has: 'phone' | 'free' | 'car' | 'unknown' = 'unknown'
    // ?reply=: this reply's own claim (a memo's follow-up is a second reply with a claim of its own, 2026-10-22)
    try { has = await fetchWithin(`/upload/claim?memo=${encodeURIComponent(memo)}&reply=${encodeURIComponent(key)}`, CLAIM_WAIT_MS, async (r) => phoneStillHas(r.status, await r.json().catch(() => null))) } catch { /* next look */ }
    if (has === 'free') await reclaimFromPhone(key)
    else if (has === 'car') forgetPhoneTake(key) // a car claimed it since (this one, before a reload): not played again from here
  }

  // No live hold and no answer from the proxy (it is down, or out of reach): the reply stays at the head of the queue,
  // its hold is renewed on every tick, and its start is asked again shortly. The watcher waits for the proxy too, so
  // the phone does not say it blind either.
  const waitForProxy = (key: string) => {
    if (playingKey.current === key) playingKey.current = ''
    setStatus('reply waiting for the upload proxy')
    window.setTimeout(() => pump.current(), CLAIM_RENEW_MS / 2)
  }

  // A hold renewed alongside the download, answered before the audio starts. The phone's (the proxy lost the hold) is left
  // to the phone. No answer plays on the live hold (renewed until the audio starts; the start is then claimed and, if the
  // proxy is still silent, re-sent until it has it). False: do not play it (the phone has it, or a note began, or another
  // pump moved on while the answer was out).
  const passGate = async (key: string, gate: Gate): Promise<boolean> => {
    const answer = await gate.answer
    const v = startVerdict(gate.plan, answer)
    if (v === 'skip') { leaveToPhone(key); return false }
    if (v === 'wait') { // 'claim' plan, no answer and no live hold: stays at the head of the queue, asked again shortly
      if (streaming.current?.unit === key) streaming.current = null
      waitForProxy(key)
      return false
    }
    return playingKey.current === key && !recordingRef.current && !arming.current
  }

  // A waiting reply renews this car's hold, so the phone copy stays out while the car still means to say it. A car that
  // was switched off stops renewing, and the phone takes it once the lease lapses.
  useEffect(() => {
    if (HOST_KIND !== 'car') return
    const t = window.setInterval(() => {
      const now = Date.now()
      for (const key of queue.current) {
        // A reply handed to the host keeps its hold until the audio really starts: the host's speech queue may hold it
        // back (another utterance, a recording), and the start is what claims it for good.
        const pending = key !== playingKey.current || !startedKeys.current.has(key)
        if (pending && units.current.has(key) && holdDue(claims.current.get(key), now)) void claimReply(key, 'hold')
      }
      for (const [key, t] of [...phoneTook.current]) {
        if (now - t.at >= PHONE_RECHECK_MAX_MS) forgetPhoneTake(key)
        else if (phoneRecheckDue(t.at, t.checkedAt, now)) void lookAtPhoneTake(key)
      }
      for (const [key, since] of [...unconfirmed.current]) {
        if (confirmDue(since, now)) void claimReply(key, 'start')
        else unconfirmed.current.delete(key)
      }
    }, CLAIM_RENEW_MS / 2)
    return () => window.clearInterval(t)
  }, [])

  // A reply that could not be played: retry a couple of times, then give it up so it never blocks the queue. A refused
  // or lost audio focus (`detail` focus_denied / focus_lost) is retried within a fraction of a second and is not a
  // strike, for a bounded number of tries (pace.ts): the reply was fine, the car's audio was busy for a moment.
  const playFailed = (key: string, text: string, detail = '') => {
    const focus = isFocusFailure(detail)
    const tries = focus ? (focusFails.current[key] = (focusFails.current[key] || 0) + 1) : 0
    if (!focus) delete focusFails.current[key]
    const plan = retryPlan(focus, tries)
    const n = plan.strike ? (loadFails.current[key] = (loadFails.current[key] || 0) + 1) : (loadFails.current[key] || 0)
    const msg = text.replace('play failed:', focus && !plan.strike ? `play failed (no audio focus, try ${tries}):` : `play failed (try ${n}):`).slice(0, 200)
    if (plan.strike && n >= PLAY_STRIKES) {
      delete focusFails.current[key]
      report('error', { error: msg })
      setStatus('reply could not play')
      if (!startedKeys.current.has(key)) void claimReply(key, 'release') // never heard: the phone may take it at once
      finish(key)
    } else {
      playingKey.current = ''
      speak({ t: 'failed', key })
      setStatus(msg)
      window.setTimeout(() => pump.current(), plan.delay)
    }
  }

  // The host's native player reports back here (started / ended / error), keyed by the reply it was given.
  useEffect(() => {
    ;(window as any).__hnPlayback = (key: string, phase: string, detail: string) => {
      if (key !== playingKey.current) return // a reply we already moved on from
      const chunked = streaming.current?.unit === key
      // A chunk never came: the rest of the reply is not there to play. Parked until its full file lands, not retried
      // (a retry would only say the first sentences again).
      if (chunked && phase === 'error' && detail === 'chunk_timeout' && !units.current.get(key)?.full) { park(key, 'a chunk never came'); return }
      // (a chunked reply's stream state is cleared by finish(), after the ended beacon has said how many chunks it had)
      if ((phase === 'deferred' || phase === 'error') && chunked) streaming.current = null
      if (phase === 'deferred') {
        // The host's speech queue stopped it (a note is starting): it stays at the head of the queue, not a failure,
        // unless it is the fast desk's own answer the driver just spoke over (dropBarged).
        playingKey.current = ''
        if (dropBarged(key, detail || 'recording')) return
        speak({ t: 'interrupted' })
        return
      }
      if (phase === 'started') { delete focusFails.current[key]; report('started'); setStatus('playing reply') }
      else if (phase === 'ended') { report('ended', { seconds: Number(detail) || undefined }); setStatus('reply played'); finish(key) }
      else playFailed(key, `play failed: ${detail || 'host player'}`, detail || '')
    }
    return () => { delete (window as any).__hnPlayback }
  })
  useEffect(() => {
    ;(window as any).__hnSpeech = (d: { memo_id?: string; kind?: string; id?: string } | null) => {
      const f = d?.memo_id ? flights.current.get(d.memo_id) : undefined
      speechEvent(f?.key || (d?.kind === 'ack' ? ackKey(String(d.id || '')) : ''), d)
    }
    return () => { delete (window as any).__hnSpeech }
  }, [])
  // The spoken ack is decided when Stop is pressed, before the upload, so the host cannot name its memo: the pad ties
  // each ack to the note it answers (the key is minted at record start), first sight wins. Then the proxy publishes it
  // as audio.memo.notified for that memo and memo:trace and /voice show the ack. "ack:stopped:*" answers the note just
  // recorded; "ack:sent:*" (the SENT tone, plus "Sent to X" after a retry) answers the send just announced.
  const noteKey = useRef('') // the note being recorded, or the one just stopped
  const sentKey = useRef('') // the recording whose send was just announced (live, or an outbox row that finally went out)
  const ackKeys = useRef<Map<string, string>>(new Map())
  const ackKey = (id: string): string => {
    const bound = ackKeys.current.get(id)
    if (bound !== undefined) return bound
    const key = id.startsWith('ack:stopped:') ? noteKey.current : id.startsWith('ack:sent:') ? sentKey.current : ''
    ackKeys.current.set(id, key)
    if (ackKeys.current.size > 50) ackKeys.current.delete(ackKeys.current.keys().next().value as string)
    return key
  }

  // A player that never reports the end (native host died, focus lost with no event) must not hold the queue or
  // keep a tile saying a reply is playing.
  // The limit is the reply's own length: from the element when it knows the duration, else bounded from its size
  // (vox Ogg/Opus runs ~30 kbit/s; 12 kbit/s is a safe floor), plus a minute.
  useEffect(() => {
    if (!speaking) return
    const el = audioRef.current
    const known = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : 0
    const bySize = (replyBytes.current * 8) / 12000 * 1000
    // A chunked reply's size is not known when it starts (its chunks are still rendering): give it the host's own
    // chunk wait on top, since the host ends it itself when a chunk never comes.
    const floor = streaming.current?.unit === speaking.key ? 120000 : 30000
    const limit = Math.max(known || bySize, floor) + 60000
    const t = window.setTimeout(() => {
      if (playingKey.current !== speaking.key) return
      try { nativeReply()?.stopReply?.() } catch { /* host bridge absent */ }
      try { audioRef.current?.pause() } catch { /* nothing playing */ }
      speak({ t: 'watchdog' })
      playFailed(speaking.key, `play failed: no end reported in ${Math.round(limit / 1000)} s`)
    }, limit)
    return () => window.clearTimeout(t)
  }, [speaking])

  // Stop whatever reply is playing (a note is about to be recorded): it stays at the head of the queue and plays
  // again when the note is done, unless it is the fast desk's own answer the driver is speaking over (dropBarged).
  const interruptReply = () => {
    if (!playingKey.current) return
    if (playingProgress.current) {
      try { audioRef.current?.pause() } catch { /* nothing playing */ }
      playingKey.current = ''
      playingProgress.current = false
      return
    }
    const key = playingKey.current
    try { nativeReply()?.stopReply?.() } catch { /* host bridge absent */ }
    try { audioRef.current?.pause() } catch { /* nothing playing */ }
    playingKey.current = ''
    streaming.current = null
    if (dropBarged(key, 'stopped')) return
    speak({ t: 'interrupted' })
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
    el.play().then(() => { unlockedRef.current = true; setSoundUnlocked(true); setStatus('sound on'); pump.current() }, () => {})
  }, [])

  // Poll for replies newer than lastDone (across UTC midnight and any number of keys), queue the fresh ones in
  // order, and say so (beacon 'skipped') about any recent reply the pad chooses not to play.
  useEffect(() => {
    const tick = async () => {
      await ready.current // the ledger (which replies are this pad's) is read before any reply is judged
      try {
        await reopenOwed()
        // First run on this device (nothing stored): old replies are history, not missed news. Skip them
        // silently instead of publishing a 'skipped' fact for memos that finished long ago.
        const firstRun = !lastDone.current
        // From the marker, or from the oldest reply still owed if that is older (the marker can move past a reply that
        // waits for its full file or its next chunk: another device's reply settled, or a later one played first).
        const owed = Object.entries(ledger.current.open).filter(([k, o]) => !o.parked && !parked.current.has(k))
          .map(([k]) => k.slice(0, k.lastIndexOf('.')))
        const after = [lastDone.current || `${REPLIES_PREFIX}/${dayPrefix(-1)}/`, ...owed].sort()[0]
        // Only dated reply keys count: legacy flat keys (replies/2026101...) sort AFTER every dated key and would
        // otherwise pin lastDone past all future replies.
        // A reply's chunks (replies/...-cNNofMM.opus) join its unit; parseReplyKey keeps only dated keys.
        const keys = (await listRepliesAfter(after)).filter((k) => parseReplyKey(k))
        for (const key of keys.sort()) ingestReply(key, firstRun)
        if (parked.current.size) await checkParked()
        pump.current()
        void feedStream()
      } catch {
        // network blip, next poll
      }
      if (flights.current.size) await pollFlightsRef.current()
    }
    let t = 0
    let stopped = false
    let busy = false
    let again = false
    const loop = async () => {
      window.clearTimeout(t)
      if (busy) { again = true; return } // one chain only: a wake during a tick runs one more tick after it
      busy = true
      try { await tick() } finally { busy = false }
      if (stopped) return
      if (again) { again = false; void loop(); return }
      t = window.setTimeout(loop, replyPollMs(lastSentAt.current, Date.now(), pushLive(push.current.heardAt, push.current.nats, Date.now()), flights.current.size > 0))
    }
    pollNow.current = () => { if (!stopped) void loop() } // a note just went out: switch to the fast cadence now
    void loop()
    return () => { stopped = true; window.clearTimeout(t); pollNow.current = () => {} }
  }, [])

  // ---- push channel: the upload proxy streams the memo facts (/upload/events, push.ts) so a reply, a reply chunk, a
  // progress clip or a stage change reaches the pad the moment it is up. Polling above stays the fallback: a dead or
  // stale stream only makes the pad slower, never wrong. Reconnects on its own (EventSource), and from scratch when the
  // stream was closed for good or went quiet for PUSH_STALE_MS (a half-open edge connection).
  const onPushRef = useRef<(ev: PushEvent) => void>(() => {})
  onPushRef.current = (ev) => {
    const f = flights.current.get(ev.memo_id)
    // offered: the proxy pushes a one-file reply the moment it is up, before the watcher's replied fact (which waits to
    // know who speaks it).
    if (ev.fact === 'voiced' || ev.fact === 'replied' || ev.fact === 'offered') {
      const key = ev.fact === 'voiced' ? ev.chunk_s3_key : ev.reply_s3_key
      if (f) flightFinal(ev.memo_id)
      if (key && ingestReply(key)) pump.current()
      return
    }
    if (ev.fact === 'released') { // the watcher gave the phone's take on a reply back: this car plays it after all
      const unit = ev.reply_s3_key
      if (unit && (phoneTook.current.has(unit) || unit in ledger.current.phone)) void reclaimFromPhone(unit)
      return
    }
    if (ev.fact === 'narrated' && f && !f.finalAt && ev.progress_s3_key && ev.narration) {
      const pick = newestProgress([ev.progress_s3_key], f.day, f.memoId, f.progressSeq)
      if (pick) void sayProgress(f, pick).catch(() => { /* the poll lists it again */ })
    }
    // Any other step of a memo in flight (heard, working, a progress line, a failure): re-read its status object.
    if (f && !f.finalAt) pollFlightSoon(ev.memo_id)
  }
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let stopped = false
    let failures = 0
    let retry = 0
    let openedAt = 0
    const heard = (nats?: unknown) => {
      push.current.heardAt = Date.now()
      if (typeof nats === 'boolean') push.current.nats = nats
    }
    const data = (e: Event) => { try { return JSON.parse((e as MessageEvent).data) } catch { return null } }
    const close = () => { try { es?.close() } catch { /* already closed */ } es = null; push.current.heardAt = 0 }
    const open = () => {
      if (stopped || es) return
      // device + host: the proxy knows which car is live, so the watcher can leave the Earshot phone copy out for it.
      const url = `/upload/events?device=${encodeURIComponent(DEVICE.id)}&host=${HOST_KIND}`
      try { es = new EventSource(url) } catch { schedule(); return }
      openedAt = Date.now()
      es.addEventListener('hello', (e) => { failures = 0; heard(data(e)?.nats); pollNow.current() }) // catch up on what a gap missed
      es.addEventListener('beat', (e) => heard(data(e)?.nats))
      es.addEventListener('resync', () => { heard(); pollNow.current() })
      es.addEventListener('memo', (e) => {
        heard()
        const ev = parsePush((e as MessageEvent).data)
        if (ev) { try { onPushRef.current(ev) } catch { /* never let one event stop the stream */ } }
      })
      // CONNECTING: the browser retries by itself (retry: 3000). CLOSED: an error status, start again with a backoff.
      es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) { close(); schedule() } }
    }
    const schedule = () => {
      window.clearTimeout(retry)
      if (!stopped) retry = window.setTimeout(open, pushBackoff(failures++))
    }
    void ready.current!.then(open)
    // A stream that stopped speaking is dropped and opened again (the proxy beats every 15 s).
    const watch = window.setInterval(() => {
      const last = push.current.heardAt || openedAt
      if (es && es.readyState !== EventSource.CLOSED && last && Date.now() - last > PUSH_STALE_MS) { close(); schedule() }
    }, 10_000)
    return () => { stopped = true; window.clearTimeout(retry); window.clearInterval(watch); close() }
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
  const countOutbox = useCallback((rows: Pending[]) => {
    const waiting = retryable(rows).length
    setOutboxCount(waiting)
    setRejectedCount(rows.length - waiting)
    setRejectedAt(newestRejectedAt(rows))
  }, [])
  // The proxy refused this recording for good (a final refusal it authored). The audio stays in the outbox, marked,
  // and the slow timer tries it again about hourly; the hero shows it while the refusal is fresh and the device event
  // says why. 5xx and network failures never come here. `live`: the send that owns the pad's phase just ended, so the
  // phase may be set.
  const holdRejected = useCallback(async (p: Pending, e: UploadRejected, agentId: string | undefined, live: boolean) => {
    await outboxPut({ ...p, attempts: p.attempts + 1, rejected: { status: e.status, reason: e.reason, at: p.rejected?.at ?? Date.now() } })
    const why = rejectionText(e.status, e.reason)
    countOutbox(await outboxAll())
    // A background retry must not overwrite a note being recorded or sent.
    if (live) setPhase('rejected')
    else setPhase((cur) => (cur === 'idle' || cur === 'sent' || cur === 'queued' ? 'rejected' : cur))
    setStatus(`NOT accepted (${why.slice(0, 80)}) - kept on this device, retrying hourly`)
    // Said once per recording: for the send the driver just made, or the first time a saved row is refused. The
    // hourly self-heal (and every pad start) retrying rows that are still refused is not news the driver can act on.
    // reason 'retry': a saved row refused for the first time by a background retry, not the note just recorded (the car app
    // pairs each note's STOP with the one answer that follows it, and this is not that note's answer).
    if (live || !p.rejected) emitHost({ t: 'rejected', id: agentId, name: p.agentName, reason: live ? String(e.status) : 'retry' })
    // An 'unroutable_agent' refusal already published its terminal failed fact at the proxy: a second one here
    // would show the same memo failing twice in /voice. Other final refusals are only visible from the device.
    if (e.code !== 'unroutable_agent') {
      clientEvent({ event: 'upload_failed', key: p.key, error: why, code: 'upload_rejected', attempts: p.attempts + 1, retryable: false })
    }
  }, [countOutbox])
  // One outbox row's turn at a send: delete it on success, mark it on a final refusal, keep it otherwise.
  const sendPending = useCallback(async (p: Pending) => {
    if (!flight.begin(p.key)) return
    try {
      await ownMemo(p.key) // a row saved before replies were scoped to the sending device
      await putObject(p.key, p.blob, p.capture)
      noteSent()
      await outboxDel(p.key)
      clientEvent({ event: 'upload_recovered', key: p.key, attempts: p.attempts + 1 })
      setStatus(`sent → ${p.agentName} (after a retry)`)
      sentKey.current = p.key
      emitHost({ t: 'sent', name: p.agentName, reason: 'retry' })
      const agentId = /^inbox\/([^/]+)\//.exec(p.key)?.[1]
      if (agentId) void trackMemo(agentId, p.agentName, p.key)
    } catch (e) {
      if (e instanceof UploadRejected) await holdRejected(p, e, undefined, false)
      else await outboxPut({ ...p, attempts: p.attempts + 1 })
    } finally {
      flight.end(p.key)
    }
  }, [flight, holdRejected])
  const flushOutbox = useCallback(async () => {
    const all = flight.idle(await outboxAll()) // a recording a live send still owns is not "waiting"
    const waiting = retryable(all)
    countOutbox(all)
    for (const p of waiting) await sendPending(p)
    if (waiting.length) countOutbox(flight.idle(await outboxAll()))
    await flushEvents()
  }, [flight, countOutbox, sendPending])
  // The rejected rows' slow self-heal: once at pad start and about hourly, so a refusal that no longer holds
  // (agent routable again, an edge answered in the proxy's place) clears itself instead of nagging forever.
  const retryRejected = useCallback(async () => {
    const all = flight.idle(await outboxAll())
    const held = all.filter((p) => p.rejected)
    for (const p of held) await sendPending(p)
    if (held.length) countOutbox(flight.idle(await outboxAll()))
  }, [flight, countOutbox, sendPending])
  useEffect(() => {
    void flushOutbox()
    void retryRejected()
    const t = window.setInterval(() => void flushOutbox(), 30000)
    const slow = window.setInterval(() => void retryRejected(), REJECTED_RETRY_MS)
    const on = () => void flushOutbox()
    window.addEventListener('online', on)
    return () => { window.clearInterval(t); window.clearInterval(slow); window.removeEventListener('online', on) }
  }, [flushOutbox, retryRejected])

  // Send a finished recording: a few quick retries holding the blob; if the network is really gone, keep it
  // in the outbox (IndexedDB) and say so, so nothing recorded in the car is ever thrown away silently.
  const sendRecording = useCallback(async (agent: Agent, key: string, blob: Blob, capture?: Capture) => {
    if (!flight.begin(key)) return
    setPhase('sending')
    // The outbox is written BEFORE the first attempt and cleared on success: if the app is backgrounded, killed or
    // loses the network mid-send, the recording is still on disk and the retry timer finishes the job.
    await ownMemo(key) // its reply is this pad's to play, however fast it comes back
    // The outbox row is written WHILE the first PUT runs, not before it (the write used to sit ahead of the upload):
    // durability is unchanged because the row is awaited before it is deleted, and a PUT that fails finds it written.
    const stored = outboxPut({ key, agentName: agent.name, blob, attempts: 0, at: Date.now(), capture }).then(() => true, () => false)
    try {
      void memoIdFor(key).then((memo) => setMemoShort(memo ? memo.slice(0, 8) : null))
      const delays = [0, 1500, 4000, 10000, 20000]
      let lastErr = ''
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) {
          setStatus(`upload failed, retrying (${i}/${delays.length - 1})…`)
          await new Promise((r) => setTimeout(r, delays[i]))
        }
        try {
          const rowWritten = stored // settled long ago on a retry; on the first PUT it is awaited only now
          await putObject(key, blob, capture)
          noteSent()
          await rowWritten
          await outboxDel(key)
          setStatus(`sent → ${agent.name}`)
          setPhase('sent')
          sentKey.current = key
          emitHost({ t: 'sent', id: agent.id, name: agent.name })
          void trackMemo(agent.id, agent.name, key)
          if (i > 0) clientEvent({ event: 'upload_recovered', key, attempts: i + 1 })
          return
        } catch (e) {
          await stored // the first row write is done before any later write to the same row
          if (e instanceof UploadRejected) {
            // Retrying a refusal only repeats it: keep the audio, stop here.
            await holdRejected({ key, agentName: agent.name, blob, attempts: i, at: Date.now(), capture }, e, agent.id, true)
            return
          }
          lastErr = (e as Error).message || String(e)
        }
      }
      await outboxPut({ key, agentName: agent.name, blob, attempts: delays.length, at: Date.now(), capture })
      countOutbox(await outboxAll())
      setStatus(`NOT sent (${lastErr.replace(/^PUT \S+: /, 'HTTP ').slice(0, 40)}) - saved, retrying`)
      setPhase('queued')
      emitHost({ t: 'queued', id: agent.id, name: agent.name })
      clientEvent({ event: 'upload_failed', key, error: lastErr, attempts: delays.length, retryable: true })
    } finally {
      flight.end(key)
    }
  }, [flight, countOutbox, holdRejected])

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
    // One start at a time: a second tap while the mic is opening would cut the "Recording for X" prompt and say it
    // again, and leave the first start waiting for an answer that goes to the second (the wheel path already refuses).
    if (arming.current || recordingRef.current) return
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
      noteKey.current = key
      const w = window as any
      arming.current = true
      discardRef.current = false
      setPhase('arming')
      const started = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        // A host that never answers (its arming watchdog gave up after 15 s) must not leave the pad refusing every
        // later start: after 20 s this start counts as interrupted.
        const t = window.setTimeout(() => resolve({ ok: false, err: 'interrupted' }), 20000)
        w.__hnStarted = (ok: boolean, err: string) => { window.clearTimeout(t); resolve({ ok, err }) }
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
      recordingRef.current = true // at once, not only after the next render: no pump in between
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
    // Arming from here until the recorder runs: nothing may (re)start a reply or a progress clip in the audio element
    // while getUserMedia is pending (a few hundred ms, seconds on a first permission prompt) - pump() checks this.
    arming.current = true
    setPhase('arming')
    const disarm = (to: PadPhase) => { arming.current = false; setPhase(to) }
    try {
      // A permission prompt left unanswered (or a getUserMedia that never settles) must not leave the pad arming for
      // good: after 20 s this start fails; a stream that shows up after that is closed at once.
      let late = false
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => {
          if (late) st.getTracks().forEach((t) => t.stop())
          return st
        }),
        new Promise<never>((_, reject) => setTimeout(() => { late = true; reject(Object.assign(new Error('no answer in 20 s'), { name: 'Timeout' })) }, 20000)),
      ])
    } catch (e) {
      disarm('error')
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
      try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) { mimeType = t; break } } catch { /* none */ }
    }
    if (!mimeType) {
      disarm('error')
      setStatus('no supported audio format on this browser')
      clientEvent({ event: 'record_failed', key: kBrowser, error: 'no supported MediaRecorder mime type', code: 'no_format', retryable: false })
      closeStream()
      return
    }
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const key = mk(ext)
    noteKey.current = key
    let mr: MediaRecorder
    try {
      mr = new MediaRecorder(stream, { mimeType })
    } catch (e) {
      disarm('error') // never left arming (which would hold every reply and every later start)
      setStatus(`mic unavailable: ${(e as Error).name}`)
      clientEvent({ event: 'record_failed', key, error: `MediaRecorder: ${(e as Error).name}`, code: 'mic_unavailable', retryable: false })
      closeStream()
      return
    }
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
    // Anything that slipped in anyway is stopped before the mic records, and the recording flag is up at once (not
    // only after the next render) so no pump between here and that render starts audio into the note.
    interruptReply()
    recordingRef.current = true
    arming.current = false
    try {
      mr.start()
    } catch (e) {
      recordingRef.current = false
      disarm('error')
      setStatus(`mic unavailable: ${(e as Error).name}`)
      clientEvent({ event: 'record_failed', key, error: `MediaRecorder.start: ${(e as Error).name}`, code: 'mic_unavailable', retryable: false })
      analyser.current?.stop()
      analyser.current = null
      closeStream()
      return
    }
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
    emitHost({ t: 'stopped', id: agent.id, name: stopAckName(HOST_KIND, agent.name), reason: 'auto' })
  }

  const stopRecording = useCallback(() => {
    stopEmitted.current = true
    // The car says the short "Got it, sending." (pace.ts): the name was said at the start, and the reply waits behind it.
    emitHost({ t: 'stopped', name: stopAckName(HOST_KIND, selectedRef.current?.name) })
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
    savedAgent.current = a.id
    lsSet(LS_AGENT, a.id)
    void agentDbSet(a.id)
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
  const pendingRoster = useRef<{ list: Agent[]; cached?: boolean; generatedAt: number | null } | null>(null)
  const rosterSeen = useRef(false) // a fetched roster has been applied: a late cache read must not undo it
  // Bring the remembered agent back as a selection (never a recording). Only when nothing is selected, so a tap that
  // beat the IndexedDB read wins; dropped only by a roster the server just answered.
  const restoreAgent = useCallback((list: Agent[], authoritative: boolean) => {
    if (selectedRef.current) return
    const { pick, drop } = restoreSelection(list, savedAgent.current, authoritative)
    if (pick) setSelected(pick)
    else if (drop) { savedAgent.current = ''; lsSet(LS_AGENT, ''); void agentDbSet('') }
  }, [])
  const applyRoster = useCallback(() => {
    const p = pendingRoster.current
    if (!p || recordingRef.current || arming.current) return
    pendingRoster.current = null
    if (p.cached && rosterSeen.current) return
    if (!p.cached) { rosterSeen.current = true; rosterSet(p.list, p.generatedAt) }
    setRosterReady(true)
    restoreAgent(p.list, !p.cached)
    if (sameRoster(agentsRef.current, p.list)) return
    setAgents(p.list)
    // The selected agent keeps its selection with its new name and picture; one that left the roster stays
    // selected (its memos still route until the registry says otherwise), it is just no longer listed.
    setSelected((s) => (s ? p.list.find((x) => x.id === s.id) ?? s : null))
  }, [restoreAgent])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(ROSTER_URL, { cache: 'no-cache' })
        if (!r.ok) throw new Error(String(r.status))
        // Age is measured on the server's clock: a fast head-unit clock must not flag a fresh list.
        const clockOffset = serverClockOffset(r.headers.get('date'), Date.now())
        const text = await r.text()
        const list = normRoster(text)
        if (!alive) return
        if (!list) throw new Error('no roster in the answer')
        // The stamp is the server's; a roster without one counts as fresh now (it was just served).
        const generatedAt = rosterGeneratedAt(text) ?? Date.now() + clockOffset
        fetchedMeta.current = true
        setRosterMeta({ generatedAt, failures: 0, clockOffset })
        pendingRoster.current = { list, generatedAt }
        applyRoster()
      } catch {
        // offline or a bad answer: keep the cached roster; only consecutive failures say it is not refreshing
        if (alive) setRosterMeta((m) => ({ ...m, failures: m.failures + 1 }))
      }
    }
    void rosterDbGet().then((got) => {
      // A fetched roster that already landed wins over the cached one.
      if (!alive || !got || pendingRoster.current || rosterSeen.current) return
      if (!fetchedMeta.current) setRosterMeta((m) => ({ ...m, generatedAt: got.generatedAt }))
      pendingRoster.current = { list: got.list, cached: true, generatedAt: got.generatedAt }
      applyRoster()
    })
    // The remembered agent (IndexedDB), when localStorage came back empty. Restored against whatever list is showing.
    void agentDbGet().then((id) => {
      if (!alive || !id || savedAgent.current) return
      savedAgent.current = id
      restoreAgent(agentsRef.current, rosterSeen.current)
    })
    void load()
    const wait = window.setTimeout(() => setRosterReady(true), ROSTER_WAIT_MS)
    const t = window.setInterval(load, ROSTER_POLL_MS)
    const clock = window.setInterval(() => setClock(Date.now()), ROSTER_CLOCK_MS)
    const onVis = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; window.clearTimeout(wait); window.clearInterval(t); window.clearInterval(clock); document.removeEventListener('visibilitychange', onVis) }
  }, [applyRoster, restoreAgent])
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
  // The tile line's clock: a once-a-second text change while a memo is in flight (no motion, so fine while driving).
  const [tick, setTick] = useState(Date.now)
  const anyFlight = Object.keys(flightView).length > 0
  useEffect(() => {
    if (!anyFlight) return
    const t = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [anyFlight])
  const progressMax = host.noText ? 0 : host.driving ? (host.maxLabel > 0 ? Math.min(28, host.maxLabel) : 28) : 60
  const workLine = (agentId: string): string | null => {
    const v = flightView[agentId]
    return v ? statusLine(v.status, elapsedSeconds(v.status, v.fetchedAt, v.sentAt, tick), progressMax) : null
  }
  const workingAgent = Object.entries(flightView).sort((x, y) => y[1].sentAt - x[1].sentAt)[0]?.[0]
  const canRecord = !!selected
  const label = (n: string) => (host.maxLabel > 0 && n.length > host.maxLabel ? n.slice(0, host.maxLabel) : n)
  const statusText = recording ? `Recording for ${selected?.name ?? ''}…` : status
  const tiles = !rosterReady ? [] : host.driving ? driveTiles(agents, selected?.id, host.maxItems > 0 ? Math.min(DRIVE_TILES, host.maxItems) : DRIVE_TILES, speaking?.agent ?? workingAgent) : agents
  const stale = rosterStaleness(rosterMeta, clock + rosterMeta.clockOffset)
  const rejectedText = `${rejectedCount} recording${rejectedCount > 1 ? 's' : ''} not accepted by the server, kept on this device`
  // Driving: one short static line under the hero, in the hsound size (secondary to the name and state), only while no
  // note is being recorded. A fresh refusal outranks an old list: it is audio the driver thinks went somewhere. It
  // fades ~30 min after the newest rejection (or on the next successful send); the parked status keeps the count.
  const heroNote = recording ? '' : nagRejected(rejectedCount, rejectedAt, lastSentAt.current, clock) ? `${rejectedCount} note${rejectedCount > 1 ? 's' : ''} not sent, saved` : stale ? stalenessText(stale, true) : ''

  return (
    <div className={`pad${host.driving ? ' drive' : ''}${host.noVideo || host.driving ? ' still' : ''}`}>
      <style>{CSS}</style>
      {host.driving && (
        <div className="hero" data-phase={phase} style={{ ['--c' as string]: selected?.color ?? '#5a6275' }} aria-live="polite">
          <div className="hname">{selected ? label(selected.name) : 'Pick an agent'}</div>
          <div className="hstate">{speaking && phase !== 'recording' && phase !== 'arming' ? replyLabel(speaking.agent, selected?.id, agents, label) : PHASE_LABEL[phase]}</div>
          {recording && <div className="hsound">{heard ? 'Sound heard' : waited ? 'No sound yet' : ''}</div>}
          {heroNote && <div className="hsound hnote">{heroNote}</div>}
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
          const work = workLine(a.id)
          return (
            <button
              key={a.id}
              data-agent={a.id}
              role="radio"
              aria-checked={on}
              className={`tile${on ? ' on' : ''}${speaking?.agent === a.id ? ' speaking' : ''}`}
              disabled={(recording || phase === 'arming') && !on}
              onClick={() => chooseAgent(a)}
              style={{ ['--c' as string]: a.color }}
            >
              <Swatch a={a} />
              <span className="name">{label(a.name)}</span>
              {work && <span className="work">{work}</span>}
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
          disabled={!canRecord || (phase === 'arming' && !recording)}
          style={{ ['--c' as string]: selected?.color ?? '#444' }}
        >
          {recording && <span className="dot" />}
          {recording ? 'Stop & Send' : phase === 'arming' ? 'Starting…' : selected ? `Record for ${label(selected.name)}` : 'Pick an agent'}
        </button>
        <div className="status" aria-live="polite">
          {statusText}
          {outboxCount > 0 && <small className="warn">{outboxCount} recording{outboxCount > 1 ? 's' : ''} waiting to upload</small>}
          {rejectedCount > 0 && <small className="warn">{rejectedText}</small>}
          {stale && <small className="warn">{stalenessText(stale)}</small>}
          {memoShort && <small>memo {memoShort} · mise run memo:trace {memoShort}</small>}
          {lastReply && <small>last reply: {lastReply.split('/').pop()}</small>}
        </div>
      </div>
      <audio
        ref={audioRef}
        style={{ display: 'none' }}
        onPlaying={() => { if (playingKey.current && !playingProgress.current) { report('started'); setStatus('playing reply') } }}
        onEnded={(e) => {
          if (playingProgress.current) { endProgress(); return }
          const key = playingKey.current
          if (!key) return
          report('ended', { seconds: (e.currentTarget as HTMLAudioElement).duration })
          setStatus('reply played')
          finish(key)
        }}
        onError={(e) => {
          if (playingProgress.current) { endProgress(); return }
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
.tiles { display:grid; grid-template-columns:repeat(2,1fr); grid-auto-rows:max-content; align-content:start; gap:clamp(8px,1.4vw,16px); flex:1 1 auto; min-height:0; max-height:400px; overflow-y:auto; overscroll-behavior:contain; padding:12px; }
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
.tile .work { max-width:100%; font-size:clamp(16px,1.8vw,22px); font-weight:600; line-height:1.15; text-align:center; color:#cfe0ff; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
.tile .check { position:absolute; top:8px; right:12px; font-size:30px; font-weight:800; color:var(--c); }
/* The agent whose reply is playing: a bouncy border in its colour (HOLOC-14). */
.tile.speaking { border:5px solid var(--c); padding:5px; animation:speak-bounce .9s ease-in-out infinite; }
.tile.speaking .swatch { animation:speak-pop .9s ease-in-out infinite; }
@keyframes speak-bounce { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--c) 70%, transparent); transform:translateY(0); } 40% { box-shadow:0 0 0 10px color-mix(in srgb, var(--c) 0%, transparent); transform:translateY(-6px); } 60% { transform:translateY(0); } }
@keyframes speak-pop { 0%,100% { transform:scale(1); } 40% { transform:scale(1.08); } }
@media (prefers-reduced-motion: reduce) { .tile.speaking, .tile.speaking .swatch { animation:none; } .tile.speaking { box-shadow:0 0 0 6px color-mix(in srgb, var(--c) 45%, transparent); } }
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
.drive .hsound.hnote { color:#ffb454; }
.hero[data-phase="recording"] { background:#7a1d16; border-color:#ff5b4d; }
.hero[data-phase="sent"] { background:#12361f; border-color:#2ecc71; }
.hero[data-phase="queued"], .hero[data-phase="rejected"], .hero[data-phase="silent"], .hero[data-phase="error"] { background:#3a2a0e; border-color:#ffb454; }
.drive .tiles { grid-template-columns:repeat(5,1fr); grid-auto-rows:1fr; align-content:stretch; max-height:none; overflow:hidden; padding:6px; flex:1 1 0; min-height:0; }
.drive .tile { min-height:0; padding:4px; border-radius:18px; }
.drive .tile:not(.on) { opacity:.78; }
.drive .tile.on { opacity:1; border-width:9px; padding:0; box-shadow:0 0 0 5px color-mix(in srgb, var(--c) 45%, transparent); }
/* Driving is motion-free (.still): the replying agent's tile is filled with its colour instead of bouncing. */
.drive .tile.speaking, .drive .tile.on.speaking { background:var(--c); border-color:#fff; opacity:1; }
.drive .tile.speaking .name { color:#fff; text-shadow:0 1px 2px #000, 0 0 6px rgba(0,0,0,.85); }
.drive .tile.speaking .swatch { box-shadow:0 0 0 4px #fff, 0 0 0 7px rgba(0,0,0,.55); }
.drive .tile .swatch { width:clamp(64px,16vh,140px); height:clamp(64px,16vh,140px); font-size:clamp(30px,7vh,64px); }
.drive .tile .name { font-size:clamp(24px,4.4vh,38px); font-weight:800; }
.drive .tile .work { font-size:clamp(18px,3vh,26px); font-weight:700; }
.drive .tile.speaking .work { color:#fff; text-shadow:0 1px 2px #000; }
.drive .bar { flex:1.25 1 0; min-height:0; }
.drive .rec { flex:1 1 100%; height:100%; min-height:0; border-radius:36px; font-size:clamp(36px,9vh,84px); }
.drive .rec.live { background:#d93a2b; }
.drive .status, .drive .unlock, .drive .silent { display:none; }
.linkbtn { align-self:flex-start; background:none; border:none; padding:10px 0; min-height:48px; color:#8ab4ff; font-size:clamp(18px,2vw,24px); text-decoration:underline; cursor:pointer; }
`

createRoot(document.getElementById('root')!).render(<App />)

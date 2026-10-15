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

function todayPrefix(): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}

function ts(): string {
  const d = new Date()
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
}

async function listKeys(prefix: string): Promise<string[]> {
  const url = `${BUCKET_BASE}?list-type=2&prefix=${prefix}/&max-keys=50`
  const res = await fetch(url)
  const text = await res.text()
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'application/xml')
  return Array.from(doc.querySelectorAll('Key')).map((k) => k.textContent || '')
}

async function putObject(key: string, blob: Blob): Promise<void> {
  // Upload via the proxy (same origin) so credentials stay server-side
  const res = await fetch(`/upload/${key}`, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  })
  if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`)
}

async function getBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
  return res.blob()
}

function App() {
  const [selected, setSelected] = useState<Agent | null>(null)
  const [recording, setRecording] = useState(false)
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [soundUnlocked, setSoundUnlocked] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const nativeActive = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pollTimer = useRef<number | null>(null)
  const lastPlayedKey = useRef<string>('')

  // Unlock audio on first user gesture (browser autoplay policy)
  const unlockAudio = useCallback(async () => {
    if (!audioRef.current) return
    try {
      audioRef.current.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
      await audioRef.current.play()
      setSoundUnlocked(true)
      setStatus('sound on')
      // If a reply arrived while locked, play it now
      if (pendingUrl) {
        audioRef.current.src = pendingUrl
        await audioRef.current.play()
        setPendingUrl(null)
      }
    } catch {
      setStatus('tap again to enable sound')
    }
  }, [pendingUrl])

  // Silent unlock on mount: succeeds inside the Holocene Auto WebView (no gesture required),
  // fails quietly in normal browsers where the "Tap to enable sound" button stays.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
    el.play().then(() => { setSoundUnlocked(true); setStatus('sound on') }, () => {})
  }, [])

  // Watch replies box and play newest unplayed
  useEffect(() => {
    const tick = async () => {
      try {
        const keys = await listKeys(`${REPLIES_PREFIX}/${todayPrefix()}`)
        const audioExts = ['.ogg', '.webm', '.m4a', '.mp3']
        const ogg = keys.filter((k) => audioExts.some(ext => k.endsWith(ext)) && k > lastPlayedKey.current)
        if (ogg.length > 0) {
          const newest = ogg.sort().pop()!
          const blob = await getBlob(`${BUCKET_BASE}/${newest}`)
          const url = URL.createObjectURL(blob)
          if (audioRef.current) {
            if (soundUnlocked) {
              audioRef.current.src = url
              await audioRef.current.play()
            } else {
              // Queue it; unlockAudio will play it after the first tap
              setPendingUrl(url)
              setStatus('reply waiting — tap to play')
            }
            setLastReply(newest)
            lastPlayedKey.current = newest
          }
        }
      } catch {
        // network blip, next poll
      }
    }
    pollTimer.current = window.setInterval(tick, 15000)
    tick()
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current) }
  }, [soundUnlocked])

  const startRecording = useCallback(async () => {
    if (!selected) return
    // Inside the Holocene Auto app the WebView's own mic capture is unreliable on car audio stacks,
    // so the host injects a native recorder. Same upload path, different capture source.
    const native = (window as any).HoloceneNative as { start(): void; stop(): void; micClosed?(): void } | undefined
    if (native) {
      const agent = selected
      const w = window as any
      const started = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        w.__hnStarted = (ok: boolean, err: string) => resolve({ ok, err })
        native.start()
      })
      if (!started.ok) { setStatus(`mic unavailable: ${started.err || 'unknown'}`); return }
      nativeActive.current = true
      w.__hnStopped = async (b64: string, mime: string) => {
        nativeActive.current = false
        setRecording(false)
        if (!b64) { setStatus('no audio captured'); return }
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: mime })
        const key = `${INBOX_PREFIX}/${agent.id}/${todayPrefix()}/${ts()}.ogg`
        try {
          await putObject(key, blob)
          setStatus(`sent → ${agent.name}`)
        } catch (e) {
          setStatus(`upload failed: ${(e as Error).message}`)
        }
      }
      setRecording(true)
      setStatus(`🔴 recording for ${agent.name}… tap Stop to send`)
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setStatus(`mic unavailable: ${(e as Error).name}`)
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
      closeStream()
      return
    }
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const mr = new MediaRecorder(stream, { mimeType })
    mediaRecorder.current = mr
    chunks.current = []
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(chunks.current, { type: mimeType })
      if (blob.size === 0) {
        setStatus('no audio captured')
        closeStream()
        setRecording(false)
        return
      }
      const key = `${INBOX_PREFIX}/${selected.id}/${todayPrefix()}/${ts()}.${ext}`
      try {
        await putObject(key, blob)
        setStatus(`sent → ${selected.name}`)
      } catch (e) {
        setStatus(`upload failed: ${(e as Error).message}`)
      }
      closeStream()
      setRecording(false)
    }
    mr.start()
    setRecording(true)
    setStatus(`🔴 recording for ${selected.name}… tap Stop to send`)
  }, [selected])

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
          {lastReply && <small>last reply: {lastReply.split('/').pop()}</small>}
        </div>
      </div>
      <audio ref={audioRef} style={{ display: 'none' }} />
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
.status small { display:block; margin-top:4px; font-size:clamp(14px,1.6vw,18px); font-weight:400; opacity:.6; }
`

createRoot(document.getElementById('root')!).render(<App />)

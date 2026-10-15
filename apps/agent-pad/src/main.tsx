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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Chrome/Android support webm; Safari supports mp4. Pick the first that works.
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    let mimeType = ''
    for (const t of mimeTypes) {
      if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break }
    }
    if (!mimeType) {
      setStatus('no supported audio format on this browser')
      stream.getTracks().forEach(t => t.stop())
      return
    }
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
    const mr = new MediaRecorder(stream, { mimeType })
    mediaRecorder.current = mr
    chunks.current = []
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data) }
    mr.onstop = async () => {
      const blob = new Blob(chunks.current, { type: mimeType })
      const key = `${INBOX_PREFIX}/${selected.id}/${todayPrefix()}/${ts()}.${ext}`
      try {
        await putObject(key, blob)
        setStatus(`sent → ${selected.name}`)
      } catch (e) {
        setStatus(`upload failed: ${(e as Error).message}`)
      }
      stream.getTracks().forEach((t) => t.stop())
      setRecording(false)
    }
    mr.start()
    setRecording(true)
    setStatus(`🔴 recording for ${selected.name}… tap Stop to send`)
  }, [selected])

  const stopRecording = useCallback(() => {
    mediaRecorder.current?.stop()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}>
      <style>{`
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
      `}</style>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Agent Pad</h1>
      {!soundUnlocked && (
        <button
          onClick={unlockAudio}
          style={{
            padding: '16px 24px',
            borderRadius: 12,
            border: '2px solid #4f8cff',
            background: '#141a24',
            color: '#4f8cff',
            cursor: 'pointer',
            marginBottom: 16,
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          🔊 Tap to enable sound
        </button>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(90px,1fr))', gap: 12, marginBottom: 16 }}>
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelected(a)}
            style={{
              aspectRatio: '1',
              borderRadius: 12,
              border: selected?.id === a.id ? `3px solid ${a.color}` : '1px solid #333',
              background: '#141a24',
              color: '#e6e6e6',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}
          >
            <div style={{ width: 28, height: 28, borderRadius: 6, background: a.color }} />
            <div style={{ fontSize: 12 }}>{a.name}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
        {recording && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 20,
            background: '#2a0a0a', border: '2px solid #e74c3c',
            color: '#e74c3c', fontWeight: 700, fontSize: 14,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#e74c3c',
              animation: 'pulse 1s ease-in-out infinite',
            }} />
            RECORDING — tap Stop to send
          </div>
        )}
        <button
          onClick={recording ? stopRecording : startRecording}
          disabled={!selected}
          style={{
            padding: '12px 24px',
            borderRadius: 24,
            border: 'none',
            background: recording ? '#e74c3c' : selected ? selected.color : '#444',
            color: '#fff',
            cursor: selected ? 'pointer' : 'not-allowed',
            fontWeight: 600,
          }}
        >
          {recording ? 'Stop & Send' : 'Record'}
        </button>
        <span style={{ fontSize: 13, opacity: 0.7 }}>{status}</span>
      </div>
      {lastReply && (
        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.6 }}>
          last reply: {lastReply.split('/').pop()}
        </div>
      )}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

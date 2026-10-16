// Capture levels: did any sound reach the microphone? The same -60 dBFS line the inbox watcher uses.
// A recording whose loudest moment stays under SILENCE_DBFS is digital silence (a stuck emulator capture stream,
// a muted or unplugged mic), not speech. Parked, it is held back instead of uploaded: the driver hears about it
// now, not as a "silent_audio" failure 40 seconds later. Driving, it is never held back (see silenceAction).
export const SILENCE_DBFS = -60
export const FLOOR_DBFS = -96
export type Capture = { peak_dbfs: number; rms_dbfs: number; samples?: number; source?: string; sent_anyway?: boolean }

export const toDb = (x: number) => (x > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(x)) : FLOOR_DBFS)
export const meter01 = (db: number) => Math.min(1, Math.max(0, (db - SILENCE_DBFS) / -SILENCE_DBFS))
export const round1 = (x: number) => Math.round(x * 10) / 10

export function normCapture(c: unknown, source: string): Capture | undefined {
  const o = c as Partial<Capture> | null
  if (!o || typeof o.peak_dbfs !== 'number' || typeof o.rms_dbfs !== 'number' || !isFinite(o.peak_dbfs) || !isFinite(o.rms_dbfs)) return undefined
  return { peak_dbfs: round1(o.peak_dbfs), rms_dbfs: round1(o.rms_dbfs), samples: typeof o.samples === 'number' ? o.samples : undefined, source: o.source || source, sent_anyway: o.sent_anyway }
}

// Fewer 100 ms windows than this (an accidental double tap) is too short to call silent: no window may have
// carried speech yet, and the "digital silence" banner would be a misleading verdict. Unknown, so it is sent.
export const MIN_JUDGEABLE_SAMPLES = 5
export const isSilent = (c?: Capture) => !!c && c.peak_dbfs < SILENCE_DBFS && !(typeof c.samples === 'number' && c.samples < MIN_JUDGEABLE_SAMPLES)

/**
 * What to do with a finished recording.
 *  - 'send':     levels unknown or audible; upload it.
 *  - 'hold':     parked and the device heard nothing; keep it back and offer "send anyway".
 *  - 'advisory': driving and the device claims silence; upload it anyway, marked sent_anyway, and let the
 *                watcher's ffmpeg (ground truth) decide. The driving layout has no banner and no "send anyway"
 *                link, and a car audio HAL that reports amplitude 0 for every window (unverified on the Civic)
 *                would otherwise swallow every note a driver dictates.
 */
export type SilenceAction = 'send' | 'hold' | 'advisory'
export function silenceAction(capture: Capture | undefined, driving: boolean): SilenceAction {
  if (!isSilent(capture)) return 'send'
  return driving ? 'advisory' : 'hold'
}

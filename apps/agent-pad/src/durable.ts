// State the pad must not lose across a cold start. The WebView's localStorage does not survive this app being killed
// (ignition off, am force-stop): the next page load sees it empty even though the file on disk held the value, so the
// "last reply played" marker was lost and every start replayed the newest replies and re-published audio.memo.played.
// The Android host keeps these keys in SharedPreferences (HoloceneNative.getPref/setPref, committed synchronously).
// In a normal browser, or on an old host without the bridge, localStorage is used exactly as before.
export type PrefBridge = { getPref?: (k: string) => string; setPref?: (k: string, v: string) => boolean } | undefined | null
export type Kv = { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function durableGet(k: string, bridge: PrefBridge, ls: Kv | undefined): string {
  try {
    const v = bridge?.getPref?.(k)
    if (v) return v
  } catch { /* old host or bridge error: fall through to localStorage */ }
  try { return ls?.getItem(k) || '' } catch { return '' }
}

export function durableSet(k: string, v: string, bridge: PrefBridge, ls: Kv | undefined): void {
  try { bridge?.setPref?.(k, v) } catch { /* old host */ }
  try { ls?.setItem(k, v) } catch { /* storage blocked */ }
}

"use client";

import { useState } from "react";
import type { Signal, Source, Ticket } from "./types";

// Small atoms from the 33GOD kit, ported for the Next app: the seven signal glyphs,
// durations, the source strip, copyable machine words and the Plane band track.

const SIGNAL_WORD: Record<Signal, string> = {
  you: "Needs you", broken: "Broken", stuck: "Stuck", working: "Working", quiet: "Quiet", cleared: "Cleared", unknown: "No signal"
};

export function Glyph({ signal, size = 10, title }: { signal: Signal; size?: number; title?: string }) {
  const common = {
    width: size, height: size, viewBox: "0 0 10 10", className: `hub-glyph sig-${signal}`,
    role: title ? "img" : undefined, "aria-hidden": title ? undefined : true, "aria-label": title
  } as const;
  switch (signal) {
    case "you": return <svg {...common}><path d="M5 .55 9.45 5 5 9.45.55 5Z" fill="currentColor" /></svg>;
    case "broken": return <svg {...common}><rect x="1" y="1" width="8" height="8" rx=".6" fill="currentColor" /></svg>;
    case "stuck": return <svg {...common}><path d="M1.2 1h7.6L5 4.85ZM1.2 9h7.6L5 5.15Z" fill="currentColor" /></svg>;
    case "working": return (
      <svg {...common}>
        <circle cx="5" cy="5" r="3.7" fill="none" stroke="currentColor" strokeWidth="1.3" opacity=".32" />
        <g className="hub-orbit"><path d="M5 1.3a3.7 3.7 0 0 1 3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></g>
      </svg>
    );
    case "quiet": return <svg {...common}><rect x="1.4" y="4.25" width="7.2" height="1.5" rx=".75" fill="currentColor" /></svg>;
    case "cleared": return <svg {...common}><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>;
    default: return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.45 1.35" /></svg>;
  }
}

export const signalWord = (s: Signal) => SIGNAL_WORD[s];

const pad = (n: number) => String(n).padStart(2, "0");
/** 14s · 12m · 1h 06m · 2h · 4d 02h · 98d */
export function formatDuration(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${pad(m % 60)}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d >= 10 ? `${d}d` : `${d}d ${pad(h % 24)}h`;
}

export function sinceSeconds(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : undefined;
}

export function Age({ seconds, verb }: { seconds?: number; verb?: string }) {
  if (seconds === undefined) return <span className="hub-age is-none">–</span>;
  return (
    <time className="hub-age" dateTime={`PT${Math.round(seconds)}S`}>
      {verb ? <span className="hub-age-verb">{verb} </span> : null}
      {formatDuration(seconds)}
    </time>
  );
}

export function SourceStrip({ sources }: { sources: Source[] }) {
  return (
    <ul className="hub-sources" aria-label="Data sources">
      {sources.map((s) => {
        const state = s.down ? "down" : s.ageSeconds !== undefined && s.maxSeconds !== undefined && s.ageSeconds > s.maxSeconds ? "stale" : "fresh";
        const title = s.down ? `${s.name} is down${s.detail ? `: ${s.detail}` : ""}` : s.ageSeconds !== undefined ? `${s.name} reported ${formatDuration(s.ageSeconds)} ago` : s.name;
        return (
          <li key={s.name} className={`hub-source is-${state}`} title={title}>
            {state !== "fresh" ? <Glyph signal={state === "stale" ? "stuck" : "broken"} size={8} /> : null}
            <span className="hub-source-name">{s.name}</span>
            <span className="hub-source-val">{s.down ? "down" : `${state === "stale" ? "~" : ""}${s.value ?? (s.ageSeconds !== undefined ? formatDuration(s.ageSeconds) : "")}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A machine word in mono that copies itself on click. */
export function CopyRef({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="hub-ref"
      title={`Copy ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="hub-ref-text">{label ?? value}</span>
      <span className="hub-ref-mark" aria-hidden="true">{copied ? "copied" : ""}</span>
    </button>
  );
}

const BANDS: Array<[string, string]> = [["backlog", "Backlog"], ["unstarted", "Unstarted"], ["started", "Started"], ["completed", "Completed"]];

/** Plane's lifecycle band. Krebs phases take over once Krebs emits them. */
export function BandTrack({ ticket }: { ticket: Ticket }) {
  const at = BANDS.findIndex(([id]) => id === ticket.band);
  return (
    <ol className="hub-track" aria-label={`Lifecycle: ${ticket.band ?? "unknown"}`}>
      {BANDS.map(([id, label], i) => (
        <li key={id} className={at < 0 ? "is-next" : i < at ? "is-done" : i === at ? "is-current" : "is-next"}>
          <span className="hub-track-bar" />
          <span className="hub-track-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function BoxIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="hub-icon">
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

export function ComponentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="hub-uml">
      <rect x="3.5" y="1.5" width="9" height="11" rx="1" />
      <rect x="1.5" y="3.5" width="4" height="2" className="hub-uml-tab" />
      <rect x="1.5" y="8.5" width="4" height="2" className="hub-uml-tab" />
    </svg>
  );
}

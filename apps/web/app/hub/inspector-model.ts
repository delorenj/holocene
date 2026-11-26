import type { Signal } from "./types";

/** Signal ranking every hub list sorts by: what needs the operator first. */
export const ORDER: Signal[] = ["you", "broken", "stuck", "working", "unknown", "quiet", "cleared"];

type Ranked = { signal: Signal; name: string };

export function bySignal(a: Ranked, b: Ranked) {
  return ORDER.indexOf(a.signal) - ORDER.indexOf(b.signal) || a.name.localeCompare(b.name);
}

/** A tile shows only a sourced value: absent (undefined, null, "") hides it; 0 is a real value. */
export function visibleFacts<T extends { value: unknown }>(facts: T[]): T[] {
  return facts.filter((f) => f.value !== undefined && f.value !== null && f.value !== "");
}

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

/** "idle · 14m": the status tag every agent header and chip reuses. */
export function heldTag(state: string, heldSeconds?: number) {
  return [state, heldSeconds !== undefined ? formatDuration(heldSeconds) : undefined].filter(Boolean).join(" · ");
}

/** An agent's directs: everyone whose reportsTo names it, never itself, ranked by signal. */
export function directReports<T extends Ranked & { id: string; reportsTo?: string }>(agents: T[], id: string): T[] {
  return agents.filter((x) => x.reportsTo === id && x.id !== id).sort(bySignal);
}

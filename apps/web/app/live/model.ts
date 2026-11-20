import type { LiveApp, LivePayload, LiveSource, SourceStatus } from "./types";

// Pure view logic for the Live page: how a source becomes a chip, how the money and the keys owed read,
// and the one-time first-promotion moment. No React, no fetch; the tests pin each of these.

/** 499 + usd -> $4.99. Zero-decimal currencies are not special-cased: the hub sells in cents. */
export function money(minor: number, currency?: string): string {
  const cur = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${cur}`;
  }
}

/** 14s · 12m · 1h 06m · 2h · 3d 04h */
export function duration(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${String(h % 24).padStart(2, "0")}h` : `${d}d`;
}

export const promotedBadge = (app: Pick<LiveApp, "liveSince" | "daysLive">) => `Promoted ${app.liveSince} · Day ${app.daysLive} live`;

// ---------------------------------------------------------------- chips

export type ChipState = "ok" | "warn" | "down" | "stale" | "pending" | "unavailable";
export type Chip = { key: string; label: string; state: ChipState; fresh: string; title: string };

const SOURCE_LABEL: Record<string, string> = {
  release: "release", storefront: "storefront", sales: "sales", fulfilment: "fulfilment", reminder: "reminder", activity: "board"
};

/** A read older than its own maxSeconds is stale, whatever it last said; a down source stays down. */
export function chipState(status: SourceStatus, ageSeconds: number | undefined, maxSeconds: number): ChipState {
  if (status === "down" || status === "unavailable" || status === "pending") return status;
  if (ageSeconds !== undefined && ageSeconds > maxSeconds) return "stale";
  return status;
}

export function chipFor(key: string, src: LiveSource<unknown>): Chip {
  const state = chipState(src.status, src.ageSeconds, src.maxSeconds);
  const label = SOURCE_LABEL[key] ?? key;
  const fresh = src.ageSeconds === undefined ? "–" : duration(src.ageSeconds);
  const word: Record<ChipState, string> = {
    ok: "reading well", warn: "needs a look", down: "down", stale: "stale", pending: "first read in progress", unavailable: "unavailable"
  };
  const title = [`${label}: ${word[state]}`, src.detail, src.ageSeconds === undefined ? undefined : `read ${duration(src.ageSeconds)} ago`].filter(Boolean).join(" · ");
  return { key, label, state, fresh, title };
}

export function chips(app: LiveApp): Chip[] {
  return (Object.keys(app.sources) as Array<keyof LiveApp["sources"]>).map((k) => chipFor(k, app.sources[k]));
}

/** Worst chip wins: down > warn/stale > the rest. */
export function overallState(app: LiveApp): "ok" | "attention" | "down" {
  const states = chips(app).map((c) => c.state);
  if (states.includes("down")) return "down";
  if (states.some((s) => s === "warn" || s === "stale")) return "attention";
  return "ok";
}

// ---------------------------------------------------------------- the numbers

export type Metric = { label: string; value: string; note?: string; tone: "plain" | "good" | "warn" | "bad" | "muted" };

export function salesMetric(app: LiveApp): Metric {
  const s = app.sources.sales;
  if (!s.data) return { label: "Sales", value: "–", note: s.detail ?? (s.status === "pending" ? "reading Stripe…" : "no data"), tone: "muted" };
  const d = s.data;
  const extras = [d.refunds.count ? `${d.refunds.count} refunded` : "", d.disputes.count ? `${d.disputes.count} disputed` : ""].filter(Boolean).join(" · ");
  if (d.count === 0) return { label: "Sales", value: "0", note: ["waiting for the first one", extras].filter(Boolean).join(" · "), tone: "plain" };
  return {
    label: "Sales",
    value: String(d.count),
    note: [`${money(d.grossMinor, d.currency)} gross${d.truncated ? "+" : ""}`, extras].filter(Boolean).join(" · "),
    tone: d.disputes.count ? "warn" : "good"
  };
}

export function saleTimes(app: LiveApp): string | undefined {
  const d = app.sources.sales.data;
  if (!d?.firstSaleAt) return undefined;
  return d.lastSaleAt && d.lastSaleAt !== d.firstSaleAt ? `first ${d.firstSaleAt.slice(0, 10)} · last ${d.lastSaleAt.slice(0, 10)}` : `first ${d.firstSaleAt.slice(0, 10)}`;
}

/** Keys owed to buyers: the promise is a time, so the metric says how close or how late it is. */
export function keysMetric(app: LiveApp, nowMs: number): Metric {
  const s = app.sources.fulfilment;
  const f = s.data;
  if (!f) return { label: "Keys owed", value: "–", note: s.detail ?? (s.status === "pending" ? "asking the issuer…" : "no data"), tone: "muted" };
  const owed = f.due + f.overdue;
  const promise = f.promiseHours ? `${f.promiseHours} h promise` : undefined;
  if (f.overdue > 0) {
    return { label: "Keys owed", value: String(owed), note: `${f.overdue} overdue${f.worstOverdueSeconds !== undefined ? ` by ${duration(f.worstOverdueSeconds)}` : ""}`, tone: "bad" };
  }
  if (f.due > 0) {
    const left = f.soonestDueAt ? Math.max(0, (Date.parse(f.soonestDueAt) - nowMs) / 1000) : undefined;
    return { label: "Keys owed", value: String(owed), note: left === undefined ? "inside the promise" : `next due in ${duration(left)}`, tone: "warn" };
  }
  if (f.blocked > 0) return { label: "Keys owed", value: "0", note: `${f.blocked} blocked${f.blockedReasons.length ? ` (${f.blockedReasons.join(", ")})` : ""}`, tone: "warn" };
  return { label: "Keys owed", value: "0", note: ["all clear", promise].filter(Boolean).join(" · "), tone: "good" };
}

export function versionMetric(app: LiveApp, nowMs: number): Metric {
  const s = app.sources.release;
  const r = s.data;
  if (!r) return { label: "Current version", value: "–", note: s.detail ?? (s.status === "pending" ? "reading latest.json…" : "no data"), tone: "muted" };
  const age = r.updatedAt ? Math.max(0, (nowMs - Date.parse(r.updatedAt)) / 1000) : undefined;
  const bits = [`build ${r.code}`, age !== undefined ? `shipped ${duration(age)} ago` : undefined, r.apk.reachable ? undefined : "APK unreachable"].filter(Boolean);
  return { label: "Current version", value: `v${r.version}`, note: bits.join(" · "), tone: r.apk.reachable && r.apk.sizeMatches !== false ? "plain" : "bad" };
}

export function storefrontMetric(app: LiveApp): Metric {
  const s = app.sources.storefront;
  const d = s.data;
  if (!d) return { label: "Storefront", value: "–", note: s.detail ?? (s.status === "pending" ? "loading the page…" : "no data"), tone: "muted" };
  const up = d.status >= 200 && d.status < 300;
  const bits = [
    up ? (d.hasBuyButton ? "buy link present" : "no buy link") : undefined,
    up ? (d.apkMatchesRelease === true ? "APK link current" : d.apkMatchesRelease === false ? "APK link stale" : undefined) : undefined
  ].filter(Boolean);
  return {
    label: "Storefront",
    value: up ? "Up" : `HTTP ${d.status || "–"}`,
    note: bits.join(" · ") || undefined,
    tone: !up ? "bad" : d.hasBuyButton && d.apkMatchesRelease !== false ? "good" : "warn"
  };
}

export function metrics(app: LiveApp, nowMs: number): Metric[] {
  return [salesMetric(app), keysMetric(app, nowMs), versionMetric(app, nowMs), storefrontMetric(app)];
}

// ---------------------------------------------------------------- the page's one sentence

export function statement(p: LivePayload | undefined, error: string | undefined, nowMs: number): string {
  if (!p) return error ? "The Holocene API is not answering." : "Reading the live apps…";
  if (p.source.down && !p.apps.length) return "pjangler is not answering, so the live apps cannot be listed.";
  if (!p.apps.length) return p.skipped.length ? `${p.skipped.length} app${p.skipped.length === 1 ? " says" : "s say"} mode: live but ${p.skipped.length === 1 ? "has" : "have"} an invalid live block.` : "No app has been promoted to live yet.";
  const parts: string[] = [`${p.apps.length} app${p.apps.length === 1 ? "" : "s"} live.`];
  for (const a of p.apps) {
    const k = keysMetric(a, nowMs);
    const owed = a.sources.fulfilment.data ? a.sources.fulfilment.data.due + a.sources.fulfilment.data.overdue : undefined;
    if (owed) parts.push(`${a.name}: ${owed} key${owed === 1 ? "" : "s"} owed, ${k.note}.`);
    const state = overallState(a);
    if (state === "down") parts.push(`${a.name} has a source down.`);
    else if (state === "attention") parts.push(`${a.name} needs a look.`);
  }
  if (parts.length === 1) parts.push(p.apps.every((a) => overallState(a) === "ok") ? "Everything reads well; no keys owed." : "");
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- the first-promotion moment

export const CELEBRATED_PREFIX = "holocene.live.celebrated.";
export const celebrationKey = (app: Pick<LiveApp, "id" | "liveSince">) => `${CELEBRATED_PREFIX}${app.id}.${app.liveSince}`;

/** The banner is for the first live app, once. `seen` is whether this browser has already shown it. */
export function shouldCelebrate(app: Pick<LiveApp, "firstPromoted">, seen: boolean): boolean {
  return app.firstPromoted && !seen;
}

/** Deterministic confetti: the same pieces on every render, so server and client markup agree. */
export function confettiPieces(n = 26): Array<{ left: number; delay: number; duration: number; rotate: number; tone: number; size: number }> {
  return Array.from({ length: n }, (_, i) => ({
    left: (i * 37 + 11) % 100,
    delay: ((i * 53) % 90) / 100,
    duration: 1.8 + ((i * 29) % 12) / 10,
    rotate: (i * 71) % 360,
    tone: i % 4,
    size: 6 + (i % 3) * 3
  }));
}

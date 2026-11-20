"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Brand, ThemeToggle, useTheme } from "../hub/hub-app";
import { CopyRef, Glyph, HubTabs, SourceStrip } from "../hub/ui";
import type { Signal, Source } from "../hub/types";
import {
  celebrationKey, chips, confettiPieces, duration, metrics, overallState, promotedBadge, saleTimes, shouldCelebrate, statement,
  type Chip, type ChipState, type Metric
} from "./model";
import type { LiveApp as App, LivePayload } from "./types";

// The Live hub: every app promoted to production (a registered pjangler project whose .launch.yaml says
// `mode: live`), with what is true about it right now. Every action here is a link or a read; the money,
// the issuer and the store are never written from this page.

const POLL_MS = 15_000;
const API_URL = "/api/modules/live/apps";

function useLive() {
  const [data, setData] = useState<LivePayload>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);

  const load = useCallback(async (force: boolean) => {
    try {
      const res = await fetch(force ? `${API_URL}?force=1` : API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as LivePayload;
      if (live.current) (setData(body), setError(undefined));
    } catch (err) {
      if (live.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load(false);
      if (live.current) timer = setTimeout(tick, document.hidden ? POLL_MS * 4 : POLL_MS);
    };
    void tick();
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  return { data, error, refresh, refreshing };
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const CHIP_SIGNAL: Record<ChipState, Signal> = { ok: "cleared", warn: "stuck", down: "broken", stale: "stuck", pending: "working", unavailable: "unknown" };

function HealthChip({ chip }: { chip: Chip }) {
  return (
    <li className={`live-chip is-${chip.state}`} title={chip.title}>
      <Glyph signal={CHIP_SIGNAL[chip.state]} size={9} />
      <span className="live-chip-name">{chip.label}</span>
      <span className="live-chip-fresh">{chip.state === "unavailable" ? "n/a" : chip.state === "pending" ? "…" : chip.fresh}</span>
    </li>
  );
}

function MetricCell({ metric, extra }: { metric: Metric; extra?: string }) {
  return (
    <div className={`live-metric is-${metric.tone}`}>
      <dt className="hub-label">{metric.label}</dt>
      <dd className="live-metric-value">{metric.value}</dd>
      {metric.note ? <dd className="live-metric-note">{metric.note}</dd> : null}
      {extra ? <dd className="live-metric-note live-metric-extra">{extra}</dd> : null}
    </div>
  );
}

function ActionLink({ href, children, primary }: { href: string; children: string; primary?: boolean }) {
  const internal = href.startsWith("/");
  return (
    <a className={`live-action${primary ? " is-primary" : ""}`} href={href} {...(internal ? {} : { target: "_blank", rel: "noreferrer noopener" })}>
      {children}
      {internal ? null : <span aria-hidden="true"> ↗</span>}
    </a>
  );
}

function Confetti() {
  return (
    <span className="live-confetti" aria-hidden="true">
      {confettiPieces().map((p, i) => (
        <i
          key={i}
          className={`live-bit tone-${p.tone}`}
          style={{ left: `${p.left}%`, width: p.size, height: p.size * 1.6, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`, transform: `rotate(${p.rotate}deg)` }}
        />
      ))}
    </span>
  );
}

function Celebration({ app, onClose }: { app: App; onClose: () => void }) {
  return (
    <aside className="live-banner" role="status" aria-label="First live app">
      <Confetti />
      <div className="live-banner-body">
        <span className="hub-label">First live app</span>
        <p className="live-banner-line">
          {app.name} is live. It is the first app promoted to this hub: people can buy it, and they are using it.
        </p>
        <p className="live-banner-sub">Promoted {app.liveSince}. Everything below is read from the real thing: the store, the release, Stripe and the key queue.</p>
      </div>
      <button type="button" className="live-banner-close" onClick={onClose} aria-label="Dismiss">
        Got it
      </button>
    </aside>
  );
}

function Hero({ app, now }: { app: App; now: number }) {
  const state = overallState(app);
  const times = saleTimes(app);
  const board = app.sources.activity.data?.recent ?? [];
  const cells = metrics(app, now);
  return (
    <article className={`live-hero is-${state}`} aria-label={`${app.name}, live`}>
      {app.firstPromoted ? <span className="live-ribbon">First live app</span> : null}
      <header className="live-hero-head">
        <span className="live-badge">{promotedBadge(app)}</span>
        <span className="live-platform">
          <span className="live-platform-word">{app.platform}</span>
          <CopyRef value={app.package} />
        </span>
      </header>

      <h2 className="live-name">{app.name}</h2>
      <p className="live-tagline">{app.tagline}</p>
      <p className="live-offer">
        {app.offer ? <span>{app.offer}</span> : null}
        {app.support ? <a href={`mailto:${app.support}`}>{app.support}</a> : null}
      </p>

      <dl className="live-metrics">
        {cells.map((m, i) => (
          <MetricCell key={m.label} metric={m} extra={i === 0 ? times : undefined} />
        ))}
      </dl>

      <ul className="live-chips" aria-label={`${app.name} sources`}>
        {chips(app).map((c) => (
          <HealthChip key={c.key} chip={c} />
        ))}
      </ul>

      <nav className="live-actions" aria-label={`${app.name} links`}>
        <ActionLink href={app.links.store} primary>Open store page</ActionLink>
        {app.links.checkout ? <ActionLink href={app.links.checkout}>Open checkout link</ActionLink> : null}
        {app.links.board ? <ActionLink href={app.links.board}>{`Open ${app.board} board`}</ActionLink> : null}
        {app.links.apk ? <ActionLink href={app.links.apk}>Current APK</ActionLink> : null}
        <ActionLink href={app.links.release}>latest.json</ActionLink>
        {app.links.candybar ? <ActionLink href={app.links.candybar}>Key reminder</ActionLink> : null}
        {app.links.evidence.map((e) => (
          <ActionLink key={e.href} href={e.href}>{e.label}</ActionLink>
        ))}
      </nav>

      {board.length ? (
        <section className="live-board" aria-label={`${app.board} board movement`}>
          <h3 className="hub-label">{app.board} board, recent</h3>
          <ul>
            {board.map((t) => (
              <li key={t.key}>
                <span className="live-ticket-key">{t.key}</span>
                <span className="live-ticket-title">{t.title}</span>
                {t.state ? <span className="live-ticket-state">{t.state}</span> : null}
                <time className="live-ticket-age" dateTime={t.updatedAt}>
                  {duration(Math.max(0, (now - Date.parse(t.updatedAt)) / 1000))} ago
                </time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

function Empty() {
  return (
    <div className="hub-placeholder live-empty">
      <span className="hub-label">No live apps yet</span>
      <p>An app is promoted to this hub when its repo&apos;s <code className="hub-code">.launch.yaml</code> says <code className="hub-code">mode: live</code> with a valid <code className="hub-code">live:</code> block,
        and the repo is a registered pjangler project. There is no separate list to edit.</p>
      <p>The lifecycle is <code className="hub-code">launch</code> (racing to a finish line), then <code className="hub-code">live</code> (people can buy it and are using it).
        Pre-launch and internal projects stay <code className="hub-code">steady</code>.</p>
    </div>
  );
}

export function LiveApp() {
  const [theme, toggleTheme] = useTheme();
  const { data, error, refresh, refreshing } = useLive();
  const now = useNow();
  const [celebrate, setCelebrate] = useState<App>();

  // The first-promotion moment: once per browser per app, remembered in localStorage (and fine without it).
  const first = data?.apps.find((a) => a.firstPromoted);
  const firstKey = first ? celebrationKey(first) : undefined;
  useEffect(() => {
    if (!first || !firstKey) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(firstKey) !== null;
      if (!seen) window.localStorage.setItem(firstKey, new Date().toISOString());
    } catch {
      // storage blocked: celebrate this visit only
    }
    if (shouldCelebrate(first, seen)) setCelebrate(first);
  }, [first?.id, firstKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources: Source[] = data ? [{ name: data.source.name, value: data.source.down ? undefined : `${data.apps.length} live`, down: data.source.down, detail: data.source.detail, ageSeconds: 0 }] : [];

  return (
    <div className="hub-root" data-theme={theme}>
      <header className="hub-header">
        <Brand />
        <HubTabs current="live" />
        <div className="hub-header-end">
          <SourceStrip sources={sources} />
          <button type="button" className="live-refresh" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? "Reading…" : "Refresh"}
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="hub-body live-body">
        <div className="hub-lede">
          <p className="hub-statement" aria-live="polite">{statement(data, error, now)}</p>
          {error ? (
            <p className="hub-error" role="status">
              <span className="hub-label">API</span>
              {data ? `Showing the last good read. ${error}` : error}
            </p>
          ) : null}
        </div>

        {celebrate ? <Celebration app={celebrate} onClose={() => setCelebrate(undefined)} /> : null}

        {data?.apps.map((app) => <Hero key={app.id} app={app} now={now} />)}

        {data && !data.apps.length && !data.source.down ? <Empty /> : null}

        {data?.skipped.length ? (
          <section className="live-skipped" aria-label="Invalid live blocks">
            <h3 className="hub-label">Says live, not promoted</h3>
            <ul>
              {data.skipped.map((s) => (
                <li key={s.id}>
                  <strong>{s.name}</strong>
                  <span>{s.problems.join("; ")}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="live-readonly">
          Read-only. Links and reads only: the money, the key queue and the store are changed in their own tools, never from this page.
          {data ? ` Read ${new Date(data.generatedAt).toLocaleTimeString()}.` : ""}
        </p>
      </div>
    </div>
  );
}

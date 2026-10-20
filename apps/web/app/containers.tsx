"use client";

import { useEffect, useMemo, useState } from "react";

type TargetHealth = "healthy" | "answering" | "dead" | "unknown";
type PolrMood = "calm" | "grumpy" | "pissed" | "asleep";

type ContainerTarget = {
  url: string;
  service: string;
  container: string;
  health: TargetHealth;
  lastStatus: number | null;
  lastProbeAt: string | null;
  lastRestartAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
};

type RestartEvent = {
  at: string;
  container: string;
  outcome: "restarted" | "failed" | "queued";
  detail: string;
};

type ContainersSnapshot = {
  generatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  stale: boolean;
  polr: { mood: PolrMood; line: string };
  targets: ContainerTarget[];
  restarts: RestartEvent[];
  skipped: { container: string; reason: string }[];
  summary: {
    total: number;
    healthy: number;
    answering: number;
    dead: number;
    unknown: number;
    inCooldown: number;
    restartsLastHour: number;
  };
};

const REFRESH_MS = 15_000;
const HEALTH_ORDER: Record<TargetHealth, number> = { dead: 0, unknown: 1, answering: 2, healthy: 3 };
const FACES: Record<PolrMood, string> = {
  calm: "[•_•]",
  grumpy: "[ò_ó]",
  pissed: "[╬ಠ益ಠ]",
  asleep: "[-_-]zz"
};

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function cardClass(target: ContainerTarget) {
  return `polr-card polr-card-${target.health}${target.inCooldown ? " polr-card-cooldown" : ""}`;
}

export default function ContainersTab({ apiBase }: { apiBase: string }) {
  const [snapshot, setSnapshot] = useState<ContainersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/containers/snapshot`, { cache: "no-store" });
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        const data = (await response.json()) as ContainersSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
          setNow(Date.now());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "snapshot unavailable");
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase]);

  const sortedTargets = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.targets].sort((a, b) => {
      if (a.health !== b.health) return HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
      if (a.inCooldown !== b.inCooldown) return a.inCooldown ? -1 : 1;
      return a.container.localeCompare(b.container);
    });
  }, [snapshot]);

  const summary = snapshot?.summary;
  const polr = snapshot?.polr;

  return (
    <section className="tooling-section" aria-label="Containers">
      <div className="section-heading">
        <div>
          <h2>Containers</h2>
          <p className="section-note">
            Traefik Deathwatch probes every public route every 10 minutes and restarts the container behind a 502/503/504.
          </p>
        </div>
        {snapshot ? <span>{new Date(snapshot.generatedAt).toLocaleTimeString()}</span> : null}
      </div>

      {polr ? (
        <div className={`polr-banner polr-mood-${polr.mood}`} role="status">
          <span className="polr-face" aria-hidden="true">
            {FACES[polr.mood]}
          </span>
          <div className="polr-says">
            <strong>POLR is {polr.mood}</strong>
            <span>{polr.line}</span>
          </div>
          <div className="polr-run">
            <span>Last run {ago(snapshot?.lastRunAt ?? null, now)}</span>
            <small>
              {snapshot?.lastRunAt ? new Date(snapshot.lastRunAt).toLocaleString() : "no run in the log"}
              {snapshot?.nextRunAt && !snapshot.stale ? ` · next ~${new Date(snapshot.nextRunAt).toLocaleTimeString()}` : ""}
            </small>
          </div>
        </div>
      ) : null}

      <div className="summary-grid" aria-label="Containers summary">
        <div className="metric">
          <span className="metric-label">Routes</span>
          <strong>{summary?.total ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Healthy</span>
          <strong style={{ color: "var(--green)" }}>{summary?.healthy ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Answering 4xx</span>
          <strong style={{ color: "var(--muted)" }}>{summary?.answering ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Dead</span>
          <strong style={{ color: "var(--red)" }}>{summary?.dead ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Kicks this hour</span>
          <strong style={{ color: "var(--yellow)" }}>{summary?.restartsLastHour ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">In cooldown</span>
          <strong style={{ color: "var(--yellow)" }}>{summary?.inCooldown ?? 0}</strong>
        </div>
      </div>

      {error ? <div className="empty">Containers feed unavailable: {error}</div> : null}
      {!error && !snapshot ? <div className="empty">Loading container probes...</div> : null}

      {snapshot ? (
        <div className="polr-columns">
          <div className="polr-log">
            <h3>Recent restarts</h3>
            {snapshot.restarts.length ? (
              <ul>
                {snapshot.restarts.map((r) => (
                  <li className={`polr-restart polr-restart-${r.outcome}`} key={`${r.at}-${r.container}`}>
                    <strong>{r.container}</strong>
                    <span>{r.outcome}</span>
                    <small title={new Date(r.at).toLocaleString()}>{ago(r.at, now)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-note">No restarts in the current log.</p>
            )}
          </div>
          <div className="polr-log">
            <h3>Dead, left alone last run</h3>
            {snapshot.skipped.length ? (
              <ul>
                {snapshot.skipped.map((s) => (
                  <li className="polr-restart" key={s.container}>
                    <strong>{s.container}</strong>
                    <span>{s.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-note">Nothing skipped.</p>
            )}
          </div>
        </div>
      ) : null}

      {!error && snapshot && !sortedTargets.length ? <div className="empty">No container targets found.</div> : null}

      {sortedTargets.length ? (
        <div className="polr-grid">
          {sortedTargets.map((target) => (
            <div className={cardClass(target)} key={target.url}>
              <span className="polr-status-dot" />
              <strong className="polr-name">{target.container}</strong>
              <span className="polr-code">{target.lastStatus === null ? "—" : target.lastStatus === 0 ? "000" : target.lastStatus}</span>
              <small className="polr-url">{target.url}</small>
              {target.lastRestartAt ? (
                <small className="polr-url" title={new Date(target.lastRestartAt).toLocaleString()}>
                  kicked {ago(target.lastRestartAt, now)}
                </small>
              ) : null}
              {target.inCooldown ? <span className="polr-cooldown">cooling down</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

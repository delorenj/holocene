"use client";

import { useEffect, useMemo, useState } from "react";

type ContainerTarget = {
  url: string;
  service: string;
  container: string;
  lastStatus: number | null;
  lastProbeAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
};

type ContainersSnapshot = {
  generatedAt: string;
  targets: ContainerTarget[];
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
    inCooldown: number;
  };
};

const REFRESH_MS = 15_000;

function cardClass(target: ContainerTarget) {
  const base = "polr-card";
  if (target.lastStatus === null) {
    return `${base} polr-card-unknown${target.inCooldown ? " polr-card-cooldown" : ""}`;
  }
  if (target.lastStatus >= 200 && target.lastStatus < 400) {
    return `${base} polr-card-healthy${target.inCooldown ? " polr-card-cooldown" : ""}`;
  }
  return `${base} polr-card-unhealthy${target.inCooldown ? " polr-card-cooldown" : ""}`;
}

export default function ContainersTab({ apiBase }: { apiBase: string }) {
  const [snapshot, setSnapshot] = useState<ContainersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/containers/snapshot`);
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        const data = (await response.json()) as ContainersSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
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
      if (a.inCooldown !== b.inCooldown) return a.inCooldown ? -1 : 1;
      return a.container.localeCompare(b.container);
    });
  }, [snapshot]);

  const summary = snapshot?.summary;

  return (
    <section className="tooling-section" aria-label="Containers">
      <div className="section-heading">
        <div>
          <h2>Containers</h2>
          <p className="section-note">
            Traefik Deathwatch probe status for DeLoNET services.
          </p>
        </div>
        {snapshot ? (
          <span>{new Date(snapshot.generatedAt).toLocaleTimeString()}</span>
        ) : null}
      </div>

      <div className="summary-grid" aria-label="Containers summary">
        <div className="metric">
          <span className="metric-label">Total</span>
          <strong>{summary?.total ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Healthy</span>
          <strong style={{ color: "var(--green)" }}>{summary?.healthy ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Unhealthy</span>
          <strong style={{ color: "var(--red)" }}>{summary?.unhealthy ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Unknown</span>
          <strong style={{ color: "var(--muted)" }}>{summary?.unknown ?? 0}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">In Cooldown</span>
          <strong style={{ color: "var(--yellow)" }}>{summary?.inCooldown ?? 0}</strong>
        </div>
      </div>

      {error ? (
        <div className="empty">Containers feed unavailable: {error}</div>
      ) : null}
      {!error && !snapshot ? (
        <div className="empty">Loading container probes...</div>
      ) : null}
      {!error && snapshot && !sortedTargets.length ? (
        <div className="empty">No container targets found.</div>
      ) : null}

      {sortedTargets.length ? (
        <div className="polr-grid">
          {sortedTargets.map((target) => (
            <div className={cardClass(target)} key={target.container}>
              <span className="polr-status-dot" />
              <strong className="polr-name">{target.container}</strong>
              <span className="polr-code">
                {target.lastStatus ?? "—"}
              </span>
              <small className="polr-url">{target.url}</small>
              {target.inCooldown ? (
                <span className="polr-cooldown">cooling down</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

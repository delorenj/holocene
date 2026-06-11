"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SystemsItem = {
  type: string;
  name: string;
  state: string;
  schedule: string;
  source: string;
  detail: string;
};

type SystemsInventory = {
  generatedAt: string;
  items: SystemsItem[];
  counts: {
    total: number;
    failed: number;
    unhealthy: number;
    byType: Record<string, number>;
  };
};

type HistoryPoint = { t: number; v: number };
type HistorySeries = { id: string; label: string; points: HistoryPoint[] };
type SystemsHistory = {
  generatedAt: string;
  rangeHours: number;
  stepSeconds: number;
  series: HistorySeries[];
};

const REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS = 60_000;
const ACTIONABLE = new Set(["usr-svc", "usr-timer", "docker", "pm2"]);
const RANGE_CHOICES = [6, 24, 72, 168] as const;

const SERIES_COLORS: Record<string, string> = {
  load1: "#f5a97f",
  containers_running: "#8aadf4",
  problems: "#ed8796",
  usr_failed: "#eed49f"
};

function stateClass(state: string) {
  if (state.includes("failed") || state.includes("unhealthy") || state.includes("restarting") || state === "errored") {
    return "status status-attention";
  }
  if (state.includes("running") || state.includes("active") || state === "online" || state === "scheduled" || state === "waiting") {
    return "status status-idle";
  }
  return "status status-unknown";
}

function LineChart({ series, rangeHours }: { series: HistorySeries[]; rangeHours: number }) {
  const W = 920;
  const H = 220;
  const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

  const drawable = series.filter((s) => s.points.length > 1);
  if (!drawable.length) {
    return <div className="empty">No history yet. Metrics accumulate every 5 minutes via bgls-metrics.timer.</div>;
  }

  const allTs = drawable.flatMap((s) => s.points.map((p) => p.t));
  const tMin = Math.min(...allTs);
  const tMax = Math.max(...allTs);

  const x = (t: number) => PAD.left + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PAD.left - PAD.right);

  return (
    <div className="systems-charts">
      {drawable.map((s) => {
        const vMax = Math.max(...s.points.map((p) => p.v), 1);
        const y = (v: number) => H - PAD.bottom - (v / vMax) * (H - PAD.top - PAD.bottom);
        const path = s.points
          .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
          .join(" ");
        const last = s.points[s.points.length - 1];
        const color = SERIES_COLORS[s.id] ?? "#8aadf4";
        const gridLines = [0.25, 0.5, 0.75];

        return (
          <figure className="systems-chart" key={s.id}>
            <figcaption>
              <span className="systems-chart-dot" style={{ background: color }} />
              {s.label}
              <strong>{Number.isInteger(last.v) ? last.v : last.v.toFixed(2)}</strong>
              <small>last {rangeHours}h · peak {Number.isInteger(vMax) ? vMax : vMax.toFixed(2)}</small>
            </figcaption>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${s.label} over the last ${rangeHours} hours`}>
              {gridLines.map((g) => (
                <line
                  key={g}
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={PAD.top + g * (H - PAD.top - PAD.bottom)}
                  y2={PAD.top + g * (H - PAD.top - PAD.bottom)}
                  stroke="currentColor"
                  opacity={0.08}
                />
              ))}
              <text x={PAD.left - 6} y={PAD.top + 8} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.6}>
                {Number.isInteger(vMax) ? vMax : vMax.toFixed(1)}
              </text>
              <text x={PAD.left - 6} y={H - PAD.bottom} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.6}>
                0
              </text>
              <text x={PAD.left} y={H - 6} fontSize={11} fill="currentColor" opacity={0.6}>
                {new Date(tMin * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </text>
              <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.6}>
                {new Date(tMax * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </text>
              <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
          </figure>
        );
      })}
    </div>
  );
}

export function SystemsTab({ apiBase }: { apiBase: string }) {
  const [inventory, setInventory] = useState<SystemsInventory | null>(null);
  const [history, setHistory] = useState<SystemsHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [rangeHours, setRangeHours] = useState<number>(24);
  const [working, setWorking] = useState<string | null>(null);

  const loadInventory = useCallback(
    async (force = false) => {
      try {
        const res = await fetch(`${apiBase}/api/modules/systems/inventory${force ? "?force=1" : ""}`, {
          cache: "no-store"
        });
        if (!res.ok) throw new Error(`inventory ${res.status}`);
        setInventory((await res.json()) as SystemsInventory);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "inventory unavailable");
      }
    },
    [apiBase]
  );

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/modules/systems/history?range=${rangeHours}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`history ${res.status}`);
      setHistory((await res.json()) as SystemsHistory);
    } catch {
      setHistory(null);
    }
  }, [apiBase, rangeHours]);

  useEffect(() => {
    void loadInventory();
    const interval = window.setInterval(() => void loadInventory(), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [loadInventory]);

  useEffect(() => {
    void loadHistory();
    const interval = window.setInterval(() => void loadHistory(), HISTORY_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [loadHistory]);

  const items = useMemo(() => {
    const all = inventory?.items ?? [];
    const needle = filter.trim().toLowerCase();
    return all.filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (problemsOnly && stateClass(item.state) !== "status status-attention") return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.source.toLowerCase().includes(needle) ||
        item.detail.toLowerCase().includes(needle)
      );
    });
  }, [inventory, filter, typeFilter, problemsOnly]);

  const types = useMemo(() => Object.keys(inventory?.counts.byType ?? {}).sort(), [inventory]);

  const runAction = async (item: SystemsItem, action: "stop" | "restart" | "disable") => {
    const key = `${item.type}/${item.name}`;
    if (action !== "restart" && !window.confirm(`${action} ${key}?`)) return;
    setWorking(key);
    try {
      const res = await fetch(
        `${apiBase}/api/modules/systems/items/${encodeURIComponent(item.type)}/${encodeURIComponent(item.name)}/${action}`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${action} failed (${res.status})`);
      }
      await loadInventory(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      <section className="summary-grid" aria-label="Systems summary">
        <div className="metric">
          <span className="metric-label">Background tasks</span>
          <strong>{inventory?.counts.total ?? "…"}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Failed</span>
          <strong>{inventory?.counts.failed ?? "…"}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Unhealthy / restarting</span>
          <strong>{inventory?.counts.unhealthy ?? "…"}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">Snapshot</span>
          <strong>{inventory ? new Date(inventory.generatedAt).toLocaleTimeString() : "loading"}</strong>
        </div>
      </section>

      <section className="systems-history" aria-label="Systems history">
        <div className="section-heading">
          <div>
            <h2>Over Time</h2>
            <p className="section-note">
              bgls inventory metrics via node-exporter textfile → Prometheus, collected every 5 minutes.
            </p>
          </div>
          <div className="systems-range" role="group" aria-label="History range">
            {RANGE_CHOICES.map((hours) => (
              <button
                className={rangeHours === hours ? "tab tab-active" : "tab"}
                key={hours}
                onClick={() => setRangeHours(hours)}
                type="button"
              >
                {hours < 24 ? `${hours}h` : `${hours / 24}d`}
              </button>
            ))}
          </div>
        </div>
        <LineChart rangeHours={history?.rangeHours ?? rangeHours} series={history?.series ?? []} />
      </section>

      <section className="systems-inventory" aria-label="Systems inventory">
        <div className="section-heading">
          <div>
            <h2>Inventory</h2>
            <p className="section-note">Every cron, systemd unit, timer, container, and pm2 process on big-chungus.</p>
          </div>
          <div className="systems-filters">
            <input
              aria-label="Filter inventory"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by name, source…"
              type="search"
              value={filter}
            />
            <select aria-label="Type filter" onChange={(e) => setTypeFilter(e.target.value)} value={typeFilter}>
              <option value="all">all types ({inventory?.counts.total ?? 0})</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t} ({inventory?.counts.byType[t]})
                </option>
              ))}
            </select>
            <label className="systems-problems-toggle">
              <input checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} type="checkbox" />
              problems only
            </label>
          </div>
        </div>

        {error ? <div className="empty">Systems feed: {error}</div> : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Type</th>
                <th align="left">Name</th>
                <th align="left">State</th>
                <th align="left">Schedule</th>
                <th align="left">Source</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 400).map((item) => {
                const key = `${item.type}/${item.name}/${item.source}`;
                const busy = working === `${item.type}/${item.name}`;
                return (
                  <tr key={key}>
                    <td>{item.type}</td>
                    <td>
                      <strong>{item.name}</strong>
                      {item.detail ? <small>{item.detail.slice(0, 90)}</small> : null}
                    </td>
                    <td>
                      <span className={stateClass(item.state)}>{item.state}</span>
                    </td>
                    <td>{item.schedule || "-"}</td>
                    <td title={item.source}>{item.source.length > 46 ? `…${item.source.slice(-45)}` : item.source}</td>
                    <td>
                      {ACTIONABLE.has(item.type) ? (
                        <span className="svc-buttons">
                          <button
                            className="svc-btn svc-btn-restart"
                            disabled={busy}
                            onClick={() => void runAction(item, "restart")}
                            title={`Restart ${item.name}`}
                            type="button"
                          >
                            ⟳
                          </button>
                          <button
                            className="svc-btn svc-btn-stop"
                            disabled={busy}
                            onClick={() => void runAction(item, "stop")}
                            title={`Stop ${item.name}`}
                            type="button"
                          >
                            ■
                          </button>
                          <button
                            className="svc-btn svc-btn-stop"
                            disabled={busy}
                            onClick={() => void runAction(item, "disable")}
                            title={`Disable ${item.name}`}
                            type="button"
                          >
                            ⌀
                          </button>
                        </span>
                      ) : (
                        <small>read-only</small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length > 400 ? <div className="empty">Showing first 400 of {items.length} — narrow the filter.</div> : null}
          {!inventory && !error ? <div className="empty">Loading inventory…</div> : null}
        </div>
      </section>
    </>
  );
}

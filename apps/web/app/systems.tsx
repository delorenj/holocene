"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as HoverCard from "@radix-ui/react-hover-card";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useMemo, useState } from "react";

type SystemsItem = {
  type: string;
  name: string;
  purpose?: string;
  context?: string;
  scheduleSemantic?: string;
  state: string;
  schedule: string;
  source: string;
  detail: string;
  preview?: SystemsPreviewTarget;
  project?: {
    repo: string;
    path: string;
  };
  pm?: {
    agentId: string;
    displayName: string;
    roleDir: string;
    hermesPath: string;
  };
  board?: {
    provider: "plane" | "linear" | "trello";
    label: string;
    url: string;
  };
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

type SystemsPreviewTarget = {
  kind: "file" | "unit";
  target: string;
  label: string;
};

type SystemsPreview = {
  kind: SystemsPreviewTarget["kind"];
  target: string;
  label: string;
  content: string;
  truncated: boolean;
  sizeBytes?: number;
  generatedAt: string;
};

type ScheduleMode = "cron" | "semantic";
type StateBucket = "attention" | "running" | "waiting" | "inactive" | "other";
type SourceScope = "all" | "projects" | "home" | "docker" | "system";
type CapabilityFilter = "actionable" | "preview" | "pm" | "board" | "scheduled";

const REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS = 60_000;
const ACTIONABLE = new Set(["usr-svc", "usr-timer", "docker", "pm2"]);
const RANGE_CHOICES = [6, 24, 72, 168] as const;
const STATE_BUCKETS: { id: StateBucket; label: string }[] = [
  { id: "attention", label: "Attention" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "inactive", label: "Inactive" },
  { id: "other", label: "Other" }
];
const CAPABILITY_FILTERS: { id: CapabilityFilter; label: string }[] = [
  { id: "actionable", label: "Actionable" },
  { id: "preview", label: "Preview" },
  { id: "pm", label: "PM" },
  { id: "board", label: "Board" },
  { id: "scheduled", label: "Scheduled" }
];
const SOURCE_SCOPES: { id: SourceScope; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "projects", label: "Projects" },
  { id: "docker", label: "Docker" },
  { id: "home", label: "Home/config" },
  { id: "system", label: "System" }
];

const SERIES_COLORS: Record<string, string> = {
  load1: "#f5a97f",
  containers_running: "#8aadf4",
  problems: "#ed8796",
  usr_failed: "#eed49f"
};

function itemPurpose(item: SystemsItem) {
  return item.purpose?.trim() || item.detail.trim() || item.name;
}

function itemContext(item: SystemsItem) {
  return item.context?.trim() || "";
}

function itemSchedule(item: SystemsItem, mode: ScheduleMode) {
  if (!item.schedule) return "-";
  return mode === "semantic" ? item.scheduleSemantic || item.schedule : item.schedule;
}

function stateBucket(item: SystemsItem): StateBucket {
  const state = item.state.toLowerCase();
  if (state.includes("failed") || state.includes("unhealthy") || state.includes("restarting") || state === "errored") return "attention";
  if (state.includes("running") || state.includes("active") || state === "online") return "running";
  if (state === "waiting" || state === "scheduled" || state.includes("timer")) return "waiting";
  if (state.includes("inactive") || state.includes("dead") || state.includes("exited") || state === "disabled") return "inactive";
  return "other";
}

function sourceScope(item: SystemsItem): SourceScope {
  const value = `${item.source} ${item.detail} ${item.project?.path ?? ""}`;
  if (item.project?.path || value.includes("/home/delorenj/code/")) return "projects";
  if (value.includes("/home/delorenj/docker/")) return "docker";
  if (value.includes("/etc/") || item.type.startsWith("sys-")) return "system";
  if (value.includes("/home/delorenj/") || value.includes("~/") || value.includes(".config")) return "home";
  return "all";
}

function hasCapability(item: SystemsItem, capability: CapabilityFilter) {
  switch (capability) {
    case "actionable":
      return ACTIONABLE.has(item.type);
    case "preview":
      return Boolean(item.preview);
    case "pm":
      return Boolean(item.pm);
    case "board":
      return Boolean(item.board);
    case "scheduled":
      return Boolean(item.schedule);
  }
}

function matchesNeedle(item: SystemsItem, needle: string) {
  if (!needle) return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    itemPurpose(item).toLowerCase().includes(needle) ||
    itemContext(item).toLowerCase().includes(needle) ||
    itemSchedule(item, "semantic").toLowerCase().includes(needle) ||
    item.pm?.displayName.toLowerCase().includes(needle) ||
    item.pm?.hermesPath.toLowerCase().includes(needle) ||
    item.board?.label.toLowerCase().includes(needle) ||
    item.board?.url.toLowerCase().includes(needle) ||
    item.project?.repo.toLowerCase().includes(needle) ||
    item.project?.path.toLowerCase().includes(needle) ||
    item.source.toLowerCase().includes(needle) ||
    item.detail.toLowerCase().includes(needle)
  );
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function previewSnippet(preview: SystemsPreview | null) {
  if (!preview) return "";
  const lines = preview.content.split(/\r?\n/);
  return lines.slice(0, 14).join("\n");
}

function formatPath(path: string) {
  return path.replace(/^\/home\/delorenj/, "~");
}

function PreviewLink({ apiBase, preview }: { apiBase: string; preview?: SystemsPreviewTarget }) {
  const [value, setValue] = useState<SystemsPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!preview || value || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind: preview.kind, target: preview.target });
      const res = await fetch(`${apiBase}/api/modules/systems/preview?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `preview ${res.status}`);
      }
      setValue((await res.json()) as SystemsPreview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "preview unavailable");
    } finally {
      setLoading(false);
    }
  }, [apiBase, loading, preview, value]);

  const openTerminal = async () => {
    if (!preview) return;
    setOpening(true);
    try {
      const res = await fetch(`${apiBase}/api/modules/systems/preview/open-terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: preview.kind, target: preview.target })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `terminal ${res.status}`);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "terminal unavailable");
    } finally {
      setOpening(false);
    }
  };

  if (!preview) return <small>-</small>;

  const body = error ? error : loading ? "Loading preview..." : previewSnippet(value) || "Hover to load preview.";

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <HoverCard.Root
        openDelay={180}
        onOpenChange={(open) => {
          if (open) void loadPreview();
        }}
      >
        <HoverCard.Trigger asChild>
          <button
            className="systems-link-button"
            onClick={() => {
              setDialogOpen(true);
              void loadPreview();
            }}
            type="button"
          >
            Preview
          </button>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content align="start" className="systems-hover-card" sideOffset={8}>
            <div className="systems-preview-heading">
              <strong>{preview.label}</strong>
              <button className="systems-link-button" disabled={opening} onClick={() => void openTerminal()} type="button">
                Alacritty
              </button>
            </div>
            <pre>{body}</pre>
            <HoverCard.Arrow className="systems-hover-arrow" />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>

      <Dialog.Portal>
        <Dialog.Overlay className="systems-dialog-overlay" />
        <Dialog.Content className="systems-dialog-content">
          <div className="systems-dialog-header">
            <div>
              <Dialog.Title className="systems-dialog-title">{value?.label ?? preview.label}</Dialog.Title>
              <Dialog.Description className="systems-dialog-description">
                {value?.kind ?? preview.kind}
                {value?.sizeBytes ? ` · ${value.sizeBytes.toLocaleString()} bytes` : ""}
                {value?.truncated ? " · truncated" : ""}
              </Dialog.Description>
            </div>
            <div className="systems-dialog-actions">
              <button className="systems-link-button" disabled={opening} onClick={() => void openTerminal()} type="button">
                Open in Alacritty
              </button>
              <Dialog.Close className="systems-link-button">Close</Dialog.Close>
            </div>
          </div>
          <pre className="systems-preview-modal">{error ? error : value?.content ?? (loading ? "Loading preview..." : "")}</pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
    return <div className="empty">No history yet. Metrics accumulate every 5 minutes via srvls-metrics.timer.</div>;
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
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [stateFilters, setStateFilters] = useState<StateBucket[]>([]);
  const [capabilityFilters, setCapabilityFilters] = useState<CapabilityFilter[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceScope>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [boardFilter, setBoardFilter] = useState<string>("all");
  const [rangeHours, setRangeHours] = useState<number>(24);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("semantic");
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
      if (typeFilters.length && !typeFilters.includes(item.type)) return false;
      if (stateFilters.length && !stateFilters.includes(stateBucket(item))) return false;
      if (capabilityFilters.length && !capabilityFilters.every((capability) => hasCapability(item, capability))) return false;
      if (sourceFilter !== "all" && sourceScope(item) !== sourceFilter) return false;
      if (projectFilter !== "all" && item.project?.repo !== projectFilter) return false;
      if (boardFilter !== "all" && item.board?.provider !== boardFilter) return false;
      return matchesNeedle(item, needle);
    });
  }, [inventory, filter, typeFilters, stateFilters, capabilityFilters, sourceFilter, projectFilter, boardFilter]);

  const types = useMemo(() => Object.keys(inventory?.counts.byType ?? {}).sort(), [inventory]);
  const allItems = inventory?.items ?? [];
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allItems) counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, [allItems]);
  const stateCounts = useMemo(() => {
    const counts: Record<StateBucket, number> = { attention: 0, running: 0, waiting: 0, inactive: 0, other: 0 };
    for (const item of allItems) counts[stateBucket(item)] += 1;
    return counts;
  }, [allItems]);
  const capabilityCounts = useMemo(() => {
    const counts: Record<CapabilityFilter, number> = { actionable: 0, preview: 0, pm: 0, board: 0, scheduled: 0 };
    for (const item of allItems) {
      for (const option of CAPABILITY_FILTERS) if (hasCapability(item, option.id)) counts[option.id] += 1;
    }
    return counts;
  }, [allItems]);
  const sourceCounts = useMemo(() => {
    const counts: Record<SourceScope, number> = { all: allItems.length, projects: 0, home: 0, docker: 0, system: 0 };
    for (const item of allItems) {
      const scope = sourceScope(item);
      if (scope !== "all") counts[scope] += 1;
    }
    return counts;
  }, [allItems]);
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      if (item.project?.repo) counts.set(item.project.repo, (counts.get(item.project.repo) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allItems]);
  const boardProviders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      if (item.board?.provider) counts.set(item.board.provider, (counts.get(item.board.provider) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allItems]);
  const hasActiveFilters =
    filter.trim() ||
    typeFilters.length ||
    stateFilters.length ||
    capabilityFilters.length ||
    sourceFilter !== "all" ||
    projectFilter !== "all" ||
    boardFilter !== "all";

  const clearFilters = () => {
    setFilter("");
    setTypeFilters([]);
    setStateFilters([]);
    setCapabilityFilters([]);
    setSourceFilter("all");
    setProjectFilter("all");
    setBoardFilter("all");
  };

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
              srvls inventory metrics via node-exporter textfile → Prometheus, collected every 5 minutes.
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
          <div className="systems-filter-summary" aria-live="polite">
            <strong>{items.length.toLocaleString()}</strong>
            <span>of {(inventory?.counts.total ?? 0).toLocaleString()}</span>
          </div>
        </div>

        {error ? <div className="empty">Systems feed: {error}</div> : null}

        <div className="systems-filter-bar" aria-label="Systems filters">
          <div className="systems-filter-row systems-filter-primary">
            <input
              aria-label="Filter inventory"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search purpose, unit, PM, board, path, command..."
              type="search"
              value={filter}
            />
            <select aria-label="Source filter" onChange={(e) => setSourceFilter(e.target.value as SourceScope)} value={sourceFilter}>
              {SOURCE_SCOPES.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.label} ({sourceCounts[scope.id]})
                </option>
              ))}
            </select>
            <select aria-label="Project filter" onChange={(e) => setProjectFilter(e.target.value)} value={projectFilter}>
              <option value="all">all projects ({projects.reduce((sum, [, count]) => sum + count, 0)})</option>
              {projects.map(([project, count]) => (
                <option key={project} value={project}>
                  {project} ({count})
                </option>
              ))}
            </select>
            <select aria-label="Board provider filter" onChange={(e) => setBoardFilter(e.target.value)} value={boardFilter}>
              <option value="all">all boards ({boardProviders.reduce((sum, [, count]) => sum + count, 0)})</option>
              {boardProviders.map(([provider, count]) => (
                <option key={provider} value={provider}>
                  {provider} ({count})
                </option>
              ))}
            </select>
            <ToggleGroup.Root
              aria-label="Schedule display"
              className="systems-toggle-group"
              onValueChange={(value) => {
                if (value === "cron" || value === "semantic") setScheduleMode(value);
              }}
              type="single"
              value={scheduleMode}
            >
              <ToggleGroup.Item className="systems-toggle-item" value="semantic">
                Semantic
              </ToggleGroup.Item>
              <ToggleGroup.Item className="systems-toggle-item" value="cron">
                Cron
              </ToggleGroup.Item>
            </ToggleGroup.Root>
            <button className="systems-link-button" disabled={!hasActiveFilters} onClick={clearFilters} type="button">
              Clear
            </button>
          </div>

          <div className="systems-filter-row">
            <span className="systems-filter-label">Type</span>
            <ToggleGroup.Root
              aria-label="Type filters"
              className="systems-chip-group"
              onValueChange={(values) => setTypeFilters(values)}
              type="multiple"
              value={typeFilters}
            >
              {types.map((type) => (
                <ToggleGroup.Item className="systems-chip" key={type} value={type}>
                  {type}
                  <span>{typeCounts[type] ?? 0}</span>
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>

          <div className="systems-filter-row">
            <span className="systems-filter-label">State</span>
            <ToggleGroup.Root
              aria-label="State filters"
              className="systems-chip-group"
              onValueChange={(values) => setStateFilters(values as StateBucket[])}
              type="multiple"
              value={stateFilters}
            >
              {STATE_BUCKETS.map((bucket) => (
                <ToggleGroup.Item className={`systems-chip systems-chip-${bucket.id}`} key={bucket.id} value={bucket.id}>
                  {bucket.label}
                  <span>{stateCounts[bucket.id]}</span>
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>

          <div className="systems-filter-row">
            <span className="systems-filter-label">Has</span>
            <ToggleGroup.Root
              aria-label="Capability filters"
              className="systems-chip-group"
              onValueChange={(values) => setCapabilityFilters(values as CapabilityFilter[])}
              type="multiple"
              value={capabilityFilters}
            >
              {CAPABILITY_FILTERS.map((capability) => (
                <ToggleGroup.Item className="systems-chip" key={capability.id} value={capability.id}>
                  {capability.label}
                  <span>{capabilityCounts[capability.id]}</span>
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </div>

          {hasActiveFilters ? (
            <div className="systems-active-filters" aria-label="Active filters">
              {filter.trim() ? <button onClick={() => setFilter("")} type="button">Search: {filter.trim()}</button> : null}
              {sourceFilter !== "all" ? <button onClick={() => setSourceFilter("all")} type="button">Source: {sourceFilter}</button> : null}
              {projectFilter !== "all" ? <button onClick={() => setProjectFilter("all")} type="button">Project: {projectFilter}</button> : null}
              {boardFilter !== "all" ? <button onClick={() => setBoardFilter("all")} type="button">Board: {boardFilter}</button> : null}
              {typeFilters.map((type) => (
                <button key={type} onClick={() => setTypeFilters((current) => current.filter((value) => value !== type))} type="button">
                  Type: {type}
                </button>
              ))}
              {stateFilters.map((state) => (
                <button key={state} onClick={() => setStateFilters((current) => current.filter((value) => value !== state))} type="button">
                  State: {state}
                </button>
              ))}
              {capabilityFilters.map((capability) => (
                <button
                  key={capability}
                  onClick={() => setCapabilityFilters((current) => current.filter((value) => value !== capability))}
                  type="button"
                >
                  Has: {capability}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Type</th>
                <th align="left">Purpose</th>
                <th align="left">State</th>
                <th align="left">Schedule</th>
                <th align="left">Preview</th>
                <th align="left">PM</th>
                <th align="left">Board</th>
                <th align="left">Source</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 400).map((item) => {
                const key = `${item.type}/${item.name}/${item.source}`;
                const busy = working === `${item.type}/${item.name}`;
                const purpose = itemPurpose(item);
                const context = itemContext(item);
                return (
                  <tr key={key}>
                    <td>{item.type}</td>
                    <td className="systems-purpose-cell">
                      <strong>{purpose}</strong>
                      <small>
                        {context ? <span>{context}</span> : null}
                        <code>{item.name}</code>
                      </small>
                    </td>
                    <td>
                      <span className={stateClass(item.state)}>{item.state}</span>
                    </td>
                    <td className="systems-schedule-cell" title={item.schedule || undefined}>
                      {itemSchedule(item, scheduleMode)}
                    </td>
                    <td>
                      <PreviewLink apiBase={apiBase} preview={item.preview} />
                    </td>
                    <td className="systems-path-cell">
                      {item.pm ? (
                        <>
                          <strong>{item.pm.displayName}</strong>
                          <code title={item.pm.hermesPath}>{formatPath(item.pm.hermesPath)}</code>
                        </>
                      ) : (
                        <small>-</small>
                      )}
                    </td>
                    <td>
                      {item.board ? (
                        <a className="systems-board-link" href={item.board.url} rel="noreferrer" target="_blank">
                          {item.board.provider}
                        </a>
                      ) : (
                        <small>-</small>
                      )}
                    </td>
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

"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ClockCard } from "../clock-card";
import { ToolingTab } from "../tooling";
import { SystemsTab } from "../systems";
import ContainersTab from "../containers";
import DirectorTab from "../director";

type ActiveWork = {
  status: "idle" | "checking" | "active" | "blocked" | "stalled" | "error" | "unknown";
  issue_id?: string;
  summary?: string;
  reason?: string;
  session?: string;
  worktree?: string;
  updated_at?: string;
  last_activity_at?: string;
  last_heartbeat_at?: string;
  last_full_run_started_at?: string;
  last_runner_completed_at?: string;
  last_runner_exit_code?: number;
  last_decision?: string;
  source?: string;
  state_path?: string;
  log_path?: string;
  age_seconds?: number;
};

type VelocityHistoryEvent = {
  agent_id: string;
  issue_id?: string;
  status: ActiveWork["status"];
  event_type: string;
  timestamp: string;
  summary?: string;
  reason?: string;
  last_runner_exit_code?: number;
};

type FleetAgent = {
  agent_id: string;
  display_name: string;
  repo: string;
  role: string;
  role_dir: string;
  project_path: string;
  profile_name: string;
  gateway_status: string;
  consumer_status: string;
  sentinel_timer_status: string;
  sentinel_service_status: string;
  busy_state: "idle" | "busy" | "blocked" | "stalled" | "error" | "unknown";
  active_work: ActiveWork;
};

type Snapshot = {
  generatedAt: string;
  source: string;
  agents: FleetAgent[];
  velocity_history?: VelocityHistoryEvent[];
};

type LogTail = {
  agent_id: string;
  path: string;
  content: string;
  truncated: boolean;
  size_bytes: number;
  generatedAt: string;
};

const configuredApi = process.env.NEXT_PUBLIC_HOLOCENE_API_URL?.trim().replace(/\/$/, "");
const API = configuredApi && configuredApi !== "/" ? configuredApi : "";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHost(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, ""));
}

function resolveApiBase() {
  if (!API) return "";
  if (typeof window === "undefined") return API;

  try {
    const apiUrl = new URL(API, window.location.href);
    if (isLoopbackHost(apiUrl.hostname) && !isLoopbackHost(window.location.hostname)) {
      return "";
    }
  } catch {
    return API;
  }

  return API;
}
const TASK_TEXT_LIMIT = 190;
const LOG_TAIL_LINES = 160;
const LOG_REFRESH_MS = 2000;
const VELOCITY_REFRESH_MS = 30_000;
const VELOCITY_RANGE_STORAGE_KEY = "holocene-velocity-range";
const VELOCITY_MIN_BAR_WIDTH_PCT = 0.8;

type VelocityRange = "1h" | "1d" | "3d";
const VELOCITY_RANGES: VelocityRange[] = ["1h", "1d", "3d"];

// Wider time-scaled tracks keep bars legible on long ranges; the 1h view fits
// the scroll area exactly.
const VELOCITY_TRACK_MIN_WIDTH: Record<VelocityRange, number | undefined> = {
  "1h": undefined,
  "1d": 1800,
  "3d": 3600
};

type VelocitySpanStatus = "completed" | "failed" | "running" | "orphaned";

type VelocitySpan = {
  id: string;
  agent_id: string;
  project: string;
  issue?: string;
  label: string;
  lane?: string;
  startedAt: string;
  endedAt: string | null;
  status: VelocitySpanStatus;
};

type VelocityTimeline = {
  generatedAt: string;
  range: VelocityRange;
  from: string;
  to: string;
  lanes: {
    project: string;
    agents: { agent_id: string; display_name: string; spans: VelocitySpan[] }[];
  }[];
  counts: { spans: number; running: number; failed: number };
  source: "candystore";
};

const statusVerbs: Record<ActiveWork["status"], string> = {
  active: "Working on",
  blocked: "Blocked on",
  checking: "Checking",
  error: "Error on",
  idle: "Idle after",
  stalled: "Stalled on",
  unknown: "Waiting on"
};

function formatAge(seconds?: number) {
  if (seconds === undefined) return "unknown";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(seconds?: number) {
  if (seconds === undefined) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `${hours}h ${remainingMinutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function secondsSince(iso: string | undefined, now: number) {
  if (!iso) return undefined;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.floor((now - timestamp) / 1000));
}

function statusClass(status: string) {
  if (status === "active" || status === "busy") return "status status-active";
  if (status === "checking") return "status status-checking";
  if (status === "blocked" || status === "stalled" || status === "error") {
    return "status status-attention";
  }
  if (status === "idle" || status === "active-service") return "status status-idle";
  return "status status-unknown";
}

function serviceClass(status: string) {
  return status === "active" ? "status status-idle" : "status status-unknown";
}

function compactText(value?: string) {
  return value?.replace(/\s+/g, " ").trim();
}

function immediateClause(text: string) {
  const clauses = text.split(/\s*;\s*/).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length <= 1) return text;

  return (
    clauses.find((clause) =>
      /\b(blocked|blocker|close|finish|fix|need|needs|pending|recover|remaining|require|requires|still|waiting)\b/i.test(
        clause
      )
    ) ?? clauses[0]
  );
}

function firstSentence(value?: string) {
  const text = compactText(value);
  if (!text) return undefined;
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const trimmed = immediateClause(sentence).trim();
  if (trimmed.length <= TASK_TEXT_LIMIT) return trimmed;
  const clipped = trimmed.slice(0, TASK_TEXT_LIMIT);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 120 ? lastSpace : TASK_TEXT_LIMIT).trim()}...`;
}

function stripIssuePrefix(text: string, issueId?: string) {
  if (!issueId) return text;
  return text.replace(new RegExp(`^${issueId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-:;]?\\s*`, "i"), "");
}

function ensureSentence(text: string) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function describeImmediateTask(agent: FleetAgent) {
  const { active_work: work } = agent;
  const rawDetail =
    firstSentence(work.summary) ??
    firstSentence(work.reason) ??
    (work.last_decision ? `Last decision: ${work.last_decision}` : undefined);

  if (!rawDetail) {
    if (work.status === "idle") return `${agent.display_name} is idle with no current task recorded.`;
    return `${agent.display_name} has no current task detail recorded.`;
  }

  const detail = stripIssuePrefix(rawDetail, work.issue_id);
  const target = work.issue_id ? `${work.issue_id}: ${detail}` : `${agent.display_name}: ${detail}`;
  return ensureSentence(`${statusVerbs[work.status]} ${target}`);
}

function freshnessSeconds(work: ActiveWork, now: number) {
  return (
    secondsSince(work.last_heartbeat_at, now) ??
    secondsSince(work.last_activity_at, now) ??
    secondsSince(work.updated_at, now) ??
    work.age_seconds
  );
}

function timerForWork(work: ActiveWork, now: number) {
  const runnerSeconds = secondsSince(work.last_full_run_started_at, now);
  if ((work.status === "active" || work.status === "checking") && runnerSeconds !== undefined) {
    return { label: "running", value: formatDuration(runnerSeconds) };
  }

  const quietSeconds = freshnessSeconds(work, now);
  if (work.status === "blocked" || work.status === "stalled" || work.status === "error") {
    return { label: "quiet", value: formatDuration(quietSeconds) };
  }
  if (work.status === "idle") return { label: "idle", value: formatDuration(quietSeconds) };
  return { label: "last signal", value: formatDuration(quietSeconds) };
}

function progressSteps(agent: FleetAgent, now: number) {
  const { active_work: work } = agent;
  const quietSeconds = freshnessSeconds(work, now);
  const runnerStartedSeconds = secondsSince(work.last_full_run_started_at, now);
  const runnerCompletedSeconds = secondsSince(work.last_runner_completed_at, now);
  const isAttention = work.status === "blocked" || work.status === "stalled" || work.status === "error";
  const pulseTone =
    isAttention || (quietSeconds !== undefined && quietSeconds > 900) ? "attention" : "current";
  const runnerActive =
    runnerStartedSeconds !== undefined &&
    (runnerCompletedSeconds === undefined ||
      Date.parse(work.last_full_run_started_at ?? "") > Date.parse(work.last_runner_completed_at ?? ""));

  return [
    {
      label: "Task",
      value: work.issue_id ?? (work.status === "unknown" ? "unmapped" : work.status),
      tone: work.issue_id ? "complete" : work.status === "unknown" ? "pending" : "current"
    },
    {
      label: "Runner",
      value: runnerActive
        ? `running ${formatDuration(runnerStartedSeconds)}`
        : runnerCompletedSeconds !== undefined
          ? `exit ${work.last_runner_exit_code ?? "?"} ${formatAge(runnerCompletedSeconds)}`
          : work.session ?? "waiting",
      tone: runnerActive
        ? "current"
        : work.last_runner_exit_code && work.last_runner_exit_code !== 0
          ? "attention"
          : runnerCompletedSeconds !== undefined
            ? "complete"
            : "pending"
    },
    {
      label: "Pulse",
      value: quietSeconds === undefined ? "unknown" : `${formatDuration(quietSeconds)} quiet`,
      tone: pulseTone
    }
  ] as const;
}

function velocityAxisTicks(range: VelocityRange, fromMs: number, toMs: number): { atMs: number; label: string }[] {
  const stepMs = range === "1h" ? 10 * 60 * 1000 : range === "1d" ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const ticks: { atMs: number; label: string }[] = [];

  for (let atMs = Math.ceil(fromMs / stepMs) * stepMs; atMs <= toMs; atMs += stepMs) {
    const date = new Date(atMs);
    const midnight = date.getHours() === 0 && date.getMinutes() === 0;
    const label =
      range !== "1h" && midnight
        ? date.toLocaleDateString([], { month: "short", day: "numeric" })
        : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    ticks.push({ atMs, label });
  }

  return ticks;
}

// Place a span on the window as left/width percentages, clipping to the window
// edges and keeping a minimum visible width for zero-length spans.
function spanGeometry(span: VelocitySpan, fromMs: number, toMs: number, nowMs: number) {
  const total = toMs - fromMs;
  if (total <= 0) return { left: 0, width: VELOCITY_MIN_BAR_WIDTH_PCT };

  const startMs = Math.max(Date.parse(span.startedAt), fromMs);
  const rawEndMs =
    span.status === "running" ? nowMs : span.endedAt ? Date.parse(span.endedAt) : Date.parse(span.startedAt);
  const endMs = Math.max(Math.min(rawEndMs, toMs), startMs);

  const left = ((startMs - fromMs) / total) * 100;
  const width = Math.max(((endMs - startMs) / total) * 100, VELOCITY_MIN_BAR_WIDTH_PCT);
  return { left: Math.min(left, 100 - VELOCITY_MIN_BAR_WIDTH_PCT), width };
}

function formatClock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function spanDurationSeconds(span: VelocitySpan, nowMs: number): number | undefined {
  const startMs = Date.parse(span.startedAt);
  const endMs = span.endedAt ? Date.parse(span.endedAt) : span.status === "running" ? nowMs : undefined;
  if (!Number.isFinite(startMs) || endMs === undefined || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function spanDescription(span: VelocitySpan, agentName: string, nowMs: number) {
  const duration = formatDuration(spanDurationSeconds(span, nowMs));
  const end = span.endedAt ? formatClock(span.endedAt) : span.status === "running" ? "now" : "no end event";
  return `${agentName} ${span.label}: ${span.status}, ${formatClock(span.startedAt)} → ${end}, ${duration}`;
}

type ServiceKind = "gateway" | "consumer" | "sentinel" | "checkpoint";
type UnitAction = "start" | "stop" | "restart";

function ServiceControls({
  agentId,
  service,
  status,
  disabled,
  onAction
}: {
  agentId: string;
  service: ServiceKind;
  status: string;
  disabled: boolean;
  onAction: (agentId: string, service: ServiceKind, action: UnitAction) => void;
}) {
  const buttons: { action: UnitAction; glyph: string; title: string }[] = [
    { action: "start", glyph: "▶", title: `Start ${service}` },
    { action: "restart", glyph: "⟳", title: `Restart ${service}` },
    { action: "stop", glyph: "■", title: `Stop ${service}` }
  ];
  return (
    <div className="svc-cell">
      <span className={serviceClass(status)}>{status}</span>
      <span className="svc-buttons">
        {buttons.map((b) => (
          <button
            className={`svc-btn svc-btn-${b.action}`}
            disabled={disabled}
            key={b.action}
            onClick={() => onAction(agentId, service, b.action)}
            title={`${b.title} (${agentId})`}
            type="button"
          >
            {b.glyph}
          </button>
        ))}
      </span>
    </div>
  );
}

export default function HomePage() {
  const [apiBase] = useState(resolveApiBase);
  const [activeTab, setActiveTab] = useState<"fleet" | "tooling" | "systems" | "containers" | "director">("fleet");
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "fleet" || tab === "tooling" || tab === "systems" || tab === "containers" || tab === "director") setActiveTab(tab);
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [velocityRange, setVelocityRange] = useState<VelocityRange>("1h");
  // Gates the first velocity fetch until the persisted range has been
  // restored, so a saved non-default range does not fire a wasted 1h fetch
  // (a lazy useState initializer would mismatch the server-rendered HTML).
  const [velocityRangeReady, setVelocityRangeReady] = useState(false);
  const [velocity, setVelocity] = useState<VelocityTimeline | null>(null);
  const [velocityError, setVelocityError] = useState<string | null>(null);
  const [velocityRequested, setVelocityRequested] = useState(false);
  const velocityScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VELOCITY_RANGE_STORAGE_KEY);
      if (saved === "1h" || saved === "1d" || saved === "3d") setVelocityRange(saved);
    } catch {
      // Private windows can refuse storage; the 1h default still applies.
    }
    setVelocityRangeReady(true);
  }, []);

  const selectVelocityRange = (range: VelocityRange) => {
    if (range === velocityRange) return;
    setVelocityRange(range);
    // Drop the previous range's timeline so stale spans, ticks and errors
    // never render against the new window while the fetch is in flight.
    setVelocity(null);
    setVelocityError(null);
    setVelocityRequested(false);
    try {
      window.localStorage.setItem(VELOCITY_RANGE_STORAGE_KEY, range);
    } catch {
      // Persistence is a convenience, never a blocker.
    }
  };
  const [openLogAgentId, setOpenLogAgentId] = useState<string | null>(null);
  const [logTails, setLogTails] = useState<Record<string, LogTail | undefined>>({});
  const [logErrors, setLogErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/hermes-fleet/snapshot`);
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        const data = (await response.json()) as Snapshot;
        if (!cancelled) {
          setSnapshot(data);
          setFeedError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setFeedError(err instanceof Error ? err.message : "snapshot unavailable");
        }
      }
    };

    void loadSnapshot();

    const es = new EventSource(`${apiBase}/api/modules/hermes-fleet/stream`);
    es.addEventListener("snapshot", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as Snapshot;
      setSnapshot(data);
      setFeedError(null);
    });
    es.onerror = () => {
      void loadSnapshot();
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [apiBase]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  const workingAgents = useMemo(
    () => agents.filter((agent) => agent.busy_state !== "idle" && agent.busy_state !== "unknown"),
    [agents]
  );
  const attentionAgents = useMemo(
    () =>
      agents.filter((agent) =>
        ["blocked", "stalled", "error", "unknown"].includes(agent.busy_state)
      ),
    [agents]
  );
  useEffect(() => {
    if (!velocityRangeReady) return undefined;
    let cancelled = false;

    const loadVelocity = async () => {
      try {
        const response = await fetch(`${apiBase}/api/modules/hermes-fleet/velocity?range=${velocityRange}`, {
          cache: "no-store"
        });
        if (!response.ok) {
          let message = `velocity ${response.status}`;
          try {
            const body = (await response.json()) as { error?: string };
            if (body.error) message = body.error;
          } catch {
            // Keep the status fallback when the API did not return JSON.
          }
          throw new Error(message);
        }
        const data = (await response.json()) as VelocityTimeline;
        if (!cancelled) {
          setVelocity(data);
          setVelocityError(null);
          setVelocityRequested(true);
        }
      } catch (err) {
        if (!cancelled) {
          setVelocityError(err instanceof Error ? err.message : "velocity feed unavailable");
          setVelocityRequested(true);
        }
      }
    };

    void loadVelocity();
    const timer = window.setInterval(() => void loadVelocity(), VELOCITY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiBase, velocityRange, velocityRangeReady]);

  // Ticks carry their true time position as a percentage of the loaded
  // window, so labels and gridlines sit exactly where bars do.
  const velocityTicks = useMemo(() => {
    if (!velocity) return [];
    const fromMs = Date.parse(velocity.from);
    const toMs = Date.parse(velocity.to);
    const total = toMs - fromMs;
    return velocityAxisTicks(velocity.range, fromMs, toMs).map((tick) => ({
      ...tick,
      left: total > 0 ? ((tick.atMs - fromMs) / total) * 100 : 0
    }));
  }, [velocity]);

  // "Now" is the right edge: land there on first load and on every range change.
  useEffect(() => {
    const scroller = velocityScrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [velocityRange, velocity?.range]);

  const velocityFromMs = velocity ? Date.parse(velocity.from) : 0;
  const velocityToMs = velocity ? Date.parse(velocity.to) : 0;
  const velocityMultiProject = (velocity?.lanes.length ?? 0) > 1;

  useEffect(() => {
    if (!openLogAgentId) return undefined;
    let cancelled = false;

    const loadLogTail = async () => {
      try {
        const response = await fetch(
          `${apiBase}/api/modules/hermes-fleet/agents/${encodeURIComponent(
            openLogAgentId
          )}/log?lines=${LOG_TAIL_LINES}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          let message = `log ${response.status}`;
          try {
            const body = (await response.json()) as { error?: string };
            message = body.error ?? message;
          } catch {
            // Keep the status fallback when the API did not return JSON.
          }
          throw new Error(message);
        }

        const data = (await response.json()) as LogTail;
        if (!cancelled) {
          setLogTails((current) => ({ ...current, [openLogAgentId]: data }));
          setLogErrors((current) => ({ ...current, [openLogAgentId]: undefined }));
        }
      } catch (err) {
        if (!cancelled) {
          setLogErrors((current) => ({
            ...current,
            [openLogAgentId]: err instanceof Error ? err.message : "log unavailable"
          }));
        }
      }
    };

    void loadLogTail();
    const interval = window.setInterval(() => {
      void loadLogTail();
    }, LOG_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase, openLogAgentId]);

  const action = async (path: string) => {
    setWorking(true);
    try {
      await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true })
      });
      const next = (await fetch(`${apiBase}/api/modules/hermes-fleet/snapshot`).then((r) =>
        r.json()
      )) as Snapshot;
      setSnapshot(next);
    } finally {
      setWorking(false);
    }
  };

  const controlService = async (agentId: string, service: ServiceKind, act: UnitAction) => {
    setWorking(true);
    try {
      await fetch(
        `${apiBase}/api/modules/hermes-fleet/agents/${encodeURIComponent(agentId)}/services/${service}/${act}`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      const next = (await fetch(`${apiBase}/api/modules/hermes-fleet/snapshot`).then((r) =>
        r.json()
      )) as Snapshot;
      setSnapshot(next);
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">33GOD Control Plane</p>
          <h1>Holocene</h1>
        </div>
        {activeTab === "fleet" ? (
          <div className="actions">
            <button
              disabled={working}
              onClick={() => action("/api/modules/hermes-fleet/actions/restart-gateways")}
            >
              Restart gateways
            </button>
            <button
              disabled={working}
              onClick={() => action("/api/modules/hermes-fleet/actions/sync-template-defaults")}
            >
              Sync defaults
            </button>
          </div>
        ) : null}
      </header>

      <nav className="tabs" aria-label="Holocene sections" role="tablist">
        <button
          aria-selected={activeTab === "fleet"}
          className={activeTab === "fleet" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("fleet")}
          role="tab"
          type="button"
        >
          Fleet
        </button>
        <button
          aria-selected={activeTab === "tooling"}
          className={activeTab === "tooling" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("tooling")}
          role="tab"
          type="button"
        >
          Tooling
        </button>
        <Link className="tab section-link" href={{ pathname: "/hooks" }}>Hooks</Link>
        <button
          aria-selected={activeTab === "systems"}
          className={activeTab === "systems" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("systems")}
          role="tab"
          type="button"
        >
          Systems
        </button>
        <button
          aria-selected={activeTab === "containers"}
          className={activeTab === "containers" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("containers")}
          role="tab"
          type="button"
        >
          Containers
        </button>
        <button
          aria-selected={activeTab === "director"}
          className={activeTab === "director" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("director")}
          role="tab"
          type="button"
        >
          Director
        </button>
      </nav>

      {activeTab === "fleet" ? (
        <>
          <ClockCard apiBase={apiBase} />

          <section className="summary-grid" aria-label="Fleet summary">
            <div className="metric">
              <span className="metric-label">Agents</span>
              <strong>{agents.length}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Working</span>
              <strong>{workingAgents.length}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Needs attention</span>
              <strong>{attentionAgents.length}</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Snapshot</span>
              <strong>{snapshot ? new Date(snapshot.generatedAt).toLocaleTimeString() : "loading"}</strong>
            </div>
          </section>

      <section className="velocity-section" aria-label="Ticket velocity">
        <div className="section-heading">
          <div>
            <h2>Ticket Velocity</h2>
            <p className="section-note">
              Hermes gateway invocations via Candystore, paired into time-scaled spans. Scroll left to inspect
              activity before a spike.
            </p>
          </div>
          <div className="velocity-controls">
            <div className="velocity-range" role="group" aria-label="Velocity time window">
              {VELOCITY_RANGES.map((range) => (
                <button
                  className={velocityRange === range ? "tab tab-active" : "tab"}
                  key={range}
                  onClick={() => selectVelocityRange(range)}
                  type="button"
                >
                  {range}
                </button>
              ))}
            </div>
            <div className="velocity-legend" aria-label="Velocity status legend">
              <span><i className="velocity-key velocity-key-green" /> completed</span>
              <span><i className="velocity-key velocity-key-yellow" /> running</span>
              <span><i className="velocity-key velocity-key-red" /> failed</span>
            </div>
          </div>
        </div>
        <div
          className="velocity-scroll"
          role="region"
          aria-label="Scrollable ticket velocity timeline"
          tabIndex={0}
          ref={velocityScrollRef}
        >
          <div
            className="velocity-grid"
            style={
              VELOCITY_TRACK_MIN_WIDTH[velocity?.range ?? velocityRange]
                ? { minWidth: 190 + (VELOCITY_TRACK_MIN_WIDTH[velocity?.range ?? velocityRange] ?? 0) }
                : undefined
            }
          >
            <div className="velocity-header">
              <div className="velocity-corner">Project / agent</div>
              <div className="velocity-axis" aria-hidden="true">
                {velocityTicks
                  .filter((tick) => tick.left <= 95)
                  .map((tick) => (
                    <span
                      className={
                        tick.left > 88 ? "velocity-axis-tick velocity-axis-tick-end" : "velocity-axis-tick"
                      }
                      key={tick.atMs}
                      style={{ left: `${tick.left}%` }}
                    >
                      <span className="velocity-axis-tick-label">{tick.label}</span>
                    </span>
                  ))}
                <span className="velocity-axis-now">now</span>
              </div>
            </div>
            {velocity?.lanes.map((projectLane) => (
              <Fragment key={projectLane.project}>
                {velocityMultiProject ? (
                  <div className="velocity-project-row">
                    <span className="velocity-project-label">{projectLane.project}</span>
                  </div>
                ) : null}
                {projectLane.agents.map((agentLane) => (
                  <div className="velocity-row" key={agentLane.agent_id}>
                    <div className="velocity-lane-label">
                      <strong>{agentLane.display_name}</strong>
                      <span>{agentLane.spans[agentLane.spans.length - 1]?.label ?? "no activity"}</span>
                    </div>
                    <div className="velocity-track" aria-label={`${agentLane.display_name} invocation timeline`}>
                      <div className="velocity-ticks" aria-hidden="true">
                        {velocityTicks
                          .filter((tick) => tick.left <= 99.9)
                          .map((tick) => (
                            <span key={tick.atMs} style={{ left: `${tick.left}%` }} />
                          ))}
                      </div>
                      {agentLane.spans.map((span) => {
                        const geometry = spanGeometry(span, velocityFromMs, velocityToMs, now);
                        const description = spanDescription(span, agentLane.display_name, now);
                        return (
                          <div
                            aria-label={description}
                            className={`velocity-bar velocity-bar-${span.status}`}
                            key={span.id}
                            role="img"
                            style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }}
                            tabIndex={0}
                            title={description}
                          >
                            <span className="velocity-bar-label">{span.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </Fragment>
            ))}
            {!velocityError && !velocityRequested ? (
              <div className="velocity-empty empty">Loading ticket velocity.</div>
            ) : null}
            {velocityError ? (
              <div className="velocity-empty empty">Velocity feed unavailable: {velocityError}</div>
            ) : null}
            {!velocityError && velocityRequested && velocity && !velocity.counts.spans ? (
              <div className="velocity-empty empty">No fleet invocations in the last {velocityRange}.</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="work-section" aria-label="Active work">
        <div className="section-heading">
          <h2>Right Now</h2>
          <span>{snapshot?.source ?? "loading registry"}</span>
        </div>
        <div className="work-list">
          {feedError ? (
            <div className="empty">Fleet feed unavailable: {feedError}</div>
          ) : null}
          {(workingAgents.length ? workingAgents : attentionAgents).map((agent) => {
            const timer = timerForWork(agent.active_work, now);
            const steps = progressSteps(agent, now);

            return (
              <article className="work-item" key={agent.agent_id}>
                <div className="work-main">
                  <div>
                    <div className="agent-title">
                      <span>{agent.display_name}</span>
                      <span className={statusClass(agent.active_work.status)}>
                        {agent.active_work.status}
                      </span>
                    </div>
                    <div className="task-terminal">
                      <p className="task-line">
                        <span className="prompt-symbol">$</span>
                        <span>{describeImmediateTask(agent)}</span>
                      </p>
                      <div className="task-timer" aria-label={`${timer.label} ${timer.value}`}>
                        <span>{timer.label}</span>
                        <strong>{timer.value}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="issue-chip">{agent.active_work.issue_id ?? "no issue mapped"}</div>
                </div>
                <div className="progress-strip" aria-label={`${agent.display_name} progress`}>
                  {steps.map((step) => (
                    <div className={`progress-step progress-step-${step.tone}`} key={step.label}>
                      <span>{step.label}</span>
                      <strong>{step.value}</strong>
                    </div>
                  ))}
                </div>
                <dl className="work-meta">
                  <div>
                    <dt>Session</dt>
                    <dd>{agent.active_work.session ?? "unknown"}</dd>
                  </div>
                  <div>
                    <dt>Worktree</dt>
                    <dd>{agent.active_work.worktree ?? agent.project_path ?? "unknown"}</dd>
                  </div>
                  <div>
                    <dt>Refreshed</dt>
                    <dd>{formatAge(freshnessSeconds(agent.active_work, now))}</dd>
                  </div>
                  <div>
                    <dt>Log</dt>
                    <dd>
                      {agent.active_work.log_path ? (
                        <button
                          aria-expanded={openLogAgentId === agent.agent_id}
                          className="log-path"
                          onClick={() =>
                            setOpenLogAgentId((current) =>
                              current === agent.agent_id ? null : agent.agent_id
                            )
                          }
                          type="button"
                        >
                          {agent.active_work.log_path}
                        </button>
                      ) : (
                        "missing"
                      )}
                    </dd>
                  </div>
                </dl>
                {openLogAgentId === agent.agent_id ? (
                  <section className="log-panel" aria-label={`${agent.display_name} log tail`}>
                    <div className="log-panel-bar">
                      <span>tail -f {agent.active_work.log_path ?? "missing"}</span>
                      <button onClick={() => setOpenLogAgentId(null)} type="button">
                        Close
                      </button>
                    </div>
                    <pre>
                      {logErrors[agent.agent_id] ??
                        logTails[agent.agent_id]?.content ??
                        "Loading log..."}
                    </pre>
                  </section>
                ) : null}
              </article>
            );
          })}
          {!feedError && !snapshot ? <div className="empty">Loading fleet work-state feed.</div> : null}
          {!feedError && snapshot && !agents.length ? (
            <div className="empty">No Hermes PM agents are registered yet.</div>
          ) : null}
          {!feedError && snapshot && agents.length && !workingAgents.length && !attentionAgents.length ? (
            <div className="empty">All registered PM agents are idle.</div>
          ) : null}
        </div>
      </section>

      <section className="fleet-section" aria-label="Fleet inventory">
        <div className="section-heading">
          <h2>Fleet</h2>
          <span>Live services and PM work-state feeds</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Agent</th>
                <th align="left">Repo</th>
                <th align="left">Gateway</th>
                <th align="left">Consumer</th>
                <th align="left">Sentinel</th>
                <th align="left">Work</th>
                <th align="left">Issue</th>
                <th align="left">Updated</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agent_id}>
                  <td>
                    <strong>{agent.display_name}</strong>
                    <small>{agent.agent_id}</small>
                  </td>
                  <td>{agent.repo}</td>
                  <td>
                    <ServiceControls
                      agentId={agent.agent_id}
                      disabled={working}
                      onAction={controlService}
                      service="gateway"
                      status={agent.gateway_status}
                    />
                  </td>
                  <td>
                    <ServiceControls
                      agentId={agent.agent_id}
                      disabled={working}
                      onAction={controlService}
                      service="consumer"
                      status={agent.consumer_status}
                    />
                  </td>
                  <td>
                    <ServiceControls
                      agentId={agent.agent_id}
                      disabled={working}
                      onAction={controlService}
                      service="sentinel"
                      status={agent.sentinel_timer_status}
                    />
                  </td>
                  <td>
                    <span className={statusClass(agent.busy_state)}>{agent.busy_state}</span>
                  </td>
                  <td>{agent.active_work.issue_id ?? "-"}</td>
                  <td>{formatAge(agent.active_work.age_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
        </>
      ) : activeTab === "tooling" ? (
        <ToolingTab apiBase={apiBase} />
      ) : activeTab === "containers" ? (
        <ContainersTab apiBase={apiBase} />
      ) : activeTab === "director" ? (
        <DirectorTab apiBase={apiBase} />
      ) : (
        <SystemsTab apiBase={apiBase} />
      )}
    </main>
  );
}

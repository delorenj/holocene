"use client";

import { useEffect, useMemo, useState } from "react";
import { ToolingTab } from "./tooling";

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
const TASK_TEXT_LIMIT = 190;
const LOG_TAIL_LINES = 160;
const LOG_REFRESH_MS = 2000;
const HEARTBEAT_INTERVAL_SECONDS = 5 * 60;
const VELOCITY_TICK_COUNT = 12;

type VelocityTone = "green" | "yellow" | "red";

type VelocitySegment = {
  id: string;
  issue: string;
  summary: string;
  status: ActiveWork["status"];
  tone: VelocityTone;
  span: 1 | 2 | 3;
  startTick: number;
  heartbeatAge?: number;
  label: string;
};

type VelocityLane = {
  agent: FleetAgent;
  segments: VelocitySegment[];
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function severityFromStatus(
  status: ActiveWork["status"],
  options: { quietSeconds?: number; busyState?: FleetAgent["busy_state"]; runnerFailed?: boolean } = {}
): { tone: VelocityTone; span: 1 | 2 | 3; label: string } {
  if (
    ["blocked", "stalled", "error"].includes(status) ||
    ["blocked", "stalled", "error"].includes(options.busyState ?? "idle") ||
    options.runnerFailed
  ) {
    return { tone: "red", span: 3, label: "3-tick blocker" };
  }

  if (
    status === "checking" ||
    options.quietSeconds === undefined ||
    options.quietSeconds > HEARTBEAT_INTERVAL_SECONDS * 2 ||
    options.busyState === "unknown"
  ) {
    return { tone: "yellow", span: 2, label: "2-tick watch" };
  }

  return { tone: "green", span: 1, label: "1-tick healthy" };
}

function velocitySeverity(agent: FleetAgent, now: number): { tone: VelocityTone; span: 1 | 2 | 3; label: string } {
  const { active_work: work } = agent;
  return severityFromStatus(work.status, {
    quietSeconds: freshnessSeconds(work, now),
    busyState: agent.busy_state,
    runnerFailed: work.last_runner_exit_code !== undefined && work.last_runner_exit_code !== 0
  });
}

function buildCurrentVelocitySegment(agent: FleetAgent, now: number): VelocitySegment {
  const heartbeatAge = freshnessSeconds(agent.active_work, now);
  const { tone, span, label } = velocitySeverity(agent, now);
  const heartbeatTick = clamp(
    VELOCITY_TICK_COUNT - 1 - Math.floor((heartbeatAge ?? 0) / HEARTBEAT_INTERVAL_SECONDS),
    0,
    VELOCITY_TICK_COUNT - 1
  );
  const startTick = clamp(heartbeatTick - span + 1, 0, VELOCITY_TICK_COUNT - span);
  const issue = agent.active_work.issue_id ?? agent.active_work.status;
  const summary =
    firstSentence(agent.active_work.summary) ??
    firstSentence(agent.active_work.reason) ??
    "No task detail recorded";

  return {
    id: `${agent.agent_id}-current-${issue}`,
    issue,
    summary,
    status: agent.active_work.status,
    tone,
    span,
    startTick,
    heartbeatAge,
    label
  };
}

function buildHistoricalVelocitySegment(event: VelocityHistoryEvent, index: number, now: number): VelocitySegment | undefined {
  const eventAge = secondsSince(event.timestamp, now);
  if (eventAge === undefined || eventAge > HEARTBEAT_INTERVAL_SECONDS * VELOCITY_TICK_COUNT) return undefined;

  const { tone, span, label } = severityFromStatus(event.status, {
    quietSeconds: 0,
    runnerFailed: event.last_runner_exit_code !== undefined && event.last_runner_exit_code !== 0
  });
  const heartbeatTick = clamp(
    VELOCITY_TICK_COUNT - 1 - Math.floor(eventAge / HEARTBEAT_INTERVAL_SECONDS),
    0,
    VELOCITY_TICK_COUNT - 1
  );
  const startTick = clamp(heartbeatTick - span + 1, 0, VELOCITY_TICK_COUNT - span);
  const issue = event.issue_id ?? event.status;

  return {
    id: `${event.agent_id}-${event.timestamp}-${index}`,
    issue,
    summary: firstSentence(event.summary) ?? firstSentence(event.reason) ?? event.event_type,
    status: event.status,
    tone,
    span,
    startTick,
    heartbeatAge: eventAge,
    label
  };
}

function buildVelocityLanes(agents: FleetAgent[], history: VelocityHistoryEvent[] | undefined, now: number): VelocityLane[] {
  const historyByAgent = new Map<string, VelocityHistoryEvent[]>();
  for (const event of history ?? []) {
    const events = historyByAgent.get(event.agent_id) ?? [];
    events.push(event);
    historyByAgent.set(event.agent_id, events);
  }

  return agents
    .filter((agent) => agent.active_work.issue_id || !["idle", "unknown"].includes(agent.busy_state) || historyByAgent.has(agent.agent_id))
    .map((agent) => {
      const historicalSegments = (historyByAgent.get(agent.agent_id) ?? [])
        .map((event, index) => buildHistoricalVelocitySegment(event, index, now))
        .filter((segment): segment is VelocitySegment => segment !== undefined);

      return {
        agent,
        segments: historicalSegments.length ? historicalSegments : [buildCurrentVelocitySegment(agent, now)]
      };
    });
}

function velocityTickLabels() {
  return Array.from({ length: VELOCITY_TICK_COUNT }, (_, index) => {
    const offsetSeconds = (VELOCITY_TICK_COUNT - 1 - index) * HEARTBEAT_INTERVAL_SECONDS;
    return offsetSeconds === 0 ? "now" : `-${Math.round(offsetSeconds / 60)}m`;
  });
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
  const [activeTab, setActiveTab] = useState<"fleet" | "tooling">("fleet");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [openLogAgentId, setOpenLogAgentId] = useState<string | null>(null);
  const [logTails, setLogTails] = useState<Record<string, LogTail | undefined>>({});
  const [logErrors, setLogErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async () => {
      try {
        const response = await fetch(`${API}/api/modules/hermes-fleet/snapshot`);
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

    const es = new EventSource(`${API}/api/modules/hermes-fleet/stream`);
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
  }, []);

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
  const velocityLanes = useMemo(() => buildVelocityLanes(agents, snapshot?.velocity_history, now), [agents, snapshot?.velocity_history, now]);
  const velocityTicks = useMemo(() => velocityTickLabels(), []);

  useEffect(() => {
    if (!openLogAgentId) return undefined;
    let cancelled = false;

    const loadLogTail = async () => {
      try {
        const response = await fetch(
          `${API}/api/modules/hermes-fleet/agents/${encodeURIComponent(
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
  }, [openLogAgentId]);

  const action = async (path: string) => {
    setWorking(true);
    try {
      await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true })
      });
      const next = (await fetch(`${API}/api/modules/hermes-fleet/snapshot`).then((r) =>
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
        `${API}/api/modules/hermes-fleet/agents/${encodeURIComponent(agentId)}/services/${service}/${act}`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      const next = (await fetch(`${API}/api/modules/hermes-fleet/snapshot`).then((r) =>
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
      </nav>

      {activeTab === "fleet" ? (
        <>
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
              Candystore-backed heartbeat history. Each tick is {formatDuration(HEARTBEAT_INTERVAL_SECONDS)}; bars widen as work needs attention.
            </p>
          </div>
          <div className="velocity-legend" aria-label="Velocity severity legend">
            <span><i className="velocity-key velocity-key-green" /> 1 tick healthy</span>
            <span><i className="velocity-key velocity-key-yellow" /> 2 tick watch</span>
            <span><i className="velocity-key velocity-key-red" /> 3 tick blocker</span>
          </div>
        </div>
        <div
          className="velocity-scroll"
          role="region"
          aria-label="Scrollable ticket heartbeat timeline"
          tabIndex={0}
        >
          <div className="velocity-grid">
            <div className="velocity-header">
              <div className="velocity-corner">Agent / ticket</div>
              <div className="velocity-axis" aria-hidden="true">
                {velocityTicks.map((tick) => (
                  <span key={tick}>{tick}</span>
                ))}
              </div>
            </div>
            {velocityLanes.map((lane) => (
              <div className="velocity-row" key={lane.agent.agent_id}>
                <div className="velocity-lane-label">
                  <strong>{lane.agent.display_name}</strong>
                  <span>{lane.segments[0]?.issue ?? "no active ticket"}</span>
                </div>
                <div className="velocity-track" aria-label={`${lane.agent.display_name} ticket velocity lane`}>
                  <div className="velocity-ticks" aria-hidden="true">
                    {velocityTicks.map((tick) => (
                      <span key={tick} />
                    ))}
                  </div>
                  <div className="velocity-segments">
                    {lane.segments.map((segment) => (
                      <div
                        aria-label={`${lane.agent.display_name} ${segment.issue}: ${segment.label}, ${segment.status}, spans ${segment.span} heartbeat ${segment.span === 1 ? "tick" : "ticks"}, last heartbeat ${formatAge(segment.heartbeatAge)}. ${segment.summary}`}
                        className={`velocity-segment velocity-segment-${segment.tone}`}
                        key={segment.id}
                        style={{ gridColumn: `${segment.startTick + 1} / span ${segment.span}` }}
                        title={`${segment.issue} • ${segment.label} • ${segment.status} • last heartbeat ${formatAge(segment.heartbeatAge)} • ${segment.summary}`}
                      >
                        <span className="velocity-segment-label">{segment.issue}</span>
                        <span className="velocity-segment-status">{segment.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {!feedError && !snapshot ? <div className="velocity-empty empty">Loading ticket velocity.</div> : null}
            {feedError ? <div className="velocity-empty empty">Fleet feed unavailable: {feedError}</div> : null}
            {!feedError && snapshot && !velocityLanes.length ? (
              <div className="velocity-empty empty">
                No active tickets are moving through heartbeat lanes right now.
              </div>
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
      ) : (
        <ToolingTab apiBase={API} />
      )}
    </main>
  );
}

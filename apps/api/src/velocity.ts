import { getFleetAgentRefs, type FleetAgentRef } from "./fleet.js";

const CANDYSTORE_API_URL = (process.env.CANDYSTORE_API_URL ?? "http://127.0.0.1:8683").replace(/\/$/, "");
const CANDYSTORE_PAGE_LIMIT = 1000;
const CANDYSTORE_MAX_PAGES = 5;
const GATEWAY_SERVICE = "bloodbank-hermes-gateway";
// Fetch a little before the window so an invocation that started before it but
// ended inside it is still shown (clipped to the window edge by the web).
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
// A started invocation with no end is "running" while it is younger than this;
// past it the end event was lost and the span is orphaned.
const RUNNING_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CACHE_TTL_MS = 15_000;

const INVOCATION_TYPES = {
  started: "bloodbank.agent.invocation.started",
  completed: "bloodbank.agent.invocation.completed",
  failed: "bloodbank.agent.invocation.failed"
} as const;

export type VelocityEventKind = keyof typeof INVOCATION_TYPES;

export type VelocityRange = "1h" | "1d" | "3d";

export const VELOCITY_RANGE_MS: Record<VelocityRange, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000
};

export function isVelocityRange(value: string): value is VelocityRange {
  return value === "1h" || value === "1d" || value === "3d";
}

export type VelocityEvent = {
  kind: VelocityEventKind;
  at: string;
  agent_id: string;
  key: string;
  lane?: string;
  issue?: string;
  reason?: string;
};

export type VelocitySpanStatus = "completed" | "failed" | "running" | "orphaned";

export type VelocitySpan = {
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

export type VelocityAgentLane = {
  agent_id: string;
  display_name: string;
  spans: VelocitySpan[];
};

export type VelocityProjectLane = {
  project: string;
  agents: VelocityAgentLane[];
};

export type VelocityTimeline = {
  generatedAt: string;
  range: VelocityRange;
  from: string;
  to: string;
  lanes: VelocityProjectLane[];
  counts: { spans: number; running: number; failed: number };
  source: "candystore";
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

// data.context arrives as an object on fresh rows but as a (possibly truncated)
// JSON string on older ones — parse defensively and treat junk as absent.
function parseContext(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value === "string" && value.trim()) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function normalizeGatewayEvent(row: unknown, kind: VelocityEventKind): VelocityEvent | undefined {
  const record = asRecord(row);
  if (!record) return undefined;

  const at = stringOrUndefined(record.time) ?? stringOrUndefined(record.timestamp);
  if (!at || !Number.isFinite(Date.parse(at))) return undefined;

  const data = asRecord(record.data) ?? {};
  const context = parseContext(data.context);

  const agent_id = firstString(
    stringOrUndefined(asRecord(record.actor)?.agent_id),
    stringOrUndefined(data.target_agent_id),
    stringOrUndefined(data.agent_id)
  );
  const key = firstString(
    stringOrUndefined(data.invocation_id),
    stringOrUndefined(data.command_id),
    stringOrUndefined(data.turn_id)
  );
  if (!agent_id || !key) return undefined;

  return {
    kind,
    at,
    agent_id,
    key,
    lane: stringOrUndefined(data.lane),
    issue: firstString(
      stringOrUndefined(data.issue_id),
      stringOrUndefined(data.active_issue),
      stringOrUndefined(context?.issue_id),
      stringOrUndefined(context?.ticket_key),
      stringOrUndefined(context?.issue),
      stringOrUndefined(context?.active_issue)
    ),
    reason: firstString(stringOrUndefined(data.reason), stringOrUndefined(context?.reason))
  };
}

function spanActivityMs(span: VelocitySpan): number {
  return Date.parse(span.endedAt ?? span.startedAt);
}

export function pairInvocations(
  events: VelocityEvent[],
  agents: FleetAgentRef[],
  nowMs: number,
  rangeMs: number
): VelocitySpan[] {
  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const fromMs = nowMs - rangeMs;
  const groups = new Map<string, VelocityEvent[]>();

  for (const event of events) {
    if (!agentsById.has(event.agent_id)) continue;
    if (!Number.isFinite(Date.parse(event.at))) continue;
    const group = groups.get(event.key) ?? [];
    group.push(event);
    groups.set(event.key, group);
  }

  const spans: VelocitySpan[] = [];

  for (const [key, group] of groups) {
    const startedMs = group.filter((e) => e.kind === "started").map((e) => Date.parse(e.at));
    const failedMs = group.filter((e) => e.kind === "failed").map((e) => Date.parse(e.at));
    const completedMs = group.filter((e) => e.kind === "completed").map((e) => Date.parse(e.at));

    const agent = agentsById.get(group[0].agent_id)!;
    const project = agent.repo || "unassigned";
    const issue = firstString(...group.map((e) => e.issue));
    const lane = firstString(...group.map((e) => e.lane));
    const reason = firstString(...group.map((e) => e.reason));
    const label = issue ?? reason ?? lane ?? "invocation";
    const base = { id: key, agent_id: agent.agent_id, project, issue, label, lane };

    if (failedMs.length || completedMs.length) {
      const endedMs = Math.max(...failedMs, ...completedMs);
      const startMs = startedMs.length ? Math.min(...startedMs) : endedMs;
      if (endedMs < fromMs || startMs > nowMs) continue;
      spans.push({
        ...base,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endedMs).toISOString(),
        status: failedMs.length ? "failed" : "completed"
      });
      continue;
    }

    if (!startedMs.length) continue;
    const startMs = Math.min(...startedMs);
    if (startMs > nowMs) continue;

    if (nowMs - startMs < RUNNING_MAX_AGE_MS) {
      // Still open and young: runs to "now", so it always overlaps the window.
      spans.push({ ...base, startedAt: new Date(startMs).toISOString(), endedAt: null, status: "running" });
    } else if (startMs >= fromMs) {
      spans.push({ ...base, startedAt: new Date(startMs).toISOString(), endedAt: null, status: "orphaned" });
    }
  }

  return spans.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function buildVelocityTimeline(
  events: VelocityEvent[],
  agents: FleetAgentRef[],
  nowMs: number,
  range: VelocityRange
): VelocityTimeline {
  const spans = pairInvocations(events, agents, nowMs, VELOCITY_RANGE_MS[range]);
  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]));

  const projects = new Map<string, Map<string, VelocitySpan[]>>();
  for (const span of spans) {
    const agentsInProject = projects.get(span.project) ?? new Map<string, VelocitySpan[]>();
    const agentSpans = agentsInProject.get(span.agent_id) ?? [];
    agentSpans.push(span);
    agentsInProject.set(span.agent_id, agentSpans);
    projects.set(span.project, agentsInProject);
  }

  const lanes: VelocityProjectLane[] = [...projects.entries()].map(([project, agentsInProject]) => ({
    project,
    agents: [...agentsInProject.entries()]
      .map(([agent_id, agentSpans]) => ({
        agent_id,
        display_name: agentsById.get(agent_id)?.display_name ?? agent_id,
        spans: agentSpans
      }))
      .filter((lane) => lane.spans.length > 0)
      .sort((a, b) => spanActivityMs(b.spans[b.spans.length - 1]) - spanActivityMs(a.spans[a.spans.length - 1]))
  }));

  lanes.sort((a, b) => {
    const recent = (lane: VelocityProjectLane) =>
      Math.max(...lane.agents.map((agent) => spanActivityMs(agent.spans[agent.spans.length - 1])));
    return recent(b) - recent(a);
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    range,
    from: new Date(nowMs - VELOCITY_RANGE_MS[range]).toISOString(),
    to: new Date(nowMs).toISOString(),
    lanes,
    counts: {
      spans: spans.length,
      running: spans.filter((span) => span.status === "running").length,
      failed: spans.filter((span) => span.status === "failed").length
    },
    source: "candystore"
  };
}

function rowsFromCandystoreJson(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const events = asRecord(json)?.events;
  return Array.isArray(events) ? events : [];
}

async function fetchGatewayEvents(kind: VelocityEventKind, fromIso: string): Promise<VelocityEvent[]> {
  const events: VelocityEvent[] = [];

  for (let page = 0; page < CANDYSTORE_MAX_PAGES; page++) {
    const url = new URL(`${CANDYSTORE_API_URL}/events`);
    url.searchParams.set("service", GATEWAY_SERVICE);
    url.searchParams.set("type", INVOCATION_TYPES[kind]);
    url.searchParams.set("from", fromIso);
    url.searchParams.set("limit", String(CANDYSTORE_PAGE_LIMIT));
    url.searchParams.set("offset", String(page * CANDYSTORE_PAGE_LIMIT));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`candystore answered ${response.status} for ${INVOCATION_TYPES[kind]}`);
    }

    const rows = rowsFromCandystoreJson(await response.json());
    for (const row of rows) {
      const event = normalizeGatewayEvent(row, kind);
      if (event) events.push(event);
    }
    if (rows.length < CANDYSTORE_PAGE_LIMIT) break;
  }

  return events;
}

async function loadVelocityTimeline(range: VelocityRange, nowMs: number): Promise<VelocityTimeline> {
  const agents = getFleetAgentRefs();
  const fromIso = new Date(nowMs - VELOCITY_RANGE_MS[range] - LOOKBACK_MS).toISOString();
  const [started, completed, failed] = await Promise.all([
    fetchGatewayEvents("started", fromIso),
    fetchGatewayEvents("completed", fromIso),
    fetchGatewayEvents("failed", fromIso)
  ]);
  return buildVelocityTimeline([...started, ...completed, ...failed], agents, nowMs, range);
}

const timelineCache = new Map<VelocityRange, { expiresAt: number; promise: Promise<VelocityTimeline> }>();

export async function getVelocityTimeline(range: VelocityRange): Promise<VelocityTimeline> {
  const nowMs = Date.now();
  const cached = timelineCache.get(range);
  if (cached && cached.expiresAt > nowMs) return cached.promise;

  const promise = loadVelocityTimeline(range, nowMs);
  timelineCache.set(range, { expiresAt: nowMs + CACHE_TTL_MS, promise });
  try {
    await promise;
  } catch {
    // Never serve a stale failure from cache.
    timelineCache.delete(range);
  }
  return promise;
}

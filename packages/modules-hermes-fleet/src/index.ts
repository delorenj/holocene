import { readFileSync, existsSync } from "node:fs";
import { load } from "js-yaml";
import type { ModuleDefinition, ModuleEvent } from "@holocene/module-sdk";
import { restartGatewayAll } from "@holocene/system-actions";

type AgentRecord = {
  agent_id: string;
  repo?: string;
  role?: string;
  role_dir?: string;
  display_name?: string;
  project_path?: string;
  profile_name?: string;
  gateway_unit?: string;
  consumer_unit?: string;
  sentinel_timer_unit?: string;
  active_work?: ActiveWork;
};

type ActiveWork = {
  status: "idle" | "checking" | "active" | "blocked" | "stalled" | "error" | "unknown";
  issue_id?: string;
  summary?: string;
  reason?: string;
  session?: string;
  worktree?: string;
  updated_at?: string;
  last_heartbeat_at?: string;
  state_path?: string;
  log_path?: string;
};

type FleetState = {
  agents: Record<string, AgentRecord>;
  lastHeartbeatAt?: string;
  busyAgents: Record<string, boolean>;
};

// Canonical, version-free Bloodbank grammar: type is
// `bloodbank.<domain>.<entity>.<action>`, subject is
// `bloodbank.<kind>.<domain>.<entity>.<action>` with kind = evt|cmd|rpy.
const BLOODBANK_EVENT_TYPES = {
  heartbeatReceived: "bloodbank.system.heartbeat.received",
  invocationStarted: "bloodbank.agent.invocation.started",
  invocationCompleted: "bloodbank.agent.invocation.completed",
  invocationFailed: "bloodbank.agent.invocation.failed"
} as const;

type BloodbankEventType = (typeof BLOODBANK_EVENT_TYPES)[keyof typeof BLOODBANK_EVENT_TYPES];

function bloodbankEventSubject(type: BloodbankEventType): string {
  return type.replace(/^bloodbank\./, "bloodbank.evt.");
}

// TRANSITIONAL, and only on the read side. No producer emits `bloodbank.v1.*`
// or `bloodbank.evt.v1.*` any more — bb-emit rejects a 5-token type outright —
// but ~713k historical rows carry the retired shape forever, and replayed or
// backfilled history has to keep landing in this reducer. So we compare the
// `<domain>.<entity>.<action>` tail of both sides rather than the whole string.
// This is tolerance for HISTORY, not permission for a producer to emit the old
// shape. Drop the strip once the pre-rename rows age out of retention.
const BLOODBANK_TYPE_PREFIX = /^bloodbank\.(evt\.)?v?[0-9]*\.?/;

function bloodbankTypeTail(value: string): string {
  return value.replace(BLOODBANK_TYPE_PREFIX, "");
}

function matchesBloodbankEvent(event: ModuleEvent, type: BloodbankEventType): boolean {
  const tail = bloodbankTypeTail(type);
  return (
    (typeof event.type === "string" && bloodbankTypeTail(event.type) === tail) ||
    (typeof event.subject === "string" && bloodbankTypeTail(event.subject) === tail)
  );
}

const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? "/home/delorenj/.hermes/agents-registry.yaml";

function readRegistry(): AgentRecord[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  const parsed = load(readFileSync(REGISTRY_PATH, "utf-8")) as any;
  const agents = parsed?.agents ?? {};
  return Object.entries<any>(agents).map(([agent_id, cfg]) => ({
    agent_id,
    repo: cfg.repo,
    role: cfg.role,
    role_dir: cfg.role_dir,
    display_name: cfg.display_name,
    project_path: cfg.project_path,
    profile_name: cfg.profile_name,
    gateway_unit: cfg.systemd?.gateway_unit,
    consumer_unit: cfg.systemd?.consumer_unit,
    sentinel_timer_unit:
      cfg.systemd?.continuous_ticket_sentinel_timer ??
      `hermes-${agent_id}-continuous-ticket-sentinel.timer`,
    active_work: readActiveWork(agent_id, cfg.role_dir)
  }));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function knownStatus(value: unknown): ActiveWork["status"] {
  const raw = stringOrUndefined(value);
  if (
    raw === "idle" ||
    raw === "checking" ||
    raw === "active" ||
    raw === "blocked" ||
    raw === "stalled" ||
    raw === "error"
  ) {
    return raw;
  }
  if (raw === "delegated" || raw === "working" || raw === "busy") return "active";
  return "unknown";
}

function readActiveWork(agentId: string, roleDir?: string): ActiveWork {
  if (!roleDir) {
    return { status: "unknown", summary: "No role directory registered." };
  }

  const statePath = `${roleDir}/runtime/continuous-ticket-sentinel-state.json`;
  const logPath = `${roleDir}/runtime/logs/continuous-ticket-sentinel.log`;
  if (!existsSync(statePath)) {
    return {
      status: "unknown",
      summary: "No active-work feed is available for this PM runtime.",
      state_path: statePath,
      log_path: logPath
    };
  }

  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    return {
      status: knownStatus(state.status),
      issue_id: stringOrUndefined(state.active_issue),
      summary: stringOrUndefined(state.summary),
      reason: stringOrUndefined(state.reason),
      session: stringOrUndefined(state.session),
      worktree: stringOrUndefined(state.worktree),
      updated_at: stringOrUndefined(state.updated_at),
      last_heartbeat_at: stringOrUndefined(state.last_heartbeat_at),
      state_path: statePath,
      log_path: stringOrUndefined(state.log_path) ?? logPath
    };
  } catch {
    return {
      status: "unknown",
      summary: `Could not parse active-work feed for ${agentId}.`,
      state_path: statePath,
      log_path: logPath
    };
  }
}

function withInventory(state: FleetState): FleetState {
  const inventory = readRegistry();
  const next = { ...state, agents: { ...state.agents } };
  for (const agent of inventory) next.agents[agent.agent_id] = agent;
  return next;
}

function fleetReducer(state: FleetState, event: ModuleEvent): FleetState {
  let next = withInventory(state);
  if (matchesBloodbankEvent(event, BLOODBANK_EVENT_TYPES.heartbeatReceived)) {
    next = { ...next, lastHeartbeatAt: event.time ?? new Date().toISOString() };
  }
  if (matchesBloodbankEvent(event, BLOODBANK_EVENT_TYPES.invocationStarted)) {
    const agentId = (event.data as any)?.actor?.agent_id ?? (event.data as any)?.agent_id;
    if (agentId) next.busyAgents[agentId] = true;
  }
  if (
    matchesBloodbankEvent(event, BLOODBANK_EVENT_TYPES.invocationCompleted) ||
    matchesBloodbankEvent(event, BLOODBANK_EVENT_TYPES.invocationFailed)
  ) {
    const agentId = (event.data as any)?.actor?.agent_id ?? (event.data as any)?.agent_id;
    if (agentId) next.busyAgents[agentId] = false;
  }
  return next;
}

const initialState: FleetState = { agents: {}, busyAgents: {} };

export const hermesFleetModule: ModuleDefinition<FleetState> = {
  meta: {
    id: "hermes-fleet",
    title: "Hermes Agent Fleet",
    version: "0.0.1",
    owner: "33GOD",
    tags: ["hermes", "bloodbank", "control-plane"]
  },
  subscriptions: [
    // Live traffic rides the version-free subjects. The `evt.v1.*` entries are
    // here so replayed/backfilled history still reaches the reducer — history
    // tolerance, not a shape any producer is allowed to emit.
    ...Object.values(BLOODBANK_EVENT_TYPES).map(bloodbankEventSubject),
    ...Object.values(BLOODBANK_EVENT_TYPES).map((type) =>
      type.replace(/^bloodbank\./, "bloodbank.evt.v1.")
    )
  ],
  initialState,
  reduce: fleetReducer,
  commands: [
    {
      id: "restart-all-gateways",
      title: "Restart all Hermes gateways",
      run: async () => restartGatewayAll()
    }
  ]
};

export function getFleetSnapshot() {
  const state = withInventory(initialState);
  return {
    generatedAt: new Date().toISOString(),
    agents: Object.values(state.agents)
  };
}

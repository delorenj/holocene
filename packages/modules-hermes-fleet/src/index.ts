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

const BLOODBANK_EVENT_TYPES = {
  heartbeatReceived: "bloodbank.v1.system.heartbeat.received",
  invocationStarted: "bloodbank.v1.agent.invocation.started",
  invocationCompleted: "bloodbank.v1.agent.invocation.completed",
  invocationFailed: "bloodbank.v1.agent.invocation.failed"
} as const;

type BloodbankEventType = (typeof BLOODBANK_EVENT_TYPES)[keyof typeof BLOODBANK_EVENT_TYPES];

function bloodbankEventSubject(type: BloodbankEventType): string {
  return type.replace("bloodbank.v1.", "bloodbank.evt.v1.");
}

function matchesBloodbankEvent(event: ModuleEvent, type: BloodbankEventType): boolean {
  const subject = bloodbankEventSubject(type);
  return event.type === type || event.type === subject || event.subject === type || event.subject === subject;
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
    tags: ["hermes", "bloodbank", "dashboard"]
  },
  subscriptions: [
    bloodbankEventSubject(BLOODBANK_EVENT_TYPES.heartbeatReceived),
    bloodbankEventSubject(BLOODBANK_EVENT_TYPES.invocationStarted),
    bloodbankEventSubject(BLOODBANK_EVENT_TYPES.invocationCompleted),
    bloodbankEventSubject(BLOODBANK_EVENT_TYPES.invocationFailed)
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

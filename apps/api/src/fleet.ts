import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load } from "js-yaml";

const execFileAsync = promisify(execFile);
const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? "/home/delorenj/.hermes/agents-registry.yaml";
const HERMES_BIN = process.env.HERMES_BIN ?? "/home/delorenj/code/hermes-agent/.venv/bin/hermes";
const CANONICAL_SKILLS_DIR = process.env.CANONICAL_SKILLS_DIR ?? "/home/delorenj/.agents/skills";
const CANONICAL_PM_SKILL = `${CANONICAL_SKILLS_DIR}/subagent-driven-development/SKILL.md`;
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const userRuntimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
const LOG_TAIL_MAX_BYTES = 128 * 1024;
const CANDYSTORE_API_URL = (process.env.CANDYSTORE_API_URL ?? "http://candystore:8080").replace(/\/$/, "");
const CANDYSTORE_HISTORY_LIMIT = Math.max(50, Math.min(2000, Number(process.env.CANDYSTORE_HISTORY_LIMIT ?? 800)));
const systemdEnv = {
  ...process.env,
  ...(userRuntimeDir ? { XDG_RUNTIME_DIR: userRuntimeDir } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS
    ? {}
    : userRuntimeDir
      ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntimeDir}/bus` }
      : {})
};

type AgentCfg = {
  repo?: string;
  role?: string;
  role_dir?: string;
  display_name?: string;
  project_path?: string;
  profile_name?: string;
  systemd?: {
    gateway_unit?: string;
    consumer_unit?: string;
    checkpoint_timer?: string;
    continuous_ticket_sentinel_service?: string;
    continuous_ticket_sentinel_timer?: string;
  };
};

export type ActiveWork = {
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

export type VelocityHistoryEvent = {
  agent_id: string;
  issue_id?: string;
  status: ActiveWork["status"];
  event_type: string;
  timestamp: string;
  summary?: string;
  reason?: string;
  last_runner_exit_code?: number;
};

export type FleetAgent = {
  agent_id: string;
  display_name: string;
  repo: string;
  role: string;
  role_dir: string;
  project_path: string;
  profile_name: string;
  gateway_unit?: string;
  consumer_unit?: string;
  sentinel_timer_unit?: string;
  sentinel_service_unit?: string;
  gateway_status: string;
  consumer_status: string;
  sentinel_timer_status: string;
  sentinel_service_status: string;
  busy_state: "idle" | "busy" | "blocked" | "stalled" | "error" | "unknown";
  active_work: ActiveWork;
};

export type AgentLogTail = {
  agent_id: string;
  path: string;
  content: string;
  truncated: boolean;
  size_bytes: number;
  generatedAt: string;
};

function readRegistry(): Record<string, AgentCfg> {
  if (!existsSync(REGISTRY_PATH)) return {};
  const parsed = load(readFileSync(REGISTRY_PATH, "utf8")) as any;
  return (parsed?.agents ?? {}) as Record<string, AgentCfg>;
}

async function unitState(unit?: string): Promise<string> {
  if (!unit) return "missing";
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", unit], {
      env: systemdEnv
    });
    return stdout.trim();
  } catch (err: any) {
    const out = (err?.stdout ?? "").toString().trim();
    return out || "unknown";
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function ageSecondsFrom(iso?: string, fallbackPath?: string): number | undefined {
  if (iso) {
    const timestamp = Date.parse(iso);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    }
  }
  if (fallbackPath && existsSync(fallbackPath)) {
    try {
      return Math.max(0, Math.floor((Date.now() - statSync(fallbackPath).mtimeMs) / 1000));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pathIsInside(path: string, parent: string) {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return path === parent || path.startsWith(normalizedParent);
}


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function stringAtPath(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const part of path) current = asRecord(current)?.[part];
  return stringOrUndefined(current);
}

function numberAtPath(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const part of path) current = asRecord(current)?.[part];
  return numberOrUndefined(current);
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

const BLOODBANK_HISTORY_TYPES = [
  "bloodbank.v1.system.heartbeat.received",
  "bloodbank.evt.v1.system.heartbeat.received",
  "bloodbank.v1.agent.invocation.started",
  "bloodbank.evt.v1.agent.invocation.started",
  "bloodbank.v1.agent.invocation.completed",
  "bloodbank.evt.v1.agent.invocation.completed",
  "bloodbank.v1.agent.invocation.failed",
  "bloodbank.evt.v1.agent.invocation.failed"
];

function extractCandystorePayload(row: Record<string, unknown>): Record<string, unknown> {
  return (
    asRecord(row.payload) ??
    asRecord(row.data) ??
    recordAt(row.envelope, "payload") ??
    recordAt(row.envelope, "data") ??
    {}
  );
}

function candystoreEventType(row: Record<string, unknown>): string {
  return (
    firstString(
      stringOrUndefined(row.event_type),
      stringOrUndefined(row.type),
      stringOrUndefined(row.subject),
      stringAtPath(row.envelope, ["event_type"]),
      stringAtPath(row.envelope, ["type"]),
      stringAtPath(row.envelope, ["subject"])
    ) ?? "unknown"
  );
}

function candystoreTimestamp(row: Record<string, unknown>): string | undefined {
  return firstString(
    stringOrUndefined(row.timestamp),
    stringOrUndefined(row.time),
    stringAtPath(row.envelope, ["timestamp"]),
    stringAtPath(row.envelope, ["time"])
  );
}

function matchesVelocityHistoryEvent(eventType: string): boolean {
  return BLOODBANK_HISTORY_TYPES.some((known) => eventType === known || eventType.endsWith(known.replace(/^bloodbank\.(evt\.)?v1\./, "")));
}

function statusFromHistory(eventType: string, payload: Record<string, unknown>): ActiveWork["status"] {
  const explicit = knownStatus(
    firstString(
      stringOrUndefined(payload.status),
      stringOrUndefined(payload.state),
      stringAtPath(payload, ["active_work", "status"]),
      stringAtPath(payload, ["work", "status"])
    )
  );
  if (explicit !== "unknown") return explicit;
  if (eventType.includes("invocation.failed")) return "error";
  if (eventType.includes("invocation.started")) return "active";
  if (eventType.includes("invocation.completed")) return "idle";
  return "active";
}

function velocityHistoryEvent(row: Record<string, unknown>, agentsById: Map<string, FleetAgent>): VelocityHistoryEvent | undefined {
  const eventType = candystoreEventType(row);
  if (!matchesVelocityHistoryEvent(eventType)) return undefined;

  const payload = extractCandystorePayload(row);
  const timestamp = candystoreTimestamp(row);
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return undefined;

  const agentId = firstString(
    stringOrUndefined(row.agent_id),
    stringOrUndefined(row.agentId),
    stringAtPath(payload, ["actor", "agent_id"]),
    stringAtPath(payload, ["actor", "agentId"]),
    stringAtPath(payload, ["active_work", "agent_id"]),
    stringAtPath(payload, ["work", "agent_id"]),
    stringOrUndefined(payload.agent_id),
    stringOrUndefined(payload.agentId)
  );
  if (!agentId || !agentsById.has(agentId)) return undefined;

  return {
    agent_id: agentId,
    issue_id: firstString(
      stringOrUndefined(payload.active_issue),
      stringOrUndefined(payload.issue_id),
      stringOrUndefined(payload.issueId),
      stringAtPath(payload, ["active_work", "issue_id"]),
      stringAtPath(payload, ["work", "issue_id"])
    ),
    status: statusFromHistory(eventType, payload),
    event_type: eventType,
    timestamp,
    summary: firstString(
      stringOrUndefined(payload.summary),
      stringAtPath(payload, ["active_work", "summary"]),
      stringAtPath(payload, ["work", "summary"])
    ),
    reason: firstString(
      stringOrUndefined(payload.reason),
      stringAtPath(payload, ["active_work", "reason"]),
      stringAtPath(payload, ["work", "reason"])
    ),
    last_runner_exit_code: firstNumber(
      numberOrUndefined(payload.last_runner_exit_code),
      numberAtPath(payload, ["active_work", "last_runner_exit_code"]),
      numberAtPath(payload, ["work", "last_runner_exit_code"])
    )
  };
}

function rowsFromCandystoreJson(json: unknown): unknown[] {
  const record = asRecord(json);
  if (Array.isArray(json)) return json;
  if (Array.isArray(record?.events)) return record.events;
  if (Array.isArray(record?.items)) return record.items;
  if (Array.isArray(record?.results)) return record.results;
  if (Array.isArray(record?.data)) return record.data;
  return [];
}

async function fetchCandystoreRows(path: string): Promise<unknown[] | undefined> {
  const url = new URL(`${CANDYSTORE_API_URL}${path}`);
  url.searchParams.set("limit", String(CANDYSTORE_HISTORY_LIMIT));

  const response = await fetch(url);
  if (!response.ok) return undefined;
  return rowsFromCandystoreJson((await response.json()) as unknown);
}

async function getVelocityHistory(agentsById: Map<string, FleetAgent>): Promise<VelocityHistoryEvent[]> {
  if (!agentsById.size) return [];

  try {
    const rows =
      (await fetchCandystoreRows("/api/v1/events")) ??
      (await fetchCandystoreRows("/events")) ??
      [];

    return rows
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== undefined)
      .map((row) => velocityHistoryEvent(row, agentsById))
      .filter((event): event is VelocityHistoryEvent => event !== undefined)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  } catch {
    return [];
  }
}

function readActiveWork(agentId: string, cfg: AgentCfg): ActiveWork {
  if (!cfg.role_dir) {
    return {
      status: "unknown",
      reason: "Registry entry has no role_dir.",
      summary: "No PM runtime path is registered."
    };
  }

  const runtime = `${cfg.role_dir}/runtime`;
  const statePath = `${runtime}/continuous-ticket-sentinel-state.json`;
  const logPath = `${runtime}/logs/continuous-ticket-sentinel.log`;
  const state = readJson(statePath);

  if (!state) {
    return {
      status: "unknown",
      reason: "No continuous-ticket sentinel state has been written yet.",
      summary: "No active-work feed is available for this PM runtime.",
      state_path: statePath,
      log_path: logPath
    };
  }

  const freshnessAt =
    stringOrUndefined(state.last_heartbeat_at) ??
    stringOrUndefined(state.last_runner_completed_at) ??
    stringOrUndefined(state.last_activity_at) ??
    stringOrUndefined(state.updated_at);

  return {
    status: knownStatus(state.status),
    issue_id: stringOrUndefined(state.active_issue),
    summary: stringOrUndefined(state.summary),
    reason: stringOrUndefined(state.reason),
    session: stringOrUndefined(state.session),
    worktree: stringOrUndefined(state.worktree),
    updated_at: stringOrUndefined(state.updated_at),
    last_activity_at: stringOrUndefined(state.last_activity_at),
    last_heartbeat_at: stringOrUndefined(state.last_heartbeat_at),
    last_full_run_started_at: stringOrUndefined(state.last_full_run_started_at),
    last_runner_completed_at: stringOrUndefined(state.last_runner_completed_at),
    last_runner_exit_code: numberOrUndefined(state.last_runner_exit_code),
    last_decision: stringOrUndefined(state.last_decision),
    source: stringOrUndefined(state.source) ?? `runtime:${agentId}`,
    state_path: statePath,
    log_path: stringOrUndefined(state.log_path) ?? logPath,
    age_seconds: ageSecondsFrom(freshnessAt, statePath)
  };
}

function readTail(path: string, lines: number): Pick<AgentLogTail, "content" | "size_bytes" | "truncated"> {
  const stats = statSync(path);
  const size = stats.size;
  const start = Math.max(0, size - LOG_TAIL_MAX_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");

  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }

  const text = buffer.toString("utf8");
  const tailLines = text.split(/\r?\n/).slice(-lines).join("\n");
  return {
    content: start > 0 ? `[... ${start} bytes omitted ...]\n${tailLines}` : tailLines,
    size_bytes: size,
    truncated: start > 0
  };
}

export function getAgentLogTail(agentId: string, lines: number):
  | AgentLogTail
  | { error: string; statusCode: number } {
  const agents = readRegistry();
  const cfg = agents[agentId];

  if (!cfg) return { error: `Unknown agent: ${agentId}`, statusCode: 404 };
  if (!cfg.role_dir) return { error: `Agent has no runtime directory: ${agentId}`, statusCode: 404 };

  const activeWork = readActiveWork(agentId, cfg);
  const logPath = activeWork.log_path;
  if (!logPath) return { error: `Agent has no log path: ${agentId}`, statusCode: 404 };
  if (!existsSync(logPath)) return { error: `Log file is not available yet: ${logPath}`, statusCode: 404 };

  try {
    const realRoleDir = realpathSync(cfg.role_dir);
    const realLogPath = realpathSync(logPath);
    const runtimeDir = `${realRoleDir}/runtime`;

    if (!pathIsInside(realLogPath, runtimeDir)) {
      return { error: `Refusing to read log outside runtime directory: ${agentId}`, statusCode: 403 };
    }

    const tail = readTail(realLogPath, lines);
    return {
      agent_id: agentId,
      path: logPath,
      generatedAt: new Date().toISOString(),
      ...tail
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : `Unable to read log for ${agentId}`,
      statusCode: 500
    };
  }
}

function busyState(activeWork: ActiveWork): FleetAgent["busy_state"] {
  if (activeWork.status === "active" || activeWork.status === "checking") return "busy";
  if (activeWork.status === "blocked") return "blocked";
  if (activeWork.status === "stalled") return "stalled";
  if (activeWork.status === "error") return "error";
  if (activeWork.status === "idle") return "idle";
  return "unknown";
}

function sentinelServiceUnit(agentId: string, cfg: AgentCfg): string {
  return cfg.systemd?.continuous_ticket_sentinel_service ?? `hermes-${agentId}-continuous-ticket-sentinel.service`;
}

function sentinelTimerUnit(agentId: string, cfg: AgentCfg): string {
  return cfg.systemd?.continuous_ticket_sentinel_timer ?? `hermes-${agentId}-continuous-ticket-sentinel.timer`;
}

export async function getFleetSnapshot() {
  const agents = readRegistry();
  const out: FleetAgent[] = [];

  for (const [agent_id, cfg] of Object.entries(agents)) {
    const gateway_status = await unitState(cfg.systemd?.gateway_unit);
    const consumer_status = await unitState(cfg.systemd?.consumer_unit);
    const sentinel_service_unit = sentinelServiceUnit(agent_id, cfg);
    const sentinel_timer_unit = sentinelTimerUnit(agent_id, cfg);
    const sentinel_service_status = await unitState(sentinel_service_unit);
    const sentinel_timer_status = await unitState(sentinel_timer_unit);
    const active_work = readActiveWork(agent_id, cfg);

    out.push({
      agent_id,
      display_name: cfg.display_name ?? agent_id,
      repo: cfg.repo ?? "",
      role: cfg.role ?? "",
      role_dir: cfg.role_dir ?? "",
      project_path: cfg.project_path ?? "",
      profile_name: cfg.profile_name ?? "",
      gateway_unit: cfg.systemd?.gateway_unit,
      consumer_unit: cfg.systemd?.consumer_unit,
      sentinel_timer_unit,
      sentinel_service_unit,
      gateway_status,
      consumer_status,
      sentinel_timer_status,
      sentinel_service_status,
      busy_state: busyState(active_work),
      active_work
    });
  }

  const agentsById = new Map(out.map((agent) => [agent.agent_id, agent]));
  const velocity_history = await getVelocityHistory(agentsById);

  return {
    generatedAt: new Date().toISOString(),
    source: REGISTRY_PATH,
    agents: out,
    velocity_history
  };
}

export async function restartGateways(agentIds?: string[]) {
  const agents = readRegistry();
  const target = Object.entries(agents)
    .filter(([id]) => !agentIds || agentIds.includes(id))
    .map(([id, cfg]) => ({ id, unit: cfg.systemd?.gateway_unit }))
    .filter((x) => !!x.unit);

  const restarted: string[] = [];
  for (const t of target) {
    await execFileAsync("systemctl", ["--user", "restart", t.unit as string], { env: systemdEnv });
    restarted.push(t.id);
  }
  return { restarted };
}

export async function syncTemplateDefaults(agentIds?: string[]) {
  const agents = readRegistry();
  const target = Object.entries(agents).filter(([id]) => !agentIds || agentIds.includes(id));

  const synced: string[] = [];
  for (const [id, cfg] of target) {
    const roleDir = cfg.role_dir;
    if (!roleDir) continue;
    const runtime = `${roleDir}/runtime`;

    await execFileAsync(HERMES_BIN, ["config", "set", "skills.external_dirs.0", CANONICAL_SKILLS_DIR], {
      env: { ...process.env, HERMES_HOME: runtime }
    });

    await execFileAsync("mkdir", ["-p", `${runtime}/skills/software-development/subagent-driven-development`]);
    await execFileAsync("cp", ["-f", CANONICAL_PM_SKILL, `${runtime}/skills/software-development/subagent-driven-development/SKILL.md`]);

    synced.push(id);
  }

  return { synced, canonical_skills_dir: CANONICAL_SKILLS_DIR };
}

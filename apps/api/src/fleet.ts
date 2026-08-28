import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load } from "js-yaml";
import type { BridgeStatus, PlaneBinding } from "@holocene/org-model";

const execFileAsync = promisify(execFile);
const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? "/home/delorenj/.hermes/agents-registry.yaml";
const HERMES_BIN = process.env.HERMES_BIN ?? "/home/delorenj/code/hermes-agent/.venv/bin/hermes";
const CANONICAL_SKILLS_DIR = process.env.CANONICAL_SKILLS_DIR ?? "/home/delorenj/.agents/skills";
const CANONICAL_PM_SKILL = `${CANONICAL_SKILLS_DIR}/subagent-driven-development/SKILL.md`;
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const userRuntimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
const LOG_TAIL_MAX_BYTES = 128 * 1024;
const CANDYSTORE_API_URL = (process.env.CANDYSTORE_API_URL ?? "http://127.0.0.1:8683").replace(/\/$/, "");
const CANDYSTORE_HISTORY_LIMIT = Math.max(50, Math.min(2000, Number(process.env.CANDYSTORE_HISTORY_LIMIT ?? 800)));

// ---- Plane webhook bridge (fleet-wide, single systemd unit) ----------------
const HOME_DIR = process.env.HOME ?? "/home/delorenj";
const BRIDGE_UNIT = process.env.HERMES_PLANE_BRIDGE_UNIT ?? "hermes-plane-webhook-bridge.service";
const BRIDGE_ENV_PATH = process.env.HERMES_PLANE_BRIDGE_ENV ?? `${HOME_DIR}/.hermes/plane-webhook-bridge.env`;
const BRIDGE_DEFAULT_PORT = 8477;
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
  plane?: {
    workspace?: string;
    project_id?: string;
    identifier?: string;
  };
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
  plane: PlaneBinding;
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

// TRANSITIONAL. Bloodbank now publishes the version-free grammar
// (type `bloodbank.<domain>.<entity>.<action>`, subject
// `bloodbank.<kind>.<domain>.<entity>.<action>`), but Candystore still holds
// ~713k historical rows stamped with the old `bloodbank.v1.*` /
// `bloodbank.evt.v1.*` shape, and a read side that only understood one of the
// two would silently drop half the window. So we normalize both sides down to
// the `<domain>.<entity>.<action>` tail and compare that — deliberate
// tolerance, not the accidental kind: the previous matcher stripped `v1` from
// its own literals and then did a bare `endsWith`, which matched any subject
// happening to end in those words. Once the pre-rename rows age out of the
// retention window, drop the strip and match these literally.
const BLOODBANK_TYPE_PREFIX = /^bloodbank\.(evt\.)?v?[0-9]*\.?/;

function bloodbankTypeTail(eventType: string): string {
  return eventType.replace(BLOODBANK_TYPE_PREFIX, "");
}

const BLOODBANK_HISTORY_TYPES = [
  "bloodbank.system.heartbeat.received",
  "bloodbank.agent.invocation.started",
  "bloodbank.agent.invocation.completed",
  "bloodbank.agent.invocation.failed"
];

const BLOODBANK_HISTORY_TAILS = new Set(BLOODBANK_HISTORY_TYPES.map(bloodbankTypeTail));

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
  return BLOODBANK_HISTORY_TAILS.has(bloodbankTypeTail(eventType));
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

type BridgeEnv = { only: string[]; port: number };

// Parse ~/.hermes/plane-webhook-bridge.env for the operator-managed allowlist
// and port. The file also holds PLANE_WEBHOOK_SECRET, which we never read here
// and MUST preserve on write (see writeBridgeOnly).
function readBridgeEnv(): BridgeEnv {
  let only: string[] = [];
  let port = Number(process.env.HERMES_PLANE_BRIDGE_PORT ?? BRIDGE_DEFAULT_PORT);
  if (existsSync(BRIDGE_ENV_PATH)) {
    for (const raw of readFileSync(BRIDGE_ENV_PATH, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === "HERMES_PLANE_BRIDGE_ONLY") {
        only = val.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "HERMES_PLANE_BRIDGE_PORT") {
        const p = Number(val);
        if (Number.isFinite(p) && p > 0) port = p;
      }
    }
  }
  return { only, port: Number.isFinite(port) && port > 0 ? port : BRIDGE_DEFAULT_PORT };
}

// Rewrite ONLY the HERMES_PLANE_BRIDGE_ONLY line, preserving every other line
// (notably PLANE_WEBHOOK_SECRET). Atomic + 0600.
function writeBridgeOnly(repos: string[]): void {
  const value = repos.join(",");
  let lines = existsSync(BRIDGE_ENV_PATH) ? readFileSync(BRIDGE_ENV_PATH, "utf8").split("\n") : [];
  let found = false;
  lines = lines.map((ln) => {
    if (/^\s*HERMES_PLANE_BRIDGE_ONLY\s*=/.test(ln)) {
      found = true;
      return `HERMES_PLANE_BRIDGE_ONLY=${value}`;
    }
    return ln;
  });
  if (!found) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `HERMES_PLANE_BRIDGE_ONLY=${value}`);
    else lines.push(`HERMES_PLANE_BRIDGE_ONLY=${value}`);
  }
  const tmp = `${BRIDGE_ENV_PATH}.tmp`;
  writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  renameSync(tmp, BRIDGE_ENV_PATH);
}

// Every repo the bridge could route to (registry maps repo -> plane project).
function bindableRepos(agents: Record<string, AgentCfg>): string[] {
  const repos = new Set<string>();
  for (const cfg of Object.values(agents)) {
    if (cfg.plane?.project_id && cfg.repo) repos.add(cfg.repo);
  }
  return [...repos];
}

function computePlaneBinding(cfg: AgentCfg, only: string[]): PlaneBinding {
  const projectId = cfg.plane?.project_id;
  const bindable = !!projectId && !!cfg.repo;
  const repo = cfg.repo ?? "";
  // Empty allowlist = whole fleet bound; otherwise only listed repos are bound.
  const bound = bindable && (only.length === 0 || only.includes(repo));
  return { projectId, identifier: cfg.plane?.identifier, bindable, bound };
}

async function getBridgeHealth(port: number): Promise<{ healthOk: boolean; projectsMapped: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { healthOk: false, projectsMapped: 0 };
    const body = (await res.json()) as { ok?: boolean; projects?: number };
    return {
      healthOk: body?.ok === true,
      projectsMapped: typeof body?.projects === "number" ? body.projects : 0
    };
  } catch {
    return { healthOk: false, projectsMapped: 0 };
  }
}

async function getBridgeStatus(env: BridgeEnv, boundRepos: string[]): Promise<BridgeStatus> {
  const serviceStatus = await unitState(BRIDGE_UNIT);
  const { healthOk, projectsMapped } = await getBridgeHealth(env.port);
  return {
    serviceUnit: BRIDGE_UNIT,
    serviceStatus,
    host: "127.0.0.1",
    port: env.port,
    healthOk,
    projectsMapped,
    scope: env.only.length ? "pilot" : "fleet",
    only: env.only,
    boundRepos,
    generatedAt: new Date().toISOString()
  };
}

// Start | stop | restart the single fleet-wide plane-webhook-bridge unit.
export async function controlBridge(action: string) {
  if (!UNIT_ACTIONS.includes(action as UnitAction)) {
    return { ok: false as const, error: `Invalid action '${action}'. Use start, stop, or restart.` };
  }
  try {
    await execFileAsync("systemctl", ["--user", action, BRIDGE_UNIT], { env: systemdEnv });
  } catch (err) {
    return {
      ok: false as const,
      unit: BRIDGE_UNIT,
      action,
      error: err instanceof Error ? err.message : String(err)
    };
  }
  let status = "unknown";
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", BRIDGE_UNIT], { env: systemdEnv });
    status = stdout.trim();
  } catch (err) {
    const stdout = (err as { stdout?: string | Buffer })?.stdout;
    status = stdout ? stdout.toString().trim() : "inactive";
  }
  return { ok: true as const, unit: BRIDGE_UNIT, action, status };
}

// Bind/unbind a single PM (by repo) to the bridge, or roll the whole fleet.
// The panel manages HERMES_PLANE_BRIDGE_ONLY as an explicit allowlist so that
// per-PM unbind works even at full fleet: any per-PM edit first materializes an
// empty (=all) allowlist to the full bindable set before applying the change,
// and a full set collapses back to empty (fleet). Restarts the bridge to apply.
export async function setBridgeBinding(body: { repo?: string; bound?: boolean; scope?: string }) {
  const agents = readRegistry();
  const allBindable = bindableRepos(agents);
  const current = readBridgeEnv().only;

  let next: string[];
  if (body?.scope === "fleet") {
    next = []; // empty = whole fleet (all bindable + any future PM)
  } else if (typeof body?.repo === "string" && typeof body?.bound === "boolean") {
    const repo = body.repo;
    if (!allBindable.includes(repo)) {
      return { ok: false as const, error: `Repo '${repo}' has no Plane project mapping; not bindable.` };
    }
    const base = current.length ? [...current] : [...allBindable];
    const set = new Set(base);
    if (body.bound) set.add(repo);
    else set.delete(repo);
    next = [...set].filter((r) => allBindable.includes(r));
    if (next.length === allBindable.length) next = []; // full set = fleet
  } else {
    return { ok: false as const, error: "Body must be {repo, bound} or {scope:'fleet'}." };
  }

  try {
    writeBridgeOnly(next);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }

  const restart = await controlBridge("restart");
  const only = readBridgeEnv().only;
  return {
    ok: true as const,
    only,
    scope: only.length ? ("pilot" as const) : ("fleet" as const),
    boundRepos: only.length ? only : allBindable,
    restarted: restart.ok,
    service_status: restart.ok ? restart.status : undefined
  };
}

export async function getFleetSnapshot() {
  const agents = readRegistry();
  const bridgeEnv = readBridgeEnv();
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
      active_work,
      plane: computePlaneBinding(cfg, bridgeEnv.only)
    });
  }

  const agentsById = new Map(out.map((agent) => [agent.agent_id, agent]));
  const velocity_history = await getVelocityHistory(agentsById);
  const bridge = await getBridgeStatus(
    bridgeEnv,
    out.filter((a) => a.plane.bound).map((a) => a.repo)
  );

  return {
    generatedAt: new Date().toISOString(),
    source: REGISTRY_PATH,
    agents: out,
    velocity_history,
    bridge
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

const UNIT_ACTIONS = ["start", "stop", "restart"] as const;
const SERVICE_KINDS = ["gateway", "consumer", "sentinel", "checkpoint"] as const;
type UnitAction = (typeof UNIT_ACTIONS)[number];
type ServiceKind = (typeof SERVICE_KINDS)[number];

function resolveServiceUnit(agentId: string, cfg: AgentCfg, service: ServiceKind): string {
  switch (service) {
    case "gateway":
      return cfg.systemd?.gateway_unit ?? `hermes-${agentId}-gateway.service`;
    case "consumer":
      return cfg.systemd?.consumer_unit ?? `hermes-${agentId}-consumer.service`;
    case "sentinel":
      return sentinelTimerUnit(agentId, cfg);
    case "checkpoint":
      return cfg.systemd?.checkpoint_timer ?? `hermes-${agentId}-checkpoint.timer`;
  }
}

// Manually start/stop/restart one systemd --user unit for one agent. Powers the
// per-service control buttons in the Holocene fleet table.
export async function controlAgentUnit(agentId: string, service: string, action: string) {
  if (!UNIT_ACTIONS.includes(action as UnitAction)) {
    return { ok: false as const, error: `Invalid action '${action}'. Use start, stop, or restart.` };
  }
  if (!SERVICE_KINDS.includes(service as ServiceKind)) {
    return { ok: false as const, error: `Invalid service '${service}'. Use gateway, consumer, sentinel, or checkpoint.` };
  }
  const cfg = readRegistry()[agentId];
  if (!cfg) return { ok: false as const, error: `Unknown agent '${agentId}'.` };

  const unit = resolveServiceUnit(agentId, cfg, service as ServiceKind);
  try {
    await execFileAsync("systemctl", ["--user", action, unit], { env: systemdEnv });
  } catch (err) {
    return {
      ok: false as const,
      agent_id: agentId,
      service,
      action,
      unit,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  // Read back is-active (exits non-zero when not active — capture its stdout anyway).
  let status = "unknown";
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", unit], { env: systemdEnv });
    status = stdout.trim();
  } catch (err) {
    const stdout = (err as { stdout?: string | Buffer })?.stdout;
    status = stdout ? stdout.toString().trim() : "inactive";
  }

  return { ok: true as const, agent_id: agentId, service, action, unit, status };
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

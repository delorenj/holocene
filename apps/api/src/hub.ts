import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { createClient } from "redis";
import type { EventStore, CollectedEvent } from "./event-store.js";
import {
  buildAgents,
  buildProjects,
  normalizePath,
  projectTickets,
  type AsmRow,
  type Component,
  type InvocationEvent,
  type ProjectRecord,
  type RegistryRow,
  type TicketEvent,
  type WorkerScope
} from "./hub-model.js";

// IO for the hub views: the agents registry, pjangler's project registry, the agent
// state machine in Redis, user systemd units and the shared event collection.
// Every source is read-only and reported with its own freshness; a source that is
// down makes the view say so instead of failing the request.

const execFileAsync = promisify(execFile);
const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? "/home/delorenj/.hermes/agents-registry.yaml";
const PJ_REGISTRY_URL = (process.env.PJ_REGISTRY_URL ?? "http://127.0.0.1:8764").replace(/\/$/, "");
const GOD_ROOT = normalizePath(process.env.GOD_SOURCE_ROOT ?? "/home/delorenj/code/33GOD");
const PLATFORM_DIR = join(GOD_ROOT, "33god-platform");
const REDIS_URL = process.env.HUB_REDIS_URL ?? process.env.TOOLING_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
const systemdEnv = {
  ...process.env,
  ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS || !runtimeDir ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` })
};

type Json = Record<string, unknown>;
type Source = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const ms = (v: unknown): number | undefined => {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
};

// ---------------------------------------------------------------- registry

function readRegistry(): { rows: RegistryRow[]; source: Source } {
  if (!existsSync(REGISTRY_PATH)) return { rows: [], source: { name: "agents registry", down: true, detail: `${REGISTRY_PATH} not found` } };
  const parsed = load(readFileSync(REGISTRY_PATH, "utf8")) as { agents?: Record<string, Json> } | null;
  const rows = Object.entries(parsed?.agents ?? {}).map(([agentId, cfg]) => {
    const plane = record(cfg.plane) ? cfg.plane : {};
    const systemd = record(cfg.systemd) ? cfg.systemd : {};
    return {
      agentId,
      displayName: text(cfg.display_name) ?? agentId,
      role: text(cfg.role) ?? "pm",
      repo: text(cfg.repo) ?? "",
      projectPath: text(cfg.project_path) ?? "",
      boardId: text(plane.project_id) ?? text(plane.board_id),
      boardIdentifier: text(plane.identifier),
      reportsTo: text(cfg.reports_to),
      gatewayUnit: text(systemd.gateway_unit),
      provisionedAt: text(cfg.provisioned_at)
    } satisfies RegistryRow;
  });
  const age = Math.round((Date.now() - statSync(REGISTRY_PATH).mtimeMs) / 1000);
  return { rows, source: { name: "agents registry", value: String(rows.length), ageSeconds: age } };
}

// ---------------------------------------------------------------- projects

function recordFromManifest(raw: Json, repoPath: string, indexed: boolean): ProjectRecord | undefined {
  const id = text(raw.project_id) ?? text(raw.project_slug) ?? text(raw.slug);
  if (!id) return undefined;
  const tp = record(raw.ticket_provider) ? raw.ticket_provider : {};
  return {
    id: id.toLowerCase(),
    name: text(raw.project_name) ?? text(raw.name) ?? id,
    repoPath: normalizePath(text(raw.repo_path) ?? repoPath),
    status: text(raw.status),
    board: text(tp.identifier),
    boardId: text(tp.board_id),
    workspace: text(tp.workspace),
    indexed
  };
}

function readManifest(repoPath: string): ProjectRecord | undefined {
  const path = join(normalizePath(repoPath), ".project.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return record(raw) ? recordFromManifest(raw, dirname(path), false) : undefined;
  } catch {
    return undefined;
  }
}

async function readProjects(extraPaths: string[]): Promise<{ projects: ProjectRecord[]; source: Source }> {
  const projects = new Map<string, ProjectRecord>();
  let source: Source;
  try {
    const res = await fetch(`${PJ_REGISTRY_URL}/v1/registry`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Json;
    const rows = record(body.projects) ? body.projects : {};
    for (const [key, snap] of Object.entries(rows)) {
      if (!record(snap)) continue;
      const rec = recordFromManifest({ ...snap, project_id: snap.project_id ?? key }, text(snap.repo_path) ?? "", true);
      if (rec) projects.set(rec.id, rec);
    }
    source = { name: "pjangler", value: `${projects.size} projects`, ageSeconds: 0 };
  } catch (error) {
    source = { name: "pjangler", down: true, detail: `${PJ_REGISTRY_URL}/v1/registry: ${(error as Error).message}` };
  }
  // A repo with a manifest that is not indexed yet still has a project; read it straight from disk.
  for (const path of extraPaths) {
    const indexedHere = [...projects.values()].some((p) => normalizePath(p.repoPath) === normalizePath(path));
    if (indexedHere) continue;
    const rec = readManifest(path);
    if (rec && !projects.has(rec.id)) projects.set(rec.id, rec);
  }
  return { projects: [...projects.values()], source };
}

function readComponents(): Component[] {
  const index = join(PLATFORM_DIR, "components.yaml");
  if (!existsSync(index)) return [];
  try {
    const doc = load(readFileSync(index, "utf8")) as Json | null;
    const files = Array.isArray(doc?.component_files) ? doc!.component_files : [];
    const out: Component[] = [];
    for (const file of files) {
      if (typeof file !== "string") continue;
      const path = resolve(PLATFORM_DIR, file);
      if (!existsSync(path)) continue;
      const c = load(readFileSync(path, "utf8")) as Json | null;
      const id = text(c?.id);
      if (!id) continue;
      out.push({
        id,
        name: text(c?.name) ?? id,
        repoPath: normalizePath(resolve(PLATFORM_DIR, text(c?.repo) ?? `../${id}`)),
        role: text(c?.role),
        description: text(c?.description)
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- agent state machine

type RedisLike = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  on(event: string, cb: () => void): unknown;
  zRange(key: string, start: number, stop: number): Promise<string[]>;
  hGetAll(key: string): Promise<Record<string, string>>;
  exists(key: string): Promise<number>;
};
let redis: RedisLike | undefined;
let redisConnecting: Promise<RedisLike> | undefined;
async function redisClient(): Promise<RedisLike> {
  if (redis?.isOpen) return redis;
  if (redisConnecting) return redisConnecting;
  const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 2000, reconnectStrategy: false } }) as unknown as RedisLike;
  client.on("error", () => undefined);
  redisConnecting = client
    .connect()
    .then(() => {
      redis = client;
      redisConnecting = undefined;
      return client;
    })
    .catch((error) => {
      redisConnecting = undefined;
      throw error;
    });
  return redisConnecting;
}

async function readAsm(): Promise<{ rows: Map<string, AsmRow>; source: Source }> {
  const rows = new Map<string, AsmRow>();
  try {
    const client = await redisClient();
    const scopes = await client.zRange("asm:live", 0, -1);
    const agentScopes = scopes.filter((s) => s.startsWith("hermes:a:"));
    const hashes = await Promise.all(agentScopes.map((s) => client.hGetAll(`asm:a:${s}`)));
    agentScopes.forEach((scope, i) => {
      const h = hashes[i] ?? {};
      if (!h.state) return;
      rows.set(scope, {
        scope,
        state: h.state,
        blockKind: text(h.block_kind),
        sinceMs: ms(h.since),
        lastMs: ms(h.last_ms),
        subs: num(h.subs),
        tools: num(h.tools),
        turn: num(h.turn)
      });
    });
    const sweeper = await client.exists("asm:sweeper");
    return {
      rows,
      source: {
        name: "asm",
        value: `${scopes.length} / ${rows.size}`,
        ...(sweeper ? { ageSeconds: 0 } : { down: true, detail: "asm:sweeper is missing; stale and gone cannot be detected" })
      }
    };
  } catch (error) {
    return { rows, source: { name: "asm", down: true, detail: `${REDIS_URL}: ${(error as Error).message}` } };
  }
}

// ---------------------------------------------------------------- systemd

async function readGateways(): Promise<Map<string, "active" | "inactive">> {
  const out = new Map<string, "active" | "inactive">();
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["--user", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager", "hermes-*-gateway.service"],
      { env: systemdEnv, timeout: 4000 }
    );
    for (const line of stdout.split("\n")) {
      const [unit, , active] = line.trim().split(/\s+/);
      if (unit?.endsWith(".service")) out.set(unit, active === "active" ? "active" : "inactive");
    }
  } catch {
    // systemd unavailable: gateways stay "unknown"
  }
  return out;
}

async function readWorkerScopes(): Promise<WorkerScope[]> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["--user", "show", "--timestamp=unix", "--property=Id,Description,ActiveState,ActiveEnterTimestamp", "hermes-worker-proc*"],
      { env: systemdEnv, timeout: 4000 }
    );
    return stdout
      .split(/\n\s*\n/)
      .map((block) => Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])))
      .filter((p) => typeof p.Id === "string" && p.Id.startsWith("hermes-worker-proc"))
      .map((p) => {
        const at = ms(String(p.ActiveEnterTimestamp ?? "").replace(/^@/, ""));
        return { unit: p.Id, description: p.Description ?? "", active: p.ActiveState === "active", activeSince: at ? new Date(at).toISOString() : undefined };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- events

const INVOCATION_TYPES = ["bloodbank.agent.invocation.started", "bloodbank.agent.invocation.completed", "bloodbank.agent.invocation.failed"];
const TICKET_TYPES = ["bloodbank.repo.task.created", "bloodbank.repo.task.updated", "bloodbank.repo.task.completed", "bloodbank.repo.task.recorded"];

function eventTime(row: CollectedEvent): string {
  const t = text((row.envelope as Json).time);
  return t && Number.isFinite(Date.parse(t)) ? t : row.collected_at;
}

function invocationOf(row: CollectedEvent, agentIds: Set<string>): InvocationEvent | undefined {
  const env = row.envelope as Json;
  const data = record(env.data) ? env.data : {};
  const invocationId = text(data.invocation_id);
  if (!invocationId) return undefined;
  const actor = record(env.actor) ? env.actor : {};
  const producer = text(env.producer) ?? "";
  const fromProducer = producer.startsWith("hermes-agent:") ? producer.slice("hermes-agent:".length) : undefined;
  const actorId = text(actor.agent_id);
  const agentId = actorId && agentIds.has(actorId) ? actorId : fromProducer && agentIds.has(fromProducer) ? fromProducer : undefined;
  const context = record(data.context) ? data.context : {};
  const type = String(env.type).split(".").pop() as InvocationEvent["type"];
  return {
    id: String(env.id ?? row.cursor),
    type,
    at: eventTime(row),
    agentId,
    invocationId,
    parentInvocationId: text(data.parent_invocation_id) ?? null,
    ticketKey: text(context.ticket_key)
  };
}

function labelNames(ticket: Json): string[] {
  const raw = Array.isArray(ticket.label_details) ? ticket.label_details : Array.isArray(ticket.labels) ? ticket.labels : [];
  return raw.map((l) => (record(l) ? text(l.name) : text(l))).filter((l): l is string => !!l && !/^[0-9a-f-]{36}$/.test(l));
}

function ticketOf(row: CollectedEvent): TicketEvent | undefined {
  const env = row.envelope as Json;
  const data = record(env.data) ? env.data : {};
  const ticketId = text(data.ticket_id) ?? text(data.task_id);
  if (!ticketId) return undefined;
  const ticket = record(data.ticket) ? data.ticket : {};
  return {
    at: eventTime(row),
    repo: text(data.repo) ?? text(data.slug),
    ticketId,
    ticketKey: text(data.ticket_key),
    title: text(data.title),
    phase: text(data.phase),
    band: text(data.tp_band),
    labels: labelNames(ticket)
  };
}

// ---------------------------------------------------------------- assembly

type Snapshot = { at: number; agents: ReturnType<typeof buildAgents>; projects: ProjectRecord[]; tickets: ReturnType<typeof projectTickets>; sources: Source[] };
let cached: Snapshot | undefined;
let inflight: Promise<Snapshot> | undefined;

async function snapshot(store: EventStore): Promise<Snapshot> {
  if (cached && Date.now() - cached.at < 4000) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const registry = readRegistry();
    const components = readComponents();
    const extraPaths = [GOD_ROOT, ...registry.rows.map((r) => r.projectPath), ...components.map((c) => c.repoPath)].filter(Boolean);
    const [projects, asm, gateways, scopes] = await Promise.all([readProjects(extraPaths), readAsm(), readGateways(), readWorkerScopes()]);
    const agentIds = new Set(registry.rows.map((r) => r.agentId));
    const invocations = store.recent(INVOCATION_TYPES, 2000).map((r) => invocationOf(r, agentIds)).filter((e): e is InvocationEvent => !!e);
    const tickets = projectTickets(store.recent(TICKET_TYPES, 3000).map(ticketOf).filter((e): e is TicketEvent => !!e));
    const agents = buildAgents({
      nowMs: Date.now(),
      registry: registry.rows,
      projects: projects.projects,
      asm: asm.rows,
      gateways,
      invocations,
      scopes,
      tickets
    });
    const lastEvent = store.lastEventAt;
    const sources: Source[] = [
      asm.source,
      registry.source,
      projects.source,
      { name: "events", ...(lastEvent ? { ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(lastEvent)) / 1000)), maxSeconds: 120 } : { down: true, detail: "no events collected yet" }) }
    ];
    const snap: Snapshot = { at: Date.now(), agents, projects: projects.projects, tickets, sources };
    cached = snap;
    return snap;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

export async function getHubAgents(store: EventStore) {
  const snap = await snapshot(store);
  return { generatedAt: new Date(snap.at).toISOString(), sources: snap.sources, ...snap.agents };
}

export async function getHubProjects(store: EventStore) {
  const snap = await snapshot(store);
  const built = buildProjects({ rootPath: GOD_ROOT, components: readComponents(), projects: snap.projects, agents: snap.agents.agents, tickets: snap.tickets });
  return { generatedAt: new Date(snap.at).toISOString(), sources: snap.sources, rootPath: GOD_ROOT, ...built };
}

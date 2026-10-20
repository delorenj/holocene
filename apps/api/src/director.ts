import { getFleetAgentRefs, type FleetAgentRef } from "./fleet.js";

// Read-only projection of the DeLoNET Director's portfolio state (HOLOC-8, Holocene half of DNET-5).
// Upstream contract: delonet-company/docs/contracts/director-read-api-v1.md. The Director API is loopback-only
// with no CORS, so only this process talks to it, GET only; the browser reads the composed snapshot instead.
// There is deliberately no write path of any kind here.
const DIRECTOR_API_URL = (process.env.DIRECTOR_API_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const SOURCE_TIMEOUT_MS = 4_000;
const RECEIPT_LIMIT = 50;
const SHOWN_RECEIPTS = 20;
const CACHE_TTL_MS = 10_000;

export type DirectorSourceName =
  | "healthz"
  | "capacity"
  | "receipts"
  | "readiness"
  | "contractsStatus"
  | "contractsReceipts";

const SOURCE_PATHS: Record<DirectorSourceName, string> = {
  healthz: "/healthz",
  capacity: "/v1/capacity",
  receipts: `/v1/receipts?limit=${RECEIPT_LIMIT}`,
  readiness: "/v1/readiness",
  contractsStatus: "/v1/contracts/status",
  contractsReceipts: `/v1/contracts/receipts?limit=${RECEIPT_LIMIT}`
};
const SOURCE_NAMES = Object.keys(SOURCE_PATHS) as DirectorSourceName[];

export type RawSource = {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  body?: unknown;
};

export type RawDirector = Record<DirectorSourceName, RawSource>;

export type Severity = "error" | "warning" | "info";
export type HealthLevel = "ok" | "degraded" | "down";

export type DirectorException = {
  severity: Severity;
  code: string;
  message: string;
  source: string;
};

export type TargetPm = {
  agent_id: string;
  resolved: boolean;
  display_name: string;
  repo: string | null;
  role: string | null;
};

export type Delegation = {
  state: "active" | "queued";
  correlation_id: string;
  kind: string;
  slot_id: string | null;
  borrowed: boolean | null;
  since: string | null;
  expires_at: string | null;
  ttl_seconds: number | null;
  ticket: string | null;
  owner: string | null;
  outcome: string | null;
  targetPm: TargetPm | null;
};

export type LaneAllocation = {
  correlation_id: string;
  kind: string;
  borrowed: boolean;
  allocated_at: string | null;
  expires_at: string | null;
  expires_in_s: number | null;
  live: boolean;
  ticket: string | null;
  owner: string | null;
  outcome: string | null;
  targetPm: TargetPm | null;
};

export type Lane = {
  id: string;
  preferred_kind: string;
  state: "free" | "live" | "expired" | "malformed";
  allocation: LaneAllocation | null;
};

export type WorkReceipt = {
  id: string;
  correlation_id: string;
  terminal_status: string;
  work_id: string | null;
  delegation_id: string | null;
  project: string | null;
  summary: string | null;
  at: string | null;
};

export type LeaseEnd = {
  id: number;
  correlation_id: string;
  action: string;
  outcome: string;
  slot_id: string | null;
  at: string | null;
};

export type ReadinessProject = { slug: string; readiness: string; reason_codes: string[] };
export type ReadinessFinding = { code: string; severity: string; message: string };

export type DirectorSnapshot = {
  generatedAt: string;
  health: {
    level: HealthLevel;
    reasons: string[];
    refused: boolean;
    mode: string | null;
    process: "up" | "unavailable";
    capacity_database_present: boolean | null;
    contract_database_present: boolean | null;
    canonical_ready: boolean | null;
    canonical_head: string | null;
    readiness: string | null;
  };
  lanes: {
    available: boolean;
    capacity_total: number | null;
    counts: Record<string, number> | null;
    needs_reconciliation: boolean | null;
    items: Lane[];
  };
  delegations: {
    available: boolean;
    fleetRegistryAvailable: boolean;
    active: Delegation[];
    queued: Delegation[];
  };
  readiness: {
    available: boolean;
    label: string | null;
    counts: Record<string, number> | null;
    findings: ReadinessFinding[];
    projects: ReadinessProject[];
    reason_codes: string[];
  };
  receipts: {
    work: { available: boolean; items: WorkReceipt[]; note: string | null };
    leases: { available: boolean; items: LeaseEnd[]; note: string | null };
  };
  exceptions: DirectorException[];
  sources: { name: DirectorSourceName; path: string; ok: boolean; status: number | null; ms: number; error?: string }[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function iso(epochSeconds: unknown): string | null {
  const n = num(epochSeconds);
  return n === null ? null : new Date(n * 1000).toISOString();
}

function countsOf(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value)) {
    const n = num(v);
    if (n !== null) out[key] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetching

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out after ${SOURCE_TIMEOUT_MS}ms`;
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

export async function fetchSource(
  baseUrl: string,
  path: string,
  timeoutMs = SOURCE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<RawSource> {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    const ms = Date.now() - started;
    if (!response.ok) {
      // The Director answers a broken store with a bare-text 500, so never assume a JSON body here.
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
      return { ok: false, status: response.status, ms, error: snippet ? `HTTP ${response.status}: ${snippet}` : `HTTP ${response.status}` };
    }
    try {
      return { ok: true, status: response.status, ms, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, ms, error: "response was not JSON" };
    }
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - started, error: describeError(err) };
  }
}

export async function fetchDirectorRaw(baseUrl = DIRECTOR_API_URL): Promise<RawDirector> {
  const entries = await Promise.all(
    SOURCE_NAMES.map(async (name) => [name, await fetchSource(baseUrl, SOURCE_PATHS[name])] as const)
  );
  return Object.fromEntries(entries) as RawDirector;
}

// ---------------------------------------------------------------------------------------------------------------------
// Composition (pure)

// A 200 whose body does not have the documented shape is as unusable as a 500; mark it unavailable instead of
// rendering whatever the guessing yields.
const SHAPE_CHECKS: Record<DirectorSourceName, (body: unknown) => boolean> = {
  healthz: (b) => isRecord(b) && typeof b.status === "string",
  capacity: (b) => isRecord(b) && Array.isArray(b.slots),
  receipts: (b) => Array.isArray(b),
  readiness: (b) => isRecord(b) && typeof b.readiness === "string",
  contractsStatus: (b) => isRecord(b) && isRecord(b.canonical) && typeof b.canonical.ready === "boolean",
  contractsReceipts: (b) => Array.isArray(b)
};

function effectiveSources(raw: RawDirector): RawDirector {
  const out = {} as RawDirector;
  for (const name of SOURCE_NAMES) {
    const source = raw[name] ?? { ok: false, status: null, ms: 0, error: "not fetched" };
    out[name] =
      source.ok && !SHAPE_CHECKS[name](source.body)
        ? { ...source, ok: false, error: "response did not have the documented shape" }
        : source;
  }
  return out;
}

function resolveTargetPm(metadata: JsonRecord, fleetRefs: FleetAgentRef[] | null): TargetPm | null {
  const agentId = str(metadata.target_agent_id);
  if (!agentId) return null;
  const ref = fleetRefs?.find((r) => r.agent_id === agentId);
  if (ref) {
    return {
      agent_id: agentId,
      resolved: true,
      display_name: ref.display_name,
      repo: ref.repo || null,
      role: ref.role || null
    };
  }
  return { agent_id: agentId, resolved: false, display_name: agentId, repo: null, role: null };
}

function metaOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

const TERMINAL_LEASE_ACTIONS = new Set(["lease.released", "queue.cancelled", "lease.expired"]);
const TERMINAL_WORK_STATUSES = new Set(["completed", "failed", "canceled"]);
// info-severity code that every portfolio carries; per-project reason_codes are raw, so drop it client-side. The code
// set is open, so any other code the global findings mark info is dropped too (see infoCodes in the builder).
const INFO_REASON_CODES = new Set(["policy.hindsight_non_authoritative"]);
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function buildDirectorSnapshot(
  rawInput: RawDirector,
  fleetRefs: FleetAgentRef[] | null,
  nowMs: number
): DirectorSnapshot {
  const raw = effectiveSources(rawInput);
  const exceptions: DirectorException[] = [];
  const reasons: string[] = [];
  const addException = (severity: Severity, code: string, message: string, source: string) =>
    exceptions.push({ severity, code, message, source });

  const healthz = raw.healthz.ok && isRecord(raw.healthz.body) ? raw.healthz.body : null;
  const mode = str(healthz?.mode);
  // The contract: assert read-only, refuse to render if the Director ever reports anything else.
  const refused = healthz !== null && mode !== "read-only";

  const data = (name: DirectorSourceName): unknown => (raw[name].ok && !refused ? raw[name].body : undefined);
  const capacityBody = isRecord(data("capacity")) ? (data("capacity") as JsonRecord) : null;
  const receiptsBody = data("receipts");
  const readinessBody = isRecord(data("readiness")) ? (data("readiness") as JsonRecord) : null;
  const contractsStatus = isRecord(data("contractsStatus")) ? (data("contractsStatus") as JsonRecord) : null;
  const contractsReceiptsBody = data("contractsReceipts");

  const allDown = SOURCE_NAMES.every((name) => !raw[name].ok);

  // Rule 1: any non-2xx / timeout / unusable body marks that source unavailable. An empty body is never "healthy".
  if (allDown) {
    addException("error", "director.unreachable", `Director API unavailable: ${raw.healthz.error ?? "no source answered"}`, "healthz");
    reasons.push("Director API unreachable");
  } else {
    for (const name of SOURCE_NAMES) {
      if (raw[name].ok) continue;
      addException("error", "director.source_unavailable", `${name} unavailable: ${raw[name].error ?? "no answer"}`, name);
      reasons.push(`${name} unavailable (${raw[name].error ?? "no answer"})`);
    }
  }

  // Rule 2: mode must be read-only.
  if (refused) {
    addException("error", "director.mode_not_read_only", `Director reports mode '${mode ?? "unknown"}', not read-only; Holocene refuses to render it`, "healthz");
    reasons.push(`Director reports mode '${mode ?? "unknown"}'; Holocene refuses to render it`);
  }

  // Rule 3: store presence is keyed off /healthz, never off emptiness.
  const capacityDb = bool(healthz?.capacity_database_present);
  const evidence = isRecord(contractsStatus?.evidence) ? (contractsStatus?.evidence as JsonRecord) : null;
  const contractDb = bool(healthz?.contract_database_present) ?? bool(evidence?.database_present);
  // A missing capacity DB answers 200 with an all-free snapshot; that is "no source", not "three idle lanes". Only
  // /healthz can say the store is present, so an unconfirmed store (healthz down) is unknown, not idle.
  const capacity = capacityDb === true ? capacityBody : null;
  if (capacityDb === false) {
    addException("error", "capacity.database_missing", "Capacity database is missing; lanes and queue are empty because there is no source", "healthz");
    reasons.push("Capacity database missing");
  }
  if (capacityDb === null && healthz !== null) {
    addException("warning", "capacity.database_unknown", "healthz did not report capacity_database_present; lane state is unknown", "healthz");
    reasons.push("Capacity database state unknown");
  }
  if (contractDb === false) {
    addException("warning", "contracts.database_missing", "Contract database is missing (Bloodbank adapter has not run); no work receipts can exist yet", "healthz");
    reasons.push("Contract database missing");
  }

  // Rule 4: canonical contract set must resolve.
  const canonical = isRecord(contractsStatus?.canonical) ? (contractsStatus?.canonical as JsonRecord) : null;
  const canonicalReady = bool(canonical?.ready);
  if (canonicalReady === false) {
    addException("error", "contracts.canonical_not_ready", `Canonical Bloodbank contracts do not resolve: ${str(canonical?.error) ?? "no reason given"}`, "contractsStatus");
    reasons.push("Canonical Bloodbank contracts not ready");
  }

  // Lanes
  const lanes: Lane[] = [];
  const active: Delegation[] = [];
  const queued: Delegation[] = [];
  let expiredCount = 0;
  let malformedCount = 0;
  if (capacity) {
    for (const slot of Array.isArray(capacity.slots) ? capacity.slots : []) {
      if (!isRecord(slot)) continue;
      const id = str(slot.id) ?? "unknown";
      const preferred = str(slot.preferred_kind) ?? "unknown";
      const alloc = isRecord(slot.allocation) ? slot.allocation : null;
      if (!alloc) {
        lanes.push({ id, preferred_kind: preferred, state: "free", allocation: null });
        continue;
      }
      const metadata = metaOf(alloc.metadata);
      const expiresAt = num(alloc.expires_at);
      // Contract: an allocation is live only if expires_at > now. The read path never reconciles, so an expired lease
      // keeps reading "active" until a writer runs.
      const live = expiresAt !== null && expiresAt * 1000 > nowMs;
      // A missing / non-numeric expires_at is a malformed allocation, which is not the same condition as expired.
      const malformed = expiresAt === null;
      const correlation = str(alloc.correlation_id) ?? "unknown";
      const targetPm = resolveTargetPm(metadata, fleetRefs);
      const allocation: LaneAllocation = {
        correlation_id: correlation,
        kind: str(alloc.kind) ?? preferred,
        borrowed: alloc.borrowed === true,
        allocated_at: iso(alloc.allocated_at),
        expires_at: iso(alloc.expires_at),
        expires_in_s: expiresAt === null ? null : Math.round(expiresAt - nowMs / 1000),
        live,
        ticket: str(metadata.ticket),
        owner: str(metadata.owner),
        outcome: str(metadata.outcome),
        targetPm
      };
      lanes.push({ id, preferred_kind: preferred, state: live ? "live" : malformed ? "malformed" : "expired", allocation });
      if (live) {
        active.push({
          state: "active",
          correlation_id: correlation,
          kind: allocation.kind,
          slot_id: id,
          borrowed: allocation.borrowed,
          since: allocation.allocated_at,
          expires_at: allocation.expires_at,
          ttl_seconds: null,
          ticket: allocation.ticket,
          owner: allocation.owner,
          outcome: allocation.outcome,
          targetPm
        });
      } else if (malformed) {
        malformedCount += 1;
        addException(
          "warning",
          "capacity.lease_malformed",
          `Lease ${correlation} on ${id} has no usable expires_at, so its liveness cannot be determined`,
          "capacity"
        );
      } else {
        expiredCount += 1;
        addException(
          "warning",
          "capacity.lease_expired",
          `Lease ${correlation} on ${id} expired ${allocation.expires_at} but is still marked active`,
          "capacity"
        );
      }
    }
    for (const entry of Array.isArray(capacity.queue) ? capacity.queue : []) {
      if (!isRecord(entry)) continue;
      const metadata = metaOf(entry.metadata);
      queued.push({
        state: "queued",
        correlation_id: str(entry.correlation_id) ?? "unknown",
        kind: str(entry.kind) ?? "unknown",
        slot_id: null,
        borrowed: null,
        since: iso(entry.requested_at),
        expires_at: null,
        ttl_seconds: num(entry.ttl_seconds),
        ticket: str(metadata.ticket),
        owner: str(metadata.owner),
        outcome: str(metadata.outcome),
        targetPm: resolveTargetPm(metadata, fleetRefs)
      });
    }
    if (malformedCount > 0) {
      reasons.push(`${malformedCount} lease${malformedCount === 1 ? "" : "s"} with no usable expires_at`);
    }
    if (expiredCount > 0) {
      reasons.push(`${expiredCount} lease${expiredCount === 1 ? "" : "s"} expired but still marked active`);
    } else if (capacity.needs_reconciliation === true) {
      // Server clock says a lease is past due; ours disagrees (skew). Still surface it.
      addException("warning", "capacity.needs_reconciliation", "Director flags active leases past expires_at (needs reconciliation)", "capacity");
      reasons.push("Capacity needs reconciliation");
    }
  }

  // Readiness
  const findings: ReadinessFinding[] = [];
  const projects: ReadinessProject[] = [];
  const reasonCodes = new Set<string>();
  const infoCodes = new Set(INFO_REASON_CODES);
  let readinessLabel: string | null = null;
  if (readinessBody) {
    readinessLabel = str(readinessBody.readiness);
    for (const f of Array.isArray(readinessBody.findings) ? readinessBody.findings : []) {
      if (isRecord(f) && f.severity === "info") {
        const code = str(f.code);
        if (code) infoCodes.add(code);
      }
    }
    for (const f of Array.isArray(readinessBody.findings) ? readinessBody.findings : []) {
      if (!isRecord(f)) continue;
      const code = str(f.code) ?? "unknown";
      const severity = str(f.severity) ?? "info";
      findings.push({ code, severity, message: str(f.message) ?? "" });
      if (severity !== "info") reasonCodes.add(code);
      // Rule 5: readiness findings with severity error|warning. Key on code/severity; message is display only.
      if (severity === "error" || severity === "warning") {
        addException(severity, code, str(f.message) ?? code, "readiness");
      }
    }
    for (const p of Array.isArray(readinessBody.projects) ? readinessBody.projects : []) {
      if (!isRecord(p)) continue;
      const slug = str(p.slug) ?? "unknown";
      const label = str(p.readiness) ?? "unknown";
      // Per-project reason_codes are raw: dedupe and drop the always-present info code.
      const codes = [
        ...new Set(
          (Array.isArray(p.reason_codes) ? p.reason_codes : []).filter(
            (c): c is string => typeof c === "string" && !infoCodes.has(c)
          )
        )
      ];
      projects.push({ slug, readiness: label, reason_codes: codes });
      for (const c of codes) reasonCodes.add(c);
      if (label === "conflict" || label === "degraded") {
        addException(
          label === "conflict" ? "error" : "warning",
          `project.${label}`,
          `${slug} is ${label}${codes.length ? `: ${codes.join(", ")}` : ""}`,
          "readiness"
        );
      }
    }
    for (const c of Array.isArray(readinessBody.reason_codes) ? readinessBody.reason_codes : []) {
      if (typeof c === "string" && !infoCodes.has(c)) reasonCodes.add(c);
    }
    // F3: a degraded snapshot can carry no itemised finding at all; never let that read as healthy.
    if (readinessLabel !== "ready" && !exceptions.some((e) => e.source === "readiness")) {
      addException("warning", "readiness.not_ready", `Portfolio readiness is ${readinessLabel ?? "unknown"} with no itemised finding`, "readiness");
    }
    if (readinessLabel !== "ready") {
      const counts = countsOf(readinessBody.counts);
      const detail = counts ? ` (${counts.global_error ?? 0} error, ${counts.global_warning ?? 0} warning findings)` : "";
      reasons.push(`Portfolio readiness is ${readinessLabel ?? "unknown"}${detail}`);
    }
  }

  // Receipts: work outcomes (contract DB) and lease ends (capacity ledger).
  const workItems: WorkReceipt[] = [];
  if (Array.isArray(contractsReceiptsBody)) {
    for (const row of contractsReceiptsBody) {
      if (!isRecord(row)) continue;
      const envelope = metaOf(row.envelope);
      const d = metaOf(envelope.data);
      const status = str(d.terminal_status);
      if (!status || !TERMINAL_WORK_STATUSES.has(status)) continue;
      const result = metaOf(d.result);
      workItems.push({
        id: str(row.event_id) ?? str(row.idempotency_key) ?? str(d.receipt_id) ?? "unknown",
        correlation_id: str(row.correlation_id) ?? "unknown",
        terminal_status: status,
        work_id: str(d.work_id),
        delegation_id: str(d.delegation_id),
        project: str(d.project),
        summary: str(result.summary),
        at: iso(row.last_seen_at)
      });
      if (workItems.length >= SHOWN_RECEIPTS) break;
    }
  }
  const workAvailable = Array.isArray(contractsReceiptsBody);
  let workNote: string | null = null;
  if (workAvailable && workItems.length === 0) {
    workNote =
      contractDb === false
        ? "Empty by design today (F7): the contract database does not exist until the Bloodbank adapter first runs (DNET-4 hold). This is not a fault."
        : contractDb === true
          ? "No terminal work receipts recorded yet. The Director cannot tell none-yet apart from missing contract tables."
          : "Contract database state is unknown (healthz unavailable); an empty list is not evidence that nothing was recorded.";
  }

  const leaseItems: LeaseEnd[] = [];
  // /v1/receipts answers 200 [] when the capacity DB is missing, so only a healthz-confirmed store makes it a ledger.
  const leasesAvailable = Array.isArray(receiptsBody) && capacityDb === true;
  const leasesNote =
    Array.isArray(receiptsBody) && capacityDb !== true
      ? capacityDb === false
        ? "Capacity database is missing, so there is no lease ledger to list."
        : "Capacity database state is unknown (healthz unavailable); an empty list is not evidence that no lease ended."
      : null;
  if (leasesAvailable && Array.isArray(receiptsBody)) {
    for (const row of receiptsBody) {
      if (!isRecord(row)) continue;
      const action = str(row.action);
      if (!action || !TERMINAL_LEASE_ACTIONS.has(action)) continue;
      const details = metaOf(row.details);
      leaseItems.push({
        id: num(row.id) ?? 0,
        correlation_id: str(row.correlation_id) ?? "unknown",
        action,
        outcome: str(row.outcome) ?? "unknown",
        slot_id: str(details.slot_id) ?? str(details.previous_slot),
        at: iso(row.occurred_at)
      });
      if (leaseItems.length >= SHOWN_RECEIPTS) break;
    }
  }

  exceptions.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const level: HealthLevel =
    !raw.healthz.ok || allDown || refused ? "down" : reasons.length > 0 ? "degraded" : "ok";

  return {
    generatedAt: new Date(nowMs).toISOString(),
    health: {
      level,
      reasons,
      refused,
      mode,
      process: raw.healthz.ok ? "up" : "unavailable",
      capacity_database_present: capacityDb,
      contract_database_present: contractDb,
      canonical_ready: canonicalReady,
      canonical_head: str(canonical?.head_commit),
      readiness: readinessLabel
    },
    lanes: {
      available: capacity !== null,
      capacity_total: num(capacity?.capacity_total),
      counts: countsOf(capacity?.counts),
      needs_reconciliation: bool(capacity?.needs_reconciliation),
      items: lanes
    },
    delegations: { available: capacity !== null, fleetRegistryAvailable: fleetRefs !== null, active, queued },
    readiness: {
      available: readinessBody !== null,
      label: readinessLabel,
      counts: countsOf(readinessBody?.counts),
      findings,
      projects,
      reason_codes: [...reasonCodes]
    },
    receipts: {
      work: { available: workAvailable, items: workItems, note: workNote },
      leases: { available: leasesAvailable, items: leaseItems, note: leasesNote }
    },
    exceptions,
    sources: SOURCE_NAMES.map((name) => ({
      name,
      path: SOURCE_PATHS[name],
      ok: raw[name].ok,
      status: raw[name].status,
      ms: raw[name].ms,
      ...(raw[name].error ? { error: raw[name].error } : {})
    }))
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Route entry point: short cache, concurrent callers share one fetch.

let cached: { at: number; snapshot: DirectorSnapshot } | null = null;
let inflight: Promise<DirectorSnapshot> | null = null;

export async function getDirectorSnapshot(): Promise<DirectorSnapshot> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    const raw = await fetchDirectorRaw();
    let refs: FleetAgentRef[] | null;
    try {
      refs = getFleetAgentRefs();
    } catch {
      refs = null;
    }
    const snapshot = buildDirectorSnapshot(raw, refs, Date.now());
    cached = { at: Date.now(), snapshot };
    return snapshot;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

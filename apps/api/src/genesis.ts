import type { CollectedEvent } from "./event-store.js";

// The Genesis tab's read model: every bloodbank.genesis.* fact in the shared collection, newest first, plus two
// derived views. Approvals join each approval.requested with its latest granted/denied/expired fact by approval id;
// alerts carry an acknowledged flag (a Holocene-side acknowledgement, or a later alert.* fact from Genesis that
// closes the alert). Pure functions only: the routes in genesis-routes.ts read the store and call these.

export const GENESIS_PREFIX = "bloodbank.genesis.";
export const GENESIS_OPERATOR_BASE = (process.env.GENESIS_URL ?? "https://genesis.delo.sh").replace(/\/$/, "");

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const when = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

export type GenesisActor = { type: string | null; agent_id: string | null };
export type GenesisEvent = {
  cursor: number;
  id: string;
  type: string;
  /** bloodbank.genesis.<entity>.<action>; a longer tail keeps the remainder in `action`. */
  entity: string;
  action: string;
  time: string | null;
  collected_at: string;
  subject: string;
  producer: string | null;
  source: string | null;
  correlationid: string | null;
  causationid: string | null;
  actor: GenesisActor | null;
  summary: string | null;
  client_id: string | null;
  client_name: string | null;
  bot_id: string | null;
  /** An https link into the Genesis operator console, or null when the fact carried none and named no client. */
  operator_url: string | null;
  test: boolean;
  data: Json;
};

/** An https URL, else null: the page renders it as a link, so nothing else gets through. */
export function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function operatorUrlFor(clientId: string | null, base = GENESIS_OPERATOR_BASE): string | null {
  return clientId ? `${base}/operator?client=${encodeURIComponent(clientId)}` : null;
}

export function toGenesisEvent(row: Pick<CollectedEvent, "cursor" | "collected_at" | "subject" | "envelope">): GenesisEvent | undefined {
  const env = row.envelope as Json;
  if (!record(env) || typeof env.type !== "string" || !env.type.startsWith(GENESIS_PREFIX) || typeof env.id !== "string") return undefined;
  const tail = env.type.slice(GENESIS_PREFIX.length).split(".");
  const data = record(env.data) ? env.data : {};
  const actor = record(env.actor) ? { type: str(env.actor.type), agent_id: str(env.actor.agent_id) } : null;
  const clientId = str(data.client_id);
  return {
    cursor: row.cursor,
    id: env.id,
    type: env.type,
    entity: tail[0] ?? "",
    action: tail.slice(1).join(".") || "",
    time: when(env.time) ?? when(data.occurred_at),
    collected_at: row.collected_at,
    subject: row.subject,
    producer: str(env.producer),
    source: str(env.source),
    correlationid: str(env.correlationid),
    causationid: str(env.causationid),
    actor,
    summary: str(data.summary),
    client_id: clientId,
    client_name: str(data.client_name),
    bot_id: str(data.bot_id) ?? actor?.agent_id ?? null,
    operator_url: safeHttpsUrl(data.operator_url) ?? operatorUrlFor(clientId),
    test: data.test === true,
    data,
  };
}

export function toGenesisEvents(rows: Array<Pick<CollectedEvent, "cursor" | "collected_at" | "subject" | "envelope">>): GenesisEvent[] {
  return rows.map(toGenesisEvent).filter((e): e is GenesisEvent => e !== undefined);
}

// ---------------------------------------------------------------- approvals

export type ApprovalState = "pending" | "approved" | "declined" | "expired" | "lapsed";
export const RESOLUTION_STATE: Record<string, Exclude<ApprovalState, "pending" | "lapsed">> = {
  granted: "approved",
  denied: "declined",
  expired: "expired",
};

export type ApprovalStep = { type: string; action: string; cursor: number; time: string | null; status: string | null; decided_via: string | null };
export type Approval = {
  approval_id: string;
  client_id: string | null;
  client_name: string | null;
  bot_id: string | null;
  kind: string | null;
  summary: string | null;
  question: string | null;
  channel: string | null;
  expires_at: string | null;
  /** Open by contract: email.send carries {to, cc?, subject, body_preview}; other kinds may carry other fields. */
  action: Json | null;
  operator_url: string | null;
  test: boolean;
  /** False when only a resolution is in the collection (the request aged out or never arrived). */
  requested: boolean;
  requested_at: string | null;
  requested_cursor: number | null;
  state: ApprovalState;
  /** The final proposal status the resolution carried. */
  status: string | null;
  decided_via: string | null;
  resolved_at: string | null;
  resolution_type: string | null;
  last_cursor: number;
  steps: ApprovalStep[];
};

const at = (e: GenesisEvent) => e.time ?? e.collected_at;

/** The approval id a fact is about: data.approval_id, else the correlation id the contract sets to it. */
export const approvalIdOf = (e: GenesisEvent) => str(e.data.approval_id) ?? e.correlationid;

export function deriveApprovals(events: GenesisEvent[], now: number): Approval[] {
  const groups = new Map<string, GenesisEvent[]>();
  for (const e of events) {
    if (e.entity !== "approval") continue;
    const id = approvalIdOf(e);
    if (!id) continue;
    const list = groups.get(id);
    if (list) list.push(e);
    else groups.set(id, [e]);
  }
  const out: Approval[] = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => a.cursor - b.cursor);
    const requests = list.filter((e) => e.action === "requested");
    const request = requests.at(-1);
    const resolution = list.filter((e) => e.action in RESOLUTION_STATE).at(-1);
    const base = request ?? resolution ?? list.at(-1)!;
    const d = base.data;
    const expiresAt = request ? when(request.data.expires_at) : null;
    const state: ApprovalState = resolution
      ? RESOLUTION_STATE[resolution.action]
      : expiresAt && Date.parse(expiresAt) <= now ? "lapsed" : "pending";
    out.push({
      approval_id: id,
      client_id: base.client_id ?? list.find((e) => e.client_id)?.client_id ?? null,
      client_name: base.client_name ?? list.find((e) => e.client_name)?.client_name ?? null,
      bot_id: base.bot_id,
      kind: str(d.kind),
      summary: base.summary,
      question: request ? str(request.data.question) : null,
      channel: request ? str(request.data.channel) : null,
      expires_at: expiresAt,
      action: request && record(request.data.action) ? request.data.action : null,
      operator_url: base.operator_url,
      test: list.some((e) => e.test),
      requested: !!request,
      requested_at: request ? at(requests[0]) : null,
      requested_cursor: request ? requests[0].cursor : null,
      state,
      status: resolution ? str(resolution.data.status) : null,
      decided_via: resolution ? str(resolution.data.decided_via) : null,
      resolved_at: resolution ? at(resolution) : null,
      resolution_type: resolution?.type ?? null,
      last_cursor: list.at(-1)!.cursor,
      steps: list.map((e) => ({
        type: e.type, action: e.action, cursor: e.cursor, time: at(e),
        status: str(e.data.status), decided_via: str(e.data.decided_via),
      })),
    });
  }
  return out.sort((a, b) => b.last_cursor - a.last_cursor);
}

// ---------------------------------------------------------------- alerts

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertAck = { at: string; via: "holocene" | "genesis"; upstream?: string | null };
export type Alert = {
  alert_id: string;
  client_id: string | null;
  client_name: string | null;
  bot_id: string | null;
  reason: string | null;
  severity: AlertSeverity;
  summary: string | null;
  detail: string | null;
  operator_url: string | null;
  test: boolean;
  raised_at: string;
  cursor: number;
  event_id: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_via: "holocene" | "genesis" | null;
};

const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];
/** A later alert.<action> from Genesis with one of these actions closes the alert for the operator. */
const CLOSING_ALERT_ACTIONS = new Set(["acknowledged", "resolved", "cleared", "closed"]);

export const alertIdOf = (e: GenesisEvent) => str(e.data.alert_id) ?? e.correlationid;

export function deriveAlerts(events: GenesisEvent[], acks: ReadonlyMap<string, AlertAck> = new Map()): Alert[] {
  const raised = new Map<string, GenesisEvent>();
  const closed = new Map<string, GenesisEvent>();
  for (const e of [...events].sort((a, b) => a.cursor - b.cursor)) {
    if (e.entity !== "alert") continue;
    const id = alertIdOf(e);
    if (!id) continue;
    if (e.action === "raised") raised.set(id, e);
    else if (CLOSING_ALERT_ACTIONS.has(e.action)) closed.set(id, e);
  }
  const out: Alert[] = [];
  for (const [id, e] of raised) {
    const severity = SEVERITIES.includes(e.data.severity as AlertSeverity) ? (e.data.severity as AlertSeverity) : "warning";
    const upstream = closed.get(id);
    const local = acks.get(id);
    out.push({
      alert_id: id,
      client_id: e.client_id,
      client_name: e.client_name,
      bot_id: e.bot_id,
      reason: str(e.data.reason),
      severity,
      summary: e.summary,
      detail: str(e.data.detail),
      operator_url: e.operator_url,
      test: e.test,
      raised_at: at(e),
      cursor: e.cursor,
      event_id: e.id,
      acknowledged: !!(upstream || local),
      acknowledged_at: upstream ? at(upstream) : local?.at ?? null,
      acknowledged_via: upstream ? "genesis" : local ? local.via : null,
    });
  }
  return out.sort((a, b) => b.cursor - a.cursor);
}

// ---------------------------------------------------------------- overview

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export type GenesisOverview = {
  generated_at: string;
  cursor: number;
  needs_you: { approvals: Approval[]; alerts: Alert[] };
  approvals: Approval[];
  alerts: Alert[];
  timeline: GenesisEvent[];
  counts: { events: number; by_type: Record<string, number>; pending: number; lapsed: number; unacknowledged: number };
};

/** `events` newest first. Needs you: pending approvals soonest-to-expire first, open alerts most severe then newest. */
export function genesisOverview(events: GenesisEvent[], acks: ReadonlyMap<string, AlertAck>, now: number, timelineLimit = 200): GenesisOverview {
  const approvals = deriveApprovals(events, now);
  const alerts = deriveAlerts(events, acks);
  const expiry = (a: Approval) => (a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY);
  const by_type: Record<string, number> = {};
  for (const e of events) by_type[e.type] = (by_type[e.type] ?? 0) + 1;
  const pending = approvals.filter((a) => a.state === "pending").sort((a, b) => expiry(a) - expiry(b) || b.last_cursor - a.last_cursor);
  const open = alerts.filter((a) => !a.acknowledged).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.cursor - a.cursor);
  return {
    generated_at: new Date(now).toISOString(),
    cursor: events[0]?.cursor ?? 0,
    needs_you: { approvals: pending, alerts: open },
    approvals,
    alerts,
    timeline: events.slice(0, timelineLimit),
    counts: {
      events: events.length,
      by_type,
      pending: pending.length,
      lapsed: approvals.filter((a) => a.state === "lapsed").length,
      unacknowledged: open.length,
    },
  };
}

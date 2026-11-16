import type { Signal } from "../hub/types";
import type { Alert, AlertSeverity, Approval, ApprovalState, GenesisEvent, GenesisOverview, Json } from "./types";

// Pure derivations for the Genesis tab. The API joins and orders; this file only turns time and state into words,
// so a countdown can run out and a pending approval can lapse on screen between server updates.

export const STATE_WORD: Record<ApprovalState, string> = {
  pending: "Waiting on the client",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
  lapsed: "Lapsed",
};

export const STATE_SIGNAL: Record<ApprovalState, Signal> = {
  pending: "you",
  approved: "cleared",
  declined: "quiet",
  expired: "stuck",
  lapsed: "stuck",
};

export const SEVERITY_SIGNAL: Record<AlertSeverity, Signal> = { critical: "broken", warning: "you", info: "quiet" };

const REASON_WORD: Record<string, string> = {
  operator_requested: "The assistant asked for you",
  gateway_failure: "Gateway failure",
  private_content_blocked: "Private content blocked",
  private_content_leaked: "Private content leaked",
};

const RESOLUTION: Record<string, ApprovalState> = { granted: "approved", denied: "declined", expired: "expired" };

/** The state now: a pending approval whose expiry has passed is lapsed even before the server says so. */
export function liveState(a: Pick<Approval, "state" | "expires_at">, now: number): ApprovalState {
  if (a.state !== "pending" || !a.expires_at) return a.state;
  const t = Date.parse(a.expires_at);
  return Number.isFinite(t) && t <= now ? "lapsed" : "pending";
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 14s · 12m · 1h 06m · 2d 03h */
export function shortDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${pad(m % 60)}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${pad(h % 24)}h` : `${d}d`;
}

/** "expires in 42m" while time is left, "lapsed 3m ago" after. */
export function expiryText(expiresAt: string | null, now: number): string | undefined {
  if (!expiresAt) return undefined;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return undefined;
  const left = (t - now) / 1000;
  return left > 0 ? `expires in ${shortDuration(left)}` : `lapsed ${shortDuration(-left)} ago`;
}

export function agoText(iso: string | null | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${shortDuration((now - t) / 1000)} ago` : undefined;
}

export function reasonWord(reason: string | null | undefined): string {
  if (!reason) return "Alert";
  return REASON_WORD[reason] ?? reason.replace(/[_.-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function clientLabel(x: { client_name: string | null; client_id: string | null }): string {
  return x.client_name ?? (x.client_id ? `client ${x.client_id.slice(0, 8)}` : "no client");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export type EmailAction = { to: string[]; cc: string[]; subject: string | null; bodyPreview: string | null; extra: Array<[string, string]> };

/** An email.send action as the card shows it; any other fields the kind carries are listed after it. */
export function emailAction(action: Json | null): EmailAction | null {
  if (!action) return null;
  const to = strings(action.to), cc = strings(action.cc);
  const subject = text(action.subject), bodyPreview = text(action.body_preview);
  if (!to.length && !subject && !bodyPreview) return null;
  return { to, cc, subject, bodyPreview, extra: otherFields(action, ["to", "cc", "subject", "body_preview"]) };
}

/** Scalar fields of an open-ended action, for a kind the page has no layout for. Objects are shown as JSON. */
export function otherFields(action: Json | null, skip: string[] = []): Array<[string, string]> {
  if (!action) return [];
  return Object.entries(action)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v)]);
}

export type TimelineKind = "approval" | "resolution" | "alert" | "generic";
export function timelineKind(e: Pick<GenesisEvent, "entity" | "action">): TimelineKind {
  if (e.entity === "approval" && e.action === "requested") return "approval";
  if (e.entity === "approval" && e.action in RESOLUTION) return "resolution";
  if (e.entity === "alert" && e.action === "raised") return "alert";
  return "generic";
}

export function resolutionState(action: string): ApprovalState | undefined {
  return RESOLUTION[action];
}

/** "Approved via telegram 4m ago" for a resolved approval; undefined while it is open. */
export function decidedText(a: Pick<Approval, "state" | "decided_via" | "resolved_at" | "status">, now: number): string | undefined {
  if (a.state === "pending" || a.state === "lapsed") return undefined;
  const via = a.decided_via && a.decided_via !== "expiry" ? ` via ${a.decided_via}` : "";
  const ago = agoText(a.resolved_at, now);
  return `${STATE_WORD[a.state]}${via}${ago ? ` ${ago}` : ""}${a.status ? ` (status ${a.status})` : ""}`;
}

export type TimelineFilter = "all" | "approvals" | "alerts" | "other";
export function filterTimeline(events: GenesisEvent[], filter: TimelineFilter, hideTest: boolean): GenesisEvent[] {
  return events.filter((e) => {
    if (hideTest && e.test) return false;
    if (filter === "approvals") return e.entity === "approval";
    if (filter === "alerts") return e.entity === "alert";
    if (filter === "other") return e.entity !== "approval" && e.entity !== "alert";
    return true;
  });
}

/** The fresher of the stream's and the poll's copy: the higher collection cursor, then the later read. */
export function newerOverview(a: GenesisOverview | undefined, b: GenesisOverview | undefined): GenesisOverview | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.cursor !== b.cursor) return a.cursor > b.cursor ? a : b;
  return Date.parse(a.generated_at) >= Date.parse(b.generated_at) ? a : b;
}

/** Needs you, re-checked against the clock: an approval that lapsed since the server's read leaves the list. */
export function needsYou(o: GenesisOverview, now: number, hideTest = false): { approvals: Approval[]; alerts: Alert[] } {
  return {
    approvals: o.needs_you.approvals.filter((a) => liveState(a, now) === "pending" && !(hideTest && a.test)),
    alerts: o.needs_you.alerts.filter((a) => !a.acknowledged && !(hideTest && a.test)),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function statement(o: GenesisOverview | undefined, now: number, hideTest = false): string {
  if (!o) return "Reading Genesis events…";
  const { approvals, alerts } = needsYou(o, now, hideTest);
  if (!o.counts.events) return "No Genesis events yet. Approval requests and alerts from client assistants land here as they happen.";
  if (approvals.length || alerts.length) {
    const parts = [approvals.length ? `${plural(approvals.length, "approval")} waiting on a client` : "", alerts.length ? plural(alerts.length, "open alert") : ""].filter(Boolean);
    return `${parts.join(" and ")}.`;
  }
  const newest = o.timeline[0];
  const ago = newest ? agoText(newest.time ?? newest.collected_at, now) : undefined;
  return `Nothing needs you. ${plural(o.counts.events, "Genesis event")} in the collection${ago ? `, newest ${ago}` : ""}.`;
}

/** Index approvals by id so a timeline row can show its approval's current state. */
export function approvalsById(o: GenesisOverview | undefined): Map<string, Approval> {
  return new Map((o?.approvals ?? []).map((a) => [a.approval_id, a]));
}
export function alertsById(o: GenesisOverview | undefined): Map<string, Alert> {
  return new Map((o?.alerts ?? []).map((a) => [a.alert_id, a]));
}
export const approvalIdOf = (e: GenesisEvent) => text(e.data.approval_id) ?? e.correlationid;
export const alertIdOf = (e: GenesisEvent) => text(e.data.alert_id) ?? e.correlationid;

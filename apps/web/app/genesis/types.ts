// The Genesis tab's payloads, as apps/api/src/genesis.ts and genesis-routes.ts send them.

export type Json = Record<string, unknown>;

export type GenesisEvent = {
  cursor: number;
  id: string;
  type: string;
  entity: string;
  action: string;
  time: string | null;
  collected_at: string;
  subject: string;
  producer: string | null;
  source: string | null;
  correlationid: string | null;
  causationid: string | null;
  actor: { type: string | null; agent_id: string | null } | null;
  summary: string | null;
  client_id: string | null;
  client_name: string | null;
  bot_id: string | null;
  operator_url: string | null;
  test: boolean;
  data: Json;
};

export type ApprovalState = "pending" | "approved" | "declined" | "expired" | "lapsed";

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
  action: Json | null;
  operator_url: string | null;
  test: boolean;
  requested: boolean;
  requested_at: string | null;
  requested_cursor: number | null;
  state: ApprovalState;
  status: string | null;
  decided_via: string | null;
  resolved_at: string | null;
  resolution_type: string | null;
  last_cursor: number;
  steps: ApprovalStep[];
};

export type AlertSeverity = "info" | "warning" | "critical";

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

export type CollectionSource = { state: string; lastEventAt: string | null; catchingUp: boolean; error: string | null };

export type GenesisOverview = {
  generated_at: string;
  cursor: number;
  needs_you: { approvals: Approval[]; alerts: Alert[] };
  approvals: Approval[];
  alerts: Alert[];
  timeline: GenesisEvent[];
  counts: { events: number; by_type: Record<string, number>; pending: number; lapsed: number; unacknowledged: number };
  source: CollectionSource;
};

export type Proposal = {
  id: string;
  kind?: string;
  to?: string[];
  subject?: string;
  body?: string;
  why?: string;
  status?: string;
  created?: string;
  expires?: string;
  decided?: string | null;
  channel?: string | null;
  error?: string | null;
};

export type HookExecution = {
  handler_id: string;
  mode: string;
  status: string;
  reason?: string | null;
  selected_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  exit_code?: number | null;
  event_id?: string | null;
  event_type?: string | null;
  publish_status?: string | null;
};

export type HookInvocation = {
  invocation_id: string;
  cli: string;
  native: string;
  role?: string;
  event_type?: string | null;
  session_id?: string | null;
  identity_kind?: string;
  received_at: string;
  updated_at: string;
  status: string;
  deduplicated?: number;
  executions: HookExecution[];
  timeline?: { sequence: number; handler_id?: string; status: string; reason?: string; at: string }[];
};

export type HookBinding = {
  cli: string;
  native: string;
  role: string;
  event_type?: string | null;
  configured: boolean;
  support_status?: string;
  state: string;
  handler_ids: string[];
  activity?: { invocations: number; last_received_at: string; deduplicated: number; failed: number } | null;
};

export type HookHandler = {
  id: string;
  mode: string;
  on: string[];
  on_native: string[];
  clis: string[];
  enabled: boolean;
  timeout_ms: number;
  order: number;
  state: string;
  require_env?: string[];
  match_tool?: string;
};

export type HookSnapshot = {
  schema_version: number;
  generated_at: string;
  observed_since?: string | null;
  hub: { state: string; started_at: string; pid: number; registry_error?: string | null; journal_error?: string | null; transport_error?: string | null; publish_enabled: boolean; async_running: number };
  bindings: HookBinding[];
  handlers: HookHandler[];
  totals: Record<string, number>;
  handler_activity: { handler_id: string; cli: string; status: string; count: number; last_at: string; mean_duration_ms?: number | null }[];
  installed_inventory?: {
    generated_at: string;
    status: string;
    clis: {
      cli: string;
      label: string;
      support_status: string;
      binary_available: boolean;
      status: string;
      trust_verification?: string;
      configs: { label: string; source: string; status: string; errors: string[] }[];
      natives: {
        native: string;
        role: string;
        expected_count: number;
        actual_hub_count: number;
        direct_managed_count: number;
        status: string;
        sources: { source: string; hub_count: number; direct_count: number; issues: string[] }[];
      }[];
    }[];
  };
};

export type HookHistory = {
  items: HookInvocation[];
  total: number;
  limit: number;
  offset: number;
  next_offset?: number | null;
};

export const CLI_NAMES: Record<string, string> = {
  claude: "Claude", codex: "Codex", hermes: "Hermes", copilot: "Copilot", gemini: "Gemini",
  kimi: "Kimi", opencode: "OpenCode", antigravity: "Antigravity", openclaw: "OpenClaw",
};
export const CLI_ORDER = Object.keys(CLI_NAMES);
export const FAILED = new Set(["failed", "timed_out", "interrupted", "missing", "duplicate", "drift", "unavailable", "error"]);

export function eventName(binding: Pick<HookBinding, "event_type" | "role">) {
  return binding.event_type?.replace(/^bloodbank\.(?:agent\.|conversation\.)?/, "") ?? binding.role.replaceAll("_", ".");
}

export function handlerName(id: string) {
  const names: Record<string, string> = {
    "bloodbank-publish": "Bloodbank publish", "publisher": "Bloodbank publish", "skill-check": "Skill check",
    "hindsight-recall": "Hindsight recall", "hindsight-retain": "Hindsight candidates", "hindsight-session-end": "Hindsight retention",
    "merge-forward": "Merge forward", "codegraph": "CodeGraph", "orca": "Orca",
  };
  return names[id] ?? id.replaceAll("-", " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function statusLabel(status: string) {
  const names: Record<string, string> = {
    timed_out: "Timed out", unobserved: "No receipts yet", active: "Receiving hooks", idle: "Quiet",
    running: "Running", selected: "Selected", started: "Running", succeeded: "Succeeded", failed: "Failed", interrupted: "Interrupted",
    skipped: "Skipped", deduplicated: "Duplicate suppressed", completed: "Completed", received: "Received",
    configured: "Configured", unavailable: "Unavailable", not_installed: "Not installed", unsupported: "No adapter", duplicate: "Duplicate wiring", drift: "Wiring drift", missing: "Missing wiring",
  };
  return names[status] ?? status.replaceAll("_", " ");
}

export function durationLabel(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function invocationDuration(invocation: HookInvocation) {
  const finished = invocation.executions.map((e) => e.finished_at ? Date.parse(e.finished_at) : NaN).filter(Number.isFinite);
  if (!finished.length || invocation.executions.some((e) => ["selected", "started"].includes(e.status))) return null;
  return Math.max(0, Math.max(...finished) - Date.parse(invocation.received_at));
}

export function normalizedGroups(bindings: HookBinding[]) {
  const grouped = new Map<string, { role: string; label: string; bindings: HookBinding[]; handlerIds: string[] }>();
  for (const binding of bindings) {
    const group = grouped.get(binding.role) ?? { role: binding.role, label: eventName(binding), bindings: [], handlerIds: [] };
    group.bindings.push(binding);
    group.handlerIds = [...new Set([...group.handlerIds, ...binding.handler_ids])];
    grouped.set(binding.role, group);
  }
  return [...grouped.values()];
}

// Payload of /api/modules/wax/catalog (apps/api/src/wax.ts). Mirrors the safe
// discovery snapshot the Wax CLI allows: purposes, capabilities, availability,
// conditions, the FROZEN compiled graph (nodes + edges + authored names),
// bindings, bounded outcome counts, recent runs and worker freshness.
// Read-only.

export type WaxSource = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

export type WaxPass = {
  slug: string;
  description?: string;
  version?: number;
  enabled?: boolean;
  auto?: boolean;
  kind?: string;
  capabilities?: string[];
  requires?: string[];
  after?: string[];
  emits?: string[];
  timeout_s?: number;
  conditions?: { when?: unknown; skip_when?: unknown } | null;
  availability: { state: string; reason: string };
  outcomes?: Record<string, number>;
};

export type WaxPipelineBinding = {
  binding_id?: string;
  folder?: string;
  enabled?: boolean;
  seeded_at?: string;
  last_scan_at?: string;
  folder_exists?: boolean;
  documents?: number;
  documents_unprocessed?: number;
  documents_pending?: number;
  documents_seeded?: number;
  documents_failed?: number;
  documents_processed?: number;
  documents_exhausted?: number;
};

export type WaxPipelineNode = {
  slug: string;
  name?: string;
  availability?: { state?: string; reason?: string };
  live_availability?: { state?: string; reason?: string };
  capabilities?: string[];
  applicable?: boolean;
  version?: number;
  conditions?: { when?: unknown; skip_when?: unknown };
  registry_drift?: { change?: string; frozen_version?: number; live_version?: number };
};

export type WaxRecentRun = {
  doc_id?: string;
  path?: string;
  state?: string;
  attempts?: number;
  last_attempt_at?: string;
  completed_at?: string;
  exhausted_at?: string;
  /** Machine cause only; raw error prose never reaches this surface. */
  reason_code?: string;
};

export type WaxWorkerStatus = {
  state?: string;
  heartbeat_at?: string;
  age_seconds?: number;
  tick?: number;
  pid?: number;
  busy?: string | null;
  pipeline_enabled?: boolean;
  documents?: { interval_s?: number; scanning?: boolean };
  note?: string;
};

export type WaxPipeline = {
  name: string;
  description?: string;
  authored_path?: string;
  authored_error?: string;
  source?: string;
  source_ref?: string;
  drift?: { state?: string; detail?: string };
  version?: number;
  definition_id?: string;
  compiled_at?: string;
  trigger?: string;
  enabled?: boolean;
  failure_policy?: string;
  executed_by?: string;
  nodes?: WaxPipelineNode[];
  edges?: { from: string; to: string; kind?: string }[];
  bindings?: WaxPipelineBinding[];
  documents_processed?: number;
  outcomes?: Record<string, Record<string, number>>;
  registry_drift?: { changed?: unknown[]; count?: number };
  recent_runs?: WaxRecentRun[];
};

export type WaxCatalog = {
  generated_at?: string;
  passes?: WaxPass[];
  counts?: { registered?: number; enabled?: number; automatic?: number; quarantined?: number; failing?: number };
  pipelines?: WaxPipeline[];
  document_status?: { bindings?: WaxPipelineBinding[]; documents_total?: number; scan_interval_s?: number; max_attempts?: number };
  worker?: WaxWorkerStatus;
};

export type WaxPayload = { generated_at: string; source: WaxSource; catalog: WaxCatalog };

export type Theme = "ledger" | "ledger-night";

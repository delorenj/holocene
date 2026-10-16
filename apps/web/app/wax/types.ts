// Payload of /api/modules/wax/catalog (apps/api/src/wax.ts). Mirrors the safe
// discovery snapshot the Wax CLI allows: purposes, capabilities, availability,
// conditions, edges, bindings and bounded outcome counts. Read-only.

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
};

export type WaxPipelineNode = {
  slug: string;
  availability?: { state?: string; reason?: string };
  capabilities?: string[];
  applicable?: boolean;
};

export type WaxPipeline = {
  name: string;
  description?: string;
  authored_path?: string;
  authored_error?: string;
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
};

export type WaxCatalog = {
  generated_at?: string;
  passes?: WaxPass[];
  counts?: { registered?: number; enabled?: number; automatic?: number; quarantined?: number; failing?: number };
  pipelines?: WaxPipeline[];
  document_status?: { bindings?: WaxPipelineBinding[]; documents_total?: number };
};

export type WaxPayload = { generated_at: string; source: WaxSource; catalog: WaxCatalog };

export type Theme = "ledger" | "ledger-night";

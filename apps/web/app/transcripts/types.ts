// Payloads of /api/modules/transcripts/{list,search,:id} (apps/api/src/transcripts.ts),
// hand-mirrored as Wax's types are. They carry summaries and ticket links, never the
// note body, the note path, the frontmatter or any storage location. Read-only.

export type TranscriptsSource = { name: string; value?: string; ageSeconds?: number; maxSeconds?: number; down?: boolean; detail?: string };

export type Classification = "monolog" | "meeting" | "phone_call" | "other";
export type KindView = Classification | "unsorted";
export type ViewId = KindView | "all";

export type HarvestSummary = {
  state: "none" | "harvested" | "no_items" | "unfiled";
  run_count: number;
  ticket_count: number;
  item_count: number;
  last_harvested_at: string | null;
};

export type TranscriptRow = {
  transcript_id: number;
  wax_item_id: string | null;
  classification: Classification | null;
  classification_detail: string | null;
  classification_confidence: number | null;
  classification_source: string | null;
  title: string;
  summary: string | null;
  effective_at: string | null;
  duration_s: number | null;
  word_count: number | null;
  speaker_count: number | null;
  origin: string | null;
  source_hint: string | null;
  tags: string[];
  project_ids: string[];
  projects: string[];
  language: string | null;
  diarized: boolean;
  audio_available: boolean;
  harvest: HarvestSummary;
};

export type TranscriptTicket = {
  harvest_id: string;
  harvested_at: string | null;
  item_id: string;
  title: string;
  category: string | null;
  item_status: string | null;
  gate_state: string | null;
  quote: string | null;
  provider: string | null;
  board_id: string | null;
  publish_status: string | null;
  ticket_ref: string | null;
  ticket_url: string | null;
  project_id: string | null;
  lane: string | null;
  published_at: string | null;
};

export type PassRun = { slug: string; pass_version: number | null; state: string | null; finished_at: string | null };

export type TranscriptProject = { project_id: string; name: string; count: number };

export type TranscriptCounts = Partial<Record<Classification | "unsorted" | "hidden_hermes", number>>;

export type TranscriptsPayload = {
  generated_at: string;
  source: TranscriptsSource;
  store?: { state: string; latest_migration?: string };
  counts: TranscriptCounts;
  rows: TranscriptRow[];
  projects: TranscriptProject[];
  truncated: boolean;
};

export type TranscriptDetailPayload = {
  generated_at: string;
  source: TranscriptsSource;
  row: TranscriptRow | null;
  tickets: TranscriptTicket[];
  pass_history: PassRun[];
};

export type SearchHit = {
  transcript_id: number;
  display_title: string;
  snippet: string | null;
  score: number | null;
  classification: Classification | null;
  effective_at: string | null;
  origin: string | null;
};

export type TranscriptSearchPayload = { generated_at: string; source: TranscriptsSource; query: string; results: SearchHit[] };

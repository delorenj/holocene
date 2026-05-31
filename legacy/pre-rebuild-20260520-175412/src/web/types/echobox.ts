export type JobStatus =
  | 'detected'
  | 'hashing'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'ready'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface EchoboxJob {
  content_hash: string;
  job_id: string;
  status: JobStatus;
  source_path: string;
  source_filename: string;
  source_mime: string | null;
  source_size_bytes: number | null;
  minio_bucket: string | null;
  minio_key: string | null;
  fireflies_id: string | null;
  fireflies_ref: string | null;
  transcript_path: string | null;
  csv_path: string | null;
  error_message: string | null;
  error_stage: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EchoboxHealth {
  status: string;
  db_connected: boolean;
  pending_jobs: number;
}

export interface EchoboxMetrics {
  total: number;
  pending: number;
  completed: number;
  failed: number;
  skipped: number;
  inProgress: number;
}

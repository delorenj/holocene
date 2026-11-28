import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// HOLOC-70: Holocene owns durable review state. A revision is an immutable, hash-addressed copy
// of a publication; annotations and drafts hang off exactly one revision and are never rebound.

export type ManifestEntry = { path: string; sha256: string; size: number };
export type Revision = {
  revisionId: string; projectId: string; artifactId: string; title: string; entry: string;
  sourceUrl: string; sourceModified?: string; snapshotBaseUrl: string; snapshotUrl: string;
  entrySha256: string; manifest: ManifestEntry[]; createdAt: string; createdBy: string;
};
export type AnnotationStatus = "draft" | "saved";
export type Annotation = {
  id: string; projectId: string; revisionId: string; artifactId: string; author: string;
  status: AnnotationStatus; kind: "text" | "element"; anchor: unknown; comment: string;
  createdAt: string; updatedAt: string; version: number;
};

/**
 * An explicit Send: the saved feedback of one revision, frozen at the click, with its recipient and its
 * delivery identity. The row is the outbox entry; publication is Bloodbank's contract (BB-67), so until
 * that contract is accepted a submission stays `saved` and nothing is published.
 */
export type SubmissionState = "saved" | "queued" | "published" | "uncertain" | "answered" | "failed";
export type FrozenAnnotation = Pick<Annotation, "id" | "version" | "author" | "kind" | "anchor" | "comment" | "updatedAt">;
export type Submission = {
  submissionId: string; projectId: string; revisionId: string; artifactId: string; author: string; recipient: string;
  note: string; annotations: FrozenAnnotation[]; digest: string; correlationId: string;
  state: SubmissionState; stateDetail: string; createdAt: string; updatedAt: string;
  /** Bloodbank's derived command id (from bb-emit), once the row has been validated against its contract. */
  commandId?: string;
  /** The JetStream PubAck of the last publish: stored in the stream, execution still unproven. */
  receipt?: { stream: string; seq: number; duplicate: boolean };
  attempts: number;
  /** HOLOC-76: what Bloodbank's durable facts say happened after acceptance (a monotone projection). */
  evidence?: Evidence;
};
/** Stages proven by gateway facts; running is display-only (the outbox still says queued). */
export type EvidenceStage = "queued" | "running" | "answered" | "failed" | "uncertain";
export type Evidence = {
  /** Fact ids already judged (immutable facts are judged once). */
  seen: string[];
  stage?: EvidenceStage; factId?: string; errorCode?: string;
  /** The PM's final answer: kept privately in the review store and shown only in this review. */
  answer?: { factId: string; time?: string; body: string; nativeSessionId: string; nativeTurnId: string };
};
const EVIDENCE_RANK: Record<EvidenceStage, number> = { queued: 1, running: 2, uncertain: 3, failed: 3, answered: 4 };
export type Delivery = { state: SubmissionState; stateDetail: string; commandId?: string; receipt?: Submission["receipt"]; attempted?: boolean };
/** States a delivery update may never move back from: a late retry outcome cannot undo a receipt or an answer. */
const SETTLED: SubmissionState[] = ["published", "queued", "answered", "failed"];

export const defaultReviewDbPath = () => process.env.HOLOCENE_REVIEW_DB
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "holocene/reviews.sqlite3");

type Row = Record<string, unknown>;
const revisionOf = (r: Row): Revision => ({
  revisionId: String(r.revision_id), projectId: String(r.project_id), artifactId: String(r.artifact_id), title: String(r.title),
  entry: String(r.entry), sourceUrl: String(r.source_url), sourceModified: r.source_modified ? String(r.source_modified) : undefined,
  snapshotBaseUrl: String(r.snapshot_base_url), snapshotUrl: String(r.snapshot_url), entrySha256: String(r.entry_sha256),
  manifest: JSON.parse(String(r.manifest)) as ManifestEntry[], createdAt: String(r.created_at), createdBy: String(r.created_by)
});
const submissionOf = (r: Row): Submission => ({
  submissionId: String(r.submission_id), projectId: String(r.project_id), revisionId: String(r.revision_id), artifactId: String(r.artifact_id),
  author: String(r.author), recipient: String(r.recipient), note: String(r.note), annotations: JSON.parse(String(r.annotations)) as FrozenAnnotation[],
  digest: String(r.digest), correlationId: String(r.correlation_id), state: String(r.state) as SubmissionState, stateDetail: String(r.state_detail),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  commandId: r.command_id ? String(r.command_id) : undefined,
  receipt: r.receipt ? JSON.parse(String(r.receipt)) as Submission["receipt"] : undefined,
  attempts: Number(r.attempts ?? 0),
  evidence: r.evidence ? JSON.parse(String(r.evidence)) as Evidence : undefined
});
const annotationOf = (r: Row): Annotation => ({
  id: String(r.id), projectId: String(r.project_id), revisionId: String(r.revision_id), artifactId: String(r.artifact_id),
  author: String(r.author), status: r.status === "draft" ? "draft" : "saved", kind: r.kind === "element" ? "element" : "text",
  anchor: JSON.parse(String(r.anchor)), comment: String(r.comment), createdAt: String(r.created_at), updatedAt: String(r.updated_at), version: Number(r.version)
});

export class ReviewStore {
  readonly db: DatabaseSync;
  constructor(path = defaultReviewDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS revisions (
        revision_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, title TEXT NOT NULL,
        entry TEXT NOT NULL, source_url TEXT NOT NULL, source_modified TEXT, snapshot_base_url TEXT NOT NULL,
        snapshot_url TEXT NOT NULL, entry_sha256 TEXT NOT NULL, manifest TEXT NOT NULL,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
        artifact_id TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','saved')),
        kind TEXT NOT NULL CHECK(kind IN ('text','element')), anchor TEXT NOT NULL, comment TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS annotations_revision ON annotations(revision_id, created_at);
      CREATE TABLE IF NOT EXISTS submissions (
        submission_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
        artifact_id TEXT NOT NULL, author TEXT NOT NULL, recipient TEXT NOT NULL, note TEXT NOT NULL, annotations TEXT NOT NULL,
        digest TEXT NOT NULL, correlation_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('saved','queued','published','uncertain','answered','failed')), state_detail TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS submissions_revision ON submissions(revision_id, created_at);`);
    // HOLOC-70 delivery columns, added in place so rows saved before delivery existed keep their identity.
    const cols = new Set(this.db.prepare("PRAGMA table_info(submissions)").all().map((c) => String((c as Row).name)));
    for (const [name, decl] of [["command_id", "TEXT"], ["receipt", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["evidence", "TEXT"]] as const)
      if (!cols.has(name)) this.db.exec(`ALTER TABLE submissions ADD COLUMN ${name} ${decl}`);
  }
  close() { this.db.close(); }

  /** Insert-or-get by revision id. The id binds (project, artifact, manifest) (HOLOC-71), so identical bytes under one publication are one revision and a twin publication is its own; pre-HOLOC-71 rows keep their bare manifest-hash id. */
  putRevision(rev: Revision): { revision: Revision; created: boolean } {
    const existing = this.revision(rev.revisionId);
    if (existing) return { revision: existing, created: false };
    this.db.prepare(`INSERT INTO revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rev.revisionId, rev.projectId, rev.artifactId, rev.title, rev.entry, rev.sourceUrl, rev.sourceModified ?? null,
      rev.snapshotBaseUrl, rev.snapshotUrl, rev.entrySha256, JSON.stringify(rev.manifest), rev.createdAt, rev.createdBy);
    return { revision: rev, created: true };
  }
  revision(id: string): Revision | undefined {
    const row = this.db.prepare("SELECT * FROM revisions WHERE revision_id=?").get(id);
    return row ? revisionOf(row) : undefined;
  }
  revisions(projectId: string): Array<Revision & { saved: number; drafts: number }> {
    return this.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM annotations a WHERE a.revision_id=r.revision_id AND a.status='saved') AS saved,
      (SELECT COUNT(*) FROM annotations a WHERE a.revision_id=r.revision_id AND a.status='draft') AS drafts
      FROM revisions r WHERE project_id=? ORDER BY created_at DESC, revision_id`).all(projectId)
      .map((row) => ({ ...revisionOf(row), saved: Number(row.saved), drafts: Number(row.drafts) }));
  }

  annotations(revisionId: string): Annotation[] {
    return this.db.prepare("SELECT * FROM annotations WHERE revision_id=? ORDER BY created_at, id").all(revisionId).map(annotationOf);
  }
  annotation(id: string): Annotation | undefined {
    const row = this.db.prepare("SELECT * FROM annotations WHERE id=?").get(id);
    return row ? annotationOf(row) : undefined;
  }
  createAnnotation(input: Pick<Annotation, "revisionId" | "author" | "status" | "kind" | "anchor" | "comment"> & { id?: string }, now = new Date().toISOString()): Annotation {
    const rev = this.revision(input.revisionId);
    if (!rev) throw Error("Unknown revision");
    // A client-chosen id makes a retried create idempotent instead of a duplicate.
    const id = input.id ?? randomUUID();
    const prior = this.annotation(id);
    if (prior) {
      if (prior.revisionId !== input.revisionId || prior.author !== input.author) throw Error("Annotation id already used");
      return prior;
    }
    this.db.prepare("INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?,?,1)").run(
      id, rev.projectId, rev.revisionId, rev.artifactId, input.author, input.status, input.kind, JSON.stringify(input.anchor), input.comment, now, now);
    return this.annotation(id)!;
  }
  /** Optimistic concurrency: a stale `version` is refused rather than overwriting a newer save. The anchor never changes. */
  updateAnnotation(id: string, author: string, version: number, patch: { comment?: string; status?: AnnotationStatus }, now = new Date().toISOString()): Annotation | "missing" | "conflict" | "forbidden" {
    const prior = this.annotation(id);
    if (!prior) return "missing";
    if (prior.author !== author) return "forbidden";
    const res = this.db.prepare("UPDATE annotations SET comment=?, status=?, updated_at=?, version=version+1 WHERE id=? AND version=?").run(
      patch.comment ?? prior.comment, patch.status ?? prior.status, now, id, version);
    return Number(res.changes) ? this.annotation(id)! : "conflict";
  }
  deleteAnnotation(id: string, author: string, version: number): "deleted" | "missing" | "conflict" | "forbidden" {
    const prior = this.annotation(id);
    if (!prior) return "missing";
    if (prior.author !== author) return "forbidden";
    return Number(this.db.prepare("DELETE FROM annotations WHERE id=? AND version=?").run(id, version).changes) ? "deleted" : "conflict";
  }

  submissions(revisionId: string): Submission[] {
    return this.db.prepare("SELECT * FROM submissions WHERE revision_id=? ORDER BY created_at DESC, submission_id").all(revisionId).map(submissionOf);
  }
  submission(id: string): Submission | undefined {
    const row = this.db.prepare("SELECT * FROM submissions WHERE submission_id=?").get(id);
    return row ? submissionOf(row) : undefined;
  }
  /**
   * Create-or-get by the client's submission id: a double click or a retry after a lost answer returns
   * the same frozen submission. Reusing an id for other content, another author or revision is refused.
   */
  createSubmission(input: Omit<Submission, "createdAt" | "updatedAt" | "correlationId" | "state" | "stateDetail" | "commandId" | "receipt" | "attempts"> & { stateDetail: string }, now = new Date().toISOString()): { submission: Submission; created: boolean } {
    const prior = this.submission(input.submissionId);
    if (prior) {
      if (prior.author !== input.author || prior.revisionId !== input.revisionId || prior.digest !== input.digest || prior.note !== input.note) throw Error("Submission id already used for other feedback");
      return { submission: prior, created: false };
    }
    this.db.prepare(`INSERT INTO submissions (submission_id, project_id, revision_id, artifact_id, author, recipient, note, annotations,
      digest, correlation_id, state, state_detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.submissionId, input.projectId, input.revisionId, input.artifactId, input.author, input.recipient, input.note,
      JSON.stringify(input.annotations), input.digest, randomUUID(), "saved", input.stateDetail, now, now);
    return { submission: this.submission(input.submissionId)!, created: true };
  }

  /**
   * Record a delivery outcome. The frozen content is never touched. A settled state (a stream receipt, an answer, a
   * terminal failure) is never moved back by a late or retried outcome; a command id, once known, never changes.
   */
  recordDelivery(id: string, d: Delivery, now = new Date().toISOString()): Submission | undefined {
    const prior = this.submission(id);
    if (!prior) return;
    if (prior.commandId && d.commandId && prior.commandId !== d.commandId) throw Error("A submission's command id never changes");
    // Monotone: once Bloodbank stored the command, or its gateway left any fact, delivery outcomes no longer apply;
    // what happens next is the evidence projection's (recordEvidence).
    if (SETTLED.includes(prior.state) || prior.evidence?.stage) return prior;
    this.db.prepare(`UPDATE submissions SET state=?, state_detail=?, command_id=COALESCE(command_id, ?), receipt=COALESCE(?, receipt),
      attempts=attempts + ?, updated_at=? WHERE submission_id=?`).run(d.state, d.stateDetail, d.commandId ?? null,
      d.receipt ? JSON.stringify(d.receipt) : null, d.attempted ? 1 : 0, now, id);
    return this.submission(id);
  }

  /**
   * Record the evidence projection (HOLOC-76). Judged fact ids always accumulate; the stage, and the outbox state it
   * implies, move only to a higher rank, so a late queued or started fact never regresses an answer or a failure.
   */
  recordEvidence(id: string, e: Evidence, show?: { state: SubmissionState; stateDetail: string }, now = new Date().toISOString()): Submission | undefined {
    const prior = this.submission(id);
    if (!prior) return;
    const before = prior.evidence;
    const seen = [...new Set([...(before?.seen ?? []), ...e.seen])];
    const advances = !!e.stage && (!before?.stage || EVIDENCE_RANK[e.stage] > EVIDENCE_RANK[before.stage]);
    const next: Evidence = advances ? { ...e, seen } : { ...(before ?? {}), seen };
    if (advances && show) this.db.prepare("UPDATE submissions SET evidence=?, state=?, state_detail=?, updated_at=? WHERE submission_id=?")
      .run(JSON.stringify(next), show.state, show.stateDetail, now, id);
    else this.db.prepare("UPDATE submissions SET evidence=? WHERE submission_id=?").run(JSON.stringify(next), id);
    return this.submission(id);
  }
}

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Artifact } from "./artifacts.js";
import { HTML_LIMIT, wrapHtml } from "./artifact-documents.js";
import { lookupProject, type IdentityResult } from "./project-identity.js";
import { ReviewStore, type Annotation, type AnnotationStatus, type FrozenAnnotation, type ManifestEntry, type Revision } from "./review-store.js";
import type { RegistryProject } from "./project-identity.js";
import { bbEmitEvidence, candystoreFacts, projectable, projectSubmission, type EvidenceJudge, type FactSource } from "./review-evidence.js";
import { bbEmitFeedback, deliverSubmission, deliveryMode, submissionView, type DeliveryMode, type FeedbackEmitter } from "./review-delivery.js";

// HOLOC-70 local slice: the project home, preserved review revisions and durable annotations.
// No feedback is sent from here (BB-67 owns delivery); nothing in this module publishes events.

const BASE = "https://s3.delo.sh";
const exec = promisify(execFile);
// RFC 3986 strict, matching publish.py's urllib quote(): encodeURIComponent alone leaves !'()* bare.
const strict = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split("/").map(strict).join("/");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- request integrity

/** Domain-separated from the catalog's read signature, so neither can stand in for the other. */
const reviewKey = (secret: string) => createHmac("sha256", secret).update("holocene-reviews/v1").digest();
export function reviewSignature(secret: string, method: string, pathAndQuery: string, body: string, user: string, timestamp: string) {
  return createHmac("sha256", reviewKey(secret)).update([method.toUpperCase(), pathAndQuery, sha256(body), user, timestamp].join("\n")).digest("hex");
}
export const VALID_USER = /^[^\s@<>"]{1,128}@[^\s@<>"]{1,125}$/;
/** Every review route, read or write, is bound to method, path+query, body bytes, author and time. */
export function verifyReviewRequest(headers: Record<string, unknown>, method: string, pathAndQuery: string, body: string, secret: string | undefined, now = Date.now()): string | undefined {
  const sig = headers["x-review-signature"], ts = headers["x-review-timestamp"], user = headers["x-review-user"];
  if (!secret || typeof sig !== "string" || typeof ts !== "string" || typeof user !== "string") return;
  if (!/^\d{13}$/.test(ts) || Math.abs(now - Number(ts)) > 30000 || !HEX64.test(sig) || !VALID_USER.test(user)) return;
  const expected = Buffer.from(reviewSignature(secret, method, pathAndQuery, body, user, ts), "hex");
  return timingSafeEqual(Buffer.from(sig, "hex"), expected) ? user.toLowerCase() : undefined;
}

// ---------------------------------------------------------------- the home

type Catalog = (force?: boolean) => Promise<{ items: Artifact[]; sources: Record<string, { ok: boolean; stale: boolean; fetchedAt?: string }>; retryAfterMs: number }>;
const isHtml = (url: string) => /\.html?$/i.test(new URL(url).pathname);
const collectionOf = (item: Artifact) => item.collection ?? item.project ?? item.source;

export type RevisionView = Revision & { saved: number; drafts: number; latest: { state: "current" | "republished" | "missing"; modified?: string } };
export function homePayload(project: Extract<IdentityResult, { status: 200 }>["project"], snapshot: Awaited<ReturnType<Catalog>>, revisions: Array<Revision & { saved: number; drafts: number }>) {
  const mine = snapshot.items.filter((item) => item.source === "projects" && collectionOf(item) === project.id);
  const walkthroughs = mine.filter((item) => item.primary && isHtml(item.originalUrl))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id))
    .map((item) => ({ id: item.id, title: item.title, description: item.description, day: item.day, dayKind: item.dayKind, date: item.date, originalUrl: item.originalUrl, files: item.filenames.length, collection: collectionOf(item) }));
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const views: RevisionView[] = revisions.map((rev) => {
    const now = byId.get(rev.artifactId);
    const projectsOk = snapshot.sources.projects?.ok;
    // Latest vs reviewed: a changed modified time means the original was published again. Absent
    // from a healthy listing is "missing"; absent while the listing is down stays unknown (current).
    const latest: RevisionView["latest"] = !now ? { state: projectsOk ? "missing" : "current" }
      : now.date && rev.sourceModified && now.date !== rev.sourceModified ? { state: "republished", modified: now.date } : { state: "current", modified: now.date };
    return { ...rev, latest };
  });
  const unattributed = { share: snapshot.items.filter((i) => i.source === "share").length, video: snapshot.items.filter((i) => i.source === "r2").length };
  const sources = Object.fromEntries(Object.entries(snapshot.sources).map(([name, s]) => [name, { ok: s.ok, stale: s.stale, fetchedAt: s.fetchedAt }]));
  return { project, walkthroughs, otherArtifacts: mine.length - walkthroughs.length, revisions: views, unattributed, sources, complete: Object.values(snapshot.sources).every((s) => s.ok) };
}

// ---------------------------------------------------------------- capture

export const CAPTURE_LIMITS = { files: 400, bytes: 96 * 1024 * 1024 };
type Fetcher = typeof fetch;
type Publisher = (dir: string, project: string, name: string, entry: string) => Promise<string>;

async function readBytes(res: Response, cap: number): Promise<Uint8Array | undefined> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => undefined); return; }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export const manifestHash = (manifest: ManifestEntry[]) => sha256([...manifest].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((m) => `${m.path}\u0000${m.sha256}\n`).join(""));
/**
 * A revision is these bytes as a review of one publication: the id binds project, artifact and manifest, so two
 * catalog publications with byte-identical files (a twin at another path or day) are two reviews, never a collision.
 * Revisions preserved before HOLOC-71 keep their bare manifest-hash id; `captureRevision` still finds them.
 */
export const revisionKey = (projectId: string, artifactId: string, manifest: ManifestEntry[]) => sha256(`holocene-review/2\u0000${projectId}\u0000${artifactId}\u0000${manifestHash(manifest)}`);
const safeRel = (rel: string) => rel.length <= 1024 && !rel.split("/").some((p) => !p || p === "." || p === ".." || /[\x00-\x1f\\]/.test(p));

export const defaultPublisher: Publisher = async (dir, project, name, entry) => {
  const script = process.env.HOLOCENE_PUBLISH_PY ?? join(homedir(), ".agents/skills/artifacts/scripts/publish.py");
  const { stdout } = await exec("/usr/bin/python3", [script, dir, "--project", project, "--name", name, "--entry", entry, "--no-index"], { timeout: 600000, maxBuffer: 16 * 1024 * 1024, cwd: dir });
  const lines = stdout.trim().split("\n");
  const url = lines.at(-1) ?? "";
  const receipt = JSON.parse(lines.slice(0, -1).join("\n")) as { ok?: boolean; entry_url?: string; verified?: number };
  if (!receipt.ok || receipt.entry_url !== url) throw Error("Publisher receipt was not verified");
  return url;
};

export type CaptureResult = { status: 200 | 201; revision: Revision } | { status: 400 | 404 | 413 | 502; error: string };
/** Copy one publication's exact bytes into a hash-addressed review publication. */
export async function captureRevision(store: ReviewStore, projectId: string, item: Artifact | undefined, user: string, fetcher: Fetcher = fetch, publish: Publisher = defaultPublisher, now = () => new Date().toISOString()): Promise<CaptureResult> {
  if (!item || item.source !== "projects" || collectionOf(item) !== projectId || !item.primary) return { status: 404, error: "That publication is not in this project's catalog" };
  if (!item.baseUrl || !isHtml(item.originalUrl) || !item.originalUrl.startsWith(item.baseUrl)) return { status: 400, error: "Only an HTML publication can be reviewed" };
  const entry = decodeURIComponent(item.originalUrl.slice(item.baseUrl.length));
  const files = [...new Set([entry, ...item.filenames])];
  if (files.length > CAPTURE_LIMITS.files) return { status: 413, error: `The publication has ${files.length} files; a review holds at most ${CAPTURE_LIMITS.files}` };
  if (!files.every(safeRel)) return { status: 400, error: "The publication has an unsafe file name" };
  const dir = await mkdtemp(join(tmpdir(), "holocene-review-"));
  try {
    const manifest: ManifestEntry[] = [];
    let total = 0;
    for (const rel of files) {
      const res = await fetcher(item.baseUrl + encodeKey(rel), { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000), headers: { "user-agent": "holocene-reviews/1" } });
      if (!res.ok) { await res.body?.cancel(); return { status: 502, error: `${rel} answered HTTP ${res.status}` }; }
      const bytes = await readBytes(res, CAPTURE_LIMITS.bytes - total);
      if (!bytes) return { status: 413, error: `The publication is larger than ${CAPTURE_LIMITS.bytes / 1024 / 1024} MB` };
      total += bytes.byteLength;
      manifest.push({ path: rel, sha256: sha256(bytes), size: bytes.byteLength });
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), bytes);
    }
    manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const bound = (r: Revision | undefined) => r && r.projectId === projectId && r.artifactId === item.id ? r : undefined;
    const existing = bound(store.revision(manifestHash(manifest))) ?? bound(store.revision(revisionKey(projectId, item.id, manifest)));
    if (existing) return { status: 200, revision: existing };
    const revisionId = revisionKey(projectId, item.id, manifest);
    const name = `review-${revisionId.slice(0, 16)}`;
    let url: string;
    try { url = await publish(dir, projectId, name, entry); }
    catch { return { status: 502, error: "Publishing the review snapshot failed; nothing was recorded" }; }
    const prefix = `${BASE}/projects/${encodeURIComponent(projectId)}/`;
    const suffix = `/${name}/${encodeKey(entry)}`;
    if (!url.startsWith(prefix) || !url.endsWith(suffix) || !/^\d{4}-\d{2}-\d{2}$/.test(url.slice(prefix.length, url.length - suffix.length))) return { status: 502, error: "The publisher answered an unexpected snapshot address" };
    const rev: Revision = { revisionId, projectId, artifactId: item.id, title: item.title, entry, sourceUrl: item.originalUrl, sourceModified: item.date,
      snapshotBaseUrl: url.slice(0, url.length - encodeKey(entry).length), snapshotUrl: url, entrySha256: manifest.find((m) => m.path === entry)!.sha256,
      manifest, createdAt: now(), createdBy: user };
    const put = store.putRevision(rev);
    return { status: put.created ? 201 : 200, revision: put.revision };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The reviewed bytes, re-verified: a snapshot that changed under its address is refused, never shown. */
export async function revisionDocument(rev: Revision, fetcher: Fetcher = fetch) {
  const res = await fetcher(rev.snapshotUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "user-agent": "holocene-reviews/1" } });
  if (!res.ok) { await res.body?.cancel(); return { status: 502, body: { error: `Snapshot answered HTTP ${res.status}` } }; }
  const bytes = await readBytes(res, HTML_LIMIT);
  if (!bytes) return { status: 413, body: { error: "Too large to render inline" } };
  if (sha256(bytes) !== rev.entrySha256) return { status: 409, body: { error: "The snapshot no longer matches the reviewed bytes" } };
  const folder = rev.snapshotUrl.slice(0, rev.snapshotUrl.lastIndexOf("/") + 1);
  return { status: 200, body: { kind: "html", srcdoc: wrapHtml(new TextDecoder().decode(bytes), folder), entrySha256: rev.entrySha256, baseUrl: folder } };
}

// ---------------------------------------------------------------- annotations

const STATUSES: AnnotationStatus[] = ["draft", "saved"];
const ANCHOR_LIMIT = 32 * 1024;
const COMMENT_LIMIT = 10000;
type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export function parseNewAnnotation(body: unknown): { id?: string; status: AnnotationStatus; kind: "text" | "element"; anchor: unknown; comment: string } | undefined {
  if (!record(body)) return;
  const { id, status, kind, anchor, comment } = body;
  if (id !== undefined && (typeof id !== "string" || !UUID.test(id))) return;
  if (!STATUSES.includes(status as AnnotationStatus) || (kind !== "text" && kind !== "element") || typeof comment !== "string" || comment.length > COMMENT_LIMIT) return;
  if (!record(anchor) || JSON.stringify(anchor).length > ANCHOR_LIMIT) return;
  if (status === "saved" && !comment.trim()) return;
  return { id: id as string | undefined, status: status as AnnotationStatus, kind, anchor, comment };
}

// ---------------------------------------------------------------- feedback submissions (HOLOC-70 AC4, Holocene side)

/** Until Bloodbank accepts the feedback command contract (BB-67), a submission is saved and nothing is published. */
export const AWAITING_CONTRACT = "Saved and frozen. Delivery is off; nothing has been published.";
const NOTE_LIMIT = 4000;

export function parseSubmission(body: unknown): { submissionId: string; note: string } | undefined {
  if (!record(body)) return;
  const { submissionId, note } = body;
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) return;
  if (note !== undefined && (typeof note !== "string" || note.length > NOTE_LIMIT)) return;
  return { submissionId, note: typeof note === "string" ? note.trim() : "" };
}

/** The one recipient: the project's sole registry agent with role "pm". None or several is a refusal, never a guess. */
export function feedbackRecipient(project: Pick<RegistryProject, "id" | "pmAgents">): { recipient: string } | { error: string } {
  if (project.pmAgents.length === 1) return { recipient: project.pmAgents[0] };
  return { error: project.pmAgents.length ? `The registry lists ${project.pmAgents.length} PM agents for ${project.id} (${project.pmAgents.join(", ")}); feedback needs exactly one recipient` : `The registry lists no PM agent for ${project.id}, so feedback has no recipient` };
}

/** Saved annotations only (drafts never ship), frozen with their versions; the digest binds the submission to exactly this content. */
export function freezeFeedback(annotations: Annotation[], note: string): { annotations: FrozenAnnotation[]; digest: string } {
  const frozen = annotations.filter((a) => a.status === "saved").map(({ id, version, author, kind, anchor, comment, updatedAt }) => ({ id, version, author, kind, anchor, comment, updatedAt }));
  return { annotations: frozen, digest: sha256(JSON.stringify({ note, annotations: frozen.map((a) => [a.id, a.version]) })) };
}

// ---------------------------------------------------------------- routes

declare module "fastify" { interface FastifyRequest { rawBody?: string } }

export function registerReviewRoutes(app: FastifyInstance, catalog: Catalog, deps: { store?: ReviewStore; fetcher?: Fetcher; publish?: Publisher; registry?: () => Promise<unknown>; secret?: () => string | undefined; delivery?: { mode?: DeliveryMode; emit?: FeedbackEmitter }; evidence?: { facts?: FactSource; judge?: EvidenceJudge } } = {}) {
  const store = deps.store ?? new ReviewStore();
  const fetcher = deps.fetcher ?? fetch;
  const secret = deps.secret ?? (() => process.env.TELEGRAM_HQ_BOT_TOKEN);
  const mode = () => deps.delivery?.mode ?? deliveryMode();
  const emit = deps.delivery?.emit ?? bbEmitFeedback();
  const delivering = new Set<string>(); // one delivery per submission at a time: a double click never publishes twice
  const facts = deps.evidence?.facts ?? candystoreFacts();
  const judge = deps.evidence?.judge ?? bbEmitEvidence();
  const projecting = new Set<string>(); // one projection per submission at a time
  // HOLOC-76: reading the review folds any new gateway facts in. Read-only toward Bloodbank; no clock, no publish.
  const project = async (s: import("./review-store.js").Submission) => {
    if (!projectable(s) || projecting.has(s.submissionId) || delivering.has(s.submissionId)) return s;
    projecting.add(s.submissionId);
    try { return await projectSubmission(store, s, facts, judge); } catch { return s; } finally { projecting.delete(s.submissionId); }
  };
  return app.register(async (scope) => {
    // The signature covers the exact body bytes, so keep them; JSON is parsed from that same string.
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (req, body, done) => {
      req.rawBody = body as string;
      try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(Object.assign(Error("Invalid JSON"), { statusCode: 400 }), undefined); }
    });
    scope.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
    const author = (req: FastifyRequest) => verifyReviewRequest(req.headers as Record<string, unknown>, req.method, req.url, req.rawBody ?? "", secret());
    const identity = async (raw: string) => lookupProject(raw, deps.registry);
    type P = { Params: { project: string; revision?: string; id?: string }; Querystring: Record<string, string> };
    // Every route: signed author first, then the project identity, then the revision belongs to it.
    const guard = async (req: FastifyRequest<P>, reply: import("fastify").FastifyReply) => {
      const user = author(req);
      if (!user) { await reply.code(401).send({ error: "Unauthorized" }); return; }
      const raw = (req.raw.url ?? "").split("?")[0].split("/")[4] ?? "";
      const who = await identity(raw);
      if (who.status !== 200) { await reply.code(who.status).send({ error: who.error }); return; }
      let rev: Revision | undefined;
      if (req.params.revision !== undefined) {
        rev = HEX64.test(req.params.revision) ? store.revision(req.params.revision) : undefined;
        if (!rev || rev.projectId !== who.project.id) { await reply.code(404).send({ error: "No such revision in this project" }); return; }
      }
      return { user, project: who.project, rev };
    };

    scope.get<P>("/api/modules/projects/:project/home", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const snapshot = await catalog(req.query.refresh === "1");
      return homePayload(ok.project, snapshot, store.revisions(ok.project.id));
    });
    scope.post<P>("/api/modules/projects/:project/revisions", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const artifactId = record(req.body) ? req.body.artifactId : undefined;
      if (typeof artifactId !== "string" || !artifactId || artifactId.length > 2048) return reply.code(400).send({ error: "artifactId is required" });
      const item = (await catalog(false)).items.find((i) => i.id === artifactId);
      const result = await captureRevision(store, ok.project.id, item, ok.user, fetcher, deps.publish);
      return reply.code(result.status).send("error" in result ? { error: result.error } : { revision: result.revision });
    });
    scope.get<P>("/api/modules/projects/:project/revisions/:revision", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      return { project: ok.project, revision: ok.rev, annotations: store.annotations(ok.rev!.revisionId), viewer: ok.user };
    });
    scope.get<P>("/api/modules/projects/:project/revisions/:revision/document", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      try { const result = await revisionDocument(ok.rev!, fetcher); return reply.code(result.status).send(result.body); }
      catch { return reply.code(502).send({ error: "Snapshot unavailable" }); }
    });
    scope.post<P>("/api/modules/projects/:project/revisions/:revision/annotations", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const input = parseNewAnnotation(req.body);
      if (!input) return reply.code(400).send({ error: "Invalid annotation" });
      try { return reply.code(201).send({ annotation: store.createAnnotation({ ...input, id: input.id ?? randomUUID(), revisionId: ok.rev!.revisionId, author: ok.user }) }); }
      catch { return reply.code(409).send({ error: "That annotation id is already used" }); }
    });
    scope.patch<P>("/api/modules/projects/:project/revisions/:revision/annotations/:id", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const body = record(req.body) ? req.body : {};
      const version = body.version, comment = body.comment, status = body.status;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || (comment !== undefined && (typeof comment !== "string" || comment.length > COMMENT_LIMIT))
        || (status !== undefined && !STATUSES.includes(status as AnnotationStatus))) return reply.code(400).send({ error: "Invalid update" });
      const prior = store.annotation(req.params.id ?? "");
      if (!prior || prior.revisionId !== ok.rev!.revisionId) return reply.code(404).send({ error: "No such annotation" });
      if ((status ?? prior.status) === "saved" && !String(comment ?? prior.comment).trim()) return reply.code(400).send({ error: "A saved annotation needs a comment" });
      const result = store.updateAnnotation(prior.id, ok.user, version, { comment: comment as string | undefined, status: status as AnnotationStatus | undefined });
      if (result === "forbidden") return reply.code(403).send({ error: "Only the author can change this annotation" });
      if (result === "conflict") return reply.code(409).send({ error: "This annotation changed since you loaded it", annotation: store.annotation(prior.id) });
      if (result === "missing") return reply.code(404).send({ error: "No such annotation" });
      return { annotation: result };
    });
    scope.delete<P>("/api/modules/projects/:project/revisions/:revision/annotations/:id", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const version = Number(req.query.version);
      const prior = store.annotation(req.params.id ?? "");
      if (!prior || prior.revisionId !== ok.rev!.revisionId) return reply.code(404).send({ error: "No such annotation" });
      if (!Number.isSafeInteger(version)) return reply.code(400).send({ error: "version is required" });
      const result = store.deleteAnnotation(prior.id, ok.user, version);
      if (result === "forbidden") return reply.code(403).send({ error: "Only the author can delete this annotation" });
      if (result === "conflict") return reply.code(409).send({ error: "This annotation changed since you loaded it", annotation: store.annotation(prior.id) });
      return reply.code(204).send();
    });
    scope.get<P>("/api/modules/projects/:project/revisions/:revision/feedback", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const m = mode();
      // Reading never waits long on Bloodbank: past the budget the stored row is shown and the projection finishes
      // on its own (its result is stored, so the next read shows it).
      const budget = (s: import("./review-store.js").Submission) => Promise.race([project(s), new Promise<typeof s>((r) => setTimeout(() => r(store.submission(s.submissionId) ?? s), 2500).unref())]);
      const subs = await Promise.all(store.submissions(ok.rev!.revisionId).map(budget));
      return { delivery: m, submissions: subs.map((s) => submissionView(s, m)) };
    });
    // The explicit Send. It freezes the revision's saved feedback, its recipient and its identity; the row is the outbox.
    scope.post<P>("/api/modules/projects/:project/revisions/:revision/feedback", async (req, reply) => {
      const ok = await guard(req, reply); if (!ok) return;
      const input = parseSubmission(req.body);
      if (!input) return reply.code(400).send({ error: "Invalid submission" });
      const prior = store.submission(input.submissionId);
      if (prior) {
        if (prior.author !== ok.user || prior.revisionId !== ok.rev!.revisionId || prior.note !== input.note) return reply.code(409).send({ error: "That submission id is already used for other feedback" });
        // The same Send again (a double click, a lost answer, or Retry on an unconfirmed delivery): same row, same command.
        const m = mode();
        if (delivering.has(prior.submissionId)) return reply.code(202).send({ delivery: m, submission: { ...submissionView(prior, m), retryable: false } });
        delivering.add(prior.submissionId);
        try { return reply.code(200).send({ delivery: m, submission: submissionView(await deliverSubmission(store, prior, m, emit), m) }); }
        finally { delivering.delete(prior.submissionId); }
      }
      const to = feedbackRecipient(ok.project);
      if ("error" in to) return reply.code(409).send({ error: to.error });
      const frozen = freezeFeedback(store.annotations(ok.rev!.revisionId), input.note);
      if (!frozen.annotations.length) return reply.code(400).send({ error: "Nothing to send: this revision has no saved annotation" });
      let put: { submission: import("./review-store.js").Submission; created: boolean };
      try {
        put = store.createSubmission({ submissionId: input.submissionId, projectId: ok.project.id, revisionId: ok.rev!.revisionId, artifactId: ok.rev!.artifactId,
          author: ok.user, recipient: to.recipient, note: input.note, annotations: frozen.annotations, digest: frozen.digest, stateDetail: AWAITING_CONTRACT });
      } catch { return reply.code(409).send({ error: "That submission id is already used for other feedback" }); }
      // Saved first, then delivered: a failed or unconfirmed delivery never loses the frozen row.
      const m = mode();
      if (delivering.has(put.submission.submissionId)) return reply.code(202).send({ delivery: m, submission: { ...submissionView(put.submission, m), retryable: false } });
      delivering.add(put.submission.submissionId);
      try { return reply.code(put.created ? 201 : 200).send({ delivery: m, submission: submissionView(await deliverSubmission(store, put.submission, m, emit), m) }); }
      finally { delivering.delete(put.submission.submissionId); }
    });
  });
}

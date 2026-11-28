// HOLOC-70 project home + review: the pure half (links, labels, save state), tested without a DOM.
import { deepLink } from "../artifacts/navigator-model";

export type Walkthrough = { id: string; title: string; description?: string; day?: string; dayKind?: string; date?: string; originalUrl: string; files: number; collection: string };
export type RevisionView = {
  revisionId: string; projectId: string; artifactId: string; title: string; entry: string; sourceUrl: string; sourceModified?: string;
  snapshotUrl: string; entrySha256: string; createdAt: string; createdBy: string; saved: number; drafts: number;
  latest: { state: "current" | "republished" | "missing"; modified?: string };
};
export type Project = { id: string; name: string; repoPath: string; board?: string; status?: string; pmAgents?: string[] };
export type HomePayload = { project: Project; walkthroughs: Walkthrough[]; otherArtifacts: number; revisions: RevisionView[]; unattributed: { share: number; video: number }; sources: Record<string, { ok: boolean; stale: boolean; fetchedAt?: string }>; complete: boolean };
export type Annotation = { id: string; revisionId: string; author: string; status: "draft" | "saved"; kind: "text" | "element"; anchor: Record<string, unknown>; comment: string; createdAt: string; updatedAt: string; version: number };

/** The agreed contract: one path segment, encoded once (PJAN-234 builds the same URL). */
export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const reviewHref = (id: string, revision: string) => `${projectHref(id)}/review/${revision}`;
export const apiBase = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
export const shortHash = (hex: string) => hex.slice(0, 12);

export const galleryLink = (w: Walkthrough) => deepLink({ project: w.collection, day: w.day ?? "undated", artifact: w.id });

/** What the identity statuses mean to the operator; never "unknown" for a project that is merely unreachable. */
export function identityMessage(status: number, id: string, detail?: string): string {
  if (status === 400) return `Malformed project id. ${detail ?? ""}`.trim();
  if (status === 404) return `No PJangler project has the id “${id}”. Project ids are canonical lowercase; repository names and board keys are not aliases.`;
  if (status === 409) return `The project identity “${id}” is conflicting in the PJangler registry. ${detail ?? ""}`.trim();
  if (status === 503) return "The project registry is unavailable, so this project cannot be resolved right now.";
  if (status === 401) return "Sign in to Holocene to open this project.";
  return detail ?? `The project home is unavailable (HTTP ${status}).`;
}

export function latestLabel(rev: Pick<RevisionView, "latest">): string {
  if (rev.latest.state === "republished") return "Published again since this review";
  if (rev.latest.state === "missing") return "Original no longer in the catalog";
  return "Matches the latest publication";
}

/** Revisions captured from one walkthrough, newest first. */
export const revisionsOf = (home: Pick<HomePayload, "revisions">, artifactId: string) => home.revisions.filter((r) => r.artifactId === artifactId);

export type SaveState = { state: "idle" | "saving" | "saved" | "failed" | "conflict"; error?: string };
/** A failed save is visible and keeps the text; nothing downstream may treat it as saved. */
export function saveOutcome(status: number, body: { error?: string }): SaveState {
  if (status >= 200 && status < 300) return { state: "saved" };
  if (status === 409) return { state: "conflict", error: body.error ?? "Changed elsewhere; reload to see the latest." };
  return { state: "failed", error: body.error ?? (status === 0 ? "Network error" : `HTTP ${status}`) };
}

/** A short human label for an anchor, from Plannotator's persisted anchor or a text quote. */
export function anchorLabel(anchor: Record<string, unknown>): string {
  const pick = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
  const quote = pick(anchor.originalText) ?? pick(anchor.quote) ?? pick(anchor.text);
  if (quote) return `“${quote.length > 120 ? `${quote.slice(0, 117)}…` : quote}”`;
  const el = pick(anchor.elementLabel) ?? pick(anchor.tagName) ?? pick(anchor.selector);
  return el ? `Element ${el}` : "Pinned element";
}

// ---------------------------------------------------------------- the annotation bridge (Plannotator protocol 2)
// Every message from the frame is page-controlled data: shape-checked and bounded here before the view reads it.

export const BRIDGE_PREFIX = "plannotator-bridge-";
export const BRIDGE_VERSION = 2;
const MAX_TEXT = 10000;
const MAX_IDS = 1000;
export type BridgeIn =
  | { type: "ready"; protocolVersion: number }
  | { type: "selection"; text: string; anchor?: Record<string, unknown>; pinpoint: boolean; context?: Record<string, unknown> }
  | { type: "selection-clear" }
  | { type: "mark-click"; id: string }
  | { type: "unanchored"; ids: string[] }
  | { type: "resize"; height: number };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

export function readBridge(data: unknown): BridgeIn | undefined {
  if (!plain(data) || typeof data.type !== "string" || !data.type.startsWith(BRIDGE_PREFIX)) return;
  const type = data.type.slice(BRIDGE_PREFIX.length);
  if (type === "ready") return typeof data.protocolVersion === "number" ? { type, protocolVersion: data.protocolVersion } : undefined;
  if (type === "selection") {
    if (typeof data.text !== "string") return;
    return { type, text: data.text.slice(0, MAX_TEXT), pinpoint: data.pinpoint === true, anchor: plain(data.anchor) ? data.anchor : undefined, context: plain(data.context) ? data.context : undefined };
  }
  if (type === "selection-clear") return { type };
  if (type === "mark-click") return id(data.id) ? { type, id: data.id } : undefined;
  if (type === "unanchored") return Array.isArray(data.ids) ? { type, ids: data.ids.filter(id).slice(0, MAX_IDS) } : undefined;
  if (type === "resize") return typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0 ? { type, height: Math.min(data.height, 200000) } : undefined;
}

/** Comment numbers: saved annotations in creation order, 1-based; drafts are unnumbered. */
export function numbering(annotations: Pick<Annotation, "id" | "status" | "createdAt">[]): Map<string, number> {
  const saved = annotations.filter((a) => a.status === "saved").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(saved.map((a, i) => [a.id, i + 1]));
}

/** The host's restore batch for a freshly loaded frame: re-find every stored anchor, then ask for the unanchored set. */
export function restoreMessages(annotations: Annotation[]): Record<string, unknown>[] {
  const numbers = numbering(annotations);
  return [
    { type: `${BRIDGE_PREFIX}clear-marks` },
    { type: `${BRIDGE_PREFIX}sync-annotations`, annotations: [...numbers].map(([id, number]) => ({ id, number })) },
    ...annotations.map((a) => ({
      type: `${BRIDGE_PREFIX}find-and-mark`, id: a.id, annotationType: "comment", structural: true,
      originalText: typeof a.anchor.originalText === "string" ? a.anchor.originalText : "",
      anchor: plain(a.anchor.htmlAnchor) ? a.anchor.htmlAnchor : undefined,
      additionalAnchors: Array.isArray(a.anchor.htmlAdditionalTargets) ? a.anchor.htmlAdditionalTargets : undefined
    })),
    { type: `${BRIDGE_PREFIX}report-unanchored` }
  ];
}

/** The bridge runs inside the preserved page; it goes after our CSP and referrer metas so the page's own CSP never governs it first. */
export function injectBridge(srcdoc: string, css: string, script: string): string {
  const tag = `<style data-holocene-review>${css}</style><script data-holocene-review>${script}</script>`;
  const marker = `<meta name="referrer" content="no-referrer">`;
  const at = srcdoc.indexOf(marker);
  return at < 0 ? tag + srcdoc : srcdoc.slice(0, at + marker.length) + tag + srcdoc.slice(at + marker.length);
}

// ---------------------------------------------------------------- feedback submissions (the explicit Send)

export type SubmissionState = "saved" | "queued" | "published" | "uncertain" | "answered" | "failed";
export type Submission = {
  submissionId: string; projectId: string; revisionId: string; author: string; recipient: string; note: string;
  annotations: Pick<Annotation, "id" | "version" | "comment" | "anchor">[]; digest: string; correlationId: string;
  state: SubmissionState; stateDetail: string; createdAt: string; updatedAt: string;
  /** Bloodbank's deterministic command id, once its contract has validated the row. */
  commandId?: string | null; receipt?: { stream: string; seq: number; duplicate: boolean } | null; attempts?: number;
  /** The server's answer to "would Retry act now?" under its delivery mode (HOLOC-75); never derived here. */
  retryable?: boolean;
  /** HOLOC-76: what Bloodbank's gateway facts proved after acceptance; running is display-only. */
  evidence?: { stage: "queued" | "running" | "answered" | "failed" | "uncertain"; errorCode?: string; answer?: { factId: string; time?: string; body: string } };
};
/** The API's delivery mode: off saves only, check validates and publishes nothing, live publishes. */
export type DeliveryMode = "off" | "check" | "live";

/** Plain words for each state; "saved" never claims delivery. */
export function submissionLabel(s: Pick<Submission, "state" | "commandId" | "evidence">): string {
  if (s.state === "saved" && s.commandId) return "Validated, not sent";
  if (s.evidence?.stage === "running") return "Running";
  if (s.state === "uncertain" && s.evidence?.stage === "uncertain") return "Execution uncertain";
  return { saved: "Saved, not sent", queued: "Queued for the PM", published: "Sent, awaiting the PM", uncertain: "Delivery uncertain", answered: "Answered", failed: "Delivery failed" }[s.state] ?? s.state;
}

/**
 * Retry is offered only where the server says a Send would act now (HOLOC-75): the API applies the same rule it
 * delivers by, so the rail never shows a control that does nothing. A retry sends the same submission id, so
 * Bloodbank derives the same command; it can never make a second one.
 */
export const canRetry = (s: Pick<Submission, "retryable">) => s.retryable === true;

/** Why an unfinished row has no Retry, in plain words; undefined where nothing needs saying. */
export function retryHint(s: Pick<Submission, "state" | "retryable" | "evidence">, mode?: DeliveryMode): string | undefined {
  // A gateway closure explains itself in the row's detail: the owner decides, there is no Retry to wait for.
  if (s.retryable || s.evidence?.stage || !(s.state === "uncertain" || s.state === "saved")) return;
  if (mode === "off") return "Delivery is turned off, so Retry is unavailable.";
  if (s.state === "uncertain") return "Retry waits until delivery is live (BB-67). This earlier attempt may already be stored, so nothing is re-sent before then.";
}

/** Who Send would reach, or why it cannot: exactly one registry PM. */
export function sendTarget(project: Pick<Project, "id" | "pmAgents">): { recipient: string } | { blocked: string } {
  const pms = project.pmAgents ?? [];
  if (pms.length === 1) return { recipient: pms[0] };
  return { blocked: pms.length ? `${project.id} lists ${pms.length} PM agents; feedback needs exactly one` : `${project.id} has no PM agent in the registry` };
}

// HOLOC-70 explicit Send, delivery half: the frozen submission row goes to Bloodbank's feedback adapter
// (`bb-emit --feedback-submission`, BB-67 contract: bloodbank docs/review-feedback.md). Holocene publishes this one
// command only on the operator's Send click; it never builds the envelope itself and never rewrites the row.
import { execFile } from "node:child_process";
import type { ReviewStore, Submission } from "./review-store.js";

export const FEEDBACK_TYPE = "bloodbank.review.feedback.send";
const DEFAULT_BB_EMIT = "/home/delorenj/.local/bin/bb-emit";

/**
 * off: save only. check: validate every Send against Bloodbank's contract, publish nothing. live: validate, then
 * publish and require the JetStream receipt. Live waits until Bloodbank has installed the adapter and enabled the
 * feedback durable (BB-67); flipping it is a config change, not a code change.
 */
export type DeliveryMode = "off" | "check" | "live";
export const deliveryMode = (raw = process.env.HOLOCENE_FEEDBACK_DELIVERY): DeliveryMode => raw === "live" || raw === "off" ? raw : "check";

/** The command's wire row: the frozen fields plus createdAt. Mutable delivery fields never go on the wire. */
export function wireRow(s: Submission) {
  const { submissionId, projectId, revisionId, artifactId, author, recipient, note, annotations, digest, correlationId, createdAt } = s;
  return { submissionId, projectId, revisionId, artifactId, author, recipient, note, annotations, digest, correlationId, createdAt };
}

export type EmitOutcome =
  | { ok: true; commandId: string; receipt?: { stream: string; seq: number; duplicate: boolean } }
  | { ok: false; kind: "refused" | "unavailable" | "unconfirmed"; detail: string };
export type FeedbackEmitter = (row: ReturnType<typeof wireRow>, check: boolean) => Promise<EmitOutcome>;

/** bb-emit, argv only and the row on stdin. Its exit codes do not separate refusal from an unconfirmed publish; its stderr does. */
export function bbEmitFeedback(executable = process.env.BB_EMIT_EXECUTABLE ?? DEFAULT_BB_EMIT, timeoutMs = 20_000): FeedbackEmitter {
  return (row, check) => new Promise((resolve) => {
    const args = ["--type", FEEDBACK_TYPE, "--feedback-submission", ...(check ? ["--check"] : [])];
    const child = execFile(executable, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const said = String(stderr).split("\n").map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 300);
      const line = String(stdout).split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
      if (!err && line) {
        try {
          const out = JSON.parse(line) as { command_id?: unknown; stream?: unknown; seq?: unknown; duplicate?: unknown };
          if (typeof out.command_id !== "string") throw Error("no command id");
          if (check) return resolve({ ok: true, commandId: out.command_id });
          if (out.stream === "BLOODBANK_COMMANDS" && Number.isInteger(out.seq) && Number(out.seq) > 0)
            return resolve({ ok: true, commandId: out.command_id, receipt: { stream: out.stream, seq: Number(out.seq), duplicate: out.duplicate === true } });
        } catch { /* fall through: an unreadable answer is not a receipt */ }
        return resolve(check ? { ok: false, kind: "unavailable", detail: "bb-emit answered without a command id" } : { ok: false, kind: "unconfirmed", detail: "bb-emit answered without a JetStream receipt" });
      }
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e?.code === "ENOENT") return resolve({ ok: false, kind: "unavailable", detail: "bb-emit is not installed" });
      if (/feedback validation failed/.test(said)) return resolve({ ok: false, kind: "refused", detail: said });
      if (/unrecognized arguments|feedback requires|validation unavailable/.test(said)) return resolve({ ok: false, kind: "unavailable", detail: said || "the installed bb-emit has no feedback adapter" });
      // A timeout or a failure after the publish began may already have been accepted: never "not sent".
      if (!check) return resolve({ ok: false, kind: "unconfirmed", detail: e?.killed ? "bb-emit timed out waiting for the JetStream receipt" : said || "bb-emit failed" });
      return resolve({ ok: false, kind: "unavailable", detail: e?.killed ? "bb-emit timed out validating" : said || "bb-emit failed" });
    });
    child.stdin?.end(JSON.stringify(row));
  });
}

const short = (id?: string) => id ? id.slice(0, 8) : "";

/**
 * Deliver one submission under the mode. Validation always runs first; a refusal keeps the row and says why.
 * Only `saved` and `uncertain` rows are (re)delivered: a retry sends the same row, so Bloodbank derives the same
 * command and refuses changed bytes under it. Never called except from the operator's Send (or its explicit retry).
 */
export async function deliverSubmission(store: ReviewStore, sub: Submission, mode: DeliveryMode, emit: FeedbackEmitter): Promise<Submission> {
  if (mode === "off" || !(sub.state === "saved" || sub.state === "uncertain")) return sub;
  const row = wireRow(sub);
  const checked = await emit(row, true);
  if (!checked.ok) {
    const why = checked.kind === "refused"
      ? `Not sent: Bloodbank's feedback contract refused this submission (${checked.detail}). It is kept unchanged.`
      : `Not sent: delivery is unavailable (${checked.detail}). It is kept unchanged.`;
    return store.recordDelivery(sub.submissionId, { state: sub.state, stateDetail: why }) ?? sub;
  }
  if (mode === "check")
    return store.recordDelivery(sub.submissionId, { state: "saved", commandId: checked.commandId,
      stateDetail: `Validated against Bloodbank's feedback contract as command ${short(checked.commandId)}. Delivery is not enabled yet (BB-67); nothing has been published.` }) ?? sub;
  const sent = await emit(row, false);
  if (sent.ok && sent.receipt)
    return store.recordDelivery(sub.submissionId, { state: "published", commandId: sent.commandId, receipt: sent.receipt, attempted: true,
      stateDetail: `In Bloodbank's command stream (${sent.receipt.stream} #${sent.receipt.seq}${sent.receipt.duplicate ? ", already stored" : ""}). The PM has not answered yet.` }) ?? sub;
  const detail = sent.ok ? "no JetStream receipt" : sent.detail;
  return store.recordDelivery(sub.submissionId, { state: "uncertain", commandId: checked.commandId, attempted: true,
    stateDetail: `Delivery unconfirmed (${detail}). It may already be stored; Retry sends the same command ${short(checked.commandId)}, never a second one.` }) ?? sub;
}

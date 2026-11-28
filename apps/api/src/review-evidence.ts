// HOLOC-76 (HOLOC-70 AC5, Holocene half): what happened to a Send after Bloodbank accepted it, read only from durable
// Candystore facts and judged only by Bloodbank's own evidence join (BB-70, `bb-emit --feedback-evidence`). Holocene
// never copies that join, never guesses a session, and never publishes from here: this runs when the operator reads
// the review, folds the facts into a monotone projection, and stores it.
import { execFile } from "node:child_process";
import { candystoreBaseUrl } from "./candystore-url.js";
import { FEEDBACK_TYPE, wireRow } from "./review-delivery.js";
import type { Evidence, EvidenceStage, ReviewStore, Submission } from "./review-store.js";

/** One raw CloudEvent envelope as Candystore stores it (`/events/<id>/raw`). */
export type Fact = { id: string; type: string; time?: string; data?: Record<string, unknown>; [k: string]: unknown };
export type FactSource = (correlationId: string, since: string) => Promise<{ ok: true; facts: Fact[] } | { ok: false; detail: string }>;
export type Judgement = { ok: true; state: EvidenceStage | null; errorCode?: string } | { ok: false; detail: string };
export type EvidenceJudge = (row: ReturnType<typeof wireRow>, fact: Fact, profile: string) => Promise<Judgement>;

/** Later evidence wins; equal rank never replaces (one command has one terminal fact). running is display-only. */
export const STAGE_RANK: Record<EvidenceStage, number> = { queued: 1, running: 2, uncertain: 3, failed: 3, answered: 4 };

/** Rows whose fate Bloodbank may have recorded: accepted or possibly accepted, and not yet answered or failed. */
export const projectable = (s: Pick<Submission, "state" | "commandId">) =>
  !!s.commandId && (s.state === "published" || s.state === "queued" || s.state === "uncertain");

const MAX_FACTS = 200;

/** Candystore by correlation id, then each fact's raw envelope: the join needs every envelope field. */
export function candystoreFacts(base = candystoreBaseUrl(), fetcher: typeof fetch = fetch, timeoutMs = 5000): FactSource {
  return async (correlationId, since) => {
    try {
      const url = `${base}/events?correlationid=${encodeURIComponent(correlationId)}&from=${encodeURIComponent(since)}&limit=${MAX_FACTS}`;
      const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, detail: `Candystore answered HTTP ${res.status}` };
      const body = await res.json() as { events?: Array<{ id?: unknown }>; rows?: Array<{ id?: unknown }> };
      const ids = (body.events ?? body.rows ?? []).map((e) => e.id).filter((id): id is string => typeof id === "string");
      const facts: Fact[] = [];
      for (const id of ids) {
        const raw = await fetcher(`${base}/events/${encodeURIComponent(id)}/raw`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!raw.ok) return { ok: false, detail: `Candystore raw fact ${id} answered HTTP ${raw.status}` };
        const fact = await raw.json() as Fact;
        if (fact && typeof fact.id === "string" && typeof fact.type === "string") facts.push(fact);
      }
      return { ok: true, facts };
    } catch (e) {
      return { ok: false, detail: `Candystore is unreachable (${e instanceof Error ? e.name : "error"})` };
    }
  };
}

/** Bloodbank's join through the installed adapter (BB-70). Never publishes: the evidence path has no broker I/O. */
export function bbEmitEvidence(executable = process.env.BB_EMIT_EXECUTABLE ?? "/home/delorenj/.local/bin/bb-emit", timeoutMs = 10_000): EvidenceJudge {
  return (row, fact, profile) => new Promise((resolve) => {
    const child = execFile(executable, ["--type", FEEDBACK_TYPE, "--feedback-evidence"], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const said = String(stderr).split("\n").map((l) => l.trim()).filter(Boolean).join(" ").slice(-300);
      if (err) return resolve({ ok: false, detail: /unrecognized arguments/.test(said) ? "the installed bb-emit has no evidence join yet (BB-70)" : said || "bb-emit failed" });
      try {
        const line = String(stdout).split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
        const out = JSON.parse(line ?? "") as { state?: unknown; error_code?: unknown; fact_id?: unknown };
        const state = out.state === null ? null : typeof out.state === "string" && out.state in STAGE_RANK ? out.state as EvidenceStage : undefined;
        if (state === undefined || (out.fact_id !== undefined && out.fact_id !== fact.id)) return resolve({ ok: false, detail: "bb-emit answered with an unreadable judgement" });
        resolve({ ok: true, state, errorCode: typeof out.error_code === "string" ? out.error_code : undefined });
      } catch { resolve({ ok: false, detail: "bb-emit answered with an unreadable judgement" }); }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify({ row, event: fact, profile }));
  });
}

const DETAIL: Record<EvidenceStage, (s: Submission, e: Evidence) => string> = {
  queued: (s) => `Bloodbank's gateway queued it for ${s.recipient}. No answer yet.`,
  running: (s) => `${s.recipient} is working on it. No answer yet.`,
  answered: (s) => `Answered by ${s.recipient}.`,
  failed: (s, e) => `Not answered: the gateway closed it as failed (${e.errorCode ?? "no reason given"}). Send it again only after you decide what to change.`,
  uncertain: (s, e) => `Execution uncertain (${e.errorCode ?? "unknown"}): the gateway cannot tell whether ${s.recipient} ran. Reconcile it by hand; it is never re-sent automatically.`
};
/** The outbox state each stage shows; running is still queued in the outbox. */
const STATE = { queued: "queued", running: "queued", answered: "answered", failed: "failed", uncertain: "uncertain" } as const;

/**
 * Fold any new facts for one submission. Facts already judged are skipped (they are immutable); an unavailable
 * source or judge changes nothing. Out-of-order facts are fine: only a higher-ranked stage is recorded.
 */
export async function projectSubmission(store: ReviewStore, sub: Submission, facts: FactSource, judge: EvidenceJudge): Promise<Submission> {
  if (!projectable(sub)) return sub;
  const got = await facts(sub.correlationId, sub.createdAt);
  if (!got.ok) return sub;
  const prior = sub.evidence ?? { seen: [] };
  const seen = new Set(prior.seen);
  let best: Evidence = { ...prior, seen: [...prior.seen] };
  const row = wireRow(sub);
  for (const fact of got.facts) {
    if (seen.has(fact.id)) continue;
    const j = await judge(row, fact, sub.recipient);
    if (!j.ok) break; // the join is unavailable: keep what is known, judge the rest next time
    seen.add(fact.id); best.seen.push(fact.id);
    if (!j.state || (best.stage && STAGE_RANK[j.state] <= STAGE_RANK[best.stage])) continue;
    best = { ...best, stage: j.state, factId: fact.id, errorCode: j.errorCode };
    if (j.state === "answered") {
      const d = fact.data ?? {};
      best.answer = { factId: fact.id, time: typeof fact.time === "string" ? fact.time : undefined, body: String(d.text ?? ""),
        nativeSessionId: String(d.native_session_id ?? ""), nativeTurnId: String(d.native_turn_id ?? "") };
    }
  }
  if (best.seen.length === prior.seen.length) return sub;
  const stage = best.stage;
  return store.recordEvidence(sub.submissionId, best, stage ? { state: STATE[stage], stateDetail: DETAIL[stage](sub, best) } : undefined) ?? sub;
}

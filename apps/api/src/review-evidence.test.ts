import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { retryOffered, wireRow } from "./review-delivery.js";
import { bbEmitEvidence, candystoreFacts, projectSubmission, type EvidenceJudge, type Fact, type FactSource } from "./review-evidence.js";
import { ReviewStore, type EvidenceStage } from "./review-store.js";
import { registerReviewRoutes, reviewSignature } from "./reviews.js";

const REV = "d".repeat(64);
function published(store = new ReviewStore(":memory:")) {
  store.putRevision({ revisionId: REV, projectId: "greeninbetween", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "x", entrySha256: "0".repeat(64), manifest: [], createdAt: "now", createdBy: "op@example.com" });
  const s = store.createSubmission({ submissionId: "44444444-4444-4444-8444-444444444444", projectId: "greeninbetween", revisionId: REV, artifactId: "a", author: "op@example.com", recipient: "green-in-between-pm", note: "n",
    annotations: [{ id: "x", version: 1, author: "op@example.com", kind: "text", anchor: { quote: "q" }, comment: "c", updatedAt: "2026-11-28T00:00:00Z" }], digest: "d", stateDetail: "saved" }).submission;
  store.recordDelivery(s.submissionId, { state: "uncertain", stateDetail: "publishing", commandId: "cmd", attempted: true });
  return { store, sub: store.recordDelivery(s.submissionId, { state: "published", stateDetail: "in stream", receipt: { stream: "BLOODBANK_COMMANDS", seq: 1, duplicate: false } })! };
}
const fact = (id: string, type = "bloodbank.agent.invocation.queued", data: Record<string, unknown> = {}): Fact => ({ id, type, time: "2026-11-28T14:00:00Z", data });
const source = (...facts: Fact[]): FactSource & { calls: number } => { const f = Object.assign(async () => { f.calls++; return { ok: true as const, facts }; }, { calls: 0 }); return f; };
/** Bloodbank's join, faked: a verdict per fact id (absent = not evidence for this submission). */
const judging = (verdicts: Record<string, { state: EvidenceStage; errorCode?: string }>) => {
  const seen: string[] = [];
  const judge: EvidenceJudge = async (_row, f) => { seen.push(f.id); const v = verdicts[f.id]; return { ok: true, state: v?.state ?? null, errorCode: v?.errorCode }; };
  return Object.assign(judge, { seen });
};

test("out-of-order facts fold to the highest stage; the answer is kept; a late queued fact never regresses it", async () => {
  const { store, sub } = published();
  const answer = fact("f-answer", "bloodbank.conversation.message.appended", { text: "Fixed the header; see rev 2.", native_session_id: "sess", native_turn_id: "turn" });
  const judge = judging({ "f-answer": { state: "answered" }, "f-started": { state: "running" }, "f-queued": { state: "queued" } });
  const a = await projectSubmission(store, sub, source(answer, fact("f-started", "bloodbank.agent.invocation.started"), fact("f-spoof")), judge);
  assert.equal(a.state, "answered");
  assert.deepEqual(a.evidence!.answer, { factId: "f-answer", time: "2026-11-28T14:00:00Z", body: "Fixed the header; see rev 2.", nativeSessionId: "sess", nativeTurnId: "turn" });
  assert.match(a.stateDetail, /Answered by green-in-between-pm/);
  // Answered is final for the projection, so it is no longer read; even a forced late fact cannot regress it.
  const late = store.recordEvidence(sub.submissionId, { seen: ["f-queued"], stage: "queued" }, { state: "queued", stateDetail: "late" })!;
  assert.equal(late.state, "answered");
  assert.equal(late.evidence!.answer!.body, "Fixed the header; see rev 2.");
  assert.deepEqual(late.evidence!.seen.sort(), ["f-answer", "f-queued", "f-spoof", "f-started"]);
});

test("queued then running then answered across reads; judged facts are never judged twice", async () => {
  const { store, sub } = published();
  const judge = judging({ q: { state: "queued" }, r: { state: "running" }, ans: { state: "answered" } });
  const q = await projectSubmission(store, sub, source(fact("q")), judge);
  assert.equal(q.state, "queued");
  const r = await projectSubmission(store, q, source(fact("q"), fact("r", "bloodbank.agent.invocation.started")), judge);
  assert.equal(r.state, "queued", "running is display-only; the outbox still says queued");
  assert.equal(r.evidence!.stage, "running");
  assert.match(r.stateDetail, /working on it/);
  const done = await projectSubmission(store, r, source(fact("q"), fact("r"), fact("ans", "bloodbank.conversation.message.appended", { text: "ok", native_session_id: "s", native_turn_id: "t" })), judge);
  assert.equal(done.state, "answered");
  assert.deepEqual(judge.seen, ["q", "r", "ans"]);
});

test("terminal failures: failed and execution-uncertain both hide Retry and ignore later delivery outcomes", async () => {
  for (const [code, state] of [["timeout", "failed"], ["feedback_execution_uncertain", "uncertain"]] as const) {
    const { store, sub } = published();
    const f = await projectSubmission(store, sub, source(fact("fail", "bloodbank.agent.invocation.failed", { error_code: code })), judging({ fail: { state, errorCode: code } }));
    assert.equal(f.state, state);
    assert.equal(f.evidence!.errorCode, code);
    assert.ok(!retryOffered(f, "live"), `${state}: an owner decides, never an automatic or one-click replay`);
    assert.equal(store.recordDelivery(f.submissionId, { state: "uncertain", stateDetail: "retry" })!.state, state);
    assert.match(f.stateDetail, state === "failed" ? /closed it as failed \(timeout\)/ : /never re-sent automatically/);
  }
});

test("an answer after an execution-uncertain closure still wins; nothing ranks with or above it after", async () => {
  const { store, sub } = published();
  const u = await projectSubmission(store, sub, source(fact("u")), judging({ u: { state: "uncertain", errorCode: "processing_outcome_unknown" } }));
  assert.equal(u.state, "uncertain");
  const a = await projectSubmission(store, u, source(fact("u"), fact("a")), judging({ a: { state: "answered" } }));
  assert.equal(a.state, "answered");
});

test("unavailable source or join, unrelated facts, and rows Bloodbank never accepted change nothing", async () => {
  const { store, sub } = published();
  const down: FactSource = async () => ({ ok: false, detail: "Candystore is unreachable" });
  assert.deepEqual(await projectSubmission(store, sub, down, judging({})), sub);
  const noJoin: EvidenceJudge = async () => ({ ok: false, detail: "the installed bb-emit has no evidence join yet (BB-70)" });
  const same = await projectSubmission(store, sub, source(fact("q")), noJoin);
  assert.equal(same.state, "published");
  assert.equal(same.evidence, undefined, "an unjudged fact is judged again once the join exists");
  const spoof = await projectSubmission(store, sub, source(fact("x"), fact("y")), judging({}));
  assert.equal(spoof.state, "published");
  assert.deepEqual(spoof.evidence!.seen, ["x", "y"]);
  const fresh = new ReviewStore(":memory:");
  const saved = published(fresh).sub;
  const never = { ...saved, state: "saved" as const, commandId: undefined };
  const src = source(fact("q"));
  await projectSubmission(fresh, never, src, judging({ q: { state: "queued" } }));
  assert.equal(src.calls, 0, "a saved row is never looked up");
});

test("Candystore: list by correlation id from the Send time, then each raw envelope", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    if (url.includes("/events?")) return new Response(JSON.stringify({ events: [{ id: "e1" }, { id: "e2" }] }));
    const id = url.split("/events/")[1].split("/")[0];
    return new Response(JSON.stringify({ id, type: "bloodbank.agent.invocation.queued", causationid: "c" }));
  }) as typeof fetch;
  const got = await candystoreFacts("http://cs", fetcher)("corr-1", "2026-11-28T00:00:00Z");
  assert.ok(got.ok);
  assert.deepEqual(got.ok && got.facts.map((f) => f.id), ["e1", "e2"]);
  assert.equal(asked[0], "http://cs/events?correlationid=corr-1&from=2026-11-28T00%3A00%3A00Z&limit=200");
  assert.deepEqual(asked.slice(1), ["http://cs/events/e1/raw", "http://cs/events/e2/raw"]);
  const bad = await candystoreFacts("http://cs", (async () => new Response("no", { status: 503 })) as unknown as typeof fetch)("c", "t");
  assert.ok(!bad.ok);
});

test("bb-emit evidence join: the row, fact and profile on stdin; a missing join is unavailable, never a verdict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "holoc76-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, body: string) => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const { sub } = published();
  const row = wireRow(sub);
  const ok = fake("ok", `cat > "${dir}/in"; echo "$@" > "${dir}/argv"; echo '{"state":"answered","fact_id":"f1","error_code":null}'`);
  assert.deepEqual(await bbEmitEvidence(ok)(row, fact("f1"), "green-in-between-pm"), { ok: true, state: "answered", errorCode: undefined });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "in"), "utf8")), { row, event: fact("f1"), profile: "green-in-between-pm" });
  assert.equal(readFileSync(join(dir, "argv"), "utf8").trim(), "--type bloodbank.review.feedback.send --feedback-evidence");
  assert.deepEqual(await bbEmitEvidence(fake("none", `echo '{"state":null,"fact_id":"f1"}'`))(row, fact("f1"), "p"), { ok: true, state: null, errorCode: undefined });
  const old = await bbEmitEvidence(fake("old", `echo "bb-emit: error: unrecognized arguments: --feedback-evidence" >&2; exit 2`))(row, fact("f1"), "p");
  assert.deepEqual(old, { ok: false, detail: "the installed bb-emit has no evidence join yet (BB-70)" });
  const other = await bbEmitEvidence(fake("other", `echo '{"state":"answered","fact_id":"someone-else"}'`))(row, fact("f1"), "p");
  assert.equal(other.ok, false, "a verdict about another fact is not a verdict");
  const junk = await bbEmitEvidence(fake("junk", `echo '{"state":"delivered"}'`))(row, fact("f1"), "p");
  assert.equal(junk.ok, false);
});

test("HTTP: reading the review projects facts and returns the answer, never the judged-fact ledger", async (t) => {
  const { store, sub } = published();
  const app = Fastify();
  t.after(() => app.close());
  const answer = fact("ans", "bloodbank.conversation.message.appended", { text: "Done.", native_session_id: "s", native_turn_id: "t" });
  await registerReviewRoutes(app, async () => ({ items: [], sources: {}, retryAfterMs: 0 }), { store, registry: async () => ({ projects: { greeninbetween: { project_id: "greeninbetween", project_name: "GIB", repo_path: "/r", agents: { "green-in-between-pm": { role: "pm" } } } } }), secret: () => "k",
    delivery: { mode: "live", emit: async () => ({ ok: false, kind: "unavailable", detail: "unused" }) }, evidence: { facts: source(answer, fact("noise")), judge: judging({ ans: { state: "answered" } }) } });
  const url = `/api/modules/projects/greeninbetween/revisions/${REV}/feedback`; const ts = String(Date.now());
  const res = await app.inject({ method: "GET", url, headers: { "x-review-user": "op@example.com", "x-review-timestamp": ts, "x-review-signature": reviewSignature("k", "GET", url, "", "op@example.com", ts) } });
  if (res.statusCode !== 200) { assert.fail(`GET ${res.statusCode}: ${res.body}`); }
  const row = res.json().submissions.find((s: { submissionId: string }) => s.submissionId === sub.submissionId);
  assert.equal(row.state, "answered");
  assert.equal(row.evidence.answer.body, "Done.");
  assert.equal(row.evidence.seen, undefined);
  assert.equal(row.retryable, false);
});

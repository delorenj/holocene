import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { bbEmitFeedback, deliverSubmission, deliveryMode, wireRow, type EmitOutcome, type FeedbackEmitter } from "./review-delivery.js";
import { ReviewStore } from "./review-store.js";
import { registerReviewRoutes, reviewSignature } from "./reviews.js";

const REV = "c".repeat(64);
const registry = { projects: { greeninbetween: { project_id: "greeninbetween", project_name: "GIB", repo_path: "/r", agents: { "green-in-between-pm": { role: "pm" } } } } };
function seeded() {
  const store = new ReviewStore(":memory:");
  store.putRevision({ revisionId: REV, projectId: "greeninbetween", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "https://s3.delo.sh/s/index.html", entrySha256: "0".repeat(64), manifest: [], createdAt: "now", createdBy: "op@example.com" });
  return store;
}
function sub(store: ReviewStore, id = "11111111-1111-4111-8111-111111111111") {
  return store.createSubmission({ submissionId: id, projectId: "greeninbetween", revisionId: REV, artifactId: "a", author: "op@example.com", recipient: "green-in-between-pm", note: "n",
    annotations: [{ id: "x", version: 1, author: "op@example.com", kind: "text", anchor: { quote: "q" }, comment: "c", updatedAt: "2026-11-28T00:00:00Z" }], digest: "d", stateDetail: "saved" }).submission;
}
/** A scripted emitter: one outcome per call, recording what it was asked. */
function scripted(...outcomes: EmitOutcome[]) {
  const calls: Array<{ check: boolean; row: unknown }> = [];
  const emit: FeedbackEmitter = async (row, check) => { calls.push({ check, row }); return outcomes.shift() ?? { ok: false, kind: "unavailable", detail: "script ran out" }; };
  return { emit, calls };
}

test("mode: check unless explicitly live or off", () => {
  assert.equal(deliveryMode(undefined), "check");
  assert.equal(deliveryMode("live"), "live");
  assert.equal(deliveryMode("off"), "off");
  assert.equal(deliveryMode("LIVE"), "check");
});

test("the wire row is the frozen row plus createdAt; delivery fields never go on the wire", () => {
  const store = seeded();
  const s = store.recordDelivery(sub(store).submissionId, { state: "uncertain", stateDetail: "x", commandId: "cmd", attempted: true })!;
  const row = wireRow(s);
  assert.deepEqual(Object.keys(row).sort(), ["annotations", "artifactId", "author", "correlationId", "createdAt", "digest", "note", "projectId", "recipient", "revisionId", "submissionId"]);
});

test("check mode validates and publishes nothing; a refusal keeps the row and says why", async () => {
  const store = seeded();
  const s = sub(store);
  const ok = scripted({ ok: true, commandId: "cmd-1" });
  const checked = await deliverSubmission(store, s, "check", ok.emit);
  assert.deepEqual(ok.calls.map((c) => c.check), [true], "only the dry run");
  assert.equal(checked.state, "saved");
  assert.equal(checked.commandId, "cmd-1");
  assert.match(checked.stateDetail, /nothing has been published/);
  const refused = await deliverSubmission(store, s, "check", scripted({ ok: false, kind: "refused", detail: "ContractViolation" }).emit);
  assert.equal(refused.state, "saved");
  assert.match(refused.stateDetail, /refused this submission \(ContractViolation\)/);
  assert.equal(store.submission(s.submissionId)!.annotations[0].comment, "c", "the frozen content is untouched");
});

test("live: validate, publish, record the receipt; an unconfirmed publish is uncertain and Retry sends the same command", async () => {
  const store = seeded();
  const s = sub(store);
  const first = scripted({ ok: true, commandId: "cmd-1" }, { ok: false, kind: "unconfirmed", detail: "timed out" });
  const u = await deliverSubmission(store, s, "live", first.emit);
  assert.equal(u.state, "uncertain");
  assert.equal(u.commandId, "cmd-1");
  assert.equal(u.attempts, 1);
  assert.match(u.stateDetail, /may already be stored/);
  const retry = scripted({ ok: true, commandId: "cmd-1" }, { ok: true, commandId: "cmd-1", receipt: { stream: "BLOODBANK_COMMANDS", seq: 42, duplicate: true } });
  const p = await deliverSubmission(store, u, "live", retry.emit);
  assert.deepEqual(retry.calls.map((c) => c.row), [wireRow(s), wireRow(s)], "the retry sends the same frozen row");
  assert.equal(p.state, "published");
  assert.deepEqual(p.receipt, { stream: "BLOODBANK_COMMANDS", seq: 42, duplicate: true });
  assert.equal(p.attempts, 2);
  // Settled: no further delivery, and a late uncertain outcome cannot move it back.
  const none = scripted();
  assert.equal((await deliverSubmission(store, p, "live", none.emit)).state, "published");
  assert.equal(none.calls.length, 0);
  assert.equal(store.recordDelivery(s.submissionId, { state: "uncertain", stateDetail: "late" })!.state, "published");
  assert.throws(() => store.recordDelivery(s.submissionId, { state: "published", stateDetail: "x", commandId: "other" }), /never changes/);
});

test("delivery columns are added to a store created before delivery existed", () => {
  const dir = mkdtempSync(join(tmpdir(), "holoc70-migrate-"));
  try {
    const file = join(dir, "r.sqlite3");
    const a = seeded(); a.close();
    const old = new ReviewStore(file);
    (old as unknown as { db: { exec(s: string): void } }).db.exec("ALTER TABLE submissions DROP COLUMN attempts; ALTER TABLE submissions DROP COLUMN receipt; ALTER TABLE submissions DROP COLUMN command_id;");
    old.close();
    const again = new ReviewStore(file);
    again.putRevision({ revisionId: REV, projectId: "greeninbetween", artifactId: "a", title: "t", entry: "index.html", sourceUrl: "u", snapshotBaseUrl: "s/", snapshotUrl: "x", entrySha256: "0".repeat(64), manifest: [], createdAt: "now", createdBy: "op" });
    const s = sub(again);
    assert.equal(s.attempts, 0);
    assert.equal(again.recordDelivery(s.submissionId, { state: "saved", stateDetail: "v", commandId: "c" })!.commandId, "c");
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bb-emit: argv and stdin only; stderr separates a refusal, a missing adapter and an unconfirmed publish", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "holoc70-bbemit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, body: string) => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const row = { submissionId: "s" } as unknown as ReturnType<typeof wireRow>;
  const echo = fake("ok", `cat > "${dir}/stdin"; echo "$@" > "${dir}/argv"; case "$*" in *--check*) echo '{"command_id":"cmd"}';; *) echo '{"command_id":"cmd","submissionId":"s","stream":"BLOODBANK_COMMANDS","seq":7,"duplicate":false}';; esac`);
  assert.deepEqual(await bbEmitFeedback(echo)(row, true), { ok: true, commandId: "cmd" });
  assert.equal((await import("node:fs")).readFileSync(join(dir, "stdin"), "utf8"), JSON.stringify(row));
  assert.deepEqual(await bbEmitFeedback(echo)(row, false), { ok: true, commandId: "cmd", receipt: { stream: "BLOODBANK_COMMANDS", seq: 7, duplicate: false } });
  assert.equal((await import("node:fs")).readFileSync(join(dir, "argv"), "utf8").trim(), "--type bloodbank.review.feedback.send --feedback-submission");
  const refused = await bbEmitFeedback(fake("refuse", `echo "bb-emit: feedback validation failed (ContractViolation); keep the frozen row" >&2; exit 1`))(row, true);
  assert.equal(refused.ok === false && refused.kind, "refused");
  const old = await bbEmitFeedback(fake("old", `echo "bb-emit: error: unrecognized arguments: --feedback-submission" >&2; exit 2`))(row, true);
  assert.equal(old.ok === false && old.kind, "unavailable");
  const lost = await bbEmitFeedback(fake("lost", `echo "bb-emit: feedback publication UNCONFIRMED (TimeoutError); reconcile by command_id before retry" >&2; exit 1`))(row, false);
  assert.equal(lost.ok === false && lost.kind, "unconfirmed");
  const noAck = await bbEmitFeedback(fake("noack", `echo '{"command_id":"cmd"}'`))(row, false);
  assert.equal(noAck.ok === false && noAck.kind, "unconfirmed", "exit 0 without a receipt is not published");
  const slow = await bbEmitFeedback(fake("slow", "sleep 5"), 200)(row, false);
  assert.equal(slow.ok === false && slow.kind, "unconfirmed", "a timeout may already have been accepted");
  assert.equal((await bbEmitFeedback(join(dir, "missing"))(row, true) as { kind: string }).kind, "unavailable");
});

test("HTTP: Send saves first, then delivers; a double click during delivery never publishes twice", async (t) => {
  const store = seeded();
  const app = Fastify();
  t.after(() => app.close());
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: boolean[] = [];
  const emit: FeedbackEmitter = async (_row, check) => { calls.push(check); if (!check) await gate; return check ? { ok: true, commandId: "cmd" } : { ok: true, commandId: "cmd", receipt: { stream: "BLOODBANK_COMMANDS", seq: 1, duplicate: false } }; };
  await registerReviewRoutes(app, async () => ({ items: [], sources: {}, retryAfterMs: 0 }), { store, registry: async () => registry, secret: () => "k", delivery: { mode: "live", emit } });
  const call = (method: "GET" | "POST", url: string, body?: unknown) => {
    const payload = body === undefined ? "" : JSON.stringify(body); const ts = String(Date.now());
    return app.inject({ method, url, payload: payload || undefined, headers: { ...(payload ? { "content-type": "application/json" } : {}), "x-review-user": "op@example.com", "x-review-timestamp": ts, "x-review-signature": reviewSignature("k", method, url, payload, "op@example.com", ts) } });
  };
  const base = `/api/modules/projects/greeninbetween/revisions/${REV}`;
  await call("POST", `${base}/annotations`, { status: "saved", kind: "text", anchor: { quote: "q" }, comment: "Fix" });
  const id = "22222222-2222-4222-8222-222222222222";
  const first = call("POST", `${base}/feedback`, { submissionId: id });
  await new Promise((r) => setTimeout(r, 50));
  const second = await call("POST", `${base}/feedback`, { submissionId: id });
  assert.equal(second.statusCode, 202, "a second click while delivering returns the row, no second publish");
  assert.equal(store.submission(id)!.state, "saved", "the row is saved before any publish");
  release();
  const done = await first;
  assert.equal(done.statusCode, 201);
  assert.equal(done.json().submission.state, "published");
  assert.deepEqual(calls, [true, false]);
});

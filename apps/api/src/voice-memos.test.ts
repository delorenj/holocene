import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoDetail, buildMemoSummaries, toJourneyEvent, type JourneyEvent } from "./voice-memos.js";
import { EventStore } from "./event-store.js";

const MEMO = "d84f8cb5-ad88-5bc9-a573-cf2e297e1b4d";
const CMD = "815c0a67-8c6f-4c9b-a82d-ed5ea0a30203";
const T0 = Date.parse("2026-10-15T19:45:53.000Z");
const iso = (secs: number) => new Date(T0 + secs * 1000).toISOString();
let cursor = 100;

function fact(type: string, secs: number, data: Record<string, unknown> = {}, memo = MEMO, producer = "inbox-watcher"): JourneyEvent {
  const envelope = {
    id: `e-${cursor}`, type: `bloodbank.${type}`, time: iso(secs), correlationid: memo, producer,
    data: { memo_id: memo, target_agent_id: "holocene-pm", s3_key: "inbox/holocene-pm/2026/10/15/a.ogg", ...data }
  };
  return toJourneyEvent({ cursor: cursor++, collected_at: iso(secs), envelope })!;
}
const uploaded = (s = 0) => fact("audio.memo.uploaded", s, { occurred_at: iso(s), bytes: 6065 }, MEMO, "agent-pad-upload");
const received = (s = 0.3) => fact("audio.memo.received", s, { occurred_at: iso(s), detect_lag_ms: 250 });
const transcribed = (s = 41) => fact("audio.memo.transcribed", s, { occurred_at: iso(s), transcript_text: "Reply with the single word PONG", word_count: 6, processing_seconds: 40.3, model: "large-v3" });
const dispatched = (s = 43) => fact("audio.memo.dispatched", s, { occurred_at: iso(s), command_id: CMD });
const started = (s = 50) => fact("agent.invocation.started", s, { command_id: CMD }, MEMO, "hermes-agent:holocene-pm");
const completed = (s = 55) => fact("agent.invocation.completed", s, { command_id: CMD }, MEMO, "hermes-agent:holocene-pm");
const replied = (s = 60) => fact("audio.memo.replied", s, { occurred_at: iso(s), command_id: CMD, reply_text: "PONG", tts_seconds: 0.9, tts_engine: "vibevoice", reply_s3_key: "replies/x.ogg" });
const hopHasType = (d: { hops: { id: string; events: { type: string }[] }[] }, id: string, type: string) => d.hops.find(h => h.id === id)!.events.some(e => e.type === type);
const now = (secs: number) => T0 + secs * 1000;

test("a complete journey has every hop ok with latencies between hops", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied()], now(120))!;
  assert.equal(d.status, "complete");
  assert.deepEqual(d.hops.map(h => h.status), ["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
  assert.equal(d.hops[2].sinceMs, 40700);
  assert.equal(d.hops[0].sinceMs, undefined);
  assert.equal(d.totalSeconds, 60);
  assert.equal(d.stageLabel, "Complete");
  assert.equal(d.transcriptPreview, "Reply with the single word PONG");
  assert.equal(d.replyText, "PONG");
  assert.equal(d.commandId, CMD);
  assert.equal(d.agent, "holocene-pm");
});

test("a journey that is waiting inside its budget is running, not stuck", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched()], now(43 + 60))!;
  assert.equal(d.status, "running");
  assert.equal(d.hops[4].status, "waiting");
  assert.equal(d.hops[4].waitedSeconds, 60);
  assert.equal(d.hops[5].status, "pending");
  assert.equal(d.stageLabel, "Waiting for agent started");
  assert.equal(d.totalSeconds, 103);
});

test("a hop older than its expected latency with nothing after it is stuck", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched()], now(43 + 121))!;
  assert.equal(d.status, "stuck");
  assert.equal(d.stuckAt, "agent_started");
  assert.equal(d.hops[4].status, "stuck");
  assert.match(d.stageLabel, /^Stuck before agent started/);
});

test("a terminal failure fact marks its hop failed with the error and stops the clock", () => {
  const failure = fact("audio.memo.failed", 650, {
    stage: "agent_reply", error_code: "timeout", error_message: "no completed turn after 600s", retryable: false, attempt: 1, command_id: CMD
  });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(660), failure], now(5000))!;
  assert.equal(d.status, "failed");
  const hop = d.hops.find(h => h.id === "agent_done")!;
  assert.equal(hop.status, "failed");
  assert.equal(hop.error?.code, "timeout");
  assert.equal(d.totalSeconds, 650);
  assert.equal(d.error, "timeout: no completed turn after 600s");
  assert.equal(d.stageLabel, "Failed at agent finished");
  assert.equal(d.hops[6].status, "pending");
  assert.ok(hopHasType(d, "agent_done", "bloodbank.audio.memo.failed"), "the failure envelope is attached to its hop");
});

test("an agent that finishes after the watcher gave up stays failed and says so", () => {
  const failure = fact("audio.memo.failed", 650, { stage: "agent_reply", error_code: "timeout", error_message: "gave up", retryable: false });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(700), completed(705), failure], now(5000))!;
  const hop = d.hops.find(h => h.id === "agent_done")!;
  assert.equal(d.status, "failed");
  assert.equal(hop.status, "failed");
  assert.match(hop.detail, /after the watcher gave up/);
});

test("an invocation.failed fact fails the agent hop before the watcher reports", () => {
  const failed = fact("agent.invocation.failed", 52, { command_id: CMD, error_code: "model_error", error_message: "provider 500" }, MEMO, "hermes-agent:holocene-pm");
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), failed], now(100))!;
  assert.equal(d.status, "failed");
  assert.equal(d.hops[5].status, "failed");
  assert.equal(d.hops[5].error?.message, "provider 500");
});

test("a retryable failure does not end the journey; it annotates the waiting hop", () => {
  const retry = fact("audio.memo.failed", 30, { stage: "transcribe", error_code: "oom", error_message: "cuda oom", retryable: true, attempt: 1 });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), retry], now(40))!;
  assert.equal(d.status, "running");
  assert.equal(d.hops[2].status, "waiting");
  assert.equal(d.hops[2].error?.code, "oom");
  assert.equal(d.hops[2].failures.length, 1);
});

test("a retried hop that later succeeds is ok but keeps its failed attempt", () => {
  const retry = fact("audio.memo.failed", 30, { stage: "transcribe", error_code: "oom", error_message: "cuda oom", retryable: true, attempt: 1 });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), retry, transcribed(), dispatched(), started(), completed(), replied()], now(100))!;
  assert.equal(d.status, "complete");
  assert.equal(d.hops[2].status, "ok");
  assert.equal(d.hops[2].failures.length, 1);
});

test("a memo without an upload fact marks that hop missing, not the journey broken", () => {
  const d = buildMemoDetail(MEMO, [received(), transcribed(), dispatched(), started(), completed(), replied()], now(100))!;
  assert.equal(d.hops[0].status, "missing");
  assert.equal(d.status, "complete");
});

test("agent facts of a different command are not attributed to the memo", () => {
  const other = fact("agent.invocation.completed", 55, { command_id: "00000000-0000-4000-8000-000000000000" }, MEMO, "hermes-agent:holocene-pm");
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), other], now(60))!;
  assert.equal(d.hops[5].status, "pending");
});

test("memos are summarised newest first and groups never mix", () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const events = [uploaded(0), received(1), fact("audio.memo.uploaded", 500, { occurred_at: iso(500) }, other, "agent-pad-upload")];
  const list = buildMemoSummaries(events, now(520));
  assert.deepEqual(list.map(m => m.memoId), [other, MEMO]);
  assert.equal(list[0].status, "running");
  assert.equal(list[0].reached, "uploaded");
  assert.equal(buildMemoSummaries(events, now(520), 1).length, 1);
});

test("envelopes without a correlation id or type are ignored", () => {
  assert.equal(toJourneyEvent({ cursor: 1, collected_at: iso(0), envelope: { type: "bloodbank.audio.memo.received", data: {} } }), undefined);
  assert.equal(toJourneyEvent({ cursor: 1, collected_at: iso(0), envelope: null }), undefined);
});

test("EventStore.correlated finds events by correlation id within a cursor bound", () => {
  const store = new EventStore(":memory:");
  const put = (sequence: number, type: string, correlationid: string) => store.db.prepare(
    "INSERT INTO events(event_id,stream,sequence,subject,type,source,collected_at,envelope) VALUES (?,?,?,?,?,?,?,?)"
  ).run(`id-${sequence}`, "S", sequence, "s", type, null, iso(sequence), JSON.stringify({ id: `id-${sequence}`, type, correlationid, data: {} }));
  put(1, "bloodbank.agent.invocation.started", MEMO);
  put(2, "bloodbank.agent.invocation.started", "other");
  put(3, "bloodbank.agent.invocation.completed", MEMO);
  put(4, "bloodbank.agent.tool.completed", MEMO);
  const types = ["bloodbank.agent.invocation.started", "bloodbank.agent.invocation.completed"];
  assert.deepEqual(store.correlated(types, [MEMO]).map(e => e.sequence), [1, 3]);
  assert.deepEqual(store.correlated(types, [MEMO], 2).map(e => e.sequence), [3]);
  assert.deepEqual(store.correlated(types, []), []);
  store.close();
});

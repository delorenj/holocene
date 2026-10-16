import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoDetail, buildMemoSummaries, toJourneyEvent, toSummary, type JourneyEvent } from "./voice-memos.js";
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
const played = (phase: "started" | "ended", s: number) => fact("audio.memo.played", s, { occurred_at: iso(s), phase, reply_age_ms: 4100, played_seconds: phase === "ended" ? 2.4 : null }, MEMO, "agent-pad-upload");
const playFailed = (s: number) => fact("audio.memo.failed", s, { stage: "playback", error_code: "autoplay_blocked", error_message: "sound is locked", retryable: true, attempt: 1 }, MEMO, "agent-pad-upload");
const hopHasType = (d: { hops: { id: string; events: { type: string }[] }[] }, id: string, type: string) => d.hops.find(h => h.id === id)!.events.some(e => e.type === type);
const now = (secs: number) => T0 + secs * 1000;

test("a complete journey has every hop ok with latencies between hops", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied()], now(120))!;
  assert.equal(d.status, "complete");
  assert.deepEqual(d.hops.map(h => h.status), ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "pending"]);
  assert.match(d.hops[7].detail, /no playback report/);
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

test("a gateway turn timeout fails the agent hop distinctly, with its numbers, before the watcher reports", () => {
  const timeoutData = { command_id: CMD, error_code: "turn_timeout", error_message: "agent turn timed out after 20s on interactive lane (limit 20s)",
    lane: "interactive", elapsed_seconds: 20.3, timeout_seconds: 20, timeout_source: "envelope", turn_stopped: true };
  const gateway = fact("agent.invocation.failed", 71, timeoutData, MEMO, "hermes-agent:holocene-pm");
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), gateway], now(100))!;
  assert.equal(d.status, "failed");
  const hop = d.hops.find(h => h.id === "agent_done")!;
  assert.equal(hop.status, "failed");
  assert.equal(hop.error?.code, "turn_timeout");
  assert.equal(hop.error?.message, "agent turn timed out after 20s on interactive lane (limit 20s)");
  assert.deepEqual(hop.error?.timeout, { elapsedSeconds: 20.3, limitSeconds: 20, lane: "interactive", source: "envelope", stopped: true });
  assert.equal(d.stageLabel, "Agent turn timed out after 20s");
  assert.equal(d.error, "turn_timeout: agent turn timed out after 20s on interactive lane (limit 20s)");
  assert.equal(d.reached, "agent_done");

  // The watcher's own failed fact (stage agent_reply) says the same thing and does not change the verdict.
  const watcher = fact("audio.memo.failed", 72, { stage: "agent_reply", error_code: "turn_timeout", error_message: timeoutData.error_message,
    retryable: false, attempt: 1, command_id: CMD, lane: "interactive", elapsed_seconds: 20.3, timeout_seconds: 20, timeout_source: "envelope", turn_stopped: true });
  const both = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), gateway, watcher], now(100))!;
  assert.equal(both.status, "failed");
  assert.equal(both.stageLabel, "Agent turn timed out after 20s");
  assert.equal(both.hops.find(h => h.id === "agent_done")!.failures[0].timeout?.stopped, true);
  assert.equal(both.hops.find(h => h.id === "replied")!.status, "pending");

  // Only the watcher's fact so far (the gateway fact not collected yet): still the distinct outcome.
  const only = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), watcher], now(100))!;
  assert.equal(only.stageLabel, "Agent turn timed out after 20s");

  // A stop Hermes could not confirm is reported as such, and a missing message is rebuilt from the numbers.
  const unconfirmed = fact("agent.invocation.failed", 71, { command_id: CMD, error_code: "turn_timeout", lane: "interactive",
    elapsed_seconds: 300.1, timeout_seconds: 300, timeout_source: "lane", turn_stopped: false }, MEMO, "hermes-agent:holocene-pm");
  const u = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), unconfirmed], now(400))!;
  assert.equal(u.hops.find(h => h.id === "agent_done")!.error?.timeout?.stopped, false);
  assert.match(u.error ?? "", /agent turn timed out after 300.1s on interactive lane \(limit 300s\)/);
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

test("playback reported by the pad completes the last hop without changing the journey time", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied(), played("started", 64), played("ended", 66.4)], now(120))!;
  assert.equal(d.status, "complete");
  assert.equal(d.hops[7].id, "played");
  assert.equal(d.hops[7].status, "ok");
  assert.equal(d.hops[7].sinceMs, 4000);
  assert.match(d.hops[7].detail, /played to the end/);
  assert.equal(d.totalSeconds, 60);
});

test("a playback failure is shown on the played hop and the memo stays complete", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied(), playFailed(62)], now(120))!;
  assert.equal(d.status, "complete");
  assert.equal(d.hops[7].status, "failed");
  assert.equal(d.hops[7].error?.code, "autoplay_blocked");
  assert.match(d.error ?? "", /autoplay_blocked/);
});

test("a device-side upload failure with nothing in S3 is a hop-one failure, not a mystery", () => {
  const f = fact("audio.memo.failed", 1, { stage: "upload", error_code: "upload_failed", error_message: "PUT 502", retryable: true, attempt: 3, occurred_at: iso(1) }, MEMO, "agent-pad-upload");
  const d = buildMemoDetail(MEMO, [f], now(5))!;
  assert.equal(d.hops[0].id, "uploaded");
  assert.equal(d.hops[0].failures.length, 1);
  assert.notEqual(d.status, "complete");
  const rec = fact("audio.memo.failed", 1, { stage: "record", error_code: "mic_unavailable", error_message: "native recorder start failed", retryable: false, attempt: 1, occurred_at: iso(1) }, MEMO, "agent-pad-upload");
  const r = buildMemoDetail(MEMO, [rec], now(5))!;
  assert.equal(r.status, "failed");
  assert.equal(r.hops[0].status, "failed");
  assert.match(r.error ?? "", /mic_unavailable/);
});

test("a no-row agent timeout fails the 'Agent started' hop, because the agent never started", () => {
  const timeout = fact("audio.memo.failed", 610, { stage: "agent_reply", error_code: "timeout", error_message: "no completed turn after 601s", retryable: false, attempt: 1, occurred_at: iso(610) });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), timeout], now(700))!;
  assert.equal(d.status, "failed");
  assert.equal(d.hops.find(h => h.id === "agent_started")!.status, "failed");
  assert.notEqual(d.hops.find(h => h.id === "agent_done")!.status, "failed");
  assert.match(d.stageLabel, /agent started/);
});

test("the dispatched fact names the lane; a fact from before lanes reads as batch", () => {
  const on = (data: Record<string, unknown>) =>
    buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), fact("audio.memo.dispatched", 43, { occurred_at: iso(43), command_id: CMD, ...data })], now(50))!;
  const interactive = on({ lane: "interactive", command_subject: "bloodbank.cmd.agent.invocation.invoke" });
  assert.equal(interactive.lane, "interactive");
  assert.equal(toSummary(interactive).lane, "interactive");
  assert.match(interactive.hops[3].detail, /interactive lane/);
  assert.equal(interactive.laneReason, undefined);

  const fellBack = on({ lane: "batch", lane_reason: "interactive_consumer_not_pulling", command_subject: "bloodbank.cmd.agent.invocation.start" });
  assert.equal(fellBack.lane, "batch");
  assert.equal(fellBack.laneReason, "interactive_consumer_not_pulling");
  assert.match(fellBack.hops[3].detail, /batch lane · fell back: interactive_consumer_not_pulling/);

  assert.equal(on({ command_subject: "bloodbank.cmd.agent.invocation.invoke" }).lane, "interactive");
  assert.equal(on({}).lane, "batch");
  // no dispatch yet: no lane to show
  assert.equal(buildMemoDetail(MEMO, [uploaded(), received()], now(5))!.lane, undefined);
});

test("the lane rides on the summaries the list view draws", () => {
  const list = buildMemoSummaries([received(), transcribed(), fact("audio.memo.dispatched", 43, { command_id: CMD, lane: "interactive" })], now(60));
  assert.equal(list[0].lane, "interactive");
});

test("a memo re-dispatched after a failed agent shows the NEWEST command's lane and only that command's facts", () => {
  const CMD2 = "cmd-retry-2";
  const first = fact("audio.memo.dispatched", 43, { occurred_at: iso(43), command_id: CMD, lane: "interactive" });
  const failed1 = fact("agent.invocation.failed", 50, { command_id: CMD }, MEMO, "hermes-agent:holocene-pm");
  const second = fact("audio.memo.dispatched", 70, { occurred_at: iso(70), command_id: CMD2, lane: "batch", lane_reason: "interactive_consumer_not_pulling" });
  const started2 = fact("agent.invocation.started", 75, { command_id: CMD2 }, MEMO, "hermes-agent:holocene-pm");
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), first, failed1, second, started2], now(80))!;
  assert.equal(d.lane, "batch");
  assert.equal(d.laneReason, "interactive_consumer_not_pulling");
  // the first command's failure is not paired with the second command's timing
  assert.equal(hopHasType(d, "agent_done", "bloodbank.agent.invocation.failed"), false);
  assert.equal(hopHasType(d, "agent_started", "bloodbank.agent.invocation.started"), true);
});

test("a silent recording names the microphone: its own stage label, the measured level, no transcript hop", () => {
  const silent = fact("audio.memo.failed", 47, {
    occurred_at: iso(47), stage: "transcribe", error_code: "silent_audio", retryable: false, attempt: 1,
    error_message: "recording is silent (max -73 dBFS, mean -83 dBFS over 6.4 s): the microphone delivered no sound",
    audio_max_dbfs: -73.4, audio_mean_dbfs: -83.3, audio_duration_seconds: 6.38
  });
  const up = fact("audio.memo.uploaded", 0, { occurred_at: iso(0), bytes: 26589, capture: { peak_dbfs: -71.2, rms_dbfs: -80 } }, MEMO, "agent-pad-upload");
  const d = buildMemoDetail(MEMO, [up, received(), silent], now(60))!;
  assert.equal(d.status, "failed");
  assert.equal(d.stageLabel, "Silent microphone");
  const hop = d.hops.find(h => h.id === "transcribed")!;
  assert.equal(hop.status, "failed");
  assert.equal(hop.error?.code, "silent_audio");
  assert.deepEqual(hop.audio, { maxDbfs: -73.4, meanDbfs: -83.3, durationSeconds: 6.38, silent: true });
  assert.equal(hop.detail, "max -73 dBFS · mean -83 dBFS · silent");
  assert.deepEqual(d.audio, hop.audio);
  // the device's own recorder level shows on the uploaded hop and the summary, so "mic dead" is visible before the file left the phone
  assert.deepEqual(d.capture, { peakDbfs: -71.2, rmsDbfs: -80, silent: true });
  assert.equal(d.hops[0].detail, "26589 bytes · device heard peak -71 dBFS, rms -80 dBFS (silent)");
  assert.equal(toSummary(d).audio?.silent, true);
  assert.match(d.error!, /^silent_audio: recording is silent/);
});

test("audible audio with no words recognised says so, and the transcribed hop shows the level when it did work", () => {
  const empty = fact("audio.memo.failed", 47, {
    occurred_at: iso(47), stage: "transcribe", error_code: "empty_transcript", retryable: false, attempt: 1,
    error_message: "audible (max -20 dBFS, mean -31 dBFS over 6.4 s) but no words recognised", audio_max_dbfs: -20, audio_mean_dbfs: -31
  });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), empty], now(60))!;
  assert.equal(d.stageLabel, "No words recognised");
  assert.equal(d.hops.find(h => h.id === "transcribed")!.audio?.silent, false);
  assert.equal(d.hops.find(h => h.id === "transcribed")!.detail, "max -20 dBFS · mean -31 dBFS · audible");

  const ok = buildMemoDetail(MEMO, [uploaded(), received(), fact("audio.memo.transcribed", 41, { occurred_at: iso(41), transcript_text: "hello", word_count: 1, audio_max_dbfs: -8.2, audio_mean_dbfs: -30.3 })], now(60))!;
  assert.match(ok.hops.find(h => h.id === "transcribed")!.detail, /1 words · max -8 dBFS · mean -30 dBFS · audible$/);

  // memos from before levels existed keep the old shape
  const legacy = buildMemoDetail(MEMO, [uploaded(), received(), transcribed()], now(60))!;
  assert.equal(legacy.audio, undefined);
  assert.equal(legacy.hops.find(h => h.id === "transcribed")!.detail, "6 words · 40.3 s · large-v3");
  const oldEmpty = fact("audio.memo.failed", 47, { stage: "transcribe", error_code: "empty_transcript", retryable: false, error_message: "transcript is empty" });
  assert.equal(buildMemoDetail(MEMO, [uploaded(), received(), oldEmpty], now(60))!.stageLabel, "Failed at transcribed");
});

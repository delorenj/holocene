import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoDetail, buildMemoSummaries, replyInfoOf, toJourneyEvent, toSummary, type JourneyEvent } from "./voice-memos.js";
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
  assert.equal(d.hops[0].detail, "26589 bytes · device heard peak -71 dBFS, window avg -80 dBFS (silent)");
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

test("a recording the pad held back as silent names the microphone, not Unknown", () => {
  const held = fact("audio.memo.failed", 0, {
    occurred_at: iso(0), stage: "record", error_code: "silent_capture", retryable: false, attempt: 1,
    error_message: "no sound reached the microphone (peak -72.2 dBFS, threshold -60)", capture: { peak_dbfs: -72.2, rms_dbfs: -72.3 }
  }, MEMO, "agent-pad-upload");
  const d = buildMemoDetail(MEMO, [held], now(10))!;
  assert.equal(d.status, "failed");
  assert.equal(d.stageLabel, "Silent microphone");
  assert.deepEqual(d.capture, { peakDbfs: -72.2, rmsDbfs: -72.3, silent: true });
  assert.match(d.error!, /^silent_capture: no sound reached the microphone/);
  assert.equal(toSummary(d).stageLabel, "Silent microphone");
});

test("'send anyway' after a held-back recording: the later upload supersedes the pad's silent_capture, the memo can complete", () => {
  const held = fact("audio.memo.failed", 0, {
    occurred_at: iso(0), stage: "record", error_code: "silent_capture", retryable: false, attempt: 1,
    error_message: "no sound reached the microphone (peak -72.2 dBFS, threshold -60)", capture: { peak_dbfs: -72.2, rms_dbfs: -72.3 }
  }, MEMO, "agent-pad-upload");
  const d = buildMemoDetail(MEMO, [held, uploaded(5), received(5.3), transcribed(40), dispatched(41), started(45), completed(50), replied(55)], now(120))!;
  assert.equal(d.status, "complete");
  assert.equal(d.stageLabel, "Complete");
  assert.equal(d.hops[0].status, "ok");
  assert.equal(d.hops[0].failures.length, 1); // the held-back attempt stays visible
});

// ---- escalation to the batch lane ------------------------------------------------------------------------------

const CMD_B = "9a1f5c2e-4b3d-4e6f-8a7b-00000000b001";
const GW = "hermes-agent:holocene-pm";
const interactiveDispatch = (s = 43) => fact("audio.memo.dispatched", s, { occurred_at: iso(s), command_id: CMD, lane: "interactive", command_subject: "bloodbank.cmd.agent.invocation.invoke" });
const turnTimeout = (s = 71) => fact("agent.invocation.failed", s, {
  command_id: CMD, error_code: "turn_timeout", error_message: "agent turn timed out after 20s on interactive lane (limit 20s)",
  lane: "interactive", elapsed_seconds: 20.3, timeout_seconds: 20, timeout_source: "lane", turn_stopped: true
}, MEMO, GW);
const escalatedDispatch = (s = 73) => fact("audio.memo.dispatched", s, {
  occurred_at: iso(s), command_id: CMD_B, lane: "batch", lane_reason: "turn_timeout_escalated", escalated_from_command_id: CMD,
  command_subject: "bloodbank.cmd.agent.invocation.start"
});
const batchStarted = (s = 80) => fact("agent.invocation.started", s, { command_id: CMD_B }, MEMO, GW);
const batchCompleted = (s = 300) => fact("agent.invocation.completed", s, { command_id: CMD_B }, MEMO, GW);
const lateReplied = (s = 310) => fact("audio.memo.replied", s, {
  occurred_at: iso(s), command_id: CMD_B, reply_text: "A long, full answer that the phone also gets as text.", tts_seconds: 4.2, tts_engine: "vibevoice",
  reply_s3_key: "replies/x.ogg", late: true, escalated: true, earshot_key: "phone/2026/10/20/x.ogg", earshot_text_key: "phone/2026/10/20/x.txt"
});
const upToEscalation = () => [uploaded(), received(), transcribed(), interactiveDispatch(), started(50), turnTimeout(), escalatedDispatch()];
const ids = (d: { hops: { id: string }[] }) => d.hops.map(h => h.id);
const statuses = (d: { hops: { status: string }[] }) => d.hops.map(h => h.status);

test("an escalated memo shows the batch dispatch as its own hop and is in progress, not failed, while the batch turn runs", () => {
  const d = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted()], now(100))!;
  assert.deepEqual(ids(d), ["uploaded", "received", "transcribed", "dispatched", "agent_started", "agent_done", "escalated", "batch_started", "batch_done", "replied", "played"]);
  assert.deepEqual(statuses(d), ["ok", "ok", "ok", "ok", "ok", "timed_out", "ok", "ok", "waiting", "pending", "pending"]);
  assert.equal(d.status, "running");
  assert.equal(d.error, undefined);
  assert.equal(d.stageLabel, "Escalated to batch · waiting for batch agent finished");
  assert.equal(d.escalated, true);
  assert.equal(toSummary(d).escalated, true);
  assert.equal(d.lane, "batch");
  assert.equal(d.laneReason, "turn_timeout_escalated");
  assert.equal(d.commandId, CMD_B);
  assert.equal(d.escalatedFromCommandId, CMD);

  const [first, interactiveStart, interactiveDone, esc, batchStart] = [d.hops[3], d.hops[4], d.hops[5], d.hops[6], d.hops[7]];
  assert.match(first.detail, new RegExp(`command ${CMD} · interactive lane`));
  assert.equal(interactiveStart.label, "Interactive agent started");
  assert.equal(interactiveDone.label, "Interactive agent finished");
  // the interactive turn's timeout is kept, with its numbers, but it is the reason for the escalation and not the verdict
  assert.equal(interactiveDone.error?.code, "turn_timeout");
  assert.deepEqual(interactiveDone.error?.timeout, { elapsedSeconds: 20.3, limitSeconds: 20, lane: "interactive", source: "lane", stopped: true });
  assert.match(interactiveDone.detail, /not a failure/);
  assert.equal(esc.label, "Escalated to batch lane");
  assert.equal(esc.detail, `command ${CMD_B} · batch lane · escalated from command ${CMD} (interactive turn timed out)`);
  assert.equal(esc.sinceMs, 2000);
  assert.ok(hopHasType(d, "escalated", "bloodbank.audio.memo.dispatched"));
  assert.equal(first.events.length, 1, "the batch dispatch is not also the interactive dispatch");
  // the batch turn's own agent facts are on the batch hops, the interactive turn's on the interactive hops
  assert.ok(hopHasType(d, "batch_started", "bloodbank.agent.invocation.started"));
  assert.equal(batchStart.events.length, 1);
  assert.ok(hopHasType(d, "agent_done", "bloodbank.agent.invocation.failed"));
  assert.equal(d.hops[8].waitedSeconds, 20);
});

test("an escalated memo that the batch turn finishes is complete, and its reply is marked late with its text sidecar", () => {
  const d = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted(), batchCompleted(), lateReplied()], now(400))!;
  assert.equal(d.status, "complete");
  assert.equal(d.stageLabel, "Complete · late reply");
  assert.deepEqual(statuses(d), ["ok", "ok", "ok", "ok", "ok", "timed_out", "ok", "ok", "ok", "ok", "pending"]);
  const replied = d.hops.find(h => h.id === "replied")!;
  assert.deepEqual(replied.reply, { late: true, escalated: true, earshotKey: "phone/2026/10/20/x.ogg", earshotTextKey: "phone/2026/10/20/x.txt" });
  assert.match(replied.detail, /^late reply · tts 4.2 s/);
  assert.equal(d.late, true);
  assert.equal(toSummary(d).late, true);
  assert.equal(d.replyText, "A long, full answer that the phone also gets as text.");
  assert.equal(d.error, undefined);
  assert.equal(d.totalSeconds, 310);
});

test("an escalated memo is in progress right after the batch dispatch, and a batch turn past its long budget is stuck", () => {
  const justNow = buildMemoDetail(MEMO, upToEscalation(), now(75))!;
  assert.equal(justNow.status, "running");
  assert.equal(justNow.hops.find(h => h.id === "batch_started")!.status, "waiting");
  assert.equal(justNow.stageLabel, "Escalated to batch · waiting for batch agent started");

  // the batch lane queues behind ticket grooming: 20 minutes is inside the budget, 31 minutes is not
  assert.equal(buildMemoDetail(MEMO, upToEscalation(), now(73 + 20 * 60))!.status, "running");
  const stuck = buildMemoDetail(MEMO, upToEscalation(), now(73 + 31 * 60))!;
  assert.equal(stuck.status, "stuck");
  assert.equal(stuck.stuckAt, "batch_started");
  assert.match(stuck.stageLabel, /^Escalated to batch · stuck before batch agent started/);

  const running = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted(80)], now(80 + 3 * 3600))!;
  assert.equal(running.status, "stuck");
  assert.equal(running.stuckAt, "batch_done");
});

test("the watcher's own copy of the interactive timeout does not fail an escalated memo, even without the gateway fact", () => {
  const watcherCopy = fact("audio.memo.failed", 72, {
    occurred_at: iso(72), stage: "agent_reply", error_code: "turn_timeout", retryable: false, attempt: 1, command_id: CMD,
    error_message: "agent turn timed out after 20s on interactive lane (limit 20s)", lane: "interactive", elapsed_seconds: 20.3, timeout_seconds: 20, turn_stopped: true
  });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), interactiveDispatch(), started(50), watcherCopy, escalatedDispatch(), batchStarted()], now(100))!;
  assert.equal(d.status, "running");
  assert.equal(d.hops.find(h => h.id === "agent_done")!.status, "timed_out");
  assert.equal(d.hops.find(h => h.id === "agent_done")!.at, iso(72));
  assert.equal(d.hops.find(h => h.id === "batch_done")!.status, "waiting");
  assert.equal(d.error, undefined);
  assert.ok(hopHasType(d, "agent_done", "bloodbank.audio.memo.failed"));
});

test("an escalated memo whose batch turn fails is failed at the batch hop, with that turn's own error", () => {
  const batchFailed = fact("agent.invocation.failed", 200, { command_id: CMD_B, error_code: "model_error", error_message: "provider 500" }, MEMO, GW);
  const d = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted(), batchFailed], now(300))!;
  assert.equal(d.status, "failed");
  assert.equal(d.hops.find(h => h.id === "batch_done")!.status, "failed");
  assert.equal(d.hops.find(h => h.id === "agent_done")!.status, "timed_out");
  assert.equal(d.error, "model_error: provider 500");
  assert.equal(d.stageLabel, "Failed at batch agent finished");

  // a watcher-side failure after the escalation belongs to the batch turn, by its command id
  const batchTimeout = fact("audio.memo.failed", 7400, { occurred_at: iso(7400), stage: "agent_reply", error_code: "turn_timeout", retryable: false, command_id: CMD_B,
    error_message: "agent turn timed out after 7200s on batch lane", lane: "batch", elapsed_seconds: 7200.4, timeout_seconds: 7200 });
  const t = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted(), batchTimeout], now(8000))!;
  assert.equal(t.status, "failed");
  assert.equal(t.hops.find(h => h.id === "batch_done")!.status, "failed");
  assert.equal(t.hops.find(h => h.id === "agent_done")!.status, "timed_out");
  assert.equal(t.stageLabel, "Batch agent turn timed out after 7200s");
});

test("without an escalation the timeout stays the memo's verdict and the hop list is unchanged", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), interactiveDispatch(), started(50), turnTimeout()], now(100))!;
  assert.equal(d.status, "failed");
  assert.equal(d.hops.length, 8);
  assert.equal(d.escalated, undefined);
  assert.equal(d.hops[5].status, "failed");
  assert.equal(d.hops[4].label, "Agent started");
});

test("the escalation rides on the summaries the list view draws", () => {
  const list = buildMemoSummaries([...upToEscalation(), batchStarted()], now(100));
  assert.equal(list[0].escalated, true);
  assert.equal(list[0].status, "running");
  assert.equal(list[0].lane, "batch");
  assert.equal(list[0].laneReason, "turn_timeout_escalated");
});

test("a reply carries its Earshot text sidecar whether or not it was escalated", () => {
  const withText = fact("audio.memo.replied", 60, { occurred_at: iso(60), command_id: CMD, reply_text: "PONG", reply_s3_key: "replies/x.ogg", earshot_key: "phone/a.ogg", earshot_text_key: "phone/a.txt" });
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), withText], now(120))!;
  assert.deepEqual(d.hops.find(h => h.id === "replied")!.reply, { late: false, escalated: false, earshotKey: "phone/a.ogg", earshotTextKey: "phone/a.txt" });
  assert.equal(d.late, undefined);
  assert.equal(d.escalated, undefined);
  assert.equal(d.stageLabel, "Complete");
  // a reply from before the sidecar existed has none
  const plain = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied()], now(120))!;
  assert.equal(plain.hops.find(h => h.id === "replied")!.reply?.earshotTextKey, undefined);
  assert.equal(replyInfoOf({ earshot_skipped: "car_live" }).earshotSkipped, "car_live");
  assert.equal("earshotSkipped" in replyInfoOf({}), false);
});

// ---- memo:cancel -----------------------------------------------------------------------------------------------

const cancelFact = (s: number, afterDispatch?: boolean) => fact("audio.memo.failed", s, {
  occurred_at: iso(s), stage: "cancelled", error_code: "cancelled", error_message: "cancelled by memo:cancel", retryable: false, attempt: 1, after_dispatch: afterDispatch
});

test("a memo cancelled before dispatch is cancelled, not failed, and nothing after it is reached", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), cancelFact(44, false)], now(500))!;
  assert.equal(d.status, "cancelled");
  assert.equal(d.stageLabel, "Cancelled before dispatch");
  assert.equal(d.error, undefined);
  assert.deepEqual(d.cancelled, { eventId: d.events.find(e => e.type === "bloodbank.audio.memo.failed")!.id, at: iso(44), afterDispatch: false, message: "cancelled by memo:cancel" });
  assert.deepEqual(statuses(d), ["ok", "ok", "ok", "cancelled", "pending", "pending", "pending", "pending"]);
  const hop = d.hops[3];
  assert.equal(hop.id, "dispatched");
  assert.equal(hop.cancel?.afterDispatch, false);
  assert.match(hop.detail, /before dispatch: nothing was sent/);
  assert.equal(hop.sinceMs, 3000);
  assert.ok(hopHasType(d, "dispatched", "bloodbank.audio.memo.failed"), "the cancel envelope is attached to its hop");
  assert.equal(hop.failures.length, 0, "a cancel is not a failed attempt");
  assert.equal(d.totalSeconds, 44, "the clock stops at the cancel");
  assert.equal(toSummary(d).cancelled?.afterDispatch, false);
  assert.equal(toSummary(d).error, undefined);
});

test("a memo cancelled after dispatch says the agent may still have run, and the agent finishing later does not revive it", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(50), cancelFact(52, true), completed(90)], now(500))!;
  assert.equal(d.status, "cancelled");
  assert.equal(d.stageLabel, "Cancelled after dispatch");
  assert.equal(d.cancelled?.afterDispatch, true);
  assert.equal(d.error, undefined);
  // the agent hop shows what really happened; the cancel sits on the first hop it never produced: the reply
  assert.equal(d.hops.find(h => h.id === "agent_done")!.status, "ok");
  const hop = d.hops.find(h => h.status === "cancelled")!;
  assert.equal(hop.id, "replied");
  assert.match(hop.detail, /agent may still run/);
  assert.equal(d.totalSeconds, 52);
});

test("a cancel without after_dispatch infers it from whether a dispatched fact came first", () => {
  assert.equal(buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(43), cancelFact(44)], now(60))!.cancelled?.afterDispatch, true);
  assert.equal(buildMemoDetail(MEMO, [uploaded(), received(), cancelFact(10)], now(60))!.cancelled?.afterDispatch, false);
});

test("a cancel is the only fact of a memo: still cancelled, not Unknown", () => {
  const d = buildMemoDetail(MEMO, [cancelFact(1, false)], now(60))!;
  assert.equal(d.status, "cancelled");
  assert.equal(d.stageLabel, "Cancelled before dispatch");
  assert.equal(d.hops[0].status, "cancelled");
});

test("an explicit memo:retry after a cancel supersedes it; the cancel stays in the record", () => {
  const retried = [uploaded(), received(), transcribed(), cancelFact(44, false), received(100), transcribed(120), dispatched(121)];
  const d = buildMemoDetail(MEMO, retried, now(130))!;
  assert.equal(d.status, "running");
  assert.equal(d.cancelled, undefined);
  assert.equal(d.hops.some(h => h.status === "cancelled"), false);
  assert.ok(d.events.some(e => e.data.stage === "cancelled"), "the cancel fact is still in the memo's events");
  const done = buildMemoDetail(MEMO, [...retried, started(125), completed(140), replied(145)], now(200))!;
  assert.equal(done.status, "complete");
});

test("an escalated memo that is then cancelled is cancelled after dispatch", () => {
  const d = buildMemoDetail(MEMO, [...upToEscalation(), batchStarted(), cancelFact(120, true)], now(500))!;
  assert.equal(d.status, "cancelled");
  assert.equal(d.escalated, true);
  assert.equal(d.hops.find(h => h.status === "cancelled")!.id, "batch_done");
  assert.equal(d.hops.find(h => h.id === "agent_done")!.status, "timed_out");
});

// ---- a failure the memo moved past is history ---------------------------------------------------------------------

const reviveMarker = (s: number, to = "await_agent") => fact("audio.memo.received", s, { occurred_at: iso(s), revived: true, revived_to: to, revive_why: "memo:retry" });
const timeoutFact = (s: number) => fact("audio.memo.failed", s, { stage: "agent_reply", error_code: "timeout", error_message: "no completed turn after 600s", retryable: false, attempt: 1, command_id: CMD });

test("a memo revived by memo:retry is running again once the watcher's revive marker follows its failure", () => {
  const events = [uploaded(), received(), transcribed(), dispatched(), started(), timeoutFact(650)];
  assert.equal(buildMemoDetail(MEMO, events, now(660))!.status, "failed");
  const d = buildMemoDetail(MEMO, [...events, reviveMarker(700)], now(710))!;
  assert.notEqual(d.status, "failed");
  assert.equal(d.error, undefined);
  assert.ok(d.events.some(e => e.type === "bloodbank.audio.memo.failed"), "the failure is still in the memo's record");
  assert.equal(d.hops.find(h => h.id === "received")!.detail, "watcher lag 250 ms", "the marker never replaces the real detection");
});

test("a revive marker after a cancel at await_agent un-cancels the memo before any reply exists", () => {
  const events = [uploaded(), received(), transcribed(), dispatched(), started(), cancelFact(52, true)];
  assert.equal(buildMemoDetail(MEMO, events, now(60))!.status, "cancelled");
  const d = buildMemoDetail(MEMO, [...events, reviveMarker(100)], now(110))!;
  assert.notEqual(d.status, "cancelled");
  assert.equal(d.cancelled, undefined);
});

test("a late reply after the watcher gave up completes the memo instead of leaving it failed", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), timeoutFact(650), reviveMarker(900, "reply"), completed(880), replied(910)], now(1000))!;
  assert.equal(d.status, "complete");
});

test("a failure with nothing after it still decides, and a retry's fresh dispatch supersedes an earlier failure", () => {
  const stale = fact("audio.memo.failed", 100, { stage: "agent_reply", error_code: "turn_timeout", error_message: "stopped", retryable: false, attempt: 1, command_id: CMD });
  assert.equal(buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), stale], now(120))!.status, "failed");
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), stale, transcribed(150), dispatched(151)], now(160))!;
  assert.notEqual(d.status, "failed");
});

// ---- what the driver heard while waiting: progress lines, narrations, the car's speech decisions -------------------

const progressed = (seq: number, s: number, text: string, cmd = CMD) =>
  fact("agent.invocation.progressed", s, { command_id: cmd, seq, text, elapsed_seconds: s - 50 }, MEMO, "hermes-agent:holocene-pm");
const narrated = (n: number, s: number, seq: number) =>
  fact("audio.memo.narrated", s, { occurred_at: iso(s), command_id: CMD, seq, narration: n, progress_s3_key: `progress/2026/10/15/${MEMO}-${n}.ogg`,
    spoken_text: "Holocene PM: checking the board.", tts_seconds: 2.1, tts_engine: "voxcpm", elapsed_seconds: s - 43 });
const notified = (utterance: string, decision: string, s: number, extra: Record<string, unknown> = {}) =>
  fact("audio.memo.notified", s, { occurred_at: iso(s), utterance, decision, mic: "idle", ...extra }, MEMO, "agent-pad-upload");

test("progress lines, narrations and car speech ride on the detail and time the first sounds without moving any hop", () => {
  const base = [uploaded(), received(), transcribed(), dispatched(), started()];
  const extra = [
    notified("ack", "start", -0.5, { device_at: iso(-0.6) }), notified("ack", "end", 0.9),
    notified("echo", "start", 41.6), progressed(1, 62, "I'll check the board first."),
    progressed(2, 70, "Reading the **open** tickets."), narrated(1, 72, 2), notified("progress", "start", 73),
    notified("progress", "deferred", 75, { reason: "recording", recording: true, mic: "recording" })
  ];
  const plain = buildMemoDetail(MEMO, base, now(80))!;
  const d = buildMemoDetail(MEMO, [...base, ...extra], now(80))!;
  assert.deepEqual(d.hops.map(h => h.status), plain.hops.map(h => h.status));
  assert.equal(d.status, "running");
  assert.deepEqual(d.progress.map(p => [p.seq, p.text, p.superseded]), [[1, "I'll check the board first.", false], [2, "Reading the **open** tickets.", false]]);
  assert.equal(d.progress[0].elapsedSeconds, 12);
  assert.deepEqual(d.narrations.map(n => [n.n, n.seq, n.engine]), [[1, 2, "voxcpm"]]);
  assert.equal(d.speech.length, 5);
  assert.deepEqual(d.speech.at(-1), { eventId: d.speech.at(-1)!.eventId, at: iso(75), deviceAt: undefined, utterance: "progress", decision: "deferred", reason: "recording", recording: true, mic: "recording" });
  // timing is measured from the upload, on the server's clock (never the device's own, which is not comparable)
  assert.deepEqual(d.timing, { ackSeconds: -0.5, heardEchoSeconds: 41.6, firstProgressSeconds: 62, firstNarrationSeconds: 72, progressPlayedSeconds: 73 });
  const sum = toSummary(d);
  assert.equal(sum.latestProgress, "Reading the **open** tickets.");
  assert.equal(sum.progressCount, 2);
  assert.equal(sum.narrationCount, 1);
  // a memo the agent answered without narrating carries none of it
  assert.equal(plain.latestProgress, undefined);
  assert.deepEqual([plain.progress, plain.narrations, plain.speech, plain.timing], [[], [], [], {}]);
});

const voiced = (n: number, of: number, s: number) =>
  fact("audio.memo.voiced", s, { occurred_at: iso(s), command_id: CMD, chunk: n, chunks: of, reply_s3_key: "replies/x.ogg",
    chunk_s3_key: `replies/x-c0${n}of0${of}.opus`, spoken_text: `chunk ${n}`, tts_seconds: 2.7, since_agent_done_seconds: Math.round((s - 55) * 10) / 10 });

test("a chunked reply lists its chunks once each and times the first response from the agent's finish", () => {
  const journey = [uploaded(), received(), transcribed(), dispatched(), started(), completed(),
    voiced(1, 3, 58.2), voiced(2, 3, 61.5), voiced(2, 3, 63), voiced(3, 3, 66), replied(66.4), played("started", 59.1)];
  const d = buildMemoDetail(MEMO, journey, now(120))!;
  assert.equal(d.status, "complete");
  assert.deepEqual(d.chunks.map(c => [c.n, c.of, c.at]), [[1, 3, iso(58.2)], [2, 3, iso(61.5)], [3, 3, iso(66)]]);
  assert.equal(d.chunks[0].sinceAgentDoneSeconds, 3.2);
  assert.equal(d.timing.firstChunkSeconds, 58.2);
  assert.equal(d.timing.replyUpSeconds, 66.4);
  assert.equal(d.timing.agentToFirstChunkSeconds, 3.2);
  assert.equal(d.timing.agentToReplySeconds, 11.4);
  assert.equal(d.timing.agentToCarSeconds, 4.1);   // the pad's beacon: no arbiter decision in this journey
  assert.equal(d.timing.carLagSeconds, 0.9);       // from the first chunk, not from the full file
  // a reply spoken as one file: the car's lag runs from the replied fact
  const one = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), completed(), replied(), played("started", 62.5)], now(120))!;
  assert.deepEqual(one.chunks, []);
  assert.equal(one.timing.carLagSeconds, 2.5);
  assert.equal(one.timing.firstChunkSeconds, undefined);
});

test("an escalated memo keeps its first turn's progress as history and reports the batch turn's newest line", () => {
  const d = buildMemoDetail(MEMO, [...upToEscalation(), progressed(1, 60, "first turn"), progressed(1, 80, "batch turn", CMD_B), progressed(2, 90, "batch turn, step two", CMD_B)], now(100))!;
  assert.deepEqual(d.progress.map(p => [p.commandId, p.seq, p.superseded]), [[CMD, 1, true], [CMD_B, 1, false], [CMD_B, 2, false]]);
  assert.equal(d.latestProgress, "batch turn, step two");
});

test("progress of another command on the same correlation id is not this memo's", () => {
  const d = buildMemoDetail(MEMO, [uploaded(), received(), transcribed(), dispatched(), started(), progressed(1, 60, "somebody else", "0b8a0c1e-0000-4000-8000-000000000000")], now(70))!;
  assert.deepEqual(d.progress, []);
});

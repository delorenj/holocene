# Priority lane under load (round 1)

Date: 2026-10-16 (02:22-02:26 UTC, evening of 2026-10-15 local). Result: PASS on the first real attempt. No code changes were needed.

## What was proved

With the batch lane fully saturated (4 of 4 slots in flight, 2 more commands queued), a real voice memo recorded on the Honda simulator (`emulator-5554`) was dispatched on the interactive lane, and the agent started 22 ms after dispatch while the batch backlog was still waiting. The memo then completed, was answered, spoken, and played back on the pad.

## Setup

1. Six ordinary `bloodbank.agent.invocation.start` commands (batch lane) were emitted with `bb-emit` to `holocene-pm`, each on its own thread id. Prompt: "Load test N: harmless queue-saturation test. Run the shell command `sleep 100`, then reply with the single line 'batch N done'. Take no other action." The `sleep 100` is a deliberate deviation from "think briefly": a brief turn would have drained the lane before the memo finished transcribing (about 42 s), so the saturation would not have overlapped the memo's dispatch.
2. Saturation confirmed from the NATS monitor (`/jsz`) right after emit and again at memo dispatch: `bloodbank-hermes-gateway` ack_pending 4 / max 4, pending 2. `bloodbank-hermes-gateway-interactive` ack_pending 0 / max 2.
3. Memo recorded on the simulator: tapped the Holocene tile, tapped Record, injected the known utterance through the emulator gRPC mic (`emulator_audio.py inject`, 5.2 s), tapped Stop & Send. No emulator crash, no fallback to the upload path needed. Utterance: "Priority lane test. Please reply with the words lane works." (flite kal16). Whisper heard: "Priority lane test. Please reply with words lane works."

## Numbers

Memo `36907b96-093e-5334-93b8-0e8877ec7f9c`, command `cef56684-168c-4a82-af6c-0e3a875d0ae4`, `bloodbank.cmd.agent.invocation.invoke`, lane `interactive`.

| Hop | Time (UTC) | Delta |
|---|---|---|
| uploaded | 02:22:39.091 | |
| watcher picked up | 02:22:41.367 | +2.3 s |
| transcribed (large-v3, 41.2 s) | 02:23:24.046 | +42.7 s |
| dispatched | 02:23:24.254 | +0.2 s |
| gateway journal row (agent started) | 02:23:24.276 | **+0.022 s after dispatch** |
| agent finished (success) | 02:23:32.465 | 8.2 s turn |
| reply rendered (TTS 1.1 s, reply text "lane works") | 02:23:36.450 | +4.0 s |
| played on the pad | 02:23:39.981 | 4.0 s later (7.7 s after rendering per the pad) |

Total upload to played: 57.4 s. The memo's wait for an agent slot was effectively zero.

Batch backlog during the same window (command emitted 02:22:21.7, all six emitted within 0.5 s):

| Batch cmd | Started (journal row) | Wait from emit | Run | Outcome |
|---|---|---|---|---|
| 1 | 02:22:21.769 | 0.0 s | 118.2 s | success |
| 2 | 02:22:21.852 | 0.0 s | 110.8 s | success |
| 3 | 02:22:21.959 | 0.1 s | 111.8 s | success |
| 4 | 02:22:22.063 | 0.1 s | 114.2 s | success |
| 5 | 02:24:12.738 | **110.7 s** | 111.7 s | success |
| 6 | 02:24:13.875 | **111.8 s** | 112.7 s | success |

At the moment the memo was dispatched (02:23:24) batch commands 5 and 6 had already been waiting 62 s and the four running ones had 49-56 s left. On the old single FIFO consumer the memo would have queued behind 5 and 6 and started at about 02:24:14, a wait of roughly 50 s here (counterfactual, estimated from the batch slots' free times, not measured). Real grooming turns run 5-11 minutes, which is where the observed 14 minute wait came from. The interactive path took 0.022 s regardless.

Queue state shown by `mise run memo:trace latest` and the API at that moment: `interactive: pulling, 0/2 in flight, 0 queued | batch: pulling, 4/4 in flight, 2 queued`.

All six batch commands completed with outcome success; the batch consumer ended at ack_pending 0, pending 0 (02:26:06).

## Evidence

`mise run memo:trace latest` (final): `VERDICT  COMPLETE in 57.0s; played on the pad 6.0s after the reply was rendered`. Every hop OK: s3_object, upload_proxy_log, fact:uploaded, fact:received, fact:transcribed, fact:dispatched (`-> bloodbank.cmd.agent.invocation.invoke lane=interactive`), gateway_journal (`lane=interactive profile=holocene-pm state=completed outcome=success`), agent:invocation.started, agent:invocation.done, hermes_session (agent saw the exact transcript), fact:replied, reply_object, pad_playback_log, played_on_pad.

`mise run memo:list` shows the memo with LANE `interactive`.

Simulator end state: `priority-lane-sim-reply-played.png` ("reply played", memo 36907b96).

Holocene API `GET /api/modules/voice/memos/36907b96-093e-5334-93b8-0e8877ec7f9c` (trimmed, envelopes omitted):

```json
{
  "memo": {
    "memoId": "36907b96-093e-5334-93b8-0e8877ec7f9c",
    "agent": "holocene-pm",
    "status": "complete",
    "reached": "played",
    "lane": "interactive",
    "totalSeconds": 57.359,
    "commandId": "cef56684-168c-4a82-af6c-0e3a875d0ae4",
    "transcript": "Priority lane test. Please reply with words lane works.",
    "replyText": "lane works",
    "hops": [
      {"id": "uploaded",      "status": "ok", "at": "2026-10-16T02:22:39.091Z"},
      {"id": "received",      "status": "ok", "at": "2026-10-16T02:22:41.367Z", "detail": "watcher lag 2288 ms"},
      {"id": "transcribed",   "status": "ok", "at": "2026-10-16T02:23:24.046Z", "detail": "9 words, 41.18 s, large-v3"},
      {"id": "dispatched",    "status": "ok", "at": "2026-10-16T02:23:24.254Z", "detail": "interactive lane"},
      {"id": "agent_started", "status": "ok", "at": "2026-10-16T02:23:24.276455Z"},
      {"id": "agent_done",    "status": "ok", "at": "2026-10-16T02:23:32.465991Z"},
      {"id": "replied",       "status": "ok", "at": "2026-10-16T02:23:36.450Z", "detail": "tts 1.1 s, vibevoice"},
      {"id": "played",        "status": "ok", "at": "2026-10-16T02:23:39.981Z", "detail": "played to the end, 7702 ms after rendering"}
    ]
  },
  "watcher": {"lanes": {
    "interactive": {"pulling": true, "inFlight": 0, "queued": 0, "slots": 2},
    "batch":       {"pulling": true, "inFlight": 4, "queued": 2, "slots": 4}
  }}
}
```

## Incidental finding

The first attempt at the batch load used non-UUID `--correlation` values. The gateway terminally rejected all six (`correlationid must be an RFC 4122 UUID`), which is the contract working as designed (memo ids are UUIDs). They never ran and caused no harm; the load was re-emitted with UUID correlation ids and a different command id each. Anyone scripting load tests against `invocation.start` must use UUID correlation ids.

## Caveats

- The memo's agent turn was a trivial 8 s reply; the point proved is queue wait, not turn length.
- The "old FIFO" wait for the memo is a calculation, not a measured run. The measured facts are the memo's 22 ms start and the batch commands' 110.7 s and 111.8 s waits in the same window.
- One run. Round 1 only.

---

# Priority lane under load (round 2)

Date: 2026-10-16 (02:40-02:44 UTC, evening of 2026-10-15 local). Result: PASS on the first attempt, no code changes needed. This run is against the build that includes the round-1 fixes (gateway restarted 22:35 EDT with interactive `max_deliver` 8, cross-lane twin termination, lane-loop supervision, `choose_lane` outage handling, `MEMO_LANE` validation).

## What was proved

With the batch lane saturated (4 of 4 slots in flight, 2 more commands queued), a real voice memo recorded on the Honda simulator (`emulator-5554`) was dispatched on the interactive lane and the agent started 18 ms after the dispatch fact. The batch backlog's commands 5 and 6 were still waiting at that moment and waited about 108 s and 110 s. The memo then completed, was answered, spoken and played on the pad.

## Setup

1. Six ordinary `bloodbank.cmd.agent.invocation.start` commands (batch lane) emitted with `bb-emit` to `holocene-pm` in 0.5 s (02:40:18.808 to 02:40:19.287), each with its own UUID command id, correlation id and thread id (see `priority-lane-r2-batch-emit.txt`). Prompt: "Load test N: harmless queue-saturation test. Run the shell command `sleep 100`, then reply with the single line 'batch N done'. Take no other action." The `sleep 100` is the same deliberate deviation from "think briefly" as round 1: a brief turn drains the lane before the memo finishes transcribing (about 42 s), which would defeat the saturation.
2. Saturation confirmed from the NATS monitor `/jsz` at 02:40:21 and 02:40:38 (just before the memo upload), and again 22 s and 29 s after the memo dispatch (02:41:47, 02:41:54): `bloodbank-hermes-gateway` ack_pending 4 (max 4), pending 2; `bloodbank-hermes-gateway-interactive` ack_pending 0, pending 0, one puller waiting.
3. Memo recorded on the simulator with the app already open on the Holocene tile: tapped Record, injected the known utterance through the emulator gRPC mic (`emulator_audio.py inject`, 5.2 s, rms 1267), tapped Stop & Send at 02:40:38.4. No emulator crash, so the upload fallback was not needed. Utterance: "Priority lane test. Please reply with the words lane works." (flite kal16). Whisper heard: "Priority lane test. Please reply with words lane works."

## Numbers

Memo `90de48a9-254c-5fbf-935c-7aea6e51952d`, command `62c3f0c3-6421-49d4-8579-7329e3142c5d`, `bloodbank.cmd.agent.invocation.invoke`, lane `interactive`.

| Hop | Time (UTC) | Delta |
|---|---|---|
| uploaded | 02:40:38.956 | |
| watcher picked up | 02:40:42.011 | +3.1 s |
| transcribed (large-v3, 42.1 s) | 02:41:25.489 | +43.5 s |
| dispatched | 02:41:25.793 | +0.3 s |
| gateway journal row / agent started | 02:41:25.811 | **+0.018 s after dispatch** |
| agent finished (success) | 02:41:30.213 | 4.4 s turn |
| reply rendered (TTS 1.55 s, "lane works") | 02:41:34.636 | +4.4 s |
| played on the pad | 02:41:39.570 | 4.9 s later |

Upload to played: 55.7 s (API `totalSeconds`; `memo:trace` says 56.0 s). Dispatch to agent start: 18 ms.

Batch backlog in the same window (all emitted 02:40:18.8-02:40:19.3):

| Batch cmd | Started (journal row) | Wait from emit | Run | Ended | Outcome |
|---|---|---|---|---|---|
| 1 | 02:40:18.830 | 0.0 s | 112.8 s | 02:42:11.646 | success |
| 2 | 02:40:18.929 | 0.0 s | 110.5 s | 02:42:09.404 | success |
| 3 | 02:40:19.016 | 0.0 s | 108.3 s | 02:42:07.333 | success |
| 4 | 02:40:19.122 | 0.0 s | 111.5 s | 02:42:10.666 | success |
| 5 | 02:42:07.436 | **108.3 s** | 111.4 s | 02:43:58.873 | success |
| 6 | 02:42:09.510 | **110.2 s** | 112.6 s | 02:44:02.115 | success |

When the memo was dispatched (02:41:25.8) batch commands 5 and 6 had already waited 66 s and still had 42 s and 44 s to go, and the four running ones had 42-46 s left. On the old single FIFO consumer the memo would have queued behind 5 and 6 and started when the first slot freed after them, about 02:42:10.7 (counterfactual, computed from the batch slots' end times, not a measured run): a wait of roughly 45 s here, against 18 ms measured. With real grooming turns of 5-11 minutes that wait is the 14 minutes seen in production. Memo wait vs batch queue wait: 0.018 s vs 108-110 s.

All six batch commands completed with outcome success and `/jsz` ended at ack_pending 0, pending 0 on both consumers (02:44:03). The simulator was left running, windowed, with the app open on the Holocene tile showing "reply played".

## Evidence

`mise run memo:trace latest`: `VERDICT  COMPLETE in 56.0s; played on the pad 7.6s after the reply was rendered`. Header: `lane interactive   queues: interactive: pulling, 0/2 in flight, 0 queued | batch: pulling, 2/4 in flight, 0 queued` (read at 02:42:47, after the batch backlog had started draining). Every hop OK: s3_object, upload_proxy_log, fact:uploaded, fact:received, fact:transcribed, fact:dispatched (`-> bloodbank.cmd.agent.invocation.invoke lane=interactive`), gateway_journal (`lane=interactive profile=holocene-pm state=completed outcome=success created=02:41:25.812 updated=02:41:30.214`), agent:invocation.started, agent:invocation.done, hermes_session (the agent saw the exact transcript), fact:replied, reply_object, pad_playback_log, played_on_pad.

Files in this directory: `priority-lane-r2-sim-recording.png` (simulator recording, the batch lane already saturated), `priority-lane-r2-sim-reply-played.png` ("reply played", memo 90de48a9), `priority-lane-r2-api.json` (the API JSON below, saved), `priority-lane-r2-batch-emit.txt` (the six emits with ids).

Holocene API `GET /api/modules/voice/memos/90de48a9-254c-5fbf-935c-7aea6e51952d` (envelopes omitted, hops trimmed to id, status, time, detail; the `watcher.lanes` block is the API's reading after everything had drained, so it shows 0 in flight):

```json
{
  "memo": {
    "memoId": "90de48a9-254c-5fbf-935c-7aea6e51952d",
    "agent": "holocene-pm",
    "status": "complete",
    "reached": "played",
    "lane": "interactive",
    "laneReason": null,
    "totalSeconds": 55.68,
    "commandId": "62c3f0c3-6421-49d4-8579-7329e3142c5d",
    "transcript": "Priority lane test. Please reply with words lane works.",
    "replyText": "lane works",
    "hops": [
      {"id": "uploaded",      "status": "ok", "at": "2026-10-16T02:40:38.956Z"},
      {"id": "received",      "status": "ok", "at": "2026-10-16T02:40:42.011Z", "detail": "watcher lag 3082 ms"},
      {"id": "transcribed",   "status": "ok", "at": "2026-10-16T02:41:25.489Z", "detail": "9 words, 42.1 s, large-v3"},
      {"id": "dispatched",    "status": "ok", "at": "2026-10-16T02:41:25.793Z", "detail": "interactive lane"},
      {"id": "agent_started", "status": "ok", "at": "2026-10-16T02:41:25.811933Z"},
      {"id": "agent_done",    "status": "ok", "at": "2026-10-16T02:41:30.213729Z"},
      {"id": "replied",       "status": "ok", "at": "2026-10-16T02:41:34.636Z", "detail": "tts 1.55 s, vibevoice"},
      {"id": "played",        "status": "ok", "at": "2026-10-16T02:41:39.570Z", "detail": "played to the end, 10418 ms after rendering, 2.41 s of audio"}
    ]
  },
  "watcher": {"lanes": {
    "interactive": {"pulling": true, "waiting": 1, "inFlight": 0, "queued": 0, "slots": 2},
    "batch":       {"pulling": true, "waiting": 1, "inFlight": 0, "queued": 0, "slots": 4}
  }}
}
```

## Caveats

- The memo's agent turn was a trivial 4 s reply; the point proved is queue wait, not turn length.
- The "old FIFO" wait is a calculation, not a measured run.
- The queue state at the instant of dispatch (4 in flight, 2 queued) is shown by `/jsz` samples 22 s later and by the journal start times of commands 5 and 6 (after the dispatch), not by a sample taken in the same second as the dispatch.
- Two runs now (round 1 and round 2), both on the same gateway build family; the starvation limits documented in round 1 (2 interactive slots, no per-turn timeout) were not exercised.

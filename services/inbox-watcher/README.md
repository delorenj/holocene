# Voice memo pipeline (inbox-watcher)

Holocene Auto / Agent Pad records a voice memo, an agent answers it aloud.
This directory is the service that runs the middle of that journey and the
tools to see every hop of it.

```
 Honda sim / phone / browser
   Agent Pad (WebView)                          HOP 1  upload
        | PUT https://agent-pad.delo.sh/upload/inbox/<agent>/<yyyy>/<mm>/<dd>/<ts>.ogg
        v
   agent-pad-upload  (container, services/upload-proxy)
        | mc cp -> MinIO bucket holocene-auto             log: upload {key, bytes, memo_id, status}
        | NATS PUB bloodbank.evt.audio.memo.uploaded      fact: audio.memo.uploaded
        v
   s3://holocene-auto/inbox/<agent>/.../<ts>.ogg         HOP 2  object exists
        | (polled every 5s by holocene-inbox-watcher.service)
        v
   inbox_watcher.py                                      memo_id = uuid5(URL, "s3://holocene-auto/"+key)
        |-- received    fact: audio.memo.received         HOP 3  watcher owns it
        |-- download, then measure the level (ffmpeg)     silent file -> failed(silent_audio), no transcription spent
        |-- `transcribe` (faster-whisper)                 HOP 4  speech to text
        |-- transcribed fact: audio.memo.transcribed      (text, seconds, model, audio duration, max/mean dBFS)
        |-- bb-emit --kind command                        HOP 5  dispatch
        |     bloodbank.cmd.agent.invocation.invoke       (interactive lane; .start = batch lane, the fallback)
        |                                                 correlationid = memo_id, thread_id = memo_id,
        |     target_agent_id = <agent from the S3 key>   context.memo_id / memo_key
        |-- dispatched  fact: audio.memo.dispatched       (command_id, lane, lane_reason)
        v
   NATS JetStream BLOODBANK_COMMANDS                     HOP 6  queued
        | durable pull consumer "bloodbank-hermes-gateway-interactive" (2 reserved slots; "bloodbank-hermes-gateway" = batch, 4)
        v
   Hermes gateway (hermes-gateway.service, bloodbank plugin)   HOP 7  agent turn
        |-- executions row (command_id)  ~/.hermes/bloodbank-hermes-gateway-state.sqlite3
        |-- facts agent.invocation.started / completed / failed  (same correlationid)
        |-- the reply is saved in the target profile's state.db (source 'bloodbank', chat_id = memo_id)
        v
   inbox_watcher.py   (correlates by command_id, never "latest row")
        |-- reads that session's last assistant message   HOP 8  reply text
        |-- vox /synthesize-url (voice rick) -> OGG        HOP 9  TTS
        |-- mc cp -> replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>.ogg    HOP 10 reply object
        |-- replied     fact: audio.memo.replied
        v
   Agent Pad polls replies/<today>/ every 15s and plays the newest new key   HOP 11 playback
        |-- POST /upload/played {reply_key, phase}  -> upload proxy log line "playback"
        |-- played      fact: audio.memo.played (phase started|ended)  or  failed(stage=playback, retryable)

   Any stage can instead publish   audio.memo.failed {stage, error_code, error_message, retryable, attempt}
```

One id ties it together: **memo_id**. It is the Bloodbank `correlationid` of
every `audio.memo.*` fact, of the invocation command, and (inherited from the
command) of the gateway's `agent.invocation.*` / `conversation.turn.*` facts.
So this single query returns the whole journey:

```bash
curl -s "http://127.0.0.1:8683/events?correlationid=<memo_id>&limit=100"
```

## See it: `mise run memo:trace`

```bash
mise run memo:trace latest            # newest inbox memo
mise run memo:trace <memo_id>         # full uuid or 8+ char prefix
mise run memo:trace 20261015T192554Z.ogg   # file name or full inbox key
mise run memo:trace latest --logs     # + the watcher's log lines for it
mise run memo:list                    # last 15 memos and the furthest stage each reached
mise run memo:list -n 40
```

Each hop prints OK / MISSING / FAILED / UNKNOWN with its timestamp and the
latency since the previous hop, and the run ends with one verdict line:

```
VERDICT  STOPPED AT gateway_journal: gateway never created an execution row for <command_id> (lane=batch); batch: pulling (busy: 4/4 in flight, 22 queued ahead) ...
VERDICT  COMPLETE in 71.4s
```

Exit code is 0 only for COMPLETE.

## Every hop, its evidence, and the command that shows it

| hop | evidence | command |
|---|---|---|
| s3_object | object in the inbox | `mc stat delo/holocene-auto/<key>` |
| upload_proxy_log | one JSON line per PUT | `docker logs agent-pad-upload \| grep <memo_id>` |
| fact:uploaded | proxy -> NATS (fail-open) | `curl -s 'http://127.0.0.1:8683/events?correlationid=<memo_id>&type=bloodbank.audio.memo.uploaded'` |
| fact:received / transcribed / dispatched / replied / failed | the watcher's facts | same query, other `type` (or no `type` for all) |
| watcher log | one JSON line per stage (`memo_id`, `key`, `agent`, `stage`, `ms`) | `journalctl --user -u holocene-inbox-watcher.service -o cat \| grep <memo_id>` |
| watcher state | per-memo stage, attempts, command id | `jq '.memos["<key>"]' ~/.local/state/holocene-auto/inbox-watcher/state.json` |
| watcher alive | heartbeat written every tick | `cat ~/.local/state/holocene-auto/inbox-watcher/heartbeat.json`, `systemctl --user status holocene-inbox-watcher` |
| command queued | JetStream consumer state (one consumer per lane) | `curl -s 'http://127.0.0.1:8222/jsz?consumers=true&streams=true&config=true'` -> BLOODBANK_COMMANDS / consumer `bloodbank-hermes-gateway-interactive` (memos) or `bloodbank-hermes-gateway` (batch): `num_waiting` or `num_ack_pending` >= 1 means somebody is pulling; `num_pending` is the queue |
| gateway_journal | execution row, keyed by command id | `sqlite3 -readonly ~/.hermes/bloodbank-hermes-gateway-state.sqlite3 "select state,outcome,profile,created_at,updated_at from executions where command_id='<command_id>'"` |
| agent:invocation.* | gateway lifecycle facts (same correlationid) | Candystore query above, `type=bloodbank.agent.invocation.completed` etc. |
| reply text | the session the gateway opened for this memo | `sqlite3 -readonly ~/.hermes/profiles/<profile>/state.db "select role,substr(content,1,200) from messages where session_id=(select id from sessions where source='bloodbank' and chat_id='<memo_id>') order by timestamp"` |
| reply_object | the TTS audio | `mc stat delo/holocene-auto/<reply_s3_key>` |
| audio level | loudest/mean sample in dBFS, measured before transcribing (`audio_max_dbfs`, `audio_mean_dbfs` on `transcribed` and on every transcribe-stage `failed`); `audio_level` hop in `memo:trace`; `device heard peak ...` from the pad when it sends `data.capture` | `ffmpeg -i <file> -af volumedetect -f null -` |
| device-side events | record start/stop/failure and upload failure from the pad | `docker logs agent-pad-upload \| grep '"event":"client"'`; failures are `failed(stage=record\|upload)` facts |
| played | the pad's beacon (`started`/`ended`/`blocked`/`error`/`skipped`) | `docker logs agent-pad-upload \| grep '"event":"playback"'`, `audio.memo.played` |

Holocene itself (`https://holocene.delo.sh`) collects every `bloodbank.evt.>`
envelope; the `audio.memo.*` facts and the gateway facts are in its event
store like any others.

## The watcher

`holocene-inbox-watcher.service` (systemd user unit, `Restart=always`):

```bash
mise run memo:watcher:install     # symlink unit into ~/.config/systemd/user, enable, restart
mise run memo:watcher:logs        # follow the JSON log
mise run memo:test                # state-machine tests, every external hop faked
```

Behaviour worth knowing:

- **Routing is explicit.** The target agent is parsed from the S3 key path
  (`inbox/<agent>/...`) and never inferred from the audio or the transcript.
  A key with no agent segment is logged `skipped` and left alone.
- **First start baselines.** If the state file does not exist, every object
  already in `inbox/` is recorded as `baseline` and never processed. Objects
  older than `MEMO_MAX_AGE_HOURS` (24) that show up later are skipped too.
- **Date boundaries do not matter.** It lists the whole `inbox/` tree each poll.
- **No double dispatch.** The command id is persisted before publishing, and the
  idempotency key is derived from (type, memo_id). After a crash between publish
  and bookkeeping, the watcher checks the gateway journal for that command id
  before it would publish again.
- **Correlation is exact.** Completion is the gateway journal row for the
  command id (fallback: Candystore `agent.invocation.completed/failed` with the
  memo's correlationid and that `command_id`). The reply is read from the
  session whose `chat_id` is the memo's unique `thread_id`. Nothing looks at
  "latest row for profile" or file mtimes.
- **Bounded retries.** Deterministic stages (transcribe, reply text) retry up
  to `MEMO_MAX_ATTEMPTS` (3). Infrastructure stages (download 10 min, dispatch
  15 min, tts and reply upload 30 min) retry on a **time budget** with capped
  exponential backoff (`MEMO_RETRY_BUDGET_S` overrides all), so a minute of vox
  or NATS trouble after the agent already ran cannot strand its work. Each
  failure publishes `failed(retryable=true)`, the last `failed(retryable=false)`.
- **`mise run memo:retry <memo_id>`** revives a failed or skipped memo at the
  stage it died in (the watcher owns state.json, so the command drops a file in
  `<state>/control/`). `memo_failed` log lines print the exact command.
- **Memos ride the interactive lane.** The watcher publishes
  `bloodbank.cmd.agent.invocation.invoke`, delivered through its own durable
  consumer (`bloodbank-hermes-gateway-interactive`, 2 reserved slots), so a
  memo starts within seconds even when a grooming burst holds all 4 batch slots
  (design: `bloodbank/docs/interactive-command-lane.md`). `MEMO_LANE=batch`
  puts memos back on `invocation.start` (the rollback lever; restart the
  watcher, no gateway restart). Before the first publish of a command id the
  watcher probes the interactive consumer (NATS monitor, two failed probes
  1.5 s apart, `MEMO_LANE_PROBE_GAP_S`, both lanes from ONE monitor read); if
  nobody is pulling interactive but batch IS pulling (lane disabled, durable
  missing), it sends on the batch lane instead, logs `lane_fallback` and stamps
  `lane=batch`, `lane_reason=interactive_consumer_not_pulling` on the
  `dispatched` fact. If neither lane has a puller the gateway itself is down or
  restarting (about 2 min), and batch would only park the memo behind the
  grooming backlog, so the memo stays on `invoke` (logs `lane_kept`,
  `lane_reason=gateway_not_pulling_queued_on_interactive`); the interactive
  durable drains first on reconnect. An unreadable monitor keeps the
  interactive lane. An unrecognised `MEMO_LANE` makes the watcher refuse to
  start (exit 2, `bad_memo_lane` on stderr) rather than guess. **The lane is pinned to the
  command id** (the idempotency key, digest and journal row differ by type), so
  a dispatch retry never hops lanes; `memo:retry` of a failed agent stage gets
  a fresh command id and may pick a fresh lane. A memo dispatched before lanes
  existed (no `lane` in state.json) is treated as batch.
- **The agent deadline stretches while the command is verifiably queued or
  running.** `MEMO_AGENT_TIMEOUT_S` (600) is extended one period at a time, up
  to `MEMO_QUEUE_MAX_WAIT_S` (3600), while the memo's OWN lane's consumer has
  commands ahead of ours or the journal row says running (an interactive memo
  is not extended on account of grooming; one that blows its deadline is a real
  alarm, not queue noise). If it still hits the deadline it fails
  `agent_reply/timeout`, but keeps watching the command for
  `MEMO_RESCUE_WINDOW_S` (2 h): when the agent finishes late the reply is
  spoken anyway ("<agent>, late reply. ...").
- **A turn the gateway timed out is its own final outcome.** The interactive lane
  stops any Hermes turn that outlives its wall clock
  (`extra.interactive.turn_timeout_seconds`, default 300 s; bloodbank
  `services/hermes-gateway/README.md`, "Per-turn wall clock"). The gateway closes the journal row
  `completed / failure / failure_code=turn_timeout` and publishes
  `agent.invocation.failed` with `error_code=turn_timeout`. The watcher reads either, and fails the memo
  `failed(stage=agent_reply, error_code=turn_timeout, retryable=false)` with the gateway's own text
  (`agent turn timed out after 300s on interactive lane (limit 300s)`) plus `lane`, `elapsed_seconds`,
  `timeout_seconds`, `timeout_source` (`lane` | `envelope`) and `turn_stopped` (false = Hermes did not confirm the
  stop). It is not `agent/agent_failure`, it is not retried and nothing waits out the 600 s deadline. `memo:retry`
  sends a FRESH command (a new command id, possibly a new lane); the old one is dead and its slot is already free.
  `bloodbank-ntfy-router` pushes the `failed` fact like any terminal memo failure.
- **A command the gateway consumed and dropped is detected.** No journal row
  while the memo's lane consumer is empty (`pending=0 ack_pending=0`) for 15 s after 20 s
  means it was rejected before starting (unroutable target): the memo fails
  `agent/gateway_terminated` with the gateway's own WARNING line in the
  message. Better still, the agent id is checked against
  `~/.hermes/agents-registry.yaml` right after `received`, so an unknown or
  disabled agent fails `dispatch/unknown_agent` in milliseconds, not after a
  45 s transcription and a 10 minute wait.
- **Nothing blocks the loop.** transcribe, dispatch and speak run on worker
  threads (one transcription at a time); `tick()` keeps discovering, polling the
  journal, flushing the outbox and writing `heartbeat.json` (which lists which
  memo is running and for how long). The transcribe timeout is
  `max(MEMO_TRANSCRIBE_TIMEOUT_S, 60 + 8 x audio seconds)` from `ffprobe`, and
  grows after a timeout instead of repeating.
- **Bad audio fails fast.** `ffprobe` rejects undecodable uploads
  (`undecodable_audio`), recordings under 0.7 s (`too_short`), and Whisper's
  noise hallucinations ("Thank you.", "you", ...) never become prompts
  (`garbage_transcript`); all terminal. Skipped memos (no agent in the key, older
  than 24 h) publish `failed(stage=receive, code=no_agent|too_old)`.
- **A silent recording names the microphone, not the transcript.** After the
  download and before Whisper the watcher runs `ffmpeg -af volumedetect` and puts
  the loudest and mean sample (`audio_max_dbfs`, `audio_mean_dbfs`, dBFS) on the
  `transcribed` fact and on every transcribe-stage `failed` fact. A recording
  whose loudest sample is below `MEMO_SILENT_MAX_DBFS` (default -60) fails at once
  with the terminal code `silent_audio` and no transcription is spent:
  `recording is silent (max -73 dBFS, mean -83 dBFS over 6.4 s): the microphone
  delivered no sound; on the simulator run mise run auto:sim:mic-check, in the car
  check the mic permission and mute`. The line was chosen from the bucket: every
  real recording peaks at -16 dBFS or louder, the two dead-mic memos of
  2026-10-16 (a corked emulator capture) peak at -73 / -75, digital silence reads
  -91, and a live mic in a quiet room sits around -45 to -35. `empty_transcript`
  now means audible-but-unrecognised and says so
  (`audible (max -20 dBFS, mean -31 dBFS over 6.4 s) but no words recognised`).
  An unmeasurable file (no ffmpeg) skips the check and behaves as before.
  `memo:retry` re-enters at transcribe, so it re-runs the level check.
- **The agent is told it is a transcript.** The prompt is
  `MEMO_VOICE_PREFIX` + transcript. After the turn the watcher compares the
  session's first user message with what it sent (`prompt_match` on the
  `replied` fact, `hermes_session` hop in `memo:trace`).
- **One reply object per memo.** The reply key is fixed on the first attempt,
  so a retry overwrites instead of leaving a second file the pad would play.
  The spoken reply starts with the agent's name.
- **One watcher.** `<state>/lock` (flock): a second instance (for example
  `--once --drain` run by hand while the service is up) exits with
  `already_running`. A corrupt state.json is moved aside, not crash-looped.
- **Facts never block the pipeline.** If NATS refuses a fact it is kept in the
  state file's outbox and re-published in order on later ticks.
- **Transcripts stay out of the vault.** `transcribe --ephemeral` only skips S3
  archiving; the watcher also passes `--output <tmpdir>` so nothing lands in
  `~/d/Transcripts`.
- **GPU contention.** On this box the RTX 3090 is usually occupied, so
  `transcribe` falls back to CPU int8 large-v3 (about 40 s for a 2 s clip).
  `MEMO_TRANSCRIBE_TIMEOUT_S` (420) is the ceiling.
- **Spoken reply** is cleaned (code blocks, links, markdown removed) and cut to
  `MEMO_SPEAK_CHARS` (500) at a sentence boundary. The `replied` fact carries
  the full reply text and `tts_engine` (watch for `elevenlabs`: it means the
  cloned voice engines were down).

Configuration is env only (see the unit file): `MEMO_AGENT_TIMEOUT_S`,
`MEMO_TRANSCRIBE_TIMEOUT_S`, `MEMO_MAX_ATTEMPTS`, `MEMO_POLL_S`,
`MEMO_MAX_AGE_HOURS`, `MEMO_SPEAK_CHARS`, `MEMO_VOX_VOICE`, `TRANSCRIBE_DIR`,
`MEMO_LANE` (`interactive` default | `batch`), `MEMO_LANE_PROBE_GAP_S`.
The heartbeat (`heartbeat.json`) carries `lane` and `lanes.{interactive,batch}`
(`ok`, `waiting`, `ack_pending`, `pending`, `max_ack_pending`, probed every 5 s
off the tick thread); `/voice` reads it.
S3 access is the `delo` alias in `~/.mc/config.json`; the unit holds no secrets.

## Bloodbank facts

Defined in the bloodbank repo (`schemas/bloodbank/audio/memo.*.json`, entity
`memo`, actions `uploaded|received|transcribed|dispatched|replied|failed`,
ordering key `memo:<memo_id>`). Validate a sample without publishing:

```bash
echo '{"memo_id":"...","s3_key":"...","target_agent_id":"holocene-pm","transcript_text":"hi"}' \
  | /home/delorenj/code/33GOD/bloodbank/bin/bb-emit --check --type bloodbank.audio.memo.transcribed --correlation <memo_id>
```

`bb-emit` gained `--command-id` (persist the id before publishing) and
`--print-ids` (JSON line with id, command_id, idempotency_key on stdout).

## Upload proxy

`services/upload-proxy/upload_proxy.py` runs in the `agent-pad-upload`
container (compose: `~/docker/stacks/websites/agent-pad/compose.yml`). It logs
one JSON line per PUT, accepted or rejected, and publishes the `uploaded` fact
over raw NATS to `host.docker.internal:4222` (compose maps it with
`extra_hosts: host-gateway`). A PUT whose body is shorter than its
Content-Length (a cell drop mid-upload) is rejected 400 `short_body` and
published as `failed(stage=upload)`; an `.ogg` key must hold an `OggS` stream.
`POST /upload/client-event` takes the device-side events from the pad (see the
hop table). After editing it:

```bash
cd ~/docker/stacks/websites/agent-pad && docker compose up -d --force-recreate agent-pad-upload
```

## Verified live (2026-10-15)

A synthetic memo (flite "reply with the single word pong", uploaded through
`https://agent-pad.delo.sh/upload/`) went through every hop to `COMPLETE`:
upload log + `uploaded` fact, `received` (+0.25 s), transcribed in 40 s (CPU
int8, GPU full), dispatched, gateway journal row, `invocation.started/completed`
(5 s turn), TTS 1 s, reply uploaded, `replied`. The 938 s total was almost all
the command waiting behind 20 stale n8n grooming commands in JetStream; the
trace showed `pulling (busy: 4 in flight, N queued ahead)` the whole time. An
earlier run with a 600 s deadline correctly ended `failed(stage=agent_reply,
retryable=false)` with that queue state in the message.

## Known limits

- The interactive lane has 2 slots (`gateway.platforms.bloodbank.extra.interactive.max_inflight`):
  a third concurrent memo waits for a slot behind two running ones. If the
  interactive consumer is down but batch is up the memo is answered late on
  the batch lane, not failed; if the whole gateway is down it waits on the
  interactive lane. A turn that never completes no longer holds its slot forever: the gateway stops it
  after `turn_timeout_seconds` (300 s) and the memo fails `agent_reply/turn_timeout`. Memos are the only
  producer on `invoke`; n8n, PMs and `hookd_bridge` stay on `start`.
- Playback is reported by the page's audio element, not by capturing the
  audible output; a car switched off mid-reply never reports `ended`.
- The gateway publishes lifecycle facts only, not the reply text, so the
  watcher reads the reply from the Hermes profile `state.db`.
- If the gateway's bloodbank platform is down, commands queue in JetStream and
  the trace verdict says `NOBODY PULLING <lane>`. Commands run when it comes back.
- `reply_renderer.py` was folded into this service and deleted.

## Voice memos view

https://holocene.delo.sh/voice draws the same hop-by-hop journey as `memo:trace`, live (4 s refresh), from the
Bloodbank collection Holocene already keeps: `GET /api/modules/voice/memos` (list) and
`/api/modules/voice/memos/<memo_id>` (timeline). Each hop shows its time, latency since the previous hop and raw
event JSON; failed hops carry the error; a hop that is older than its expected latency with nothing after it gets a
STUCK badge (budgets: pickup 30 s, transcribe 180 s, dispatch 30 s, agent start 120 s, agent finish 600 s, reply 60 s,
in `apps/api/src/voice-memos.ts`). Holocene only reads; nothing there publishes.

The list shows a lane chip per memo (`interactive`, or `batch (fallback)` with the reason on hover), taken from the
`dispatched` fact's `lane` (older facts: parsed from `command_subject`, else batch). While a memo waits at "Agent started" the
hop shows its lane's queue (`interactive lane: 1/2 in flight, 0 queued`, from the watcher heartbeat). A banner appears when the
watcher is configured for the interactive lane but nobody is pulling that consumer. `mise run memo:trace` prints
`lane <lane>   queues: interactive: pulling, 0/2 in flight, 0 queued | batch: pulling, 4/4 in flight, 17 queued`,
and `mise run memo:list` has a LANE column.

A silent recording reads as its own outcome too: the list and header show a level chip (`max -73 dBFS · silent`, red when
silent), the stage label is `Silent microphone` (`No words recognised` for audible audio Whisper could not read), the
**Transcribed** hop is failed with `silent_audio` and the measured level, and the **Recorded and uploaded** hop shows
`device heard peak -71 dBFS, window avg -80 dBFS` when the pad reports its own capture level (`data.capture.peak_dbfs` /
`rms_dbfs` on the uploaded fact; the device's `rms_dbfs` is the RMS of its 100 ms window peaks, so it reads louder than the
watcher's true mean and is labelled "window avg"). `memo:trace` prints an `audio_level` line and ends
`STOPPED AT transcribe: SILENT MICROPHONE - recording is silent (max -73 dBFS, ...)`.

A turn timeout reads as its own outcome everywhere: the list stage label is `Agent turn timed out after 300s`,
the **Agent finished** hop is failed with `turn_timeout` / `agent turn timed out after 300s on interactive lane (limit 300s)`
and a meta line (`turn stopped · interactive limit 300s`, or `stop not confirmed, the turn may still be unwinding`), and
`memo:trace` ends `STOPPED AT agent finished: turn timeout - agent turn timed out after 300s on interactive lane (limit 300s)`.

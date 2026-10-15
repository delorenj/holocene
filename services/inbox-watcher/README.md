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
        |-- download + `transcribe` (faster-whisper)      HOP 4  speech to text
        |-- transcribed fact: audio.memo.transcribed      (text, seconds, model, audio duration)
        |-- bb-emit --kind command                        HOP 5  dispatch
        |     bloodbank.cmd.agent.invocation.start        correlationid = memo_id, thread_id = memo_id,
        |     target_agent_id = <agent from the S3 key>   context.memo_id / memo_key
        |-- dispatched  fact: audio.memo.dispatched       (command_id)
        v
   NATS JetStream BLOODBANK_COMMANDS                     HOP 6  queued
        | durable pull consumer "bloodbank-hermes-gateway"
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
VERDICT  STOPPED AT gateway_journal: gateway never created an execution row for <command_id>; pulling (busy: 4 in flight, 22 queued ahead) ...
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
| command queued | JetStream consumer state | `curl -s 'http://127.0.0.1:8222/jsz?consumers=true&streams=true'` -> BLOODBANK_COMMANDS / consumer `bloodbank-hermes-gateway`: `num_waiting` or `num_ack_pending` >= 1 means somebody is pulling; `num_pending` is the queue |
| gateway_journal | execution row, keyed by command id | `sqlite3 -readonly ~/.hermes/bloodbank-hermes-gateway-state.sqlite3 "select state,outcome,profile,created_at,updated_at from executions where command_id='<command_id>'"` |
| agent:invocation.* | gateway lifecycle facts (same correlationid) | Candystore query above, `type=bloodbank.agent.invocation.completed` etc. |
| reply text | the session the gateway opened for this memo | `sqlite3 -readonly ~/.hermes/profiles/<profile>/state.db "select role,substr(content,1,200) from messages where session_id=(select id from sessions where source='bloodbank' and chat_id='<memo_id>') order by timestamp"` |
| reply_object | the TTS audio | `mc stat delo/holocene-auto/<reply_s3_key>` |
| played | **not observable**: the pad only polls the bucket | open the pad |

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
- **Bounded retries.** Each stage retries up to `MEMO_MAX_ATTEMPTS` (3) with
  exponential backoff, publishing `failed(retryable=true)` per failure and
  `failed(retryable=false)` when it gives up. Waiting for the agent has a
  deadline (`MEMO_AGENT_TIMEOUT_S`, default 600) after which it publishes
  `failed(stage=agent_reply, retryable=false)` with the gateway queue state in
  the message. A command that finishes after that deadline gets no spoken reply.
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
`MEMO_MAX_AGE_HOURS`, `MEMO_SPEAK_CHARS`, `MEMO_VOX_VOICE`, `TRANSCRIBE_DIR`.
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
`extra_hosts: host-gateway`). After editing it:

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

- No playback hop: the pad polls the bucket and reports nothing back.
- The gateway publishes lifecycle facts only, not the reply text, so the
  watcher reads the reply from the Hermes profile `state.db`.
- If the gateway's bloodbank platform is down, commands queue in JetStream and
  the trace verdict says `NOBODY PULLING`. Commands run when it comes back.
- `reply_renderer.py` was folded into this service and deleted.

## Voice memos view

https://holocene.delo.sh/voice draws the same hop-by-hop journey as `memo:trace`, live (4 s refresh), from the
Bloodbank collection Holocene already keeps: `GET /api/modules/voice/memos` (list) and
`/api/modules/voice/memos/<memo_id>` (timeline). Each hop shows its time, latency since the previous hop and raw
event JSON; failed hops carry the error; a hop that is older than its expected latency with nothing after it gets a
STUCK badge (budgets: pickup 30 s, transcribe 180 s, dispatch 30 s, agent start 120 s, agent finish 600 s, reply 60 s,
in `apps/api/src/voice-memos.ts`). Holocene only reads; nothing there publishes.

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
        |-- warm GPU whisper :8766, else `transcribe` CLI  HOP 4  speech to text (holocene-whisper.service)
        |-- transcribed fact: audio.memo.transcribed      (text, seconds, model, backend, device, fallback_reason,
        |                                                  audio duration, max/mean dBFS)
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
        |-- agent.invocation.progressed  0..n: every line the model writes next to a tool call (seq 1..n, text <= 500)
        |-- the reply is saved in the target profile's state.db (source 'bloodbank', chat_id = memo_id)
        v
   inbox_watcher.py   (correlates by command_id, never "latest row")
        |-- WHILE THE AGENT WORKS (progress thread, Candystore every 1.5 s):
        |     newest progress line -> status object (below)
        |     spoken: vox (same voice, 6 steps, ~2 s) -> progress/<yyyy>/<mm>/<dd>/<memo_id>-<n>.ogg
        |       never in the turn's first 15 s, at most one per 30 s, newest line wins, none once the turn is done
        |     narrated   fact: audio.memo.narrated {seq, narration n, progress_s3_key, tts_seconds}
        |-- reads that session's last assistant message   HOP 8  reply text
        |-- vox /synthesize-url (voice rick) -> OGG        HOP 9  TTS
        |-- mc cp -> replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>.ogg    HOP 10 reply object
        |-- replied     fact: audio.memo.replied
        |-- EVERY stage change and progress line: status/<yyyy>/<mm>/<dd>/<memo_id>.json (the car's view)
        v
   Agent Pad polls replies/ every 2 s for 10 min after a send (else 15 s), plays in order   HOP 11 playback
        |-- and the memo's status object on the same poll: tile line "Working 1:20 · <progress>", heard echo, progress clips
        |-- POST /upload/played {reply_key, phase}  -> upload proxy log line "playback"
        |-- played      fact: audio.memo.played (phase started|ended)  or  failed(stage=playback, retryable)
        |-- the car's ONE speech queue (SpeechArbiter): ack on Stop & Send, heard echo, progress, reply, never over a
        |   recording or each other; every decision POST /upload/client-event {event: speech} -> log line "speech",
        |   and memo-tied start|end|halt|drop|deferred -> notified fact: audio.memo.notified

   Any stage can instead publish   audio.memo.failed {stage, error_code, error_message, retryable, attempt}
```

## While the agent works: status object and spoken progress

Measured on six real memos (2026-10-19/20): upload to dispatch under 2 s, transcription 5-6 s, the agent turn
102-231 s, the reply's TTS 8-19 s. The wait is real work, so the car is told what is happening instead of sitting
silent:

| when | what the driver gets | from |
|---|---|---|
| Stop & Send, ~0.5 s | "Got it, <agent>'s on it" (local Android TTS, no server) | the car |
| transcription done, ~7 s | "<agent> heard: <first words>" | `status.heard` |
| every 30 s while the agent works (not before 15 s) | "<agent>: <newest progress line>" | `progress/...-<n>.ogg` |
| the turn is done | the reply, as before | `replies/` |

**Status object** `status/<yyyy>/<mm>/<dd>/<memo_id>.json` in `holocene-auto` (the inbox key's day, so the car names it
from the key it uploaded; anonymous read, `Cache-Control: no-store`), rewritten on every stage change and every new
progress line by one writer thread (newest document per memo wins, a failed write is retried):

```json
{"v": 1, "memo_id": "...", "agent": "holocene-pm", "agent_name": "Holocene PM", "s3_key": "inbox/holocene-pm/...",
 "stage": "received|transcribing|heard|working|replying|done|failed",
 "heard": "<first 200 chars of the transcript>", "progress": "<newest progress line, one line, <= 200>",
 "progress_seq": 7, "progress_at": "...", "spoken_seq": 2, "spoken_key": "progress/2026/10/20/<memo_id>-2.ogg",
 "narration": {"n": 2, "key": "...", "seq": 7, "at": "...", "text": "..."},
 "started_at": "<upload time>", "dispatched_at": "...", "updated_at": "...", "elapsed_s": 81.4,
 "command_id": "...", "lane": "interactive", "late": false, "escalated": false, "reply_key": null,
 "error_code": "silent_audio", "error": "..."}
```

Both prefixes expire after 7 days (bucket lifecycle rules on `status/` and `progress/`, set 2026-10-20: `mc ilm rule ls delo/holocene-auto`).

`progress_seq` is the gateway's seq (it restarts at 1 on an escalated memo's batch command); `spoken_seq` is the newest
clip number, 1..n per memo, the one the pad plays up to. `error`/`error_code` only on `failed` (a `memo:cancel` is
`failed` with `error_code: cancelled`).

**Spoken progress** comes from `bloodbank.agent.invocation.progressed`, which the Hermes gateway publishes for every
line the model writes next to a tool call (bloodbank `services/hermes-gateway/README.md`, "Progress"). Most memo turns
wrote none (0-4 of 8-18 tool rounds, 2026-10-20), so the voice prefix asks for one short sentence before each tool call
(`MEMO_VOICE_PREFIX` overrides it). The watcher renders the newest line with the reply's voice at
`MEMO_PROGRESS_TTS_STEPS` (6) steps: about 2 s on voxcpm. vox has no per-request engine choice and vibevoice is not in
`VOX_ENGINES` on this host today, so "the fast engine" is voxcpm with fewer steps. A render in flight when the turn
finishes is dropped before upload (`narration_dropped reason=turn_finished`); one that lands while the reply is still
rendering stays, and the car's speech queue drops progress that would play after a reply. Progress never goes to the
Earshot bucket, so the phone plays replies only. Knobs: `MEMO_PROGRESS_POLL_S` (1.5), `MEMO_NARRATE_FIRST_S` (15),
`MEMO_NARRATE_GAP_S` (30), `MEMO_NARRATE_MAX` (20 per memo), `MEMO_NARRATE_CHARS` (140), `MEMO_PROGRESS_VOICE` (the
reply voice), `MEMO_PROGRESS_TTS_STEPS` (6).

Log lines: `progress` (a new line adopted), `narrated`, `narration_dropped`, `narration_failed`, `status_write_failed`,
`progress_read_failed`. `memo:trace` shows `agent:progress#<seq>` and `car:narrated#<n>` hops inside each turn (a long
turn shows its first and last three lines), a `car_status_object` hop, a "car speech" block (every arbiter decision,
relative to the upload) and one timing line: `since upload: ack -0.4s | heard-echo +7.1s | first progress +19.0s |
first narration +31.2s | progress played +32.0s | reply played +128.5s`. Holocene `/voice` shows the same under the
memo's summary, and the newest progress line on a running memo's row.

## The reply, sentence by sentence, pushed to the car

**Chunked speech.** vox renders a 500-character reply in 8-19 s, and the car used to hear nothing until all of it was
done. A spoken reply longer than `MEMO_CHUNK_MIN_CHARS` (160) is now split at sentence ends into chunks that grow
(`MEMO_CHUNK_CHARS` 110,170,300: the first renders in about 3 s, the second is ready before the first finished
playing). Each chunk is rendered, uploaded as `replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>-c<ii>of<nn>.opus`
(Ogg/Opus, `Content-Type: audio/ogg`) on a publisher thread while vox renders the next one (vox serves one request at a
time: two at once each take twice as long), and announced as `audio.memo.voiced` {chunk, chunks, chunk_s3_key,
reply_s3_key, spoken_text, tts_seconds, since_reply_seconds, since_agent_done_seconds}. Then ffmpeg joins the chunks
into the full reply `replies/...-<memo_id>.ogg` (re-encoded; a failed join falls back to rendering it whole), which is
the reply of record: the `replied` fact (now with `reply_chunks`, `first_chunk_seconds`, `last_chunk_seconds`,
`full_seconds`), the Earshot mirror and older pads use it. The `.opus` extension is deliberate: a pad page from before
chunking only plays `.ogg/.webm/.m4a/.mp3`, so it never plays a chunk as a separate reply. A chunk key sorts just before
its full key and names its count, so a pad that only lists still knows when it has them all. A cancel between chunks
takes every uploaded chunk back; a speak-stage retry re-uploads the same keys and announces each chunk once.
`MEMO_REPLY_CHUNKS=0` turns it off. The status object carries `reply_chunks {n, voiced}` while it happens.
Chunks are uploaded with the object tag `kind=chunk`, and a bucket lifecycle rule expires them after a day (the full
file holds the same audio): `mc ilm rule add --tags "kind=chunk" --expire-days 1 delo/holocene-auto`.

**Push channel.** The upload proxy keeps one core NATS subscription to `bloodbank.evt.audio.memo.>` and
`bloodbank.evt.agent.invocation.progressed` and serves `GET /upload/events` on the pad's own host (Server-Sent Events,
through Cloudflare and Traefik): one `memo` event per received / transcribed / dispatched / narrated / voiced / replied /
failed fact and per memo-turn progress line, reduced to the ids and keys the car needs, a `beat` every 15 s (with
whether NATS is up), a `hello` on connect, ids `<boot>-<n>` with a 200-event replay ring for `Last-Event-ID`, and each
stream recycled after 3 min (`PUSH_MAX_AGE_S`; the pad reconnects about 3 s later and the ring replays the gap). The pad subscribes for as long as it runs: a `voiced` or `replied` event queues the
chunk or reply at once (no listing), `narrated` fetches that progress clip, anything else re-reads the memo's status
object. Polling stays the fallback; with the stream live the fast reply poll relaxes from 2 s to 6 s, and a stream
that is silent for 45 s is dropped and reopened. `docker logs agent-pad-upload | grep '"event":"push'` shows streams
opening and closing and NATS going up or down.

**Only the sending pad plays a reply, and exactly one of the car and the phone speaks it.** A pad keeps the ids of
the memos it uploaded (IndexedDB, it survives the car's cold start) and plays only their replies (`?replies=all` in a
browser opts back into every reply). It names its device (a random id) and host (`car` or `browser`) on the PUT
(`X-Holocene-Device`, `X-Holocene-Host`, kept as S3 metadata on the inbox object and as `device_id` / `device_host` on
`audio.memo.uploaded`) and on its push stream (`/upload/events?device=&host=`).

The phone's Earshot copy plays through the car's speakers when the phone is paired with it, so a reply the car speaks
must not go to the phone (twice, or into the next recording), and a reply the car does NOT speak must (a car switched
off right after the agent finished heard it nowhere while the rule was "the car is connected": an edge keeps a dead
car's push stream open for minutes). The upload proxy decides who, atomically (`POST /upload/claim`, `ReplyClaims` in
`services/upload-proxy`):
- **The car** (the pad page, host `car`) holds every reply it means to play as soon as it learns of it, renews the hold
  every 5 s while the reply waits in its queue (behind a recording, another reply) **and until its audio really starts**
  (the host's `started`), and claims its **start at that moment**, not when the page hands the reply to the host. A
  playback that fails before any audio **releases** the hold, so the phone may take the reply at once. A hold is a 20 s
  lease: a car that is switched off lets go within 20 s. Its playback beacon and its speech queue's
  `start` also count as its start (a page from before claims).
- **The watcher**, once the car's copy is up, offers the reply (a one-file reply is pushed to the car right then, as
  `offered`, so the car does not wait for the `replied` fact) and asks to take it for the phone. The take is refused
  while the car holds or has started the reply; it is granted when no car claimed it within `MEMO_EARSHOT_CAR_GRACE_S`
  (20: the pad's 15 s idle poll plus a margin; it was 12, shorter than that poll, and a live car that missed a push
  lost its reply to the phone) of its first audio being up (chunk 1, or the one file), or when the car's lease lapsed.
  The pad now also keeps its fast reply poll for as long as a memo is in flight. A live car that keeps
  holding it is waited for, at most `MEMO_EARSHOT_HOLD_MAX_S` (300), then left to it.
- **A granted take is final, unless the drop fails.** A car that comes back later (an ignition, a reconnect) is refused
  its hold and its start and leaves the reply to the phone (the page logs nothing; the proxy logs the refused `claim`).
  The car is the one that gives way because the pad page is deployed live, and Earshot plays whatever lands in its
  channel. But a reply the phone took and whose Earshot drop then fails would be heard nowhere: the watcher retries the
  drop `MEMO_EARSHOT_DROP_TRIES` (4) times (backoff `MEMO_EARSHOT_DROP_BACKOFF_S` 2,5,10; an attempt that landed
  despite an error is found by a stat, never dropped twice), and if it ultimately fails it **releases the take**
  (`POST /upload/claim` `by: watcher, action: release`): the proxy pushes `released` to the cars, the pad that left the
  reply to the phone plays it after all (it also looks every 5 s for 5 min, then every 30 s up to 30 min, from a list kept in its ledger, so a page reload or a cold start keeps looking), and the replied fact says
  `earshot_skipped: car_released`, `earshot_reason: drop_failed` (log `earshot_released`; memo:trace shows an UNKNOWN
  `phone_object` hop). A proxy that cannot take the release fails the stage (`earshot_release_failed`), which retries.
- **A released reply nobody claims is dropped for the phone later (the phone retry).** With the car off for good the
  release gives the reply to nobody, so the memo record (`phone_retry` in state.json, memo stays `done`) keeps trying the
  phone in the background, resumable across restarts. A round: `MEMO_EARSHOT_RETRY_FIRST_S` (45) after the release, then
  after each failed round `MEMO_EARSHOT_RETRY_BACKOFF_S` (60,120,240,300, the last repeats), for at most
  `MEMO_EARSHOT_RETRY_TOTAL_S` (2700; 0 = off) from the release. It asks the proxy first: a car that started the reply
  ends it (`car_heard`), a live hold is waited for (`car_holds`, never raced), an unreachable proxy is waited for
  (`proxy_unreachable`), a settling proxy too. Otherwise it TAKES the reply (atomic: one device plays it), checks Earshot
  for an earlier drop that landed (`phone_has_it`, never dropped twice), drops once (`phone_dropped` ends it), and on a
  failed drop gives the take back (`drop_failed`; a car that is on claims it through the `released` push). The deadline
  ends it with `gave_up` and the reason. Every decision is written to the record (`phone_retry.decisions`, one line per
  change) and logged (`phone_retry_decision`, `phone_retry_done`); memo:trace shows a `phone_retry` hop with the outcome
  and one `phone_retry:<decision>` hop per decision, and the heartbeat counts `phone_retries`.
  A drop that lands in the retry publishes `audio.memo.mirrored` (the replied fact already said `car_released`; /voice
  shows "mirrored to the phone late" from it, and the ntfy router mutes it). `gave_up` quotes the last failed drop (not a
  proxy blip that came after it) and the last decision. A manual `memo:retry` that runs the mirror stage again after a
  `gave_up` and fails the drop again arms a fresh retry (the old decisions stay in front); a retry still pending is kept.
- **One-file replies announce themselves too.** A reply spoken as one file publishes `audio.memo.voiced` with chunk 1 of
  chunks 1 (its `chunk_s3_key` is the reply file) when it is up, before the `replied` fact that waits for the phone-or-car
  decision. /voice and memo:trace use it as "first audio up", so a one-file reply a live car holds behind a recording for
  minutes is waiting, not stuck (the schema's `chunks` minimum is 1 since 2026-10-21). It is announced once per reply file (`voiced_one` holds the key and survives the done-compaction).
- **The phone decision is its own stage, `mirror`** (after `speak`, which renders the voice and puts the car's copy up).
  It runs on a pool of its own, so replies held by a car never queue another memo's voice behind them (the speak pool
  has three workers), and everything it needs is in the memo record (`reply_up`: the moment the car could start, the
  object key, the facts for the replied fact). On SIGTERM the decision loop ends within about a second
  (`step_stopped`), the memo stays at `mirror`, and the next start resumes the same decision from the same clock.
- The `replied` fact waits for the decision and records it: `earshot_skipped: car_spoke | car_holds | no_answer` (left
  out, a `phone_object` hop in memo:trace) or `earshot_key` (mirrored, with a `phone_decision` hop saying why), and
  `earshot_reason: car_started | car_holds | claim_failed` (left out) or `no_car_claim | car_let_go | browser_sender |
  skip_off` (mirrored), plus `reply_up_at` (when the car's copy was up) and `earshot_wait_seconds`. /voice says the same
  under the replied hop. Logged `earshot_skipped` or `earshot_mirror_decided`.
- **Neither speaks without the proxy's yes** (no fail-open). The car reads replies straight from S3, so a proxy that is
  down does not stop it from playing one; "the proxy did not answer" therefore never means "nobody is playing it":
  - The watcher mirrors only on a granted take. An offer, poll or take that fails is retried every second; once the
    proxy answers again a take waits `MEMO_EARSHOT_SETTLE_S` (10) more. Still unanswered `MEMO_EARSHOT_HOLD_MAX_S` after
    the reply was up: left to the car (`earshot_skipped: no_answer`, `earshot_reason: claim_failed`; memo:trace shows
    an UNKNOWN `phone_object` hop, look at the car's played hop). Logged `earshot_car_check_failed` once and
    `earshot_car_check_back` with the outage length.
  - The car plays without an answer only on a live hold (answered less than 10 s ago: the proxy refuses the phone for
    at least 10 s more). Its start goes out with the download and its answer is looked at before the audio starts (the
    phone's: skipped); a start that got no answer is re-sent every 2.5 s for 10 min. Without a live hold no answer
    means wait: the reply stays at the head of the car's queue ("reply waiting for the upload proxy") and is asked
    again every 2.5 s.
  - The proxy writes its claims through to `CLAIM_STATE_FILE` (`~/.local/share/agent-pad/claims/claims.json` on the
    host) on every change and reads them back at start, so a restart forgets no hold, start or take; for
    `CLAIM_SETTLE_S` (10) after it starts every take is refused (`settling`), so the car's re-sent start and renewed
    holds land first. The container runs under `init: true` with `exec python3`, so a recreate takes about a second.
  - Left: a car whose own link to the proxy breaks for more than 10 s exactly as it starts a reply on its hold (the
    proxy and the watcher see no outage, the lease lapses, the phone may take it), and a car whose start was granted
    but whose answer was lost and which is then switched off before its retry (heard nowhere; /voice still has it).
- `MEMO_EARSHOT_SKIP_CAR=0` mirrors every reply; `MEMO_PAD_CLAIM_URL` (default
  `https://agent-pad.delo.sh/upload/claim`) points at the proxy.

While a note is armed or recorded the car app also holds exclusive transient audio focus, so the head unit pauses other
media (the phone's Bluetooth stream, the radio) for the length of the note.

**On the car.** With a host that has the chunk player (`HoloceneNative.speechVersion() >= 2`, `playReplyChunk`) the pad
hands the chunks over in order as they download; the speech arbiter plays them back to back as ONE reply (audio focus
kept from chunk to chunk, nothing of lower rank between them, a missing chunk ends it after 45 s, a recording start
stops all of it and the pad offers it again from chunk 1, or the full file if it is up by then). An older host or a
plain browser waits for the full file. The played beacon says `chunks: n`. Measured on the sim, 2026-10-20: the car
started 0.3-0.4 s after the first audio was up, against 2-5 s for the phone; chunk 2 and 3 were buffered before the
chunk before them ended.

Why the old "car started 10-22 s after the reply was rendered" number was wrong: `reply_age_ms` counts from the reply
key's stamp, which the watcher takes BEFORE vox renders, so it contained the whole TTS time. Against the replied fact
the car's real lag on 2026-10-19/20 was 0.9-8.4 s (median 2.6 s), the 2 s poll plus a listing, a download and the
native prepare. memo:trace and /voice now measure the car from the first audio it could play (first chunk, else the
reply object's own time) and add an "after the agent finished" line: first audio up, full reply up, car speaking. The
replied fact (which waits for the phone decision) is shown as "phone decided"; /voice counts a waiting replied hop from
the first audio up with the decision's allowance, and not at all once the car has started the reply.

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
mise run memo:cancel latest           # stop a memo: <memo_id> | s3 key | latest (see "memo:cancel" below)
mise run memo:retry <memo_id>         # revive a failed, skipped or cancelled memo
```

Each hop prints OK / MISSING / FAILED / UNKNOWN with its timestamp and the
latency since the previous hop, and the run ends with one verdict line:

```
VERDICT  STOPPED AT gateway_journal: gateway never created an execution row for <command_id> (lane=batch); batch: pulling (busy: 4/4 in flight, 22 queued ahead) ...
VERDICT  COMPLETE in 71.4s
VERDICT  CANCELLED before dispatch
VERDICT  CANCELLED after dispatch; reply not spoken
```

Exit code is 0 only for COMPLETE.

A memo whose interactive turn timed out and was escalated to the batch lane shows BOTH dispatches
(`fact:dispatched(1)` interactive, `fact:dispatched` batch with `ESCALATED: ...`) and both turns: the first turn's hops
are named `turn1:gateway_journal`, `turn1:agent:invocation.done`, ... and marked superseded (printed as FAILED, never the
reason the memo is reported stopped). The header gains `escalated from <command_id>`, the verdict of a finished one
says `escalated to the batch lane after the interactive turn timed out (spoken as a late reply)`, and `memo:list` shows
the lane as `batch (esc.)`. The phone hops start with `phone_text` (the full-text sidecar, `earshot_text_key`) before
`phone_object`.

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
| phone_decision | why the reply went to the phone (`earshot_reason`: no car claimed it in time, the car let go, a browser sent it) | `docker logs agent-pad-upload \| grep '"event":"claim"' \| grep <memo_id>` |
| phone_text / phone_object | the full reply text (`earshot_text_key`, uploaded first) and the phone audio (`earshot_key`) in the Earshot channel | `mc stat delo/earshot/<earshot_text_key>`, `mc stat delo/earshot/<earshot_key>` |
| audio level | loudest/mean sample in dBFS, measured before transcribing (`audio_max_dbfs`, `audio_mean_dbfs` on `transcribed` and on every transcribe-stage `failed`); `audio_level` hop in `memo:trace`; `device heard peak ...` from the pad when it sends `data.capture` | `ffmpeg -i <file> -af volumedetect -f null -` |
| device-side events | record start/stop/failure and upload failure from the pad | `docker logs agent-pad-upload \| grep '"event":"client"'`; failures are `failed(stage=record\|upload)` facts |
| played | the pad's beacon (`started`/`ended`/`blocked`/`error`/`skipped`) | `docker logs agent-pad-upload \| grep '"event":"playback"'`, `audio.memo.played` |
| agent:progress#n | what the agent wrote while working (gateway) | `curl -s 'http://127.0.0.1:8683/events?correlationid=<memo_id>&type=bloodbank.agent.invocation.progressed'` |
| car:narrated#n | a progress line spoken for the car (watcher) | same query, `type=bloodbank.audio.memo.narrated`; `mc stat delo/holocene-auto/progress/<day>/<memo_id>-<n>.ogg` |
| car_status_object | the car's view of the memo | `mc cat delo/holocene-auto/status/<day>/<memo_id>.json` |
| car speech | every decision of the car's speech queue | `docker logs agent-pad-upload \| grep '"event":"speech"'`; memo-tied ones: `type=bloodbank.audio.memo.notified` |

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
- **`mise run memo:retry <memo_id>`** revives a failed, skipped or cancelled memo at the
  stage it stopped in (the watcher owns state.json, so the command drops a file in
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
  durable drains first on reconnect. While hermes-gateway drains for a
  reload/restart (`~/.hermes/gateway_state.json` says `draining` with a live
  pid, or `stopped`/`starting` right after a requested restart) the Bloodbank
  plugin stops pulling both lanes on purpose for up to 30 min: the memo stays on
  `invoke` without a second probe (`lane_reason=gateway_draining_queued_on_interactive`),
  its agent deadline is extended instead of failing at 600 s, and every
  liveness line names why: `gateway restarting (draining), memo queued; it runs
  when the gateway is back` for a reload/restart, `gateway stopping (draining)
  ...` for a plain stop (SIGTERM, `restart_requested` false),
  `gateway paused for maintenance (draining) ...` while Hermes'
  `~/.hermes/.drain_request.json` marker is present (Hermes ignores one older
  than 1 h), and `gateway starting, memo queued; it runs once its Bloodbank
  lanes connect` for the ~1 min a new process (`starting`, live pid, under
  10 min old, its bloodbank platform not `fatal`) spends before its lanes pull.
  An unreadable monitor keeps the
  interactive lane. An unrecognised `MEMO_LANE` makes the watcher refuse to
  start (exit 2, `bad_memo_lane` on stderr) rather than guess. **The lane is pinned to the
  command id** (the idempotency key, digest and journal row differ by type), so
  a dispatch retry never hops lanes; `memo:retry` of a failed agent stage gets
  a fresh command id and may pick a fresh lane (a memo that escalated stays on batch). A memo dispatched before lanes
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
- **A turn the gateway timed out escalates to the batch lane, once.** The interactive lane
  stops any Hermes turn that outlives its wall clock
  (`extra.interactive.turn_timeout_seconds`, default 300 s; bloodbank
  `services/hermes-gateway/README.md`, "Per-turn wall clock"). The gateway closes the journal row
  `completed / failure / failure_code=turn_timeout` and publishes
  `agent.invocation.failed` with `error_code=turn_timeout`. A long ask is not a failed one, so on either signal the
  watcher does NOT fail the memo. It re-dispatches the SAME prompt (its persisted `prompt_sha256` is re-checked at send)
  on the batch lane (`bloodbank.cmd.agent.invocation.start`, which has no gateway wall clock) as a new command:
  - a NEW command id, saved to state.json before the publish (a crash cannot mint a second one);
  - the same correlationid (`memo_id`) and the same `thread_id`, so the Hermes session keeps its context;
  - `causation` = the timed-out command (its envelope id), and `context.escalated_from_command_id`;
  - a second `audio.memo.dispatched` fact with `lane=batch`, `lane_reason=turn_timeout_escalated` and
    `escalated_from_command_id` (the first one stays: `memo:trace` shows both dispatches and both turns).

  The watcher waits `MEMO_BATCH_TURN_TIMEOUT_S` (default 7200) for that turn (it is not stretched by the queue
  rule above). When it completes, the reply is spoken as a late reply (`<agent>, late reply.`) and
  `audio.memo.replied` carries `late=true` and `escalated=true`. Nothing is said while it runs (no interim notice). A
  reply older than the escalated command is the stopped turn's partial output, never an answer: it is refused
  (`no_reply_text`). The escalation happens at most once per memo and only for a turn that was on the interactive lane.
  The timeout is final otherwise, as `failed(stage=agent_reply, error_code=turn_timeout, retryable=false)` with the
  gateway's own text (`agent turn timed out after 300s on interactive lane (limit 300s)`) plus `lane`,
  `elapsed_seconds`, `timeout_seconds`, `timeout_source` (`lane` | `envelope`) and `turn_stopped` (false = Hermes did
  not confirm the stop): when the batch turn is stopped too, when the memo rides the batch lane, after an explicit
  `memo:retry` of an escalated memo (its fresh command does not escalate again), or with
  `MEMO_BATCH_TURN_TIMEOUT_S=0` (the off switch). It is not `agent/agent_failure`, it is not retried, nothing waits
  out the 600 s deadline. `memo:retry` of that failure sends a FRESH command (a new command id); the old one is dead
  and its slot is already free. A memo that never escalated gets the interactive lane again; one that DID escalate is a
  long ask, so its retry stays on the batch lane (`lane_reason` unchanged, still no second escalation). A retry that
  re-transcribes (`receive`/`transcribe`, e.g. a prompt an old watcher cut) is a new ask: it drops the old command
  (id, `publish_attempted`, lane, envelope id) and any escalation state, so a fresh interactive command is published
  and no `dispatched` fact reuses the old id. A retry that resumes at `await_agent` keeps the live command. When the
  gateway reports `turn_stopped=false` the watcher logs `turn_not_confirmed_stopped` and waits
  `MEMO_TURN_UNWIND_WAIT_S` (10) before it escalates, so the batch turn does not start beside a turn that may still be
  unwinding. The late-reply rescue window of an escalated memo runs from its batch deadline, so a batch reply after 2 h
  is still spoken. `bloodbank-ntfy-router` pushes the `failed` fact like any terminal memo failure.
- **A detached turn is waited out, not killed and re-run (2026-10-22).** With `extra.interactive.detach_on_timeout`
  on, the gateway lets an interactive turn that reaches the 300 s wall clock run on with its slot released (bloodbank
  `docs/interactive-command-lane.md` section 9). The watcher sees it from the journal's `executions.detached_at` (every
  poll) or from `agent.invocation.detached` / a `progressed` fact with `detached=true` (Candystore, for a turn older
  than `MEMO_DETACH_PROBE_AFTER_S`, 240). Once per command it logs `memo_detached`, waits up to
  `MEMO_DETACHED_WAIT_S` (3000; the gateway's ceiling is 2700) from the dispatch, says `MEMO_DETACHED_LINE` once in the
  car ("<agent>, still on it. I will call you back when it is done.", a narrated progress clip with `kind=detached`)
  and stops the 30 s narration. The reply is a late reply, and `replied` carries `detached=true`. A detached turn that
  the gateway stops at its ceiling (`turn_timeout`, `timeout_source=detached_ceiling`, `detached=true`) fails the memo
  with no batch re-run: it already ran the whole time a re-run would. So does one a gateway reload cut off
  (`interrupted_by_shutdown`, `detached=true`; the gateway no longer NAKs a detached turn for a re-run from the top).
  The escalation above stays for a gateway that stopped the turn at the wall clock (detach off, `max_detached`
  reached, an envelope deadline), including a re-run of a command whose EARLIER attempt detached: the terminal's
  `timeout_source lane|envelope` with no `detached` flag is this attempt's verdict.
- **Answer-then-background (2026-10-22).** `MEMO_VOICE_PREFIX` gives a voice turn a budget (about a minute, at most 3
  tool calls, no vox-speak, no sleep-and-recheck, no deploys unless asked; a driver IS waiting, whatever the gateway's
  platform hint says) and one way out for a long ask: answer in a sentence or two, then end the reply with a line
  `BACKGROUND: <complete instructions>`. The watcher never speaks that line (`split_background`). After the quick
  answer's `replied` fact (`background=true`, `background_plan`), the plan goes back to the same agent as follow-up N:
  `MEMO_FOLLOWUP_PREFIX` + plan, a new command id persisted before the publish, its own `prompt_sha256`, the same
  thread id (the Hermes session holds the whole talk), `MEMO_FOLLOWUP_LANE` (batch: no wall clock), the 2 h deadline,
  `context.reason=voice-followup`, `context.followup_of`, and a `dispatched` fact with `lane_reason=voice_followup`,
  `followup=N`, `followup_of_command_id`, `followup_plan`. The memo stays active (car stage `working`, status object
  `followup {n, state}`), nothing is narrated while it runs, and its reply is spoken as "<agent>, follow-up. ..." into a
  NEW `replies/<day>/<HHMMSS>Z-<agent>-<memo_id>.ogg` (the pad plays every reply unit of a memo it sent). The car or
  phone decision is made again for it: claims at the upload proxy are per reply FILE, so the follow-up has a claim of
  its own and a car switched off since the quick answer lets the phone take it after the grace window (before
  2026-10-22 the quick answer's `car=ended` decided the follow-up too, and a follow-up that landed after the car went off
  was heard nowhere while trace said "spoken"). Its `replied` fact carries `followup=N`. A follow-up that fails, times
  out, completes without new text, or only hands off again is spoken as such (`followup_failed=true`) instead of failing
  a memo whose answer was already given; `memo:cancel` keeps it quiet and `memo:retry` brings it back at the stage it
  stopped (its own prompt, its own reply). A pending phone retry of the quick answer keeps going during the follow-up
  (it carries its own reply key and stamp). One follow-up per memo by default (`MEMO_FOLLOWUP_MAX=1`; 0 turns the
  hand-off off, the line is still never spoken). A reply that is only a `BACKGROUND:` line with nothing handed off says
  so (`NO_HANDOFF_LINE`), never "Done.". The marker is matched in upper case only and never inside a code fence
  (`**Background:**`, CSS `background:` and YAML `background: true` are ordinary text). `MEMO_FOLLOWUP_PREFIX` carries
  the voice prefix's rule over: no deploy, restart or push unless the driver's own words asked (the plan was written
  from a speech-to-text transcript; an unclear ask does the read-only part and says what it left undone), and no
  `delegate_task` (a subagent runs on `automaticai/auto/subagent`, not the turn's model: 410 s synchronous on the
  2026-10-22 sim). This is a watcher-side self-dispatch rather than a gateway tool: no gateway edit or reload, and the
  watcher already owns the memo, its cancel and its trace.
- **Voice turns name their model (2026-10-22).** Every memo command carries `data.model = MEMO_VOICE_MODEL`, default
  `automaticai/personal/sol-6.1`. A follow-up carries `MEMO_FOLLOWUP_MODEL`, default empty (the profile's own model).
  **Sonnet 5.5 was tried and rolled back the same day (operator-approved, then reverted).** Anthropic answers Hermes'
  gateway turns on both Claude routes (personal and intelliforia) with HTTP 400 "Third-party apps now draw from your
  extra usage, not your plan limits", although a plain gateway call or a Hermes CLI call on the same token succeeds
  (live e2e, memo `0a24d782`): every turn paid one failed call and ran on glm-5.3 (quick answer +105.8 s vs +43.7 s on
  sol-6.1). Scoping a Claude route onto the shared `hermes` token also put it in `automaticai/auto`'s candidates, so
  non-voice desks got the same 400 and fell back. The route is unscoped again from `hermes` and
  `hermes-delonet-director`. To retry: enable extra usage on the Claude account, give the car desks a token auto cannot
  use (not the shared `hermes` one), scope the route there, then set both env vars in the unit and restart the watcher
  between memos. The `model_override` fact says `applied` when `/model` took, even if Hermes then fell back; read the
  profile's `agent.log` (`API call #n: model=`) for the model that answered. The gateway runs that one turn on it through an
  internal `/model <route> --once` (bloodbank `docs/interactive-command-lane.md` section 10). On the real heavy step of a
  crank circuit (20.7k-token prompt): glm-5.3@max (where `automaticai/auto` lands for the desks' tokens) 51 s, kimi-2.8
  11-27 s, sol-6.1 8.4 s at high and 13-15 s at the providers' xhigh, sonnet-5.5 5.1 s (what goes on the wire: effort is
  not a per-turn knob on this provider, the route is). Hermes' fallback chain (glm-5.3, kimi-2.8) takes over when the
  route answers 403/429. `dispatched` and `replied` carry `model`, `replied` the gateway's `model_override {requested,
  applied, reason}`. Empty `MEMO_VOICE_MODEL` = the profile's own model.
- **A revive tells the journey.** Every `memo:retry` / rescue revive at a stage other than `receive` publishes a small
  `audio.memo.received` fact with `revived=true`, `revived_to` and `revive_why` (no detection data; ntfy-router mutes
  `received`). `memo:trace`, `memo:list` and Holocene `/voice` treat a failed or cancelled fact older than a later stage
  fact (this marker included) as history, and `memo:trace` also does so while the watcher's record is active and was
  revived or dispatched after it, so a memo whose batch turn is running no longer reads `STOPPED AT agent`. The record
  carries `revived_ts`. A cancelled or failed record keeps what its facts say.
- **`mise run memo:cancel <memo_id|key|latest>`** stops a memo, honestly. It drops `cancel-<memo_id>` in
  `<state>/control/` (the same mechanism as `memo:retry`; files are taken in the order they were written) and the
  watcher honours it at every stage, a transcription in flight included:
  - **before the command is published** (stage receive / transcribe / dispatch, i.e. before `publish_attempted`):
    the memo ends `cancelled` and nothing is ever dispatched, `data.after_dispatch=false`. A memo waiting to publish
    its escalation is the same: the batch command is not sent.
  - **after it** (await_agent / reply / speak, or any memo that ever published a command: an escalated one, one with a
    `dispatched_ts`): a published command cannot be recalled, so the agent may still run. The watcher ends the memo
    `cancelled` and does NOT synthesize, speak or mirror the reply, `data.after_dispatch=true`. A memo cancelled
    between its escalation and the batch publish is `after_dispatch=true` too (the interactive command went out); its
    `error_message` says the batch command was not sent. A failed memo still watched for a late reply
    (`agent_reply/timeout`) can be cancelled too, so that reply is never spoken. A cancel that lands in the instant a
    worker is mid-upload takes the objects back: the watcher `mc rm`s the `replies/` object and the Earshot audio and
    text it just uploaded (logged `reply_retracted`; a failure is `reply_retract_failed`).

  Either way one fact is published: `audio.memo.failed` with `data.stage="cancelled"`, `error_code="cancelled"`,
  `retryable=false`, `data.after_dispatch=true|false` (and `command_id` when one was out). A cancelled memo is never
  revived by escalation, the late rescue or a retry loop; only `memo:retry` revives it, at the stage it was cancelled
  in. `memo:trace` ends `CANCELLED before dispatch` or `CANCELLED after dispatch; reply not spoken`, `memo:list` shows
  `CANCELLED`. There is deliberately no pad or car button for it: nothing to press while driving.
- **A command the gateway consumed and dropped is detected.** No journal row
  while the memo's lane consumer is empty (`pending=0 ack_pending=0`) for 15 s after 20 s
  means it was rejected before starting (unroutable target): the memo fails
  `agent/gateway_terminated` with the gateway's own WARNING line in the
  message. Better still, the agent id is checked against
  `~/.hermes/agents-registry.yaml` right after `received`, so an unknown or
  disabled agent fails `dispatch/unknown_agent` in milliseconds, not after a
  45 s transcription and a 10 minute wait.
  `memo:retry` of that memo restarts at `receive` (it has no transcript to
  dispatch). The upload proxy refuses such a PUT up front (422), so the pad
  shows "NOT sent" instead of SENT.
- **A prompt is never shortened.** The whole transcript and prompt are kept for
  every failed or active memo (only done / skipped memos are compacted to
  previews); `prompt_sha256` is saved with the transcript, before the publish,
  and checked at send (`prompt_changed` holds a mismatch). A transcript over
  `MEMO_MAX_TRANSCRIPT_CHARS` (200000) is held `transcribe/transcript_too_long`,
  not cut. The size and etag of the object are recorded at discovery; a download
  that differs is held `download/object_changed` (`memo:retry` takes the object
  as it is now).
- **Transcription takes the warm GPU first.** `holocene-whisper.service` keeps
  large-v3-turbo fp16 resident on the GPU (about 2.4 GB of VRAM) at
  `127.0.0.1:8766` (`MEMO_WHISPER_URL`; empty turns it off): about 0.5 s for a
  7 s car clip. The watcher POSTs the clip there first and runs the `transcribe`
  CLI instead on any failure: server down, slower than `MEMO_WHISPER_TIMEOUT_S`
  (8) + 0.1 s per audio second, an error, a malformed answer, or a junk
  transcript (empty, "Thank you.": the CLI gives a second opinion before the memo
  fails). Recordings over `MEMO_WHISPER_MAX_AUDIO_S` (900) go straight to the
  CLI. The `transcribed` fact says which path ran (`backend`
  `faster-whisper-server` or `faster-whisper`, `device`, `fallback_reason`) and
  so does `memo:trace`. The CLI alone was 5-6 s cold on the GPU and 8-17 s on
  CPU whenever another transcription (Wax, Telnyx intake, HeyMa) held its heavy
  lock: every car memo of 2026-10-21 took that CPU `small` fast lane. The server
  is the same `~/code/infra/scripts/vocalinux-faster-whisper-server.py` that
  VocaLinux dictation runs on :8765 (CPU); `install.sh` installs both units.
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
- **The phone also gets the FULL reply text.** The 500-character digest is what is spoken; the whole reply is uploaded
  to Earshot as a sibling object of the phone audio, same key with a `.txt` extension
  (`phone/2026/10/20/021530123Z-holocene-pm-<memo_id>.txt`, `Content-Type: text/plain; charset=utf-8`), BEFORE the
  audio object, so the phone already has it when the audio arrives. It is fail-open like the audio mirror (a refused
  upload is logged `earshot_text_failed` and the audio still goes), uploaded once per memo, and its key is recorded as
  `earshot_text_key` on `audio.memo.replied` (`memo:trace` shows it as the `phone_text` hop, before `phone_object`).
  The car path (`replies/` audio, the 500-character digest) is unchanged. The phone ignores a text over 64 KB, so
  the sidecar is capped at `MEMO_EARSHOT_TEXT_MAX_BYTES` (60000) with a closing
  `[truncated; full text in Holocene /voice]` note (logged `earshot_text_truncated`); the `replied` fact and `/voice`
  keep the whole reply.

Configuration is env only (see the unit file): `MEMO_AGENT_TIMEOUT_S`,
`MEMO_TRANSCRIBE_TIMEOUT_S`, `MEMO_MAX_ATTEMPTS`, `MEMO_POLL_S`,
`MEMO_MAX_AGE_HOURS`, `MEMO_SPEAK_CHARS`, `MEMO_VOX_VOICE`, `TRANSCRIBE_DIR`,
`MEMO_LANE` (`interactive` default | `batch`), `MEMO_LANE_PROBE_GAP_S`,
`MEMO_BATCH_TURN_TIMEOUT_S` (7200: how long an escalated batch turn is waited for; 0 turns escalation off),
`MEMO_TURN_UNWIND_WAIT_S` (10), `MEMO_EARSHOT_TEXT_MAX_BYTES` (60000), and the progress knobs above.
The heartbeat (`heartbeat.json`) carries `lane` and `lanes.{interactive,batch}`
(`ok`, `waiting`, `ack_pending`, `pending`, `max_ack_pending`, probed every 5 s
off the tick thread); `/voice` reads it.
S3 access is the `delo` alias in `~/.mc/config.json`; the unit holds no secrets.

## Fast conversation layer (the in-car desk, HOLOC-23)

A car memo for an allowlisted agent tile can be answered in seconds by a fast model instead of minutes by the agent.
The desk talks, drafts briefs and reads them back; work starts only when the driver confirms aloud, and then exactly
once, on the agent the driver confirmed. It ships **off**.

```
transcribe -> converse -> speak -> mirror -> done                  reply | propose | cancel | end   (no agent command)
                       -> speak -> mirror -> dispatch -> ... -> speak   confirm: the read-back, then the brief as follow-up 1
                       -> dispatch -> ... today's path                  direct, a failed ladder, or a memo the desk can't take
```

**Code.** `converse.py` (pure logic + the HTTP ladder; `test_converse.py`) and the `converse` stage in
`inbox_watcher.py` (`step_converse`, `_converse_apply`; `test_converse_pipeline.py`). One worker (`pools["converse"]`),
so the turns of a conversation are decided in order. `memo:retry`, `memo:cancel` and a restart all know the stage:
the decision is stored on the memo (`conv_raw`) before it is applied, so a restart re-applies it with no second LLM call.

**Who takes the desk.** The memo leaves `transcribe` for `converse` only when the mode is `on` (the flag file, else
`MEMO_CONVERSE`), the agent is in the list (`MEMO_CONVERSE_AGENTS`, `*` = all), and the memo was never dispatched before.
`step_converse` then also requires `host=car` (the upload proxy's `X-Amz-Meta-Holocene-Host` on the inbox object, read
at receive in parallel with the download, together with the agent card), the device in `MEMO_CONVERSE_DEVICES` when set,
audio at most 90 s, a transcript at most 4000 characters and a key that is not unreadable. Anything else goes to
`dispatch` with a `converse_skipped` log line and no LLM call.

**The decision.** One JSON object from the model (`response_format: json_object`, temperature 0.3, max 700 tokens, a
system prompt with two literal examples: deepseek-v4.1-flash-1017 ignores json_object 40 % of the time without them):

```json
{"say": "...", "action": "reply|propose|confirm|cancel|direct|end", "target": "<agent id>", "title": "<= 8 words",
 "brief": {"goal": "...", "context": ["..."], "done_when": ["..."]}, "perm": "read_only|changes_ok|deploy_ok"}
```

Prose with no object is a `reply` whose `say` is that prose; JSON that does not parse is a failure of that rung. The
prompt is stable first (rules, the agent card, the roster: byte-identical across turns, so the provider's prompt cache can hit it), then the last
12 turns as user/assistant pairs, then the volatile desk state (pending draft, the 24 h delegation board with live state,
newest progress line and results, recent memos) and the new transcript.

**Lexicon short-circuits (no LLM call).** With a pending draft (or a delegation in the last 30 min), a transcript that is
only a confirmation ("send it", "yes send it", "go ahead.") is `confirm`; only a cancellation ("cancel that", "don't send
it", "no") is `cancel`; "that's all" / "thanks, bye" is `end`; "ask <agent> directly" or "full agent" is `direct`.

**The guard (deterministic; the model only proposes).**
- `confirm` needs a pending draft (proposed, at most `MEMO_CONVERSE_DRAFT_TTL_S`=600 s old), an affirmative transcript
  and no negation (`don't`, `not`, `but`, `instead`, `change`, `wait`, ...). The stored draft is sent **verbatim**: its
  body's sha256 must still match. A brief whose sha was sent in this conversation in the last 30 min is refused
  ("Already sent to ..."), and so is a second "send it" while the first is being sent.
- `propose` builds the draft and the read-back from a template, never from model prose:
  `Draft for <Target>: <title>. <Read-only | Code changes OK, no deploy | Changes and deploy OK>. Say send it, or tell me
  what to change.` A confirm is spoken `Sending to <Target>: <title>. I'll call you back.`
- The permission is clamped by the driver's own last two transcripts: `read_only` unless they said fix/change/edit/write/
  commit (`changes_ok`) or deploy/restart/release/push it (`deploy_ok`). The clamp is a ceiling, never a raise.
- The target is the tile's agent. Another agent only with `MEMO_CONVERSE_HANDOFF=named`, when the driver said its name
  or id (`flume`, `flume pm`) in the last two transcripts and `registry_route(target).ok`; otherwise the draft stays on
  the tile (`converse_retarget_refused`). A confirm that names a different target is read back again, never sent.
- A reply that claims something was sent or started has that sentence removed ("Nothing was sent.").

**The brief that is sent.** `MEMO_CONVERSE_DELEGATE_PREFIX` (do it now, yourself, no `delegate_task`, no vox, **no
deploy, restart, push or other change to a live system unless the Permission section allows it**, end with a spoken
summary, no `BACKGROUND:` line) + the stored brief (`# title`, goal, `## Context`, `## Done when`, `## Permission`) + the
driver's own words, oldest first, with times (the confirmation included) + a trace line (conversation, memo, brief id,
tile). It is follow-up 1 of the confirming memo (`start_followup(kind="delegation")`): command id
`uuid5(brief_id)` (the gateway dedupes a redelivery), `MEMO_CONVERSE_DELEGATE_LANE` (batch), the **voice model** (`MEMO_CONVERSE_DELEGATE_MODEL`, default `MEMO_VOICE_MODEL` = sol-6.1; the PMs' own default is
`automaticai/auto`, a pool with Claude routes, so it is never the default here; `profile` opts back in; a forbidden one is
ignored), `thread_id` = the memo id, `context.reason =
voice-delegation` with `conv_id`, `brief_id`, `brief_sha256`, `tile_agent_id`, `perm`. `MEMO_FOLLOWUP_MAX=0` does not
stop it, and a delegated agent's own `BACKGROUND:` line is refused (spoken as not finished). Its result is spoken as
`<Target>, follow-up on <title>. <summary>` (the car, or the phone after the 20 s grace, as any follow-up) and written
back into the conversation (the delegation's `result`, a `result` turn). A read-back that never went out (vox down past
its budget, `memo:cancel`) puts the draft back to proposed and marks the delegation `not_sent`.

**Speech.** A fast turn's reply: the agent's name on the conversation's first turn only (a read-back names its target
itself), chunks of 70/170/300 characters from 80 (`MEMO_CONVERSE_CHUNK_CHARS`, `_MIN_CHARS`), vox at 6 steps
(`MEMO_CONVERSE_TTS_STEPS`). Every vox render of the watcher goes through `TtsGate`: one at a time, fast turns first, then
replies and results, then narration, released between chunks. The car's status object says `stage: working` during
converse, sends `heard: null` for a fast turn (no "<agent> heard: ..." echo in front of an answer seconds away; a direct
turn gets `heard` back), and adds `conv: {sid, turn, action, draft_title, reply_key}`: `reply_key` is THIS turn's reply of
record, so the pad tells a barged fast-turn reply (not replayed) from a follow-up result (its own key, replayed).

**The default route (never Anthropic; operator decision 2026-10-22).** Operator, verbatim: "use aai/auto/fast and its
existing fallback chain, as requested. No pinned model or gateway rebuild." `MEMO_CONVERSE_ROUTES` (JSON, in the unit) is
**one route**, `automaticai/auto/fast` on `api.automaticai.io`; the gateway's own auto chain (fast tier, then strong tier,
then the free last resort, each intersected with the token's scope) is the fallback, so the desk pins no model and a gateway
change needs no watcher change. The budget `MEMO_CONVERSE_BUDGET_S` is **14 s** (the route's 12 s timeout plus slack; keep it
at least the sum of the route timeouts). It replaced a three-rung ladder (Hyper flash, DeepSeek flash, then this route);
those two upstreams are now opt-in tile aliases only (below).

| route | model | key (op:// item-UUID ref) | timeout | measured 2026-10-22 |
| --- | --- | --- | --- | --- |
| r1 | gateway `automaticai/auto/fast` (temperature 1, no effort: auto sets the rung's) | token holocene-converse `yeurk5dpqkaarspvsn3cjtmkki/holocene-converse` (id 88) | 12 s | the card-sized prompt, 12 calls: p50 5.4 s, p90 6.6 s, max 10.7 s, all served by `automaticai/personal/glm-5.3`; 11 of 12 a valid decision, one `empty` content went to the full agent. The lead's earlier run on a larger prompt: 7.1-8.8 s |

then today's full-agent path (`fallback_reason=all_routes_failed`): that, not a second model, is what backs the route up. A
runtime override of the route set lives in the flag file (`mise run memo:converse on --routes-file f.json`, drop it with
`--clear-routes`); it wins over the unit until cleared, and a watcher restart picks up the unit's route. The kill switch is
`mise run memo:converse off`. The Hindsight item (`tflaecgcrdgxrh2ovgi5ysjkzq`) is no longer used anywhere in the desk,
and a route naming it is refused (`key_retired`), so an old routes override from the evidence (`runs/s11*.json`) cannot
bring it back.
Costs of the single route, known: the car hears nothing while the desk waits (3-7 s typical, 12 s at worst, then the
full-agent path; spoken progress only starts 15 s into a dispatched agent turn), and three failed calls in 120 s (an `empty`
answer counts) open r1's breaker for 60 s, so every memo in that minute goes straight to the full agent. A fresh watcher
answers `scope_unproven` (full agent) until its background scope proof finishes. A hold cue after about 3 s of desk wait is
the open follow-up (HOLOC-23).
The Hyper key is out of credit (`402`; a tile that opts into `deepseek-flash` or `deepseek-pro` skips that rung in ~0.2 s
and it comes back by itself after a top-up: a 402 opens the rung's breaker for 10 min). DeepSeek accepts `temperature` and
`reasoning_effort` `low|high|max` (its `/models`; default high); the rungs send neither effort. A rung is also skipped while its breaker is open
(3 failures in 120 s: 60 s) or its key is unreadable (retried every 300 s); a 401 re-reads the key once. A `propose` with
neither a title nor a brief goal counts as `incomplete_propose` and goes to the next rung; if no rung does better the guard
builds the brief from the driver's own words. Keys are **op:// item-UUID references only** (`op read` at first use and
once at start-up, memory only, never logged; a pasted key is refused; `op read` of every ref works from a
`systemd-run --user` shell).

The rule: `FORBIDDEN_MODEL_RE` (`claude|anthropic|sonnet|opus|haiku|fable|^automaticai/auto`, `openrouter/auto`; NFKC
normalised, zero-width characters stripped, a non-ASCII name refused, and the gateway's `aai/` alias spelling read as
`automaticai/`, because the gateway's `CanonicalModel` rewrites it: `aai/auto/orchestrator` IS the orchestrator pool) refuses
a configured route (stored and sent in the canonical spelling)
(`converse_route_refused`; no route left = off), with ONE exception: exactly `automaticai/auto/fast` and `automaticai/free`,
and only on a route whose key is in `MEMO_CONVERSE_SCOPED_KEY_REFS` (the holocene-converse token; anything else is
`auto_unscoped`). Bare `automaticai/auto` (an orchestrator-class request, frontier tier), `/orchestrator`, `/subagent` and
`openrouter/auto` stay refused everywhere, and the delegated turn's model override still refuses every auto name. Such a
router rung is used only while its **scope proof** is fresh: `GET <base>/models` with the token lists models and none is
Anthropic (at start-up, re-checked every 10 min in the background; a Claude id in the scope = `scope_unsafe`, no proof yet =
`scope_unproven`, both skip the rung without sending anything). Every answer is checked: a `model` field that is forbidden or
not a string at all (a list or an object cannot be checked), or an `X-AutomaticAI-Route` header (the route that served an
auto/free request) that names Anthropic, is thrown away (`forbidden_model`, a failure of the rung); a router answer with no
route header is not used (`route_unproven`), nor one whose served route is not a name the scope proof listed
(`route_out_of_scope`).

The gateway side (verified in `middleware/automaticai.go` `resolveAutomaticAIAuto` and `auto.go` `evaluate`): auto needs the
`aai-personal` group and the auto name in the token's scope, then every candidate is intersected with the token's scope
(`TokenModelLimitAllows`). **`automaticai/free` is not bounded the same way**: `serveAutomaticAIFree`
(`middleware/automaticai_free.go`) checks only that the free family is in scope, then `ResolveFreeServable` picks from the
whole free policy (46 members in `ops/routes.json`, none Anthropic today), not the token's names. For free the desk's bound
is after the fact: an answer from a route outside the proven scope listing is never used (`route_out_of_scope`); the
prompt has already gone to that free route by then. The free alias is opt-in per tile. The holocene-converse token was re-scoped on 2026-10-22 (`gateway-tokens.py scope
holocene-converse --models <12 routes> --auto --free`, key and expiry kept) to 37 names, **none Anthropic**:
`automaticai/personal/{glm-5.3-flash, kimi-k3s, glm-5.3, kimi-k3, kimi-2.8}`, `automaticai/hypercharm/{glm-5.3, kimi-k3,
minimax-m3}`, `automaticai/deepseek/{deepseek-flash, deepseek-v4-pro}`, `automaticai/mistral-allowance/ministral-14b`,
`automaticai/gemini-free/gemini-3.5-flash-lite`, the four auto names, `automaticai/free`, and the auto policy's 20 free
routes (OpenRouter `:free`, kilo-anon, cf, zai-free, mistral-small, groq, agnes, bazaarlink, vercel). `sol-6.1` is left out
(frontier tier: auto/fast never climbs past rung 3, and Sol's weekly pool is the voice turns'). Auto/fast's fast tier is
glm-5.3-flash, kimi-k3s and `damien/claude-haiku-4.5`; with this scope the haiku route can never be a candidate. Four live
calls to `automaticai/auto/fast` were answered by `glm-5.3` (`X-AutomaticAI-Auto: role=fast; rung=3`), two to
`automaticai/free` by agnes-3.0-flash and cf glm-5.3-flash.

**Why auto/fast is safe as the only default.** Three independent checks stand between the driver's words and an Anthropic
model, none of them a pinned name: (1) the **scope proof**, `GET /models` with the holocene-converse token lists 35-37 names
and none is Anthropic, so the gateway cannot pick one for this token (re-proved at start-up and every 10 min; a Claude id
in it is `scope_unsafe`, no proof is `scope_unproven`, and either skips the route without sending anything); (2) the
**served-route header**, `X-AutomaticAI-Route` of every answer must be a name the proof listed and must not name Anthropic
(`route_unproven`, `route_out_of_scope`, `forbidden_model`); (3) the **response `model`** field is checked the same way. A
route that fails any of them is thrown away and the memo takes the full-agent path.

If every rung fails the memo takes today's path (`fallback_reason=all_routes_failed`, the echo restored): a memo is never
failed for an LLM reason.

**Tiles: a voice and a model per agent (HOLOC-23, 2026-10-22).** The flag file carries `tiles: {<agent>: {voice, model,
voice_set_at/by, model_set_at/by}}`, written under an fcntl lock (`.converse.json.lock`; the watcher, the CLI and the skills
all write the same file; `memo:converse on|off` keeps the map). A file that only holds tiles keeps the unit's mode.

- **Voice** (car only; the agent's Telegram/Hermes `tts.voice` is untouched): `tiles[agent].voice`, else `MEMO_VOX_VOICE`
  (rick), for a memo **the car sent**: a browser memo, or one whose sender cannot be read (S3 metadata, read once and only
  when the tile has a voice of its own), keeps the default (`tile_voice_not_car` log). Per agent, not per device: a voice
  set from the sim also speaks on the Honda (clear it after a sim run). Valid = vox's list (`voxxy -q voice list --json`, `GET <vox>/voices`; 12 today: brule carlin damian david dumply
  marge morgan morty peter rick walken walken2); a display name, a unique first/last word (`freeman`) or spoken digits
  (`walken two` = walken2) resolve. The voice is **locked per reply at its first render** (`voice_lock` on the memo: chunks,
  the full file and retries keep it; a follow-up round locks again). If vox answers `voice 'x' not found`, the render falls
  back to the default voice at once (`voice_fallback` log, no 1800 s TTS retry). `voiced` / `replied` facts carry `voice`
  (used) and, on a fallback, `voice_requested` + `voice_fallback`. Progress narration uses the tile's voice too unless
  `MEMO_PROGRESS_VOICE` pins one.
- **Model** (the desk's ladder only; the agent's own Hermes model, the direct-turn and delegated-turn models are
  untouched): `tiles[agent].model` names an alias in **`car_desk_aliases.json`** (version 1, shared by the watcher, the CLI
  and the car-set-model skill). The alias's routes go in FRONT of the default route (auto/fast); a `(base_url, model)` already in the
  default keeps its id (one breaker per upstream) and appears once; the default route still backs the alias up, so an
  alias's `budget_s` covers its own timeouts plus the default's 12 s.

  | alias | phrases | routes in front | measured 2026-10-22 |
  | --- | --- | --- | --- |
  | `deepseek-flash` | deepseek flash, flash | `flash-h` Hyper flash-1017 (4 s), `flash-d` DeepSeek `deepseek-flash` (5 s), budget 21 s | flash-d 1.3-2.8 s (opt-in: it was the old default) |
  | `deepseek-pro` | deepseek pro, pro | `pro-h` Hyper `deepseek-v4-pro-0813` (6 s), `pro-d` DeepSeek `deepseek-v4-pro` (12 s, max_tokens 2000), budget 30 s | pro-h 402; pro-d 1.96-3.6 s, once 8.98 s on a loaded host (hence 12 s, was 9 s) |
  | `free` | free, free model | `free` gateway `automaticai/free` on the holocene-converse token (8 s), budget 20 s | 1.4-2.7 s, one 8 s timeout (OpenRouter nemotron :free) |
  | `auto` | auto, autorouter | r1 gateway `automaticai/auto/fast` (12 s) = the default | 3.5-10.7 s (glm-5.3) |
  | `default` | default model, reset the model | none (clears the tile's model) | |

**Switching from the car.** Two ways, one effect:
1. **Setting phrases** (no LLM call; `path=setting_phrase`): a whole utterance like "use walken voice", "switch to the Walken
   two voice", "switch the voice to Morgan Freeman", "reset the voice", "switch to deepseek pro", "use the free model",
   "switch the model to auto", "reset the model". A bare name is a voice only next to the word voice ("switch to marge" is
   an agent, not a voice); "use the default" alone names nothing. Whisper's spellings are matched next to the word voice:
   one edit off a five-letter name, two off a longer one when four letters or more were heard, the nearest voice only when
   no other is as near ("walkin", "USE WALK VOICE" = walken; walken2 is one edit further), and "face", glued or not, is
   the word voice ("Use Rickface!" = rick).
2. **The `tool` action**: the decision may be `{"action": "tool", "tool_name": "...", "args": {...}}`. The tools are the
   Skillex skills of the desk's own scope, `MEMO_CONVERSE_TOOLS_DIR` = `~/.local/state/holocene-auto/car-desk-scope`
   (`skillex init`, `inherit off`, `enable pack car-desk@0.1.0`): every `.agents/skills/*/SKILL.md` whose
   `metadata.tool.consumers` names `car-desk`, with its `tool.json` (an OpenAI function object), read at start-up and again
   on any mtime change. Today: `car_set_voice(voice)` (skill car-set-voice) and `car_set_model(model: deepseek-flash |
   deepseek-pro | free | auto | default)` (skill car-set-model). They are listed in the system prompt's TOOLS block; the
   model's args are validated against the schema (type, enum, required, additionalProperties false, maxLength) and the
   skill's entrypoint runs with no shell, stdin closed, in a process group of its own, at most 3 s (a timeout kills the
   whole group, so the skill's own writer child never lands a change the driver was told failed): `<entrypoint> --json --agent <tile> --by car --<arg>
   <value>`; it writes through the watcher's own verb (below). Without the scope, a phrase still switches in process through
   the same locked writer (`via=builtin`).

The tool runs in the converse step before the decision is stored, so a restart re-applies the outcome and never runs it
twice; shadow mode never runs a tool. What the driver hears is a template, spoken in the NEW voice: "Switched Holocene PM
to Walken.", "Holocene PM now thinks with Deep Seek Pro.", "Holocene PM is back to the default voice.", or "I couldn't
change the voice: there's no voice called bob." The routed fact carries `tool {tool, args, ok, via, exit, ms, error}`,
`tile_model` (the alias that decided the turn), `tile_voice` (the voice the reply is spoken in) and `served_route`.

**CLI verbs (the watcher's own; the skills call them).** `mise run memo:voice <agent> [<voice>|--clear] [--json]` and
`mise run memo:model <agent> [<alias>|--clear] [--json]` (`memo_trace.py voice|model`): validate, write the tile under the
lock, print the result (exit 3 on a refused value). No restart: the watcher reads the file per reply / per turn. The skills
themselves are run with `skillex`, never a mise task.

**State.** `state.json` `conversations` keyed `<device>|<agent>` (`conv_id`, `sid`, `turns[]` upserted by memo id,
`pending` draft, `delegations[]`) and `conversations_closed` (the last 20). Idle `MEMO_CONVERSE_IDLE_S` (900 s) closes one
(tick sweeper every 60 s, or the next memo); a closing conversation's draft expires unsent (`converse_draft_expired`).

**Kill switch.** Three layers, none needs a restart or a deploy:
1. `mise run memo:converse off|shadow|on [--agents a,b|'*'] [--devices <id>] [--handoff named|off]` writes
   `~/.local/state/holocene-auto/inbox-watcher/converse.json` atomically; it wins over the unit's env and is read per memo.
   `mise run memo:converse status` prints the effective mode, source, agents and routes and the watcher's own view
   (heartbeat `converse`: mode, source, `key_status`, breaker state, the fact contract). `--routes-file f.json` overrides
   the ladder (S11 tests), `--clear-routes` drops the override. `status` also prints each tile's voice, model and ladder,
   the loaded tools, and the watcher's view of every rung (key, scope proof, breaker).
2. The unit: `MEMO_CONVERSE=off|shadow|on` (shipped `off`), `MEMO_CONVERSE_AGENTS`, `MEMO_CONVERSE_DEVICES`,
   `MEMO_CONVERSE_HANDOFF`. An invalid value turns the desk off (logged), never the watcher.
3. Per memo: "ask <agent> directly" / "full agent" forces today's path. `shadow` runs today's path untouched and logs
   what the desk would have done (`converse_shadow`).

**Facts.** `audio.memo.routed` once per decision: `conv_id`, `sid`, `conv_turn`, `conv_opened`, `action`,
`decided_action` (the model's own), `say`, `title`, `brief_id`, `target`, `perm`, `delegate_to`, `guard` (reasons),
`model_answered` (response.model), `requested_model`, `route`, `attempts` (rungs tried), `attempt_log` (route, model,
outcome, ms, http_status, answered_model), `latency_ms`, `usage`, `cached_tokens`, `path` (`fast` | `confirm_only` |
`cancel_only` | `end_only` | `force_direct` | `fallback`), `lexicon`, `fallback_reason`, `card_sha256`, `card_age_s`,
`recall`, `device`, `decide_ms`, `reply_s3_key`. `audio.memo.delegated` once per confirmed brief: `target_agent_id`,
`tile_agent_id`, `conv_id`, `brief_id`, `brief_sha256`, `command_id`, `lane`, `perm`, `title`, `prompt_sha256`,
`followup`, `thread_id`. The delegation's `dispatched` fact carries `followup=1`, `lane_reason=voice_delegation`,
`target_agent_id` (the confirmed target), `tile_agent_id`, `delegated_to`, `conv_id`, `brief_id`, `brief_title`, `perm`;
the read-back's `replied` fact carries `conv {conv_id, sid, turn, action, path}`. Both types are muted in ntfy-router.
At start-up the watcher runs `bb-emit --check` for both; a refused type is logged only (`fact_unavailable`) and never
queued, so it can never block the outbox.

**See it.** `mise run memo:trace <memo>` shows a `fast:routed` hop (`reply glm-5.3@r1 (1 attempt,
812 ms, 900 in / 40 out, 640 cached) conv 7f3a1b2c turn 3`, failed rungs, guard notes) where dispatch and the agent turn
would be, a delegation as `followup#1` (`DELEGATED to flume-pm: 'title'`), and a timing line that starts `transcribed |
routed`. `mise run memo:conv [latest|<agent>|<conv id>]` prints the conversation: turns (model@route, ms, driver words,
what was said), the pending draft (with its body) and the delegations with memo and command ids and results.
Log events: `converse_decided`, `converse_skipped`, `converse_guard`, `converse_retarget_refused`,
`converse_attempt_failed`, `converse_route_refused`, `converse_config`, `converse_contract`, `conversation_opened`,
`conversation_closed`, `converse_draft_expired`, `converse_draft_dropped`, `delegation_sent`, `delegation_result`,
`delegation_restored`, `converse_shadow`, `converse_tool`, `converse_tools_loaded`, `converse_scope_unproven`,
`voice_fallback`.

## Bloodbank facts

Defined in the bloodbank repo (`schemas/bloodbank/audio/memo.*.json`, entity
`memo`, actions `uploaded|received|transcribed|dispatched|replied|played|failed`, plus the annotations `narrated`
(watcher: a progress line spoken for the car), `voiced` (watcher: one sentence-chunk of the reply is up) and `notified`
(upload proxy: a memo-tied decision of the car's speech queue), ordering key `memo:<memo_id>`). The gateway's `agent.invocation.progressed` carries the memo id in
`data.context.memo_id` and the memo's correlationid. ntfy-router mutes all three. Validate a sample without publishing:

```bash
echo '{"memo_id":"...","s3_key":"...","target_agent_id":"holocene-pm","transcript_text":"hi"}' \
  | /home/delorenj/code/33GOD/bloodbank/bin/bb-emit --check --type bloodbank.audio.memo.transcribed --correlation <memo_id>
```

`bb-emit` gained `--command-id` (persist the id before publishing) and
`--print-ids` (JSON line with id, command_id, idempotency_key on stdout).

Additive fields the watcher puts on these facts (the schemas allow extra properties): `dispatched`:
`escalated_from_command_id` (with `lane=batch`, `lane_reason=turn_timeout_escalated`); `replied`: `escalated`,
`earshot_text_key` (next to `late` and `earshot_key`); `failed` for a cancelled memo: `stage=cancelled`,
`error_code=cancelled`, `after_dispatch`; `received` as a revive marker: `revived`, `revived_to`, `revive_why`. Publishing is not schema-checked, but the `stage` enum in
`schemas/bloodbank/audio/memo.failed.json` still needs `cancelled` for validators that enforce it.

## Upload proxy -> watcher: the wake hint and the early push (HOLOC-23 phase 2)

Two loopback hops that take the 1 s `mc ls` tick and the `bb-emit` subprocess off the car's critical path.

- **Wake hint (live).** When the proxy has stored an inbox memo it POSTs `{key, size, etag (md5), uploaded_at, memo_id,
  device, host}` to the watcher's `http://host.docker.internal:8697/wake` (`WATCHER_WAKE_URL` on the proxy, `MEMO_WAKE_PORT`
  on the watcher, 0 turns the listener off). The watcher answers 202 first, then `discover()`s that one entry exactly as a
  listing would and runs the receive stage and the start of transcribe in the request thread, so a main loop stuck in a
  2 s listing cannot delay it. Keys the watcher already knows are skipped (memo id = uuid5 of the key), so a hint and the
  poll can never start a memo twice; the poll still runs and still finds anything the hint missed. Logged as `wake_hint`
  on both sides. Measured on the live host (load 70+), PUT landed to memo discovered: p50 6.1 s -> 0.004 s, p90 9.6 s -> 0.011 s.
- **Early push (live both sides: the watcher calls it for `received` / `transcribed` / `voiced`, see "Latency levers").** `POST http://127.0.0.1:8698/internal/push {action, memo_id,
  data}` (compose publishes the proxy's 8080 on loopback only; `/internal/` is not under Traefik's `/upload/` rule) pushes
  the same compact event the NATS fact would produce to every open `/upload/events` stream at once, and drops the NATS copy
  of it as a duplicate. `push_hint(action, memo_id, data)` in `inbox_watcher.py` is the fail-open client (300 ms cap, ~2 ms
  typical): call it with the fact's own `data` just before the `bb-emit` of `voiced` / `transcribed` / `replied`.
  `data` must carry the same key fields as the fact (`chunk_s3_key` / `reply_s3_key` / `progress_s3_key`, `chunk`,
  `chunks`, `narration`, `seq`) or the duplicate is not recognised and the pad hears it twice.
- **Claims file.** `ReplyClaims._save` rewrites only the claims touched within `CLAIM_PERSIST_S` (2 h) of the newest one
  (memory keeps all): 15-30 ms -> under 1 ms per hold / start / end on the loaded host.

## Hold cue: no silent wait (HOLOC-23)

The car desk calls ONE route (`automaticai/auto/fast`, 3-7 s typical, 12 s at its timeout) and, when that fails, hands the turn
to the full agent, whose spoken progress starts `MEMO_NARRATE_FIRST_S` (15 s) after dispatch. Before the hold cue the driver
heard the stop tone and then nothing for up to ~27 s. Now:

| when | what the car hears | knob (default) |
|---|---|---|
| the desk's decision is not in 3 s after the desk call started | one of "One sec." / "Thinking." / "Hold on." / "Let me see." | `MEMO_CONVERSE_HOLD_CUE_S=3` (**0 turns every hold cue off**) |
| still waiting at 9 s | "Still on it." / "Still working on it." | `MEMO_CONVERSE_HOLD_CUE2_S=9` (0 = no second cue) |
| the desk handed the turn to the full agent (`conv.action=direct`) and it has been quiet 7 s after dispatch, then every 8 s, at most 3 | "Still on it." / "Still working on it." (the agent's own narration at 15 s ends them) | `MEMO_CONVERSE_HOLD_FALL_FIRST_S=7`, `_FALL_GAP_S=8`, `_FALL_MAX=3` |

- **Voice and cost.** The lines are in the PhraseBank (`converse.HOLD_CUE_LINES` / `HOLD_CUE2_LINES`, warmed per tile voice at
  start-up), spoken in the tile's own voice (`tiles[agent].voice`; a voice vox lacks falls back to the default), so a cue is a
  file copy (~1 ms, engine `phrasebank`), never a vox render on the critical path. The same line is never heard twice in a row
  per tile. Every line is under a second of speech.
- **Wire.** A cue is a progress clip: `progress/<yyyy>/<mm>/<dd>/<memo_id>-<n>h.ogg` (the `h` suffix marks a hold cue; it shares
  the `<n>` numbering with the agent's narration, so a later narration never overwrites a cue) announced as
  `audio.memo.narrated` with `kind` `hold_cue` | `hold_cue2` | `hold_keepalive` (`command_id` null while the desk is still
  deciding; `seq` = `narration` = the clip number; no new Bloodbank type, valid under `bb-emit --check`), pushed to the pad
  with the early-push hint. A pad from before this does not match the `-<n>h.ogg` name and never plays it.
- **Invariants.** A cue is checked before the render, after it and after the upload: if the desk's decision (or the agent turn)
  is over by then it is dropped and never uploaded (`hold_cue_dropped`, reason `answer_ready` | `turn_finished` | ...), so the
  answer never waits behind a stale cue. The pad's speech queue ranks a progress clip below the reply and the heard echo, drops
  it once the memo has its reply, and never overlaps utterances; the pad itself drops a hold cue (`mayPlayProgress`) while the
  driver is arming or recording instead of deferring it. A cue already playing is under a second, so the answer simply follows.
  Kill switch `mise run memo:converse off` skips the desk and so the cue; non-converse memos have none.
- **Trace.** `memo:trace` shows `car:hold-cue#<n>` hops and a "first hold cue" timing for an agent turn.


## Latency levers in the watcher (HOLOC-23 phase 2)

Record stop to first audible answer is the operator's priority. These are the watcher-side levers, each env-gated with the
old behaviour as the fallback (the unit turns them on; a test run leaves them off). Numbers are measured on this host
under load (load average 70-85), not estimated.

| lever | env (unit) | what it replaces | measured |
|---|---|---|---|
| S3 over the local MinIO port | `MEMO_S3_ALIAS=delodrive` | the `delo` alias = `s3.delo.sh` through Cloudflare for every `mc` call | `mc cp` up 7.1 s p50 -> 0.14 s, down 3.5 s -> 0.07 s, `mc stat` 3.9 s -> 0.07 s |
| In-process kept-alive S3 (`s3direct.py`) | `MEMO_S3_DIRECT=1` | an `mc` process per cp / ls / stat / cat / pipe | up 65 ms, down 18 ms, stat 3 ms, listing of 415 objects 113 ms vs 147 ms. Falls back to `mc` on any error, any other verb, a missing object |
| Fast discovery thread | `MEMO_DISCOVER_FAST_S=0.4` | the 1 s tick listing (the proxy's wake hint is faster still and stays) | landed -> discovered p50 0.70 s (p90 4.8 s, today's journal) -> 0.39 s on the poll alone |
| Level probe beside Whisper | always | ffmpeg `volumedetect` (0.2-0.3 s) in front of the Whisper request | download -> transcript stage 1.07 / 1.35 s -> 0.79 s. A silent clip is still refused (after one GPU call) |
| Ordered async facts | `MEMO_FACTS_ASYNC=1` | `bb-emit` subprocess (0.16-0.5 s under load) in front of Whisper, the desk and the next chunk | `received` / `transcribed` / `voiced` leave through one ordered thread; any other fact waits for it to drain first, so bus order is unchanged. A failed publish goes to the outbox; shutdown drains the queue |
| Early push hint | `MEMO_PUSH_HINT_URL` | the pad waited for the fact to travel bb-emit -> NATS -> proxy | `received` / `transcribed` / `voiced` call the proxy's `/internal/push` first (~2 ms, own thread, fail-open); the NATS copy is dropped as a duplicate |
| PhraseBank | `MEMO_PHRASEBANK=1` | a vox render of "Dropped. Nothing was sent.", "Okay. Talk soon." and the other fixed lines (1.5-3.5 s) | rendered once per voice and kept in `<state>/phrases/` (warmed at start-up at the lowest vox priority, learned on first use); a hit is a file copy, logged `phrasebank_hit`, engine `phrasebank` |
| Shorter first beat | `MEMO_CONVERSE_CHUNK_CHARS=45,80,170,300`, `..._MIN_CHARS=60` | a 70-character first chunk | vox renders in about 1.6 s + 0.018 s per character at 6 steps (26 chars 1.9 s, 46 chars 2.5 s, 66 chars 2.7 s, 100 chars 3.4 s): the first chunk is about 0.3 s sooner, and the second (80) is ready before the first has finished playing. A reply under 85 characters is still one piece (a tail under 40 characters rejoins) |

Controlled A/B of the real watcher on a scratch bucket (`holo-bench`; same Whisper, LLM ladder and vox; `bb-emit --check` as
the publisher), 6 spoken memos each, seconds from the PUT returning:

| point (p50, seconds after the PUT returned) | before (alias `delo`, mc, sync facts, 1 s tick) | after (all levers) | change |
|---|---|---|---|
| discovered | 0.81 | 0.25 | -0.56 (the proxy's wake hint is not in this bench; it makes this ~0) |
| download done | 1.97 | 0.39 | -1.58 (the download itself 295 ms -> 3 ms) |
| transcript ready (Whisper done) | 2.73 | 1.14 | -1.59 |
| `transcribed` stage done / fact | 3.07 | 1.35 | -1.7 |
| first chunk uploaded, measured from the decision | 3.07-4.41 | 1.9-2.3 | about -1.2 (TTS 2.5-2.8 s -> 1.8-2.1 s, chunk upload 0.35 s -> 0.07 s) |

The decision itself (the LLM, 2.4-6.7 s through `automaticai/auto/fast` in these runs) was the same code on both sides and
is now the largest hop.

Not done, with the reason:
- Streaming the LLM and speaking the first sentence early: the guards rewrite `say` after the full decision (the sent-claim
  filter, `incomplete_propose`, the forbidden-model check), so speaking early can say "sent" when nothing was sent.
- TTS at 4 steps: about 0.3 s sooner (2.66 s -> 2.30 s at 66 characters) but the voice quality needs a listen first; env only
  (`MEMO_CONVERSE_TTS_STEPS`).
- Card prefetch on `record_started`: `decide_ms - llm_ms` is 6-35 ms and the card is already cached, so it is worth about 0.
- Whisper tail: Whisper on fast turns was 0.5 / 0.64 s p50 / p90 with a 1.5 s maximum; nothing to fix on this evidence.
- A queued fact is lost if the process is killed (not stopped) in the ~0.3 s before it publishes; a normal stop drains the queue.

## Upload proxy

`services/upload-proxy/upload_proxy.py` runs in the `agent-pad-upload`
container (compose: `~/docker/stacks/websites/agent-pad/compose.yml`). It logs
one JSON line per PUT, accepted or rejected, and publishes the `uploaded` fact
over raw NATS to `host.docker.internal:4222` (compose maps it with
`extra_hosts: host-gateway`). A PUT whose body is shorter than its
Content-Length (a cell drop mid-upload) is rejected 400 `short_body` and
published as `failed(stage=upload)`; an `.ogg` key must hold an `OggS` stream.
`POST /upload/client-event` takes the device-side events from the pad (see the
hop table). `{"event": "speech", "key": <inbox key>, "speech": {action, kind, id, seq, reason, mic, at, mono_ms,
memo_id}}` is one decision of the car's speech queue: logged as a `speech` line (`docker logs agent-pad-upload | grep
'"event":"speech"'` is the overlap audit: `at` is the device's wall clock, `mic` idle|arming|recording), and the
memo-tied `start|end|halt|drop|deferred` ones are published as `audio.memo.notified` (`queued`, `ignored` and `mic` stay
in the log). After editing it:

```bash
cd ~/docker/stacks/websites/agent-pad && docker compose up -d --force-recreate agent-pad-upload
```

## Verified live: tiles, tools and the new ladder (2026-10-22, sim emulator-5554)

Watcher at 9de56bd + b9703c1 (restarted idle; heartbeat: routes r1/r2/r3, `key_status ok` per rung, r3 `scope ok`, tools
`car_set_model`, `car_set_voice` loaded from the car-desk scope, 12 vox voices). Driver: `converse-e2e/tools/drive_converse.py`,
holocene-pm tile, speech through the `holo_testmic` null sink (the emulator's mic started ~2 s late this run: utterances were
padded with 2.5 s of lead-in silence; two recordings still came out empty or as "Yes").

| memo | driver said (whisper heard) | path | result |
| --- | --- | --- | --- |
| 8139c55f | "Use Walken voice." ("Use the walkin' voice!") | LLM: r1 `http_402` (breaker opened), r2 deepseek-flash 1741 ms -> `action tool` | `car_set_voice(walken)` via the skill, exit 0, 784 ms; "Switched Holocene PM to Walken." `voiced`/`replied` `voice=walken` |
| 8078da50 | "Switch to Deep Seek Pro!" | `setting_phrase` (no LLM call) | `car_set_model(deepseek-pro)` via the skill, 124 ms; "Holocene PM now thinks with Deep Seek Pro." |
| b02d569c, 5f183acd | two questions | ladder pro-h (breaker) > **pro-d deepseek-v4-pro** | answered in 4757 / 2844 ms, spoken in walken |
| f3a98ef4 | "Reset the model." | `setting_phrase` | back to the default ladder |
| 0f56b037 | a question | r1 402, r2 deepseek-flash `empty` (no content), **r3 auto/fast -> glm-5.3** | 8457 ms; r2 now has max_tokens 1500 |

`mise run memo:trace 8139c55f` shows `tool deepseek-flash@r2 (2 attempts, 1741 ms, ...) failed: r1 http_402 ... tool
car_set_voice(voice=walken) ok via skill 784 ms tile voice walken model default ladder`. The voice was reset afterwards
(`mise run memo:voice holocene-pm --clear`). Whisper's "walkin'" now also matches the phrase short-circuit (one letter off a
name of five letters or more, on the speech path only).

## Verified live: the fast in-car desk (2026-10-22, sim emulator-5554)

Honda sim, driving mode, holocene-pm, converse on for the sim device only (flag file), watcher at the commits listed in
`_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/evidence.md` (the full record, scenarios S1-S13, traces and
the overlap files live in that folder). Speech went through the `holo_testmic` null sink. **The model criterion is not met:**
Hyper (the key shared with Hindsight) was out of credit (`402`), so deepseek-v4.1-flash-1017 answered none of the run; the
non-Anthropic gateway rungs answered all of it (`ministral-14b` 39 decisions, `gemini-3.5-flash-lite` 36, `k3-256k` 1; none
Anthropic).

| record stop to the first sound of the answer, 12 fast turns of one conversation | p50 | p90 | max |
| --- | --- | --- | --- |
| first speaker-tap packet after the car starts the reply | **7.80 s** | **10.39 s** | 11.59 s |
| the car starts the reply (`HoloceneSpeech start reply`) | 6.81 s | 9.42 s | 10.90 s |

Every one is `routed action=reply`, no `dispatched` fact; the LLM took 0.6-2.1 s; the rest is upload (p50 0.8 s), whisper
(p50 +2.4 s from the stop), TTS and the pad's two ack cues in front of the reply (`waited_ms` 2.0-3.3 s).

| scenario | result |
| --- | --- |
| S2 propose, S6 "let it change the code", S4 duplicate "send it", S5 "how's that going", S7 "ask <agent> directly", S12 kill switch | pass |
| S3 confirm | one batch follow-up with a uuid5 command id, one journal row, one `delegated` fact; "Sending to ..." audible at 7.7-10.4 s (the 7 s target is not met: it waits behind the acks) |
| S8 retarget | live: named `Flume PM` -> `target_agent_id=flume-pm`, journal profile flume-pm; the unnamed refusal is unit-tested only |
| S9, S10 | a delegation result halted by a new recording replays in full after the note; a fast reply the driver records over is not replayed (`skipped barged_in`) |
| S11 | Hyper unroutable -> a gateway rung answers; every rung unroutable -> today's path, `fallback_reason=all_routes_failed`, echo back |
| S13 | drafts expired unsent after 600 s (`converse_draft_expired` x2); the `sim_stop.sh` half was not run |

Gateway journal, per confirmed brief (5): 1 row, `lane=batch`, command id = `uuid5` of the brief id, 1 `audio.memo.delegated`,
1 follow-up `dispatched`; 6 repeated "send it" turns published nothing.

Overlap audit (`apps/auto/tools/speech_overlap.py`, speaker tap + logcat): period 1 (370 utterances, 84 recordings, tol 60 ms)
ZERO OVERLAPS on all six checks; period 2 (59 utterances, 14 recordings, **tol 30 ms**) ZERO OVERLAPS on all six; whole session
logcat only (516 utterances, 117 recordings): ZERO OVERLAPS at 60 ms. At 30 ms, check 2 flags 2 recordings where the pad's own
`ack:stopped` cue started 1 ms after `mic=idle` and the OS capture dump lagged 41 and 54 ms. The tap has no data from 12:24 to
12:53Z (its 90 minutes ran out), so checks 4-5 did not run in that gap.

What the run fixed (all in `converse.py`, tested): a 402 opens a rung for 10 minutes; ministral-14b and gemini-3.5-flash-lite
rungs ahead of kimi/glm; whisper's "S-Send it!" matches the lexicons; "I've sent it" is not rewritten while a delegation exists;
a propose with no title or brief goes to the next rung, then the guard builds it from the driver's words; an expired draft says
so; "send it" with nothing pending is never a draft or a direct turn; a gateway timeout blames the upstream channel, not the
gateway.

## Verified live: fast model, answer-then-background (2026-10-22, sim emulator-5554)

Four holocene-pm memos from the simulator (flite speech through the null-sink mic), watcher 4e52756 + f9c35f5,
gateway eac6bb0 (detach on, `data.model`), the GPU whisper server on. Times are from the upload (server clock).

| memo | ask | result |
| --- | --- | --- |
| 2cbf4423 | "what is your status? one sentence" | STT 0.57 s (GPU), sol-6.1 applied, turn 10.6 s, reply playing in the car at +20.2 s |
| 7554c8d1 | "read every README in the repo and summarize each" | quick answer playing at +30.6 s ("I'll read every README ..."), follow-up 1 on batch dispatched 1 s after its replied fact, 195 s of work, the car played it at +233.7 s |
| 225824b2 | "run sleep 170 twice, do not hand it off" (garbled by STT) | handed off anyway: quick answer at +30.3 s, follow-up spoken 186.7 s later |
| c5728a71 | "run sleep 170 two times, no background" | one 202 s interactive turn with narration, reply at +203.2 s (no detach needed) |

For comparison, the real car on 2026-10-21: median reply 188 s, p75 393 s, four memos killed at 300 s and re-run
(answers at 384-1989 s). 7554c8d1's follow-up spoke the head of a 7140-char report; its closing summary is what is
spoken now (`spoken_summary`, 4th commit). A detach was not reproduced through a memo: the budget and Sol keep turns
under 300 s. The gateway's own live proof (command 426a8f89: detached at 300.0 s, completed at 355.2 s) wrote the
same `detached_at` column and facts that `test_followup_detach.Detached` feeds the watcher.

## Verified live: chunked reply over the push channel (2026-10-20)

Memo `1ac175ad` from the sim ("reply with a long paragraph", 1063-character reply, 3 chunks): the agent finished at
+12.6 s into its turn; chunk 1 (105 chars, 4.4 s on vox) was up 4.8 s later and the car started it 0.4 s after that
(4.9 s after the agent finished); chunks 2 and 3 were buffered before the one before them ended and played back to
back; the full file was up 16.5 s after the agent finished and the phone started it 2.3 s later. Memo `2508b667`: a
recording started 2 s into chunk 1 stopped the reply before the mic armed; after the note the reply played again from
chunk 1, then the queued "not sent" cue. `mise run memo:trace 1ac175ad` shows `car:chunk#1of3`, `car:chunk#3of3` and the
"after the agent finished" line.

## Verified live: progress (2026-10-20)

One memo through the proxy (`inbox/holocene-pm/2026/10/20/20261020T192012Z.ogg`, memo `f753985b`), as the status
object showed it: `transcribing` +0.9 s, `heard` +7.2 s, `working` +7.4 s, progress #1 "I'll check the current date."
+17.4 s (9.9 s into the turn), #2 +23 s, narration #1 (of #2, 3.1 s voxcpm) uploaded +27.4 s, `replying` +28.9 s,
`done` +32.4 s; the sim's pad played the reply 9.2 s after it was rendered and reported it as `audio.memo.notified`.
`mise run memo:trace f753985b` shows every one of those hops and the timing line.

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
  after `turn_timeout_seconds` (300 s) and the watcher re-dispatches the same prompt once on the batch lane (answered
  as a late reply); only a second stop, or an escalation that is switched off, fails the memo
  `agent_reply/turn_timeout`. Memos are the only producer on `invoke`; n8n, PMs and `hookd_bridge` stay on `start`.
  A published command cannot be recalled: `memo:cancel` after dispatch keeps the reply from being spoken but the
  agent may still run (and spend its tokens) to the end of its turn.
- Playback is reported by the page's audio element, not by capturing the
  audible output; a car switched off mid-reply never reports `ended`.
- The gateway publishes lifecycle facts only, not the reply text, so the
  watcher reads the reply from the Hermes profile `state.db`.
- If the gateway's bloodbank platform is down, commands queue in JetStream and
  the trace verdict says `NOBODY PULLING <lane>`. Commands run when it comes back.
  A gateway that pulls nothing on purpose says why instead (memo:trace, the
  watcher log, the /voice banner): `gateway restarting (draining)`, `gateway
  stopping (draining)`, `gateway paused for maintenance (draining)`, `gateway
  restarting` (between processes) or `gateway starting`, each followed by
  `memo queued; it runs when ...`.
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


### Review fixes (2026-10-22, HOLOC-23)

An independent review of the desk found the following, all fixed and covered by `test_converse_review.py`:

- **Confirmation is explicit.** `send it`, `go ahead`, `do it`, `ship it`, `make it so` alone (optionally behind yes/okay) are
  the lexicon. A bare `yes` / `okay` / `sure` confirms only when the read-back was the desk's last words (`send_affirmed`,
  `readback_just_heard`); `Okay, how long will that take?` or `Yeah. Also, who owns X?` never sends (a question beside a
  confirmation re-reads the draft). Great / perfect / correct are not confirmations.
- **Permission clamp** drops clauses with a negation (`don't change any code`, `do not deploy`) and questions (`why did it
  restart?`); `change` alone (editing the draft) grants nothing; the turn before counts only while a draft is pending.
- **Named handoff**: the target is exempt from re-naming once it was named and read back (`make the title shorter` keeps
  Flume PM); a model confirm that echoes another id is ignored unless the driver named that agent in this turn; display
  names resolve to roster ids; ordinary words that are also id stems (`monitoring`, `infra`) name nobody.
- **Cancel / redirect while the read-back is still spoken**: cancel stops the delegation if it has not been published
  (`Okay, cancelled before it left`), or says it is already on its way; a redirect or edit says it is already being sent.
  Brief ids now carry the target and the proposal time, so a redirect never shares an id with the draft it replaces.
- **A delegation that cannot be dispatched** (unroutable target, bus down past the budget) fails its follow-up, restores the
  draft, and the driver hears `I couldn't send that to X, so nothing was sent`; a draft stuck in `sending` for 30 min is
  cleared by the sweep. **memo:retry** of a confirm whose read-back failed or that was cancelled re-asks the desk
  (`resume_stage=converse`, `conv_raw` and the half-made delegation dropped), so it never re-speaks `Sending to ...` with
  nothing sent, never re-publishes a command id, and honours the kill switch. A failure half way through the apply rolls
  the conversation and memo fields back.
- **Config robustness**: a malformed `timeout_s` / `temperature` / `max_tokens` refuses that route (never raises out of
  `settings()`); an unreadable key is `unreadable` only until its retry time; `op read` is waited on for at most the rest of
  the ladder budget (the read finishes in the background).
- **Never Anthropic**: delegated briefs run on the voice model, not the PM's `automaticai/auto` default; `forbidden()` is
  hardened (see above); a response with no `model` field no longer credits the requested model.
- `converse_slow` logs any fast turn whose reply took longer than `MEMO_CONVERSE_SLOW_S` (15 s) with its stage breakdown.

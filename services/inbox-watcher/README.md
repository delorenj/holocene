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
  with no batch re-run: it already ran the whole time a re-run would. The escalation above stays for a gateway that
  stopped the turn at the wall clock (detach off, `max_detached` reached, an envelope deadline).
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
  NEW `replies/<day>/<HHMMSS>Z-<agent>-<memo_id>.ogg` (the pad plays every reply unit of a memo it sent; the claim for
  the phone is the memo's, so whoever spoke the quick answer speaks the follow-up). Its `replied` fact carries
  `followup=N`. A follow-up that fails, times out, or completes without new text is spoken as such
  (`followup_failed=true`) instead of failing a memo whose answer was already given; `memo:cancel` keeps it quiet. One
  follow-up per memo by default (`MEMO_FOLLOWUP_MAX=1`; 0 turns the hand-off off, the line is still never spoken). This
  is a watcher-side self-dispatch rather than a gateway tool: no gateway edit or reload, and the watcher already owns
  the memo, its cancel and its trace.
- **Voice turns name their model (2026-10-22).** Every memo command carries `data.model = MEMO_VOICE_MODEL` (follow-ups:
  `MEMO_FOLLOWUP_MODEL`), default `automaticai/personal/sol-6.1`, and the gateway runs that one turn on it through an
  internal `/model <route> --once` (bloodbank `docs/interactive-command-lane.md` section 10). On the real heavy step of a
  crank circuit (20.7k-token prompt): glm-5.3@max (where `automaticai/auto` lands for the desks' tokens) 51 s, kimi-2.8
  11-27 s, sol-6.1 8.4 s at high and 13-15 s at the providers' xhigh (what goes on the wire: effort is not a per-turn
  knob on this provider, the route is). Hermes' fallback chain (glm-5.3, kimi-2.8) takes over when the Sol pool answers
  403/429. `dispatched` and `replied` carry `model`, `replied` the gateway's `model_override {requested, applied,
  reason}`. Empty `MEMO_VOICE_MODEL` = the profile's own model.
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

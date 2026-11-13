# HOLOC-14 — Auto app: close the voice loop

**Branch:** `holoc-14-voice-loop` (pushed from `.worktrees/holoc-12-auto-ux`; carries the
formerly-unreachable HOLOC-12 commits — HOLOC-13 mitigation)
**Worktree:** `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-12-auto-ux`
**Claimed:** 2026-10-11 by holocene-pm

## Verified server-side contract (read from live systems, not docs)

### Upload → transcription
- Wax inbox `~/HeyMa/inbox` is a **plain local dir; safe to write** (WAX-DESIGN;
  Syncthing feed was repointed to `dropoff` 2026-06-29). A bare media file in the
  inbox with no ledger row is selected by `next_item()` as `pending` → processed.
- Accepted suffixes (`wax/state.py MEDIA_SUFFIXES`): `.m4a` among them (AAC in
  MP4 — encodable with pure-framework MediaCodec+MediaMuxer).
- `item_id = sha256(file_bytes)[:16]` (`wax/ledger.identify`). The app computes
  this over its upload and correlates the transcription event.
- On completion Wax publishes **`bloodbank.audio.transcription.completed`** with
  `data.item_id`, `data.transcript_text` (inline, verified live: faster-whisper,
  `transcript_inline: true`), `data.file_path`, `data.s3_url`.

### Dispatch (proven: exec `ab9aa4b7`, thread `holocene-auto-loop-test-002`)
- Subject `bloodbank.cmd.agent.invocation.start`; envelope required:
  `command_id`, `idempotency_key` (uuid), `delivery: "single_consumer"`,
  `dataschema: apicurio://holyfields/bloodbank.agent.invocation.start/versions/1`,
  `schemaref: bloodbank.agent.invocation.start.v1`, `kind: command`,
  `domain: agent`, `subject` mirrored, base CE fields.
- `data`: `target_agent_id` (profile, e.g. `33god-pm`), `prompt` = transcript
  text (never null), `thread_id`, `context.source = "HOLOCENE-AUTO:Agent:<Name>"`.
- NATS at `host:4222` has **no client auth** (cluster auth only) — a minimal
  TCP NATS client (CONNECT/SUB/PUB/PING) in-app needs no credentials.

### Answer (proven: Candystore rows 2026-10-11)
- **`bloodbank.conversation.message.appended`**, `data.thread_id` matches the
  dispatched thread, `data.final_answer: true`, `data.reply.audio.url` points at
  `https://s3.delo.sh/holocene-auto/...` (bucket anonymous `download`,
  range-capable — MediaPlayer can stream it directly).

### New server piece (smallest that closes the gap)
- `services/wax-intake/` — stdlib-Python HTTP intake (PUT /inbox/<filename>,
  bearer token) writing atomically into `~/HeyMa/inbox` (staging + rename),
  systemd user unit, binds localhost + LAN. Client uploads its m4a here.
  This is the ticket's "direct inbox write path" option; dropoff is gated by the
  Syncthing guard policy (`received.json`) and would strand app uploads.

## Decision (holocene-pm, 2026-10-11)
App-side dispatch: the app itself subscribes `transcription.completed` (filter
`item_id`), extracts `transcript_text`, and publishes the invocation command over
the same NATS client it uses for the answer subscription. No new server
dispatcher component. Basis: Pillar 3 (one liftable NATS part covers upload
correlation, dispatch, answer subscribe), Pillar 4 (adapter over transport).
Rejected: server-side dispatcher on filename tags — extra component, and the
source tag would be inferred instead of asserted by the surface that knows it.

## Verification ladder (per auto-loop.md, extended for app-side)
1. Unit tests green; debug APK builds.
2. Emulator (HOLOC_9_Honda_API33): `adb reverse tcp:4222 tcp:4222` and intake
   port; speak utterance → file appears once, complete, in `~/HeyMa/inbox`.
3. `bloodbank.audio.transcription.completed` arrives; app log shows item_id match.
4. Gateway journal: execution row for the app's command_id reaches `completed`
   (non-instantaneous).
5. App log: `message.appended` on its thread_id; MediaPlayer starts; square
   bounces during wait+playback; audio audible.
6. Candystore row for the answer event.

## Status log
- 2026-10-11 claimed; branch pushed; implementer dispatched.

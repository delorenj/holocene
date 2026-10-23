#!/usr/bin/env python3
"""Inbox watcher: the voice memo pipeline as an observable service.

    Agent Pad upload -> S3 inbox/<agent>/<yyyy>/<mm>/<dd>/<file>
      -> received -> transcribed -> dispatched (bb command) -> agent turn
      -> reply text -> TTS -> S3 replies/... -> replied

Every hop produces TWO records, so a stuck memo is never a mystery:

1. A Bloodbank fact `bloodbank.audio.memo.<stage>` whose correlationid is the
   memo id (uuid5 of the S3 key). The agent invocation command carries the
   same correlationid, so the gateway's agent.invocation.* facts join in and
   `GET candystore/events?correlationid=<memo_id>` returns the whole journey.
2. One structured JSON log line on stdout (journald) with memo_id, key, agent,
   stage and ms.

Operator rule (Jarad, 2026-10-12): routing is explicit from the button press,
never inferred. The target agent comes ONLY from the S3 key path.

State lives in ~/.local/state/holocene-auto/inbox-watcher/ (never in the repo).
On the very first start every existing inbox object is baselined as already
seen so old test memos are never replayed.

Run: python3 inbox_watcher.py [--once] [--drain] [--poll 5]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import copy
import fcntl
import hashlib
import heapq
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import converse as cv  # noqa: E402
import memo_common as mc_  # noqa: E402
from memo_common import (  # noqa: E402
    BB_EMIT, BUCKET, CANCELLED, DELEGATION_REASON, ESCALATED_REASON, FOLLOWUP_REASON, REPLIES_PREFIX, STATE_DIR,
    agent_from_key, cancel_after_dispatch, iso, live_followup, long_turn, memo_escalated, memo_id_for, now_utc,
    rescue_open, resume_for, truncated_by_old_watcher,
)

SERVICE = "inbox-watcher"
TRANSCRIBE = os.environ.get("MEMO_TRANSCRIBE", str(Path.home() / ".local/bin/transcribe"))
TRANSCRIBE_DIR = os.environ.get("TRANSCRIBE_DIR", str(Path.home() / "HeyMa"))
VOICE = os.environ.get("MEMO_VOX_VOICE", "rick")

# Which gateway lane a memo's command rides: "interactive" (bloodbank.agent.invocation.invoke, own
# durable consumer + reserved slots, starts within seconds even while grooming saturates the batch
# lane) or "batch" (invocation.start, FIFO behind grooming; the pre-lane behavior and the rollback lever).
# An interactive memo falls back to batch, loudly, when nothing is pulling the interactive consumer.
LANE = os.environ.get("MEMO_LANE", "interactive").strip().lower()
if LANE not in mc_.GATEWAY_CONSUMERS:
    # A typo in the rollback lever (MEMO_LANE=bacth) must not quietly put memos on the lane the operator
    # was trying to leave. Refuse to start: systemd shows the failure and the log says why.
    sys.stderr.write(json.dumps({"level": "error", "event": "bad_memo_lane", "value": LANE,
                                 "valid": sorted(mc_.GATEWAY_CONSUMERS),
                                 "note": "MEMO_LANE must be 'interactive' or 'batch'"}) + "\n")
    raise SystemExit(2)
LANE_PROBE_GAP_S = float(os.environ.get("MEMO_LANE_PROBE_GAP_S", "1.5"))
LANE_HEARTBEAT_PROBE_S = float(os.environ.get("MEMO_LANE_HEARTBEAT_PROBE_S", "5"))

AGENT_TIMEOUT_S = int(os.environ.get("MEMO_AGENT_TIMEOUT_S", "600"))
# The agent deadline is extended (one AGENT_TIMEOUT_S at a time) while the command is verifiably
# still queued or running, up to this total. The deadline is judged against the memo's OWN lane:
# an interactive memo is extended only while the interactive lane is busy, not while grooming is.
QUEUE_MAX_WAIT_S = int(os.environ.get("MEMO_QUEUE_MAX_WAIT_S", "3600"))
# A memo that timed out may still finish later; keep watching its command this long and speak the
# reply late rather than lose work the agent already did.
RESCUE_WINDOW_S = int(os.environ.get("MEMO_RESCUE_WINDOW_S", "7200"))
# An interactive turn the gateway stopped at its wall clock (turn_timeout) is not the end of the memo: the same prompt is
# re-dispatched once on the BATCH lane, which has no wall clock. This is how long the watcher then waits for that turn.
BATCH_TURN_TIMEOUT_S = int(os.environ.get("MEMO_BATCH_TURN_TIMEOUT_S", "7200"))
# The gateway's turn_timeout says turn_stopped=false when Hermes did not confirm the turn stopped (it may still be
# unwinding): the batch turn would start on the same session beside it. Wait this long before escalating then.
TURN_UNWIND_WAIT_S = float(os.environ.get("MEMO_TURN_UNWIND_WAIT_S", "10"))
# A reply older than the escalated command (minus this slack) is the stopped turn's partial output, never an answer.
REPLY_FRESH_SLACK_S = 2.0
# Floor for the transcribe timeout; the real timeout scales with the audio (see transcribe_timeout()).
TRANSCRIBE_TIMEOUT_S = int(os.environ.get("MEMO_TRANSCRIBE_TIMEOUT_S", "420"))
TRANSCRIBE_RATIO = float(os.environ.get("MEMO_TRANSCRIBE_RATIO", "8"))  # CPU large-v3 measured ~5x realtime
TRANSCRIBE_MAX_S = int(os.environ.get("MEMO_TRANSCRIBE_MAX_S", "7200"))
# The fast path (holocene-whisper.service): large-v3-turbo kept warm on the GPU, about 0.5 s for a 7 s clip. Tried first;
# the `transcribe` CLI runs instead on ANY failure (down, slow, an error, a junk result), so the server can only make a
# memo faster, never fail it. The CLI alone was 5-6 s cold on the GPU and 8-17 s whenever another transcription held
# its heavy lock (its CPU "small" fast lane: every car memo of 2026-10-21). Empty MEMO_WHISPER_URL turns it off.
WHISPER_URL = os.environ.get("MEMO_WHISPER_URL", "http://127.0.0.1:8766").rstrip("/")
WHISPER_TIMEOUT_S = float(os.environ.get("MEMO_WHISPER_TIMEOUT_S", "8"))     # plus 0.1 s per second of audio
WHISPER_MAX_AUDIO_S = float(os.environ.get("MEMO_WHISPER_MAX_AUDIO_S", "900"))  # longer goes to the CLI
MAX_ATTEMPTS = int(os.environ.get("MEMO_MAX_ATTEMPTS", "3"))
MIN_AUDIO_S = float(os.environ.get("MEMO_MIN_AUDIO_S", "0.7"))
SILENT_MAX_DBFS = mc_.SILENT_MAX_DBFS  # loudest-sample line below which a recording is silent (see memo_common)
# Prepended to the transcript so the agent knows it is speech-to-text, not typed text, and that the driver hears what it
# says while it works: the gateway publishes every sentence the model writes next to a tool call
# (agent.invocation.progressed) and the watcher speaks the newest one every 30 s. Without the ask most memo turns write
# none (measured 2026-10-20: 0-4 of 8-18 tool rounds carried text), and a 2-minute turn is 2 minutes of silence.
# The budget half (2026-10-21 latency study, 17 real car asks, median reply 188 s, p75 393 s): 8 of them were status or
# "did you hear me" questions that ran 9-28 model calls (median 165 s), and 406 s of the tool time was `sleep N` waits,
# 346 s was the agent speaking through vox-speak itself, 288 s a deploy nobody asked for. The gateway's own platform hint
# says no human is present, the opposite of the truth here, so the prefix says otherwise first. A long ask is answered
# in a sentence or two and handed to a background turn with a BACKGROUND: line (split_background, start_followup).
VOICE_PREFIX = os.environ.get("MEMO_VOICE_PREFIX", "[Voice memo transcript - speech-to-text, may contain recognition errors. "
                              "A driver is waiting to hear your answer aloud, whatever else says no human is present: answer "
                              "within about a minute and at most 3 tool calls. The driver hears your progress aloud while you "
                              "work: before each tool call, write one short sentence saying what you are about to do. Never "
                              "run vox-speak or any text-to-speech yourself (your reply is spoken for you), never sleep or "
                              "wait and re-check, never delegate to a subagent (delegate_task), and run no deploy or long "
                              "command unless asked. If the ask needs longer "
                              "work, do not start it now: tell the driver in one or two sentences what you will do, then end "
                              "your reply with a line that starts with BACKGROUND: followed by complete instructions for "
                              "yourself. That work starts right after, on this same conversation, and its result is spoken "
                              "to the driver as a follow-up.] ")
# Prepended to a reply's BACKGROUND: instructions when they go back to the same agent as a background turn.
# The plan below it was written by the agent from a speech-to-text transcript and runs unattended (2026-10-22 review):
# the voice prefix's "no deploy unless asked" rule is carried over, and a misheard ask does the safe part and says so.
# No delegate_task: a subagent runs on automaticai/auto/subagent, not the turn's model (B, 2026-10-22: 410 s synchronous).
FOLLOWUP_PREFIX = os.environ.get("MEMO_FOLLOWUP_PREFIX", "[Background continuation of the voice memo above: the driver already "
                                 "heard your short answer. Do the work below now, in full, without asking questions; the "
                                 "one-minute budget does not apply here. Do it yourself: never delegate to a subagent "
                                 "(delegate_task). Never run vox-speak or any text-to-speech yourself. Run no deploy, "
                                 "restart, push or other change to a live system unless the driver's own words asked for "
                                 "it; the ask came through speech-to-text, so if it is unclear, do only the read-only part "
                                 "and say what you left undone. Your final message is spoken to the driver as a follow-up: "
                                 "end it with a spoken summary of the result in two to four sentences, and do not write a "
                                 "BACKGROUND: line.] ")
# How many background follow-ups one memo may chain (a follow-up's own BACKGROUND: line counts). The batch lane has no
# wall clock, so a follow-up has no reason to hand off again: 1 by default. 0 turns answer-then-background off (the line
# is still never spoken).
FOLLOWUP_MAX = int(os.environ.get("MEMO_FOLLOWUP_MAX", "1"))
# The lane a follow-up rides: batch (invocation.start, no wall clock) by default.
FOLLOWUP_LANE = os.environ.get("MEMO_FOLLOWUP_LANE", "batch").strip().lower()
if FOLLOWUP_LANE not in mc_.GATEWAY_CONSUMERS:
    FOLLOWUP_LANE = "batch"
# What the driver hears when the agent wrote only a BACKGROUND: line and no answer of its own.
FOLLOWUP_ACK = "On it. I will call you back with the result."
# What the driver hears when the agent wrote only a BACKGROUND: line and nothing could be handed off (no instructions after
# it, or MEMO_FOLLOWUP_MAX=0). Never "Done.": nothing was done.
NO_HANDOFF_LINE = "Nothing was started in the background, so no follow-up is coming. Please ask again."
# Voice turns run on a fast model, per turn: the command carries data.model and the gateway runs that one turn on it
# through Hermes' internal `/model <route> --once` (the memo's own session only, never Telegram, never config.yaml; its
# terminal fact reports model_override {requested, applied, reason}; bloodbank docs/interactive-command-lane.md section 10).
# Measured 2026-10-21 on the real heavy step of a crank circuit (20.7k-token prompt, the call that took 62 s live):
# glm-5.3@max, where automaticai/auto lands for the desks' tokens, 51 s (113 s at high); kimi-2.8@high 11-27 s;
# sol-6.1 8.4 s at high and 13-15 s at xhigh (the providers' extra_body effort, which is what goes on the wire: per-turn
# effort is not a knob on this provider, the route is); production per-call mean 13.4-15.9 s on GLM vs 8.4-9.3 s on Sol.
# Sonnet 5.5 was 5.1 s on a plain call. 2026-10-22: the voice turn and the follow-up were switched to
# automaticai/personal/claude-sonnet-5.5 (operator-approved) and ROLLED BACK the same day: Anthropic answers Hermes'
# gateway turns on every Claude route (personal and intelliforia) with HTTP 400 "Third-party apps now draw from your extra
# usage, not your plan limits" (live e2e, memo 0a24d782), so every turn paid one failed call and ran on glm-5.3 (quick
# answer +105.8 s vs +43.7 s on sol-6.1), and a Claude route in the shared "hermes" token's scope also enters
# automaticai/auto's candidates, so non-voice desks got the same 400 (navi-pm, pile-of-dumb-things-pm). The model_override
# fact says "applied" even when Hermes then fell back: it means /model took, not that the route answered; read the
# profile's agent.log "API call #n: model=". To retry Sonnet: enable extra usage on the Claude account, give the car desks
# a token that auto cannot use (not the shared "hermes" one), scope the route, then set MEMO_VOICE_MODEL and
# MEMO_FOLLOWUP_MODEL in the unit. Hermes' fallback chain (glm-5.3, kimi-2.8) takes over on a route-limit 403/429, so an
# exhausted route costs a fast failure per call, never the memo. The route must be in the profile's
# providers.automaticai.models. Empty = the profile's own model.
VOICE_MODEL = os.environ.get("MEMO_VOICE_MODEL", "automaticai/personal/sol-6.1").strip()
# A background follow-up has nobody waiting on it, and Sol's weekly pool is what keeps the VOICE turns fast (2026-10-22
# review: one follow-up made 12 Sol calls, 933k input tokens, 3.5x all 18 voice-turn calls of that round). So it runs on
# the profile's own model unless MEMO_FOLLOWUP_MODEL names one.
FOLLOWUP_MODEL = os.environ.get("MEMO_FOLLOWUP_MODEL", "").strip()
# A detached interactive turn (the gateway kept it running past its 300 s wall clock and released the slot) is waited for
# this long from its dispatch: the gateway's own ceiling for a detached turn is 2700 s (detached_ceiling_seconds), and it
# publishes failed(turn_timeout, timeout_source=detached_ceiling) when it cuts one off there.
DETACHED_WAIT_S = int(os.environ.get("MEMO_DETACHED_WAIT_S", "3000"))
# Said once, in the car, when the interactive turn is detached; after it the 30 s progress narration stops (the reply is
# spoken late). Empty: nothing is said.
DETACHED_LINE = os.environ.get("MEMO_DETACHED_LINE", "still on it. I will call you back when it is done.")
# An interactive turn older than this is also asked about a detach fact in Candystore (the journal is read every poll).
DETACH_PROBE_AFTER_S = float(os.environ.get("MEMO_DETACH_PROBE_AFTER_S", "240"))
# Whisper's usual output on noise or an accidental tap: never a real prompt.
HALLUCINATIONS = {"thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching", "you", "bye",
                  "bye bye", "okay", "ok", "uh", "um", "hmm", "mm", "mhm", "oh", "ah", "so"}
MAX_AGE_S = int(float(os.environ.get("MEMO_MAX_AGE_HOURS", "24")) * 3600)
SPEAK_CHARS = int(os.environ.get("MEMO_SPEAK_CHARS", "500"))
# A prompt is never shortened: a transcript over this many characters (about 3.7 hours of speech at roughly
# 900 chars/min, far above any real memo) is held with a clear error instead of being sent cut. The old 20000-char
# slice (about 22 minutes of speech) silently dropped the tail of a long memo and sent the agent half a sentence
# as if it were the whole ask.
MAX_TRANSCRIPT_CHARS = int(os.environ.get("MEMO_MAX_TRANSCRIPT_CHARS", "200000"))
# Every spoken reply is also dropped into this Earshot channel (s3://earshot/<channel>/), so it plays on the phone
# and its last hop (detected / started / finished on the device) shows up in memo:trace. Empty turns it off.
EARSHOT_BUCKET = os.environ.get("MEMO_EARSHOT_BUCKET", "earshot")
# The phone copy is left out when the car that sent the memo speaks the reply itself (a paired phone plays through the
# car's speakers: the same reply twice, or a reply into the next recording), and only then. Who speaks it is decided by
# the upload proxy's reply claims (POST /upload/claim): the car holds the reply on a renewed lease while it waits and
# claims its start; the watcher takes it for the phone when no car started it or holds it EARSHOT_CAR_GRACE_S after its
# first audio was up. A car switched off right after the agent finished never claims it (or lets its lease lapse), so
# the phone speaks it. Being connected is not enough: a dead car's push stream stays "open" for minutes at the edge.
# Only the proxy's yes sends the phone copy: a proxy that cannot be asked is waited for, never failed open (the car
# reads replies from S3 and may be speaking this one). MEMO_EARSHOT_SKIP_CAR=0 mirrors every reply again.
EARSHOT_SKIP_CAR = os.environ.get("MEMO_EARSHOT_SKIP_CAR", "1") != "0"
CLAIM_URL = os.environ.get("MEMO_PAD_CLAIM_URL", "https://agent-pad.delo.sh/upload/claim")
CLAIM_TIMEOUT_S = float(os.environ.get("MEMO_PAD_CLAIM_TIMEOUT_S", "4"))
# How long after the reply's first audio is up (chunk 1, or the one file) a car that never claimed it is waited for. A
# live car claims it within about a second of the push; the poll behind a dead or missed push is 2 s while a memo is in
# flight (the pad keeps its fast poll for as long as one is) and at the slowest the pad's idle poll, 15 s
# (apps/agent-pad/src/roster.ts REPLY_POLL_IDLE_MS), plus the listing and the hold's round trip. So the grace is the idle
# poll plus a margin: a live car that missed a push still holds the reply before the phone may take it (12 s was shorter
# than the idle poll, and such a car lost its reply to the phone). A car that is off costs the phone these seconds.
EARSHOT_CAR_GRACE_S = float(os.environ.get("MEMO_EARSHOT_CAR_GRACE_S", "20"))
# The Earshot drop is retried this many times (backoff EARSHOT_DROP_BACKOFF_S between tries) before the phone's take is
# given back: a reply the phone took and that never landed in Earshot would be heard nowhere (the car is refused for good).
EARSHOT_DROP_TRIES = int(os.environ.get("MEMO_EARSHOT_DROP_TRIES", "4"))
EARSHOT_DROP_BACKOFF_S = tuple(float(x) for x in os.environ.get("MEMO_EARSHOT_DROP_BACKOFF_S", "2,5,10").split(",") if x.strip()) or (2.0,)
# How long the release of the phone's take is tried (the proxy may be down as well) before the stage is retried.
EARSHOT_RELEASE_BUDGET_S = float(os.environ.get("MEMO_EARSHOT_RELEASE_BUDGET_S", "30"))
# A reply the phone took, whose Earshot drop failed for good, is given back to the car (the release above). With the car off
# for good nobody claims it, so the watcher keeps trying the phone in the background: EARSHOT_RETRY_FIRST_S after the
# release (a live car reclaims within about a second of the `released` push, 20 s at the slowest), then after each failed
# round EARSHOT_RETRY_BACKOFF_S (the last value repeats), until the phone has it, a car plays it, or EARSHOT_RETRY_TOTAL_S
# have passed since the release (0 turns the retry off). Every round re-asks the proxy: a car that holds or started the
# reply is never raced, and the phone's take is atomic, so one device plays it.
EARSHOT_RETRY_FIRST_S = float(os.environ.get("MEMO_EARSHOT_RETRY_FIRST_S", "45"))
EARSHOT_RETRY_BACKOFF_S = tuple(float(x) for x in os.environ.get("MEMO_EARSHOT_RETRY_BACKOFF_S", "60,120,240,300").split(",") if x.strip()) or (60.0,)
EARSHOT_RETRY_TOTAL_S = float(os.environ.get("MEMO_EARSHOT_RETRY_TOTAL_S", "2700"))
# A live car that holds the reply (it is recording, or another reply plays) is waited for this long, then left to it.
EARSHOT_HOLD_MAX_S = float(os.environ.get("MEMO_EARSHOT_HOLD_MAX_S", "300"))
EARSHOT_POLL_S = float(os.environ.get("MEMO_EARSHOT_POLL_S", "1"))
# Neither the car nor the phone speaks a reply without the proxy's yes: a proxy that cannot be asked is waited for (at
# most MEMO_EARSHOT_HOLD_MAX_S, then the reply is left to the car), never "failed open" to the phone. Once it answers
# again the watcher lets it settle this long before it takes a reply: a car that played the reply on its live hold
# while the proxy was out of reach re-sends its start every 2.5 s (and a waiting car renews its holds every 5 s), so
# those land first. The proxy itself refuses every take for its CLAIM_SETTLE_S after a restart.
EARSHOT_SETTLE_S = float(os.environ.get("MEMO_EARSHOT_SETTLE_S", "10"))
# Reply chunks carry this object tag; the holocene-auto lifecycle rule for it expires them after a day.
CHUNK_TAGS = "kind=chunk"
EARSHOT_CHANNEL = os.environ.get("MEMO_EARSHOT_CHANNEL", "phone")
# The phone also gets the FULL reply text (not the 500-char spoken digest) as a sibling object of the audio, same key
# with a .txt extension, uploaded first so it is already there when the audio arrives.
EARSHOT_TEXT_TYPE = "text/plain; charset=utf-8"
# The phone ignores a sibling text over 64 KB (abandoned, not cut), so the watcher cuts it first, with a note saying where
# the rest is.
EARSHOT_TEXT_MAX_BYTES = int(os.environ.get("MEMO_EARSHOT_TEXT_MAX_BYTES", "60000"))
EARSHOT_TEXT_CUT_NOTE = "\n\n[truncated; full text in Holocene /voice]"
WAIT_LOG_EVERY_S = 30
# ---- the car's view of a memo while it waits (status object + spoken progress)
# status/<yyyy>/<mm>/<dd>/<memo_id>.json is rewritten on every stage change and every new progress line; the pad reads
# it anonymously (Cache-Control: no-store). One writer thread, newest document per memo wins.
STATUS_ATTR = "Content-Type=application/json;Cache-Control=no-store"
HEARD_CHARS = 200            # status.heard: the start of the transcript, for the car's "heard" echo
PROGRESS_LINE_CHARS = 200    # status.progress: the newest progress line, one line
# How often the watcher asks Candystore for a working memo's newest agent.invocation.progressed (a ~20 ms query).
PROGRESS_POLL_S = float(os.environ.get("MEMO_PROGRESS_POLL_S", "1.5"))
# Spoken progress: nothing in the turn's first NARRATE_FIRST_S (a quick answer needs no update), then at most one every
# NARRATE_GAP_S per memo, always the newest line, none once the turn is done, at most NARRATE_MAX per memo.
NARRATE_FIRST_S = float(os.environ.get("MEMO_NARRATE_FIRST_S", "15"))
NARRATE_GAP_S = float(os.environ.get("MEMO_NARRATE_GAP_S", "30"))
NARRATE_MAX = int(os.environ.get("MEMO_NARRATE_MAX", "20"))
NARRATE_CHARS = int(os.environ.get("MEMO_NARRATE_CHARS", "140"))
# vox has no per-request engine choice: a voice is served by its own engine (vibevoice for a cloned profile, else the
# VOX_ENGINES order, voxcpm on this host today). A short line on voxcpm renders in about 2 s (measured 2026-10-20: 70
# characters, 2.1 s at 6 steps, 2.6 s at 10), so progress keeps the reply's voice at fewer steps.
PROGRESS_VOICE = os.environ.get("MEMO_PROGRESS_VOICE") or VOICE
PROGRESS_TTS_STEPS = int(os.environ.get("MEMO_PROGRESS_TTS_STEPS", "6"))
# ---- chunked reply speech: the car starts speaking the first sentence while the rest renders
# vox renders a whole 500-character reply in 8-19 s before a single word plays. A reply longer than CHUNK_MIN_CHARS is
# split at sentence boundaries into chunks that grow (CHUNK_CHARS: the first is short, so it renders in about 2.7 s; the
# second is small enough to be ready before the first finished playing; the rest are larger), each rendered, uploaded
# as replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>-cNNofMM.opus and announced as audio.memo.voiced while the
# next one renders. vox serves one request at a time (two concurrent renders each take twice as long, measured
# 2026-10-20), so the chunks render back to back. The full reply (the chunks joined by ffmpeg) still goes up as
# replies/...-<memo_id>.ogg afterwards: the reply of record for the replied fact, Earshot, /voice and older pads.
# The chunk extension is .opus (Ogg/Opus, Content-Type audio/ogg) on purpose: a pad page from before chunking only
# plays .ogg/.webm/.m4a/.mp3 keys, so it never mistakes a chunk for a reply and speaks the reply twice.
REPLY_CHUNKS = os.environ.get("MEMO_REPLY_CHUNKS", "1") != "0"
CHUNK_MIN_CHARS = int(os.environ.get("MEMO_CHUNK_MIN_CHARS", "160"))
CHUNK_CHARS = tuple(int(x) for x in os.environ.get("MEMO_CHUNK_CHARS", "110,170,300").split(",") if x.strip()) or (110, 170, 300)
CHUNK_TAIL_CHARS = 40     # a last chunk shorter than this joins the one before it
CHUNK_MAX = 20
# How often a dispatched memo re-reads the gateway journal for its turn (a local read-only sqlite row): the gap
# between "agent done" and the watcher noticing used to be up to this plus a 1 s tick.
AWAIT_POLL_S = float(os.environ.get("MEMO_AWAIT_POLL_S", "0.5"))
# Fast discovery (HOLOC-23 phase 2): with the in-process S3 client a listing is ~0.1 s and no process spawn, so a thread lists
# inbox/ every DISCOVER_FAST_S and wakes the tick the moment an object it has not seen appears (landed -> discovered was
# 0.67 s p50, up to 4.9 s, on the 1 s mc tick). 0 = off (the 1 s tick lists, as before). The tick's own listing is the fallback.
DISCOVER_FAST_S = float(os.environ.get("MEMO_DISCOVER_FAST_S", "0"))
# Facts off the critical path (HOLOC-23 phase 2): `received`, `transcribed` and `voiced` were synchronous bb-emit subprocesses
# (0.16-0.25 s each) in front of Whisper, the desk and the pad's push. With MEMO_FACTS_ASYNC=1 they go through one ordered
# publisher thread (FactQueue), the same one the desk's `routed` fact already used; any other fact waits for it to drain first
# so the order on the bus is unchanged. A failed publish still lands in the outbox.
FACTS_ASYNC = os.environ.get("MEMO_FACTS_ASYNC", "0") == "1"
# PhraseBank (HOLOC-23 phase 2): the desk's fixed lines ("Dropped. Nothing was sent.", "Okay. Talk soon." ...) are rendered once
# per voice and kept on disk, so a turn that ends in one is spoken from a file (a copy, ~1 ms) instead of a 1.5-3.5 s vox
# render. Warmed in the background at start-up (lowest vox priority) and learned on first use. MEMO_PHRASEBANK=0 turns it off.
PHRASEBANK = os.environ.get("MEMO_PHRASEBANK", "0") == "1"
# Only a render by the tile voice's own engine is kept: a fallback engine's render (vox outage -> another engine) would
# otherwise be replayed for good under the tile voice's key. Comma list; an unknown engine name is never banked.
PHRASEBANK_ENGINES = frozenset(x.strip() for x in os.environ.get("MEMO_PHRASEBANK_ENGINES", "voxcpm").split(",") if x.strip())
FACT_DRAIN_WAIT_S = float(os.environ.get("MEMO_FACT_DRAIN_WAIT_S", "3"))
# ---- the fast in-car conversation desk (HOLOC-23; converse.py, README "Fast conversation layer")
# MEMO_CONVERSE=off|shadow|on is only the default: the flag file <state>/converse.json (`mise run memo:converse ...`) wins,
# read per memo, no restart. off = today's path for every memo, unchanged.
# A fast turn's reply is voiced with a short first chunk (the car starts speaking sooner) at fewer vox steps.
CONVERSE_CHUNK_CHARS = tuple(int(x) for x in os.environ.get("MEMO_CONVERSE_CHUNK_CHARS", "70,170,300").split(",") if x.strip()) or (70, 170, 300)
CONVERSE_CHUNK_MIN_CHARS = int(os.environ.get("MEMO_CONVERSE_CHUNK_MIN_CHARS", "80"))
CONVERSE_TTS_STEPS = int(os.environ.get("MEMO_CONVERSE_TTS_STEPS", "6"))
# A confirmed brief rides this lane (batch: no wall clock, no detach narration) on this model ("" = the profile's own:
# the desk never adds a model route, and never an Anthropic one).
CONVERSE_DELEGATE_LANE = os.environ.get("MEMO_CONVERSE_DELEGATE_LANE", "batch").strip().lower()
if CONVERSE_DELEGATE_LANE not in mc_.GATEWAY_CONSUMERS:
    CONVERSE_DELEGATE_LANE = "batch"
# A delegated brief runs on the voice model unless MEMO_CONVERSE_DELEGATE_MODEL says otherwise ("profile" = the target
# profile's own default, which for the PMs is automaticai/auto, a pool that contains Claude routes: never the default here).
CONVERSE_DELEGATE_MODEL = os.environ.get("MEMO_CONVERSE_DELEGATE_MODEL", VOICE_MODEL).strip()
if CONVERSE_DELEGATE_MODEL.lower() == "profile":
    CONVERSE_DELEGATE_MODEL = ""
if cv.forbidden(CONVERSE_DELEGATE_MODEL):
    CONVERSE_DELEGATE_MODEL = ""  # the never-Anthropic rule holds for the delegated turn's model override too
# The earlier conversation a direct turn's prompt carries, at most this many characters.
CONVERSE_DIRECT_CONTEXT_CHARS = int(os.environ.get("MEMO_CONVERSE_DIRECT_CONTEXT_CHARS", "1200"))
# How long step_converse waits for the card the receive-time prefetch is building (download + Whisper usually cover it).
CONVERSE_CARD_WAIT_S = float(os.environ.get("MEMO_CONVERSE_CARD_WAIT_S", "0.6"))
CONVERSE_SWEEP_S = 60.0
CONVERSE_SLOW_S = float(os.environ.get("MEMO_CONVERSE_SLOW_S", "15"))
# Hold cue (HOLOC-23): the car hears a very short line when the desk's decision has not arrived this many seconds after the desk
# call started (0 turns every hold cue off), a second one at HOLD_CUE2_S (0 = no second), and a memo that fell through to the
# full agent gets a keep-alive line when it has been quiet HOLD_FALL_FIRST_S after dispatch and every HOLD_FALL_GAP_S after
# that, at most HOLD_FALL_MAX, until the agent's own first narration (NARRATE_FIRST_S) takes over. Lines are PhraseBank clips
# in the tile's voice, uploaded as progress/<day>/<memo>-<n>h.ogg: the pad plays them, and drops them while the driver records.
HOLD_CUE_S = float(os.environ.get("MEMO_CONVERSE_HOLD_CUE_S", "3"))
HOLD_CUE2_S = float(os.environ.get("MEMO_CONVERSE_HOLD_CUE2_S", "9"))
HOLD_FALL_FIRST_S = float(os.environ.get("MEMO_CONVERSE_HOLD_FALL_FIRST_S", "7"))
HOLD_FALL_GAP_S = float(os.environ.get("MEMO_CONVERSE_HOLD_FALL_GAP_S", "8"))
HOLD_FALL_MAX = int(os.environ.get("MEMO_CONVERSE_HOLD_FALL_MAX", "3"))
# A cue longer than this (seconds of audio, measured on the clip about to go up) is dropped and its line is not used again: a cue
# that plays long holds the pad's speech queue and the echo / reply waits behind it.
HOLD_MAX_CLIP_S = float(os.environ.get("MEMO_CONVERSE_HOLD_MAX_CLIP_S", "1.2"))
CONVERSE_SENDING_STUCK_S = 1800.0  # past the dispatch retry budget (900 s) with room to spare
CONVERSE_RESULT_CHARS = 600
CONVERSE_CLOSED_KEEP = 20
# The main loop's longest sleep. It also wakes for the earliest due memo, the next S3 listing, and at once when a
# stage finishes (WAKE), so a stage never waits for a tick boundary to start the next one.
TICK_S = float(os.environ.get("MEMO_TICK_S", "1"))
# The slow fallbacks behind the 0.5 s journal read (a Candystore HTTP query, the NATS monitor) run at most this
# often per memo: polled every 0.5 s they held the tick lock ~0.75 s per call and stalled every other memo.
SLOW_PROBE_S = float(os.environ.get("MEMO_SLOW_PROBE_S", "5"))
LIST_TIMEOUT_S = 10      # a hung MinIO must not hold the loop for a minute
OUTBOX_RETRY_S = 5       # a blocked outbox is retried this often, not every tick
WAKE = threading.Event()

# Retry backoff base seconds per failure stage (doubles each attempt, capped).
BACKOFF = {"download": 10, "transcribe": 20, "dispatch": 10, "agent_reply": 5, "tts": 15, "reply_upload": 10, "converse": 3}

# Stages that fail for infrastructure reasons (S3, NATS, vox) retry on a TIME budget, not a count:
# a minute of vox trouble after the agent already ran must not strand the work. Backoff is capped at 300 s.
_budget = os.environ.get("MEMO_RETRY_BUDGET_S")
RETRY_BUDGET_S = {"download": 600, "dispatch": 900, "tts": 1800, "reply_upload": 1800}
if _budget is not None:
    RETRY_BUDGET_S = {k: float(_budget) for k in RETRY_BUDGET_S}

# Where a failed memo resumes when `memo:retry` (or the late rescue) revives it.
RESUME_STAGE = {"receive": "receive", "download": "transcribe", "transcribe": "transcribe", "dispatch": "dispatch",
                "agent": "dispatch", "agent_reply": "reply", "tts": "speak", "reply_upload": "speak", "converse": "converse"}
FAIL_STAGE = {"receive": "receive", "transcribe": "transcribe", "dispatch": "dispatch", "await_agent": "agent",
              "reply": "agent_reply", "speak": "tts", "mirror": "reply_upload", "converse": "converse"}
# run off the tick thread. speak renders and uploads the car's copy (three workers); mirror is the phone decision that
# follows: it can wait minutes on a car that holds its reply, and it must not sit on a speak worker (three held replies
# would then queue the next memo's voice behind them), so it has a pool of its own, wide enough that holds never queue.
# converse (the fast desk) has ONE worker: turns of a conversation are decided in key order, each seeing the one before.
SLOW_STAGES = {"transcribe": "transcribe", "dispatch": "io", "speak": "speak", "mirror": "decide", "converse": "converse"}

STOP = False


class WatcherStopping(Exception):
    """The service was told to stop while a worker waited (the phone decision): the step ends where it is, the memo stays
    at its stage with everything the next start needs in state.json, and the decision resumes there."""


# ------------------------------------------------------------------ logging

def log(event: str, level: str = "info", **fields) -> None:
    rec = {"ts": iso(now_utc()), "svc": SERVICE, "level": level, "event": event}
    rec.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)


def level_fields(levels: dict) -> dict:
    """Additive fact fields for a measured recording (audio.memo.transcribed / failed): loudest and mean level in dBFS."""
    if not levels.get("ok"):
        return {}
    return {"audio_max_dbfs": levels["max_dbfs"], "audio_mean_dbfs": levels["mean_dbfs"]}


class StageError(Exception):
    """A failure attributed to a pipeline stage (the `stage` of the failed fact)."""

    def __init__(self, stage: str, code: str, message: str, retryable: bool = True, extra: dict | None = None):
        super().__init__(message)
        self.stage, self.code, self.message, self.retryable = stage, code, message, retryable
        self.extra = extra or {}  # additive fields for the failed fact (e.g. the turn-timeout numbers)


# ------------------------------------------------------------------ subprocess

def run(cmd: list[str], timeout: int, env: dict | None = None, stdin: str | None = None) -> subprocess.CompletedProcess:
    """subprocess.run that kills the whole process group on timeout (transcribe forks)."""
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin is not None else None,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         env=env, start_new_session=True)
    try:
        out, err = p.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = p.communicate()
        raise subprocess.TimeoutExpired(cmd, timeout, output=out, stderr=err)
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


# ------------------------------------------------------------------ state

class State:
    def __init__(self, directory: Path):
        self.dir = directory
        self.path = directory / "state.json"
        self.heartbeat_path = directory / "heartbeat.json"
        self.data: dict = {"version": 1, "memos": {}, "outbox": []}
        self.fresh = not self.path.exists()
        self._last = ""
        if not self.fresh:
            try:
                self.data = json.loads(self.path.read_text())
            except (json.JSONDecodeError, OSError) as e:
                # A corrupt state file used to crash-loop the unit every 5 s forever. Move it aside
                # (outside the repo) and start fresh: existing inbox objects are baselined, not replayed.
                aside = self.path.with_name(f"state.corrupt-{int(time.time())}.json")
                try:
                    os.replace(self.path, aside)
                except OSError:
                    pass
                log("state_corrupt", "error", error=str(e)[:200], moved_to=str(aside),
                    note="starting from an empty state; in-flight memos are not resumed")
                self.data = {"version": 1, "memos": {}, "outbox": []}
                self.fresh = True
            self.data.setdefault("memos", {})
            self.data.setdefault("outbox", [])
        # the fast desk's conversations (converse.py): open ones by "<device>|<agent>", and a ring of closed ones
        self.data.setdefault("conversations", {})
        self.data.setdefault("conversations_closed", [])

    def save(self) -> None:
        """Write state.json only when it changed (it used to be rewritten, indented, every second)."""
        body = json.dumps(self.data, separators=(",", ":"), default=str)
        if body == self._last:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(body)
        os.replace(tmp, self.path)
        self._last = body

    @property
    def memos(self) -> dict:
        return self.data["memos"]

    def heartbeat(self, extra: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        rec = {"pid": os.getpid(), "ts": iso(now_utc()), **extra}
        tmp = self.heartbeat_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, indent=1))
        os.replace(tmp, self.heartbeat_path)


def compact(m: dict) -> None:
    """A finished memo (done / skipped) keeps previews, not full transcripts: state.json must not grow without bound.

    A failed or active memo keeps its whole transcript, prompt and reply: `memo:retry` re-sends that prompt and
    re-speaks that reply, so a preview there would be a silent truncation (four turn_timeout memos sat holding
    300-char prompts, 2026-10)."""
    if m.get("status") in ("done", "skipped"):
        for k, n in (("transcript", 300), ("reply_text", 300), ("prompt", 300)):
            if isinstance(m.get(k), str) and len(m[k]) > n:
                m[k] = m[k][:n]
        m.pop("progress_full", None)  # the status object keeps the short line; the full one is in Candystore
        m.pop("voiced_keys", None)    # the chunk keys only matter while a cancel could still retract them
        # voiced_one (the reply key announced as voiced 1 of 1) stays: it is what keeps a memo:retry of a finished memo
        # from announcing the same one-file reply a second time.
        m.pop("reply_up", None)
        for fu in m.get("followups") or []:  # a finished follow-up keeps a preview of what it was asked
            for k in ("prompt", "plan"):
                if isinstance(fu.get(k), str) and len(fu[k]) > 300:
                    fu[k] = fu[k][:300]
    for k in ("live", "live_ts", "cs_checked_ts"):  # await-stage probe caches
        m.pop(k, None)


# Upper case only, and never inside a code fence (2026-10-22 review: "**Background:** the gateway was reloaded", a CSS
# "background: #222;" and a YAML "- background: true" all cut a reply short and the rest was sent back as a plan).
_BACKGROUND_LINE = re.compile(r"^[ \t>*_#`-]*BACKGROUND[*_`]*[ \t]*:[*_`]*[ \t]*", re.MULTILINE)
_FENCE_LINE = re.compile(r"^[ \t]*(```|~~~)", re.MULTILINE)


def _in_fence(text: str, pos: int) -> bool:
    """Whether pos lies inside a fenced code block (an odd number of fence lines before it)."""
    return len(_FENCE_LINE.findall(text, 0, pos)) % 2 == 1


def split_background(text: str) -> tuple[str, str | None]:
    """(what is spoken, the BACKGROUND: instructions or None). The first line outside a code fence that starts with
    BACKGROUND: in upper case (markdown bullets, quotes and bold around it allowed) ends the spoken answer; everything
    after it is the plan for the background turn. The line itself is never spoken, even when no follow-up is sent (none
    allowed, or nothing after it)."""
    hit = next((h for h in _BACKGROUND_LINE.finditer(text or "") if not _in_fence(text, h.start())), None)
    if not hit:
        return text, None
    answer = text[:hit.start()].rstrip()
    plan = text[hit.end():].strip().strip("*_`").strip()
    return answer, (plan or None)


# resume_for / truncated_by_old_watcher live in memo_common (shared with memo_trace) and are imported above.

def transcribe_timeout(audio_s: float | None, timeouts_so_far: int) -> int:
    """Seconds allowed for one transcribe run: scales with the audio, grows after each timeout."""
    if not audio_s:
        base = TRANSCRIBE_TIMEOUT_S
    else:
        base = max(TRANSCRIBE_TIMEOUT_S, 60 + TRANSCRIBE_RATIO * audio_s)
    return int(min(TRANSCRIBE_MAX_S, base * (1 + timeouts_so_far)))


def silent_reason(levels: dict, audio_s: float | None) -> tuple[str, str] | None:
    """(code, message) when the recording is too quiet for any speech to be in it, else None.

    Needs a successful measurement: an unmeasurable file (ffmpeg missing) goes on to transcription as before."""
    if levels.get("ok") and levels["max_dbfs"] < SILENT_MAX_DBFS:
        return "silent_audio", (f"recording is silent ({mc_.level_text(levels['max_dbfs'], levels['mean_dbfs'], audio_s)}): "
                                "the microphone delivered no sound; on the simulator run `mise run auto:sim:mic-check`, "
                                "in the car check the mic permission and mute")
    return None


def junk_reason(text: str, audio_s: float | None, levels: dict | None = None) -> tuple[str, str] | None:
    """(code, message) when a transcript is not a real prompt, else None.

    `levels` (from measure_levels) turns "empty" into a statement about the audio: it was audible, Whisper just
    found no words in it. Silent audio never gets this far (see silent_reason)."""
    lv = levels or {}
    heard = f" ({mc_.level_text(lv['max_dbfs'], lv['mean_dbfs'], audio_s)})" if lv.get("ok") else ""
    norm = re.sub(r"[^a-z0-9' ]+", " ", text.lower()).strip()
    norm = re.sub(r"\s+", " ", norm)
    if not norm:
        if lv.get("ok"):
            return "empty_transcript", f"audible{heard} but no words recognised"
        return "empty_transcript", "transcript is empty (silence or unrecognised audio)"
    if norm in HALLUCINATIONS:
        return "garbage_transcript", f"transcript {text.strip()!r} is a typical Whisper hallucination on noise, not a prompt{heard}"
    return None


# ------------------------------------------------------------------ the watcher

class LaneProbe:
    """Background snapshot of both gateway lanes for the heartbeat (the API's /voice banner reads it).

    A daemon thread, so a hung NATS monitor can never stall the tick loop."""

    def __init__(self, every_s: float = LANE_HEARTBEAT_PROBE_S):
        self.every_s = every_s
        self._snap: dict = {}
        self._lock = threading.Lock()

    def probe_once(self) -> None:
        lanes = mc_.gateway_lanes()
        snap = {}
        for lane, info in lanes.items():
            snap[lane] = {
                "consumer": info.get("consumer"), "ok": info.get("ok"),
                "waiting": info.get("num_waiting"), "ack_pending": info.get("num_ack_pending"),
                "pending": info.get("num_pending"), "max_ack_pending": info.get("max_ack_pending"),
                "error": info.get("error"), "checked_at": iso(now_utc()),
                # the gateway is restarting: nothing is pulled on purpose, queued memos run when it is back
                "draining": bool(info.get("draining")), "gateway": info.get("gateway_detail"),
                "gateway_kind": info.get("gateway_kind"), "gateway_label": info.get("gateway_label"),
            }
        with self._lock:
            self._snap = snap

    def start(self) -> None:
        def loop():
            while not STOP:
                try:
                    self.probe_once()
                except Exception as e:  # noqa: BLE001
                    log("lane_probe_failed", "warn", error=str(e)[:200])
                time.sleep(self.every_s)
        threading.Thread(target=loop, name="lane-probe", daemon=True).start()

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._snap)


def put_status_object(key: str, body: bytes) -> tuple[bool, str]:
    """Upload one status document (mc pipe, JSON, no-store). (ok, error)."""
    try:
        r = mc_.mc_pipe(mc_.s3_url(key), body, STATUS_ATTR)
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"[:200]
    if r.returncode != 0:
        return False, f"mc pipe rc={r.returncode}: {r.stderr.decode('utf-8', 'replace').strip()[-200:]}"
    return True, ""


class FactQueue:
    """One thread publishing queued facts in order. Never takes the watcher's lock: a caller that holds it may wait here."""

    def __init__(self):
        self._q: queue.Queue = queue.Queue()
        self._cv = threading.Condition()
        self._pending = 0
        self._thread: threading.Thread | None = None

    def submit(self, fn) -> None:
        with self._cv:
            self._pending += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="fact-publisher", daemon=True)
                self._thread.start()
        self._q.put(fn)

    def _run(self) -> None:
        while True:
            fn = self._q.get()
            try:
                fn()
            except Exception as e:  # noqa: BLE001 - a fact never stops the publisher
                log("fact_publisher_error", "warn", error=f"{type(e).__name__}: {e}"[:200])
            finally:
                with self._cv:
                    self._pending -= 1
                    self._cv.notify_all()

    def pending(self) -> int:
        with self._cv:
            return self._pending

    def wait_idle(self, timeout: float) -> bool:
        end = time.time() + timeout
        with self._cv:
            while self._pending > 0:
                left = end - time.time()
                if left <= 0:
                    return False
                self._cv.wait(left)
        return True


class StatusWriter:
    """status/<yyyy>/<mm>/<dd>/<memo_id>.json for every memo, newest document wins.

    put() never blocks the caller (it runs under the watcher lock): it replaces the pending document for that key and
    wakes one writer thread, which uploads them one at a time. A document superseded before it went up is never written;
    a failed write is retried once its key has nothing newer. Tests call drain() instead of start()."""

    def __init__(self, upload=put_status_object):
        self._upload = upload
        self._pending: dict[str, bytes] = {}
        self._cv = threading.Condition()
        self._last_err: str | None = None
        self.written = 0

    def put(self, key: str, doc: dict) -> None:
        body = json.dumps(doc, separators=(",", ":"), default=str).encode()
        with self._cv:
            self._pending[key] = body
            self._cv.notify()

    def pending(self) -> int:
        with self._cv:
            return len(self._pending)

    def _take(self, wait: float | None) -> tuple[str, bytes] | None:
        with self._cv:
            if not self._pending and wait:
                self._cv.wait(wait)
            if not self._pending:
                return None
            key = next(iter(self._pending))
            return key, self._pending.pop(key)

    def _write(self, key: str, body: bytes) -> bool:
        ok, err = self._upload(key, body)
        if ok:
            self.written += 1
            self._last_err = None
            return True
        if err != self._last_err:  # an outage logs once, not once per document
            log("status_write_failed", "warn", key=key, error=err)
        self._last_err = err
        with self._cv:
            self._pending.setdefault(key, body)  # retried unless something newer replaced it meanwhile
        return False

    def drain(self) -> int:
        """Write everything pending now, on the caller's thread (tests, shutdown). Returns how many went up."""
        n = 0
        for _ in range(1000):
            item = self._take(None)
            if item is None:
                break
            if not self._write(*item):
                break
            n += 1
        return n

    def start(self) -> None:
        def loop():
            while not STOP:
                item = self._take(1.0)
                if item and not self._write(*item):
                    time.sleep(2.0)
        threading.Thread(target=loop, name="status-writer", daemon=True).start()


def car_stage(m: dict) -> str:
    """The memo's stage as the car shows it: received | transcribing | heard | working | replying | done | failed."""
    status, stage = m.get("status"), m.get("stage")
    if status in ("failed", "skipped", CANCELLED):
        return "failed"
    if status == "done" or stage == "done":
        return "done"
    if stage == "receive":
        return "received"
    if stage == "transcribe":
        return "transcribing"
    if stage == "converse":
        # the fast desk is deciding: the pad knows no other stage name, and the answer is seconds away
        return "working"
    if stage == "dispatch":
        # an escalated memo goes back through dispatch on its way to the batch lane, and a memo whose quick answer was
        # spoken goes back through it for its background follow-up: the agent is still on it
        return "working" if m.get("escalated") or live_followup(m) else "heard"
    if stage == "await_agent":
        return "working"
    if stage in ("reply", "speak", "mirror"):
        return "replying"
    return "received"


def memo_started_ts(m: dict) -> float:
    """When the memo started, for the car's 'Working 1:20': the upload (the device's Stop & Send), else detection."""
    up = mc_.parse_iso(m.get("uploaded_at"))
    return up.timestamp() if up else float(m.get("detected_ts") or time.time())


def fast_turn(m: dict) -> bool:
    """The memo is (or was) a fast desk turn, not an agent turn: it is at the converse stage, or the desk decided anything
    but `direct` for it. Its transcript is not echoed back ("<agent> heard: ..."): the answer itself is seconds away."""
    conv = m.get("conv")
    return m.get("stage") == "converse" or (isinstance(conv, dict) and conv.get("action") not in (None, "direct"))


def status_doc(m: dict) -> dict:
    """The car's status document for one memo (schema: services/inbox-watcher/README.md, "Status object")."""
    now = time.time()
    started = memo_started_ts(m)
    stage = car_stage(m)
    # heard is null for a fast desk turn: the pad echoes the transcript only when heard is set, and the echo would put
    # seconds of speech in front of an answer that is itself seconds away. A direct turn gets it back (today's path).
    heard = None if fast_turn(m) else (re.sub(r"\s+", " ", m.get("transcript") or "").strip()[:HEARD_CHARS] or None)
    doc = {
        "v": 1, "memo_id": m["memo_id"], "agent": m.get("agent"),
        "agent_name": m.get("display_name") or (m.get("agent") or "").replace("-", " ") or None,
        "s3_key": m["key"], "stage": stage, "heard": heard,
        "progress": m.get("progress_text"), "progress_seq": m.get("progress_seq", 0),
        "progress_at": iso(m["progress_ts"]) if m.get("progress_ts") else None,
        # the newest progress clip: progress/<day>/<memo_id>-<spoken_seq>.ogg (1..n per memo, the pad's playback cursor)
        "spoken_seq": m.get("narr_count") or None, "spoken_key": m.get("narr_key"),
        "narration": ({"n": m["narr_count"], "key": m.get("narr_key"),
                       "seq": None if m.get("narr_hold") else m.get("narr_src_seq"), "kind": m.get("narr_hold"),
                       "at": iso(m["narr_last_ts"]) if m.get("narr_last_ts") else None, "text": m.get("narr_text")}
                      if m.get("narr_count") else None),
        "started_at": iso(started), "dispatched_at": iso(m["dispatched_ts"]) if m.get("dispatched_ts") else None,
        "updated_at": iso(now), "elapsed_s": round(max(0.0, now - started), 1),
        "command_id": m.get("command_id"), "lane": m.get("lane"),
        "late": bool(m.get("late")), "escalated": bool(m.get("escalated")),
        "reply_key": m.get("reply_key"),
        # the interactive turn passed the gateway's wall clock and kept running (the reply comes late, no re-run)
        "detached": detached_now(m),
    }
    fus = m.get("followups") or []
    if fus:
        # answer-then-background: the quick answer was spoken (or is being), the newest background follow-up is in `state`
        # dispatching | running | spoken | failed | cancelled; its reply is a later replies/ object for the same memo
        fu = fus[-1]
        doc["followup"] = {"n": fu.get("n"), "state": fu.get("state"), "command_id": fu.get("command_id"),
                           "started_at": fu.get("started_at"), "reply_key": fu.get("reply_key")}
    if m.get("reply_chunks"):
        # the reply is being spoken chunk by chunk: how many it has and how many are up (replies/...-cNNofMM.opus)
        doc["reply_chunks"] = {"n": m["reply_chunks"], "voiced": m.get("voiced_n", 0)}
    conv = m.get("conv")
    if isinstance(conv, dict):
        # the fast desk's turn: sid (the conversation's short id), turn (1-based), action (reply | propose | confirm |
        # cancel | end | direct), draft_title (the pending draft, if any) and reply_key (THIS turn's reply of record, so
        # the pad can tell a barged fast-turn reply from a follow-up result, which has a reply key of its own)
        doc["conv"] = {"sid": conv.get("sid"), "turn": conv.get("turn"), "action": conv.get("action"),
                       "draft_title": conv.get("draft_title"), "reply_key": conv.get("reply_key")}
    if stage == "failed":
        code = m.get("failed_code") or m.get("status")
        doc["error_code"] = code
        doc["error"] = (m.get("failed_message") or str(code))[:300]
    return doc


def detached_now(m: dict) -> bool:
    """The memo's current command is an interactive turn the gateway detached at its wall clock (m["detached"] holds the
    id of the command that was detached, so a later command of the memo, its follow-up say, is not)."""
    return bool(m.get("detached")) and m.get("detached") == m.get("command_id")


def rescue_closes_at(m: dict) -> float:
    """When a failed memo stops being watched for a late reply. The window runs from the command's own deadline for an
    escalated batch turn (a turn that ends at its 2 h deadline would otherwise find the 2 h window already shut and
    its reply dropped), and from the dispatch for everything else."""
    start = m.get("deadline_ts") if long_turn(m) and m.get("deadline_ts") else m.get("dispatched_ts", 0)
    return float(start) + RESCUE_WINDOW_S


def memo_lane(m: dict) -> str:
    """The lane a memo's command rides. A memo dispatched before lanes existed has none: batch."""
    lane = m.get("lane")
    return lane if lane in mc_.GATEWAY_CONSUMERS else "batch"


class Watcher:
    def __init__(self, state: State):
        self.s = state
        self.last_list_err = None
        self.last_list_s = 0.0          # how long the last inbox listing took (paces the next one)
        self.outbox_blocked_at = 0.0
        # One lock guards state. The tick thread holds it while it works; slow steps (whisper, vox,
        # bb-emit) run on worker threads and take it only to read inputs and to apply results, so a
        # 45 s (or 20 min) transcription no longer stops discovery, polling and the heartbeat.
        self.mu = threading.RLock()
        self.running: set[str] = set()
        self.pools = {"transcribe": concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="transcribe"),
                      "io": concurrent.futures.ThreadPoolExecutor(2, thread_name_prefix="io"),
                      "speak": concurrent.futures.ThreadPoolExecutor(3, thread_name_prefix="speak"),
                      "decide": concurrent.futures.ThreadPoolExecutor(32, thread_name_prefix="decide"),
                      # spoken progress renders on its own worker: a 2 s vox call never holds up a stage
                      "narrate": concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="narrate"),
                      # the fast desk: one worker, so the turns of a conversation are decided in order
                      "converse": concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="converse")}
        self.last_rescue = 0.0
        self.lane_probe: LaneProbe | None = None  # started by main(); tests leave it off
        self.status_writer = StatusWriter()       # its thread is started by main(); tests drain() it
        self.narrating: set[str] = set()          # memo keys with a progress render in flight
        self.hold_last: dict[str, str] = {}       # per tile: the hold-cue line its car heard last (never twice in a row)
        self.hold_long: set[str] = set()          # hold-cue lines whose render was longer than HOLD_MAX_CLIP_S: not used again
        self.progress_err: str | None = None
        # The fast in-car conversation desk (converse.py). Its settings are read per memo (env default + flag file).
        self.desk = cv.Desk(state.dir, log=log)
        # receive-time prefetch per memo key: {"done": Event, "card": card | None}
        self.prefetch: dict[str, dict] = {}
        # Whether bb-emit accepts the desk's two facts (main() runs the --check gate): a fact it would refuse must never
        # sit at the head of the outbox and block every later fact, so until then they are logged only.
        self.contract_ok = {"routed": True, "delegated": True}
        self.last_conv_sweep = 0.0
        self.facts = FactQueue()
        self.phrases = PhraseBank(state.dir / "phrases", enabled=PHRASEBANK)
        self.fresh_listing: tuple | None = None   # a listing the discovery thread saw a new object in, for the next tick
        self.fast_listed_at = 0.0                 # when the discovery thread last listed (the tick skips its own then)

    def choose_lane(self) -> tuple[str, str | None]:
        """(lane, reason). The configured lane, unless it is interactive and the BATCH lane is the better bet.

        Falling back is only worth it when batch is verifiably pulling and interactive is not (lane disabled, durable
        missing, its fetch loop dead). When BOTH lanes are unpulled the gateway itself is down or restarting (the
        usual cause of an unpulled interactive consumer): the command queues durably on either subject, and the
        interactive durable drains first on reconnect, so the memo stays interactive instead of being pinned behind
        whatever grooming backlog builds during the outage.

        Two failed probes 1.5 s apart are required: a parked pull request can be momentarily absent between fetch
        cycles. A monitor that cannot be read (ok is None) keeps the configured lane: it is diagnostic, the publish is
        core NATS either way. Both lanes come from ONE monitor read, so the verdict is one consistent snapshot."""
        if LANE != "interactive":
            return LANE, None
        for attempt in range(2):
            lanes = mc_.gateway_lanes()
            if lanes.get("interactive", {}).get("draining"):
                # The gateway is draining for a restart: neither lane pulls on purpose, and the interactive durable
                # is the first thing the new process fetches.
                return "interactive", ("gateway_draining_queued_on_interactive"
                                       if lanes["interactive"].get("ok") is False else None)
            if lanes.get("interactive", {}).get("ok") is not False:
                return "interactive", None
            if attempt == 0:
                time.sleep(LANE_PROBE_GAP_S)
                continue
            if lanes.get("batch", {}).get("ok") is True:
                return "batch", "interactive_consumer_not_pulling"
            return "interactive", "gateway_not_pulling_queued_on_interactive"
        return "interactive", None  # unreachable

    def shutdown(self, wait: bool) -> None:
        self.facts.wait_idle(10.0)  # queued facts are published before the process goes
        for p in self.pools.values():
            p.shutdown(wait=wait, cancel_futures=not wait)
        # the drain may have moved last_fact_id or put a failed publish in the outbox: persist it, or a restart loses it
        try:
            with self.mu:
                self.s.save()
        except Exception as e:  # noqa: BLE001
            log("shutdown_save_failed", "error", error=f"{type(e).__name__}: {e}"[:200])

    # ---- facts -----------------------------------------------------------

    def _emit_raw(self, rec: dict) -> dict:
        cmd = [BB_EMIT, "--strict", "--print-ids", "--type", f"bloodbank.audio.memo.{rec['action']}",
               "--source", f"urn:33god:service:{SERVICE}", "--producer", SERVICE, "--service", SERVICE,
               "--correlation", rec["memo_id"], "--ordering-key", f"memo:{rec['memo_id']}"]
        if rec.get("causation"):
            cmd += ["--causation", rec["causation"]]
        r = run(cmd, 20, stdin=json.dumps(rec["data"]))
        if r.returncode != 0:
            raise RuntimeError(f"bb-emit rc={r.returncode}: {r.stderr.strip()[-300:]}")
        try:
            return json.loads(r.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            return {}

    def fact(self, action: str, m: dict, payload: dict) -> None:
        """Publish bloodbank.audio.memo.<action>. Failure queues it in the outbox (never lost, never blocks)."""
        if self.facts.pending():
            self.facts.wait_idle(FACT_DRAIN_WAIT_S)  # earlier async facts first: the order on the bus stays the order of events
        data = {"memo_id": m["memo_id"], "s3_key": m["key"], "target_agent_id": m["agent"],
                "occurred_at": iso(now_utc()), **payload}
        rec = {"action": action, "memo_id": m["memo_id"], "data": data, "causation": m.get("last_fact_id")}
        try:
            ids = self._emit_raw(rec)
            m["last_fact_id"] = ids.get("id") or m.get("last_fact_id")
            log("fact_published", memo_id=m["memo_id"], key=m["key"], agent=m["agent"],
                stage=action, fact=f"audio.memo.{action}", fact_id=ids.get("id"))
        except Exception as e:  # noqa: BLE001
            self.s.data["outbox"].append(rec)
            log("fact_queued", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"],
                stage=action, error=str(e)[:300], outbox=len(self.s.data["outbox"]))

    def fact_gated(self, action: str, m: dict, payload: dict) -> None:
        """A fast-desk fact (routed | delegated): published like any fact once bb-emit's --check accepted its type at
        start-up, else logged only (fact_unavailable) and never queued: a type bb-emit refuses would block the outbox."""
        if self.contract_ok.get(action):
            return self.fact(action, m, payload)
        log("fact_unavailable", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], fact=f"audio.memo.{action}",
            note="bb-emit --check refused this type at start-up: logged only, never queued", data=payload)

    def fact_async(self, action: str, m: dict, payload: dict) -> None:
        """A fact published off the critical path: bb-emit is a subprocess (0.16-0.4 s) and what the driver hears must not
        wait for it. One ordered publisher thread (FactQueue); the causation id is read when the fact is published, so the
        chain stays intact; same outbox-on-failure as fact(). Caller holds the lock. `routed` and, with MEMO_FACTS_ASYNC=1,
        `received` | `transcribed` | `voiced` come through here (fact_fast); the desk's gate applies to the desk's facts."""
        if action in self.contract_ok and not self.contract_ok.get(action):
            return self.fact_gated(action, m, payload)
        m.setdefault("last_fact_id", None)  # the key exists before the publisher thread writes it: state.json is never resized under save()
        data = {"memo_id": m["memo_id"], "s3_key": m["key"], "target_agent_id": m["agent"],
                "occurred_at": iso(now_utc()), **payload}
        rec = {"action": action, "memo_id": m["memo_id"], "data": data, "causation": None}
        queued_at = time.time()

        def work():
            rec["causation"] = m.get("last_fact_id")
            try:
                ids = self._emit_raw(rec)
                m["last_fact_id"] = ids.get("id") or m.get("last_fact_id")
                log("fact_published", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=action,
                    fact=f"audio.memo.{action}", fact_id=ids.get("id"), async_=True,
                    queued_ms=int((time.time() - queued_at) * 1000))
            except Exception as e:  # noqa: BLE001
                self.s.data["outbox"].append(rec)
                log("fact_queued", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=action,
                    error=str(e)[:300], outbox=len(self.s.data["outbox"]))
        self.facts.submit(work)

    PUSH_HINT_KEYS = ("chunk_s3_key", "reply_s3_key", "progress_s3_key", "chunk", "chunks", "narration", "seq")

    def fact_fast(self, action: str, m: dict, payload: dict) -> None:
        """received | transcribed | voiced: the car is told over loopback first (push_hint, ~2 ms, on a thread of its own so it
        never waits behind a publish; the proxy drops the NATS copy as the duplicate it is), then the fact is published:
        async when MEMO_FACTS_ASYNC=1, else exactly fact()."""
        if action in PUSH_HINT_ACTIONS and PUSH_HINT_URL:
            hint = {"target_agent_id": m.get("agent"), **{k: payload[k] for k in self.PUSH_HINT_KEYS if k in payload}}
            threading.Thread(target=push_hint, args=(action, m["memo_id"], hint), name="push-hint", daemon=True).start()
        if FACTS_ASYNC:
            return self.fact_async(action, m, payload)
        return self.fact(action, m, payload)

    def check_contracts(self) -> dict:
        """Start-up gate: does bb-emit accept audio.memo.routed and audio.memo.delegated? A dry run (--check), no NATS."""
        sample = {"memo_id": str(uuid.uuid4()), "s3_key": "inbox/holocene-pm/2026/01/01/check.ogg",
                  "target_agent_id": "holocene-pm", "conv_id": "check", "action": "reply",
                  "tile_agent_id": "holocene-pm", "brief_id": str(uuid.uuid4()), "brief_sha256": "0" * 64,
                  "command_id": str(uuid.uuid4()), "lane": "batch", "perm": "read_only"}
        for action in ("routed", "delegated"):
            try:
                r = run([BB_EMIT, "--check", "--strict", "--type", f"bloodbank.audio.memo.{action}",
                         "--source", f"urn:33god:service:{SERVICE}", "--producer", SERVICE, "--service", SERVICE],
                        20, stdin=json.dumps(sample))
                ok, err = r.returncode == 0, r.stderr.strip()[-300:]
            except Exception as e:  # noqa: BLE001
                ok, err = False, f"{type(e).__name__}: {e}"[:300]
            self.contract_ok[action] = ok
            log("converse_contract", "info" if ok else "warn", fact=f"audio.memo.{action}", ok=ok,
                error=None if ok else err)
        return dict(self.contract_ok)

    def status(self, m: dict) -> None:
        """Queue the memo's status object for the car (never blocks; the writer thread uploads it)."""
        if not m.get("agent"):
            return  # a key with no agent was never going anywhere: nothing for a tile to show
        try:
            self.status_writer.put(mc_.status_key_for(m["key"], m["memo_id"]), status_doc(m))
        except Exception as e:  # noqa: BLE001 - the car's view never stops the pipeline
            log("status_failed", "warn", memo_id=m["memo_id"], key=m["key"], error=f"{type(e).__name__}: {e}"[:200])

    def flush_outbox(self) -> None:
        box = self.s.data["outbox"]
        if box and time.time() - self.outbox_blocked_at < OUTBOX_RETRY_S:
            return  # blocked a moment ago: do not fork bb-emit and log on every tick of an outage
        while box:
            rec = box[0]
            try:
                self._emit_raw(rec)
            except Exception as e:  # noqa: BLE001
                self.outbox_blocked_at = time.time()
                log("outbox_blocked", "warn", memo_id=rec["memo_id"], stage=rec["action"],
                    error=str(e)[:200], outbox=len(box))
                return
            self.outbox_blocked_at = 0.0
            box.pop(0)
            log("outbox_flushed", memo_id=rec["memo_id"], stage=rec["action"], outbox=len(box))
            self.s.save()

    # ---- discovery -------------------------------------------------------

    def baseline_if_first_start(self) -> None:
        if not self.s.fresh:
            return
        objs = mc_.s3_list_inbox()  # raise: do not create state from a failed listing
        for o in objs:
            self.s.memos[o["key"]] = {
                "memo_id": memo_id_for(o["key"]), "key": o["key"], "agent": agent_from_key(o["key"]),
                "status": "baseline", "stage": "baseline",
            }
        self.s.fresh = False
        self.s.save()
        log("baseline", count=len(objs), note="first start: existing inbox objects will never be replayed")

    def list_inbox(self) -> tuple[list[dict] | None, str | None]:
        t0 = time.time()
        try:
            return mc_.s3_list_inbox(timeout=LIST_TIMEOUT_S), None
        except Exception as e:  # noqa: BLE001
            return None, str(e)[:300]
        finally:
            self.last_list_s = time.time() - t0

    def discover(self, listing: tuple[list[dict] | None, str | None] | None = None) -> None:
        objs, err = listing if listing is not None else self.list_inbox()
        if err is not None:
            if err != self.last_list_err:  # do not spam an outage every tick
                log("s3_list_failed", "error", stage="receive", error=err)
            self.last_list_err = err
            return
        self.last_list_err = None
        for o in objs:
            key = o["key"]
            if key in self.s.memos:
                continue
            agent = agent_from_key(key)
            mid = memo_id_for(key)
            age = (now_utc() - o["last_modified"]).total_seconds() if o["last_modified"] else 0
            m = {"memo_id": mid, "key": key, "agent": agent, "size": o["size"], "etag": o.get("etag"),
                 "uploaded_at": iso(o["last_modified"]), "detected_ts": time.time(),
                 "attempts": {}, "next_at": 0.0, "status": "active", "stage": "receive"}
            self.s.memos[key] = m
            skip = None
            if agent is None:
                skip = ("no_agent", "no agent id in key path (expected inbox/<agent>/<yyyy>/<mm>/<dd>/<file>)")
            elif age > MAX_AGE_S:
                skip = ("too_old", f"older than {MAX_AGE_S // 3600}h ({int(age)}s) when first seen; `memo:retry` re-runs it")
            if skip:
                m.update(status="skipped", stage="skipped", failed_stage="receive", failed_code=skip[0])
                log("skipped", "warn", memo_id=mid, key=key, agent=agent, stage="receive", reason=skip[1])
                # A skipped memo used to leave only a log line: /voice showed "uploaded" and the trace "STOPPED".
                self.fact("failed", m, {"stage": "receive", "error_code": skip[0], "error_message": skip[1],
                                        "retryable": False, "attempt": 1})
            else:
                log("discovered", memo_id=mid, key=key, agent=agent, stage="receive", bytes=o["size"],
                    age_s=round(age, 1))
                self.status(m)
            self.s.save()

    # ---- control + rescue ------------------------------------------------

    @staticmethod
    def drop_command(m: dict) -> None:
        """Forget the command a memo sent, so the next dispatch mints a fresh one (new id, lane chosen again). Everything
        step_dispatch reads to recover a published command goes: with the old command id and publish_attempted still
        there it would find the old command in the gateway journal and call it dispatched, never sending anything."""
        for k in ("command_id", "publish_attempted", "lane", "lane_reason", "command_envelope_id", "escalation_causation",
                  "dropped_since", "last_wait_log", "unwind_since", "live", "live_ts", "cs_checked_ts"):
            m.pop(k, None)

    def revive(self, m: dict, stage: str, why: str) -> None:
        failed = m.get("failed_stage")
        if stage == "speak":
            m.pop("reply_up", None)  # a retry renders the voice again
        if stage in ("receive", "transcribe"):
            # A new prompt is a new ask: nothing of the old command, or of the escalation it went through, carries over.
            self.drop_command(m)
            for k in ("escalated", "escalated_from_command_id", "escalated_ts", "late", "rescue_closed", "followups",
                      "background_plan", "detached", "detached_ts", "conv", "conv_raw", "delegate"):
                m.pop(k, None)
        elif stage == "dispatch" and (failed == "agent" or (failed == "agent_reply" and m.get("failed_code") == mc_.TURN_TIMEOUT)):
            was_escalated = bool(m.get("escalated"))  # the old command was rejected or failed: send a fresh one
            self.drop_command(m)
            if was_escalated:
                # Sticky lane: a memo that already escalated is a long ask. Its retry rides the batch lane (reason
                # unchanged) instead of timing out on the interactive one with no escalation left.
                m["lane"], m["lane_reason"] = "batch", ESCALATED_REASON
        if stage == "converse":
            # the desk decides this turn again (kill switch, eligibility and the conversation as it is now): the old decision,
            # its read-back and its half-made delegation are dropped, never re-applied to a draft that moved on
            for k in ("conv_raw", "conv", "delegate", *self.REPLY_ROUND_KEYS):
                m.pop(k, None)
            kept = [f for f in m.get("followups") or [] if not (f.get("kind") == "delegation" and not f.get("dispatched_ts"))]
            if kept:
                m["followups"] = kept
            else:
                m.pop("followups", None)  # a delegation that never left is not a dispatch: the desk decides this turn afresh
            self.drop_command(m)
        fus = m.get("followups") or []
        if (stage not in ("receive", "transcribe", "converse") and fus and fus[-1].get("state") == CANCELLED and m.get("command_id")
                and fus[-1].get("command_id") == m.get("command_id")):
            # A follow-up cancelled while in flight is the memo's command again, whatever stage it stopped at: live once
            # more, so dispatch sends ITS prompt (not the memo's), reply finds ITS answer and it is spoken as a
            # follow-up, not as a late reply of the quick answer (2026-10-22 review: only await_agent did this).
            fus[-1]["state"] = "dispatching" if stage == "dispatch" else "running"
            fus[-1].pop("ended_at", None)
        if stage == "await_agent":
            # an escalated command (or a follow-up) is a batch turn: it is waited for as long as it was the first time
            m["deadline_ts"] = time.time() + (BATCH_TURN_TIMEOUT_S if long_turn(m) else AGENT_TIMEOUT_S)
        if m.get("failed_code") == "object_changed" and m.get("observed_object"):
            # The operator asked for this memo again: take the object as it is now as the one to transcribe.
            obs = m.pop("observed_object")
            m["size"], m["etag"] = obs["size"], obs.get("etag")
        if failed:
            m["attempts"].pop(failed, None)
            m.get("first_fail", {}).pop(failed, None)
        for k in ("failed_stage", "failed_code", "failed_message", "resume_stage", "cancelled_ts", "cancelled_stage",
                  "cancelled_after_dispatch"):
            m.pop(k, None)
        m.update(status="active", stage=stage, next_at=0.0, revived_ts=time.time())
        log("memo_revived", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage, why=why)
        self.status(m)
        if stage != "receive":
            # Tell the journey the memo is moving again: a failed or cancelled fact older than this is history. A revive
            # at receive needs none (step_receive publishes the real `received` fact next); one at await_agent or reply
            # may not produce a stage fact for a long time. Same fact type as the watcher's own (ntfy-router mutes it,
            # the schema allows extra fields); `revived` marks it, and it carries no detection data.
            self.fact("received", m, {"revived": True, "revived_to": stage, "revive_why": why[:200]})
        self.s.save()

    def process_control(self) -> None:
        """`memo:retry <memo>` and `memo:cancel <memo>` drop a file here; the watcher owns state.json, so it does the
        work. Files are taken in the order they were written, so a cancel followed by a retry means what it says."""
        cdir = STATE_DIR / "control"
        if not cdir.is_dir():
            return
        files = []
        for f in cdir.iterdir():
            if f.name.startswith(("retry-", "cancel-")):
                try:
                    files.append((f.stat().st_mtime_ns, f.name, f))
                except OSError:
                    continue  # taken by another reader between the listing and the stat
        for _, name, f in sorted(files):
            verb, _, mid = name.partition("-")
            m = next((x for x in self.s.memos.values() if x["memo_id"] == mid), None)
            try:
                f.unlink()
            except OSError:
                pass
            if verb == "cancel":
                self._control_cancel(m, mid)
            else:
                self._control_retry(m, mid)

    def _control_retry(self, m: dict | None, mid: str) -> None:
        if m is None:
            log("retry_refused", "warn", memo_id=mid, reason="unknown memo")
        elif m["key"] in self.running or m.get("status") == "active":
            log("retry_refused", "warn", memo_id=mid, key=m["key"], reason=f"memo is {m.get('status')} at {m.get('stage')}, not failed")
        elif m.get("status") not in ("failed", "skipped", "cancelled"):
            log("retry_refused", "warn", memo_id=mid, key=m["key"], reason=f"memo status is {m.get('status')}")
        elif m.get("agent") is None:
            log("retry_refused", "warn", memo_id=mid, key=m["key"], reason="no agent in the key path")
        elif truncated_by_old_watcher(m):
            # An old watcher cut this prompt to 300 characters, but the audio is still in the inbox:
            # re-transcribe from it instead of refusing. The object and prompt-hash checks then apply normally.
            for k in ("transcript", "prompt", "prompt_sha256"):
                m.pop(k, None)
            self.revive(m, "transcribe", "memo:retry (re-transcribe: an old watcher cut the prompt)")
        else:
            self.revive(m, resume_for(m), "memo:retry")

    def _control_cancel(self, m: dict | None, mid: str) -> None:
        if m is None:
            log("cancel_refused", "warn", memo_id=mid, reason="unknown memo")
        elif m.get("status") == "active" or rescue_open(m):
            # active: stopped at once, wherever it is. A failed memo still watched for a late reply is cancelled too,
            # so that late reply is never spoken.
            self.cancel_memo(m)
        else:
            log("cancel_refused", "warn", memo_id=mid, key=m["key"],
                reason=f"memo is {m.get('status')} at {m.get('stage')}: only a memo still in flight can be cancelled")

    def cancel_memo(self, m: dict) -> None:
        """End a memo the operator cancelled. Honest about what that can mean: before the command is published nothing
        is ever sent; after it, the agent may still run, and the watcher only refuses to speak or mirror the reply.
        Facts and state are written under the caller's lock; a worker mid-step sees the status and stops at its next
        side effect (see _cancelled)."""
        stage = m.get("stage")
        after = cancel_after_dispatch(m)
        m["cancelled_stage"], m["cancelled_after_dispatch"], m["cancelled_ts"] = stage, after, time.time()
        m["resume_stage"] = resume_for({**m, "resume_stage": stage})  # `memo:retry` restarts where it stopped
        m.update(status=CANCELLED, failed_stage=CANCELLED, failed_code=CANCELLED, next_at=0.0)
        m["failed_message"] = "cancelled by memo:cancel"
        fu = live_followup(m)
        if fu is not None:
            # The quick answer was spoken; the background follow-up still runs on the agent but is never spoken.
            fu["state"], fu["ended_at"] = CANCELLED, iso(now_utc())
        if m.get("delegate") or (fu is not None and fu.get("kind") == "delegation" and not m.get("publish_attempted")):
            # a confirmed brief that never left: its draft goes back to the conversation, so "send it" works again
            if self.restore_draft(m, "cancelled before the delegation was sent"):
                m["resume_stage"] = "converse"  # memo:retry asks the desk again; it never replays a stale confirm
        if after and memo_escalated(m) and not m.get("publish_attempted") and stage not in ("await_agent", "reply", "speak", "mirror"):
            # after_dispatch stays true (the interactive command went out and ran); only the message is about the batch one
            msg = (f"cancelled at {stage} by memo:cancel while escalating to the batch lane: the interactive command was "
                   "sent and may still be running, the batch command was not sent")
        elif after:
            msg = (f"cancelled at {stage} by memo:cancel after the command was published: the agent may still run, "
                   "its reply is not spoken")
        else:
            msg = f"cancelled at {stage} by memo:cancel before the command was published: nothing was sent to the agent"
        data = {"stage": CANCELLED, "error_code": CANCELLED, "error_message": msg, "retryable": False, "attempt": 1,
                "after_dispatch": after}
        if m.get("command_id") and after:
            data["command_id"] = m["command_id"]
        self.fact("failed", m, data)
        log("memo_cancelled", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage,
            after_dispatch=after, command_id=m.get("command_id") if after else None,
            retry_with=f"mise run memo:retry {m['memo_id']}")
        self.status(m)
        self.s.save()

    @staticmethod
    def _cancelled(m: dict) -> bool:
        """Checked by worker steps (under the lock) before each side effect: a cancelled memo publishes nothing more."""
        return m.get("status") == CANCELLED

    def rescue_late(self) -> None:
        """A memo that hit the agent deadline may still complete (the command stayed queued). Speak it late."""
        if time.time() - self.last_rescue < 20:
            return
        self.last_rescue = time.time()
        for m in list(self.s.memos.values()):
            if not rescue_open(m) or m["key"] in self.running:
                continue
            if time.time() > rescue_closes_at(m):
                m["rescue_closed"] = True
                continue
            st = self.agent_status(m)
            if st["state"] == "done":
                m["profile"] = st.get("profile") or m["agent"]
                m["late"] = True
                log("late_rescued", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], command_id=m["command_id"],
                    waited_s=int(time.time() - m["dispatched_ts"]), note="agent finished after the deadline; replying late")
                self.revive(m, "reply", "late completion")
            elif st["state"] == "failed":
                if st.get("code") == mc_.TURN_TIMEOUT and self.can_escalate(m, st.get("timeout")):
                    # The watcher gave up first (the command sat queued past its deadline), then the gateway ran it and
                    # stopped it at its wall clock: still an interactive turn that timed out, so it escalates the same way.
                    log("late_turn_timeout", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"],
                        command_id=m["command_id"], note="the queued command ran after the deadline and hit the turn wall clock; escalating")
                    self.revive(m, "await_agent", "late turn timeout: escalating to the batch lane")
                else:
                    m["rescue_closed"] = True

    # ---- step machinery --------------------------------------------------

    def active(self) -> list[dict]:
        return sorted((m for m in self.s.memos.values() if m.get("status") == "active"),
                      key=lambda m: m["key"])

    def tick(self, discover: bool = True) -> None:
        # The listing is I/O: run it outside the lock so a slow MinIO never stalls workers applying results.
        listing, self.fresh_listing = self.fresh_listing, None
        if listing is None and discover and not (DISCOVER_FAST_S and time.time() - self.fast_listed_at < 3 * DISCOVER_FAST_S + 1.0):
            listing = self.list_inbox()
        with self.mu:
            self.flush_outbox()
            self.process_control()
            if listing is not None:
                self.discover(listing)
            self.rescue_late()
            for m in self.active():
                if STOP:
                    break
                if m.get("next_at", 0) > time.time():
                    continue
                self.advance(m)
            self.schedule_phone_retries()
            self.converse_sweep()
            self.s.save()
            counts: dict[str, int] = {}
            for m in self.s.memos.values():
                counts[m["status"]] = counts.get(m["status"], 0) + 1
            try:
                converse_hb = self.desk.heartbeat(open_conversations=len(self.s.data.get("conversations") or {}),
                                                  contract=dict(self.contract_ok), default_voice=VOICE)
            except Exception as e:  # noqa: BLE001 - the heartbeat never stops the loop
                converse_hb = {"error": f"{type(e).__name__}: {e}"[:200]}
            self.s.heartbeat({
                "lane": LANE, "lanes": self.lane_probe.snapshot() if self.lane_probe else {},
                "memos": counts, "outbox": len(self.s.data["outbox"]),
                "phone_retries": sum(1 for m in self.s.memos.values() if self.phone_retry_pending(m)),
                "converse": converse_hb,
                "active": [{"memo_id": m["memo_id"], "key": m["key"], "stage": m["stage"],
                            "running": m["key"] in self.running,
                            "step_s": int(time.time() - m["step_started_ts"]) if m.get("step_started_ts") else None}
                           for m in self.active()]})

    def start_discovery_watch(self) -> None:
        """A thread that lists inbox/ every DISCOVER_FAST_S and wakes the tick as soon as it sees a key the state does not
        know. It only reads: discover() (under the lock, in the tick) is still the one place a memo is created, and a memo
        id is a uuid5 of its key, so a listing seen twice (here and by the tick's own) cannot make two memos."""
        if not DISCOVER_FAST_S:
            return

        def loop():
            while not STOP:
                t0 = time.time()
                try:
                    objs, err = self.list_inbox()
                    if err is None:
                        self.fast_listed_at = time.time()
                        if any(o["key"] not in self.s.memos for o in objs):
                            self.fresh_listing = (objs, None)
                            WAKE.set()
                except Exception as e:  # noqa: BLE001 - the tick's own listing covers it
                    log("discovery_watch_error", "warn", error=f"{type(e).__name__}: {e}"[:200])
                time.sleep(max(0.05, DISCOVER_FAST_S - (time.time() - t0)))
        threading.Thread(target=loop, name="discovery-watch", daemon=True).start()

    def sleep_for(self, until_discover: float) -> float:
        """Seconds the main loop may sleep: until the earliest due memo or the next listing, never above TICK_S."""
        now = time.time()
        with self.mu:
            due = [m.get("next_at", 0) - now for m in self.active() if m["key"] not in self.running] + self.next_phone_retry_in()
        return max(0.05, min([TICK_S, until_discover, *due]))

    def advance(self, m: dict) -> None:
        stage = m["stage"]
        pool = SLOW_STAGES.get(stage)
        if pool:
            if m["key"] in self.running:
                return
            self.running.add(m["key"])
            m["step_started_ts"] = time.time()
            self.pools[pool].submit(self._exec, m, stage)
            return
        self._exec(m, stage)

    def _exec(self, m: dict, stage: str) -> None:
        step = {"receive": self.step_receive, "transcribe": self.step_transcribe, "converse": self.step_converse,
                "dispatch": self.step_dispatch, "await_agent": self.step_await_agent,
                "reply": self.step_reply, "speak": self.step_speak, "mirror": self.step_mirror}[stage]
        t0 = time.time()
        err: StageError | None = None
        try:
            step(m)
        except WatcherStopping:
            log("step_stopped", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage,
                note="the service is stopping: the memo stays at this stage and resumes there on the next start")
        except StageError as e:
            err = e
        except Exception as e:  # noqa: BLE001
            err = StageError(FAIL_STAGE[stage], "unexpected", f"{type(e).__name__}: {e}", True)
        finally:
            WAKE.set()  # a step ended: let the main loop pick up what it unblocked (first, so a failing save cannot skip it)
            # The failure is settled and the memo is released in ONE critical section: a memo:retry that lands between
            # the two would find the memo failed but still "running", be refused, and its control file would be gone.
            with self.mu:
                try:
                    if err is not None:
                        self._settle_error(m, err)
                finally:
                    m["last_step_ms"] = int((time.time() - t0) * 1000)
                    m.pop("step_started_ts", None)
                    self.running.discard(m["key"])
                    self.s.save()

    def _settle_error(self, m: dict, e: StageError) -> None:
        if m.get("status") == CANCELLED:
            # A worker step that was already running when the memo was cancelled: its failure is not the memo's outcome.
            log("stage_failed_after_cancel", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300])
            return
        self.on_error(m, e)

    def on_error(self, m: dict, e: StageError) -> None:
        n = m["attempts"][e.stage] = m["attempts"].get(e.stage, 0) + 1
        if e.retryable and e.stage in RETRY_BUDGET_S:
            first = m.setdefault("first_fail", {}).setdefault(e.stage, time.time())
            retry = (time.time() - first) < RETRY_BUDGET_S[e.stage]
        else:
            retry = e.retryable and n < MAX_ATTEMPTS
        data = {"stage": e.stage, "error_code": e.code, "error_message": e.message[:800],
                "retryable": retry, "attempt": n}
        if m.get("command_id"):
            data["command_id"] = m["command_id"]
        data.update(e.extra)
        self.fact("failed", m, data)
        if retry:
            delay = min(300, BACKOFF.get(e.stage, 10) * (2 ** (n - 1)))
            m["next_at"] = time.time() + delay
            log("stage_failed", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300], attempt=n, retry_in_s=delay)
        else:
            fu = live_followup(m)
            if (e.stage == "dispatch" and fu is not None and fu.get("kind") == "delegation"
                    and not self._delegation_published(m)):
                # the confirmed brief could not be sent (the target is unroutable, the bus stayed down past the budget) and
                # nothing left: the draft is pending again and the driver is told, instead of an "Already sent" forever
                self.delegation_unsent(m, fu, e.code, e.message)
                return
            m["status"] = "failed"
            m["failed_stage"] = e.stage
            m["failed_code"] = e.code
            m["failed_message"] = e.message[:300]
            restored = False
            if m.get("delegate"):
                # the read-back of a confirmed brief never made it out (vox down past its budget, say): nothing was
                # sent, so the draft goes back to proposed and "send it" works again
                restored = self.restore_draft(m, f"the read-back failed at {e.stage}: {e.code}")
            m["resume_stage"] = ("await_agent" if e.stage == "agent_reply" and e.code == "timeout" and m.get("command_id")
                                 else "dispatch" if e.stage == "agent_reply" and e.code == mc_.TURN_TIMEOUT  # fresh command
                                 else RESUME_STAGE.get(e.stage, "receive"))
            if restored:
                m["resume_stage"] = "converse"  # memo:retry asks the desk again: the old "Sending to ..." line is never re-spoken
            m["resume_stage"] = resume_for(m)
            compact(m)
            log("memo_failed", "error", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300], attempt=n,
                retry_with=f"mise run memo:retry {m['memo_id']}")
            self.status(m)

    def done_stage(self, m: dict, stage: str, nxt: str, ms: float | None = None, **extra) -> None:
        log("stage_done", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage,
            next=nxt, ms=int(ms) if ms is not None else None, **extra)
        m["stage"] = nxt
        m["next_at"] = 0.0
        self.status(m)
        WAKE.set()  # the next stage starts now, not at the next tick

    # ---- steps -----------------------------------------------------------

    def step_receive(self, m: dict) -> None:
        ext = Path(m["key"]).suffix.lower().lstrip(".")
        ctype = {"ogg": "audio/ogg", "opus": "audio/ogg", "webm": "audio/webm", "m4a": "audio/mp4",
                 "mp3": "audio/mpeg", "wav": "audio/wav", "mp4": "audio/mp4"}.get(ext)
        up = mc_.parse_iso(m.get("uploaded_at"))
        det = now_utc()
        lag = int((det - up).total_seconds() * 1000) if up else None
        self.fact_fast("received", m, {"size_bytes": m.get("size"), "content_type": ctype,
                                  "uploaded_at": m.get("uploaded_at"), "detected_at": iso(det),
                                  "detect_lag_ms": lag})
        m["received_ts"] = time.time()
        # Fail in 1 ms, not after 45 s of Whisper and a 10 minute wait: the gateway consumes a command
        # for an unroutable agent and drops it without a journal row or a fact.
        route = mc_.registry_route(m["agent"])
        if route["ok"] is False:
            raise StageError("dispatch", "unknown_agent", route["reason"], retryable=False)
        m["display_name"] = mc_.spoken_name(m["agent"], route)
        if self.desk.wants(m["agent"]):
            # the fast desk may take this memo: who sent it (car or browser, which device) and the agent's card are
            # fetched now, in parallel with the download and Whisper, so the desk has them the moment the transcript lands
            self.start_prefetch(m)
        self.done_stage(m, "received", "transcribe", size=m.get("size"), detect_lag_ms=lag)

    # -- transcribe (worker thread) --

    def step_transcribe(self, m: dict) -> None:
        with self.mu:
            key, mid, agent, timeouts = m["key"], m["memo_id"], m["agent"], m.get("timeouts", 0)
            want = {"size": m.get("size"), "etag": m.get("etag")}
        try:
            work = self._transcribe_work(key, mid, agent, timeouts, want)
        except StageError as e:
            if e.code == "timeout":
                with self.mu:
                    m["timeouts"] = m.get("timeouts", 0) + 1
            elif e.code == "object_changed":
                with self.mu:
                    m["observed_object"] = getattr(e, "observed", None)  # adopted if the operator retries
            raise
        with self.mu:
            if self._cancelled(m):  # cancelled while Whisper ran: the transcript is dropped, no fact, nothing dispatched
                log("step_dropped_after_cancel", "warn", memo_id=m["memo_id"], key=key, agent=agent, stage="transcribe")
                return
            self._transcribe_apply(m, work)

    def _transcribe_work(self, key: str, mid: str, agent: str, timeouts: int, want: dict | None = None) -> dict:
        tmp = Path(tempfile.mkdtemp(prefix="memo-"))
        try:
            audio = tmp / Path(key).name
            t0 = time.time()
            r = mc_.mc("cp", "--quiet", mc_.s3_url(key), str(audio), timeout=90)
            if r.returncode != 0 or not audio.exists():
                raise StageError("download", "mc_cp_failed", f"mc cp rc={r.returncode}: {r.stderr.strip()[-300:]}")
            log("stage_done", memo_id=mid, key=key, agent=agent, stage="download",
                ms=int((time.time() - t0) * 1000), bytes=audio.stat().st_size)
            self._check_object(audio, key, want or {})

            # The level probe (ffmpeg, 0.2-0.3 s) runs at the same time as ffprobe and, after it, the warm Whisper server:
            # it used to run in front of Whisper. Its verdict still gates the turn (below), after the transcript is in.
            lvl_pool = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="levels")
            levels_f = lvl_pool.submit(mc_.measure_levels, audio)
            try:
                # Fail fast on audio nothing can decode, and size the timeout from the real duration.
                probe = mc_.probe_audio(audio)
                if probe["ok"] is False:
                    raise StageError("transcribe", "undecodable_audio", f"ffprobe cannot read the upload: {probe['error']}", retryable=False)
                audio_s = probe["duration"]
                if probe["ok"] and audio_s is not None and audio_s < MIN_AUDIO_S:
                    raise StageError("transcribe", "too_short", f"recording is {audio_s:.2f}s (< {MIN_AUDIO_S}s): an accidental tap, not a prompt",
                                     retryable=False)

                # A dead microphone (a corked emulator capture, a revoked permission, a muted car mic) records a perfectly
                # valid file of digital silence, and "the transcript is empty" says nothing about why: the level is measured
                # for every memo and every later failure of this stage carries it. A silent clip is refused after the
                # server answered (one GPU call spent on a dead mic; the common case saves the probe's 0.2-0.3 s).
                t_w = time.time()
                pre = (*self._transcribe_server(audio, mid, key, agent, audio_s, levels_f), t_w)
                levels = levels_f.result()
            finally:
                lvl_pool.shutdown(wait=False)
            lvl = level_fields(levels)
            log("audio_level", memo_id=mid, key=key, agent=agent, stage="transcribe", audio_s=audio_s, **lvl,
                measured=levels["ok"], error=levels["error"])
            silent = silent_reason(levels, audio_s)
            if silent:
                raise StageError("transcribe", silent[0], silent[1], retryable=False,
                                 extra={**lvl, "audio_duration_seconds": round(audio_s, 2) if audio_s is not None else None})
            try:
                return self._transcribe_run(tmp, audio, mid, key, agent, audio_s, levels, lvl, timeouts, pre=pre)
            except StageError as e:
                e.extra = {**lvl, "audio_duration_seconds": round(audio_s, 2) if audio_s is not None else None, **e.extra}
                raise
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @staticmethod
    def _check_object(audio: Path, key: str, want: dict) -> None:
        """Hold a memo whose object is not the one that was discovered: a recording replaced or cut after the listing
        would be transcribed and sent to an agent as if it were what the operator said."""
        size = audio.stat().st_size
        etag = (want.get("etag") or "").strip('"')
        why = None
        if want.get("size") is not None and size != want["size"]:
            why = f"{size} bytes now, {want['size']} bytes when it was discovered"
        elif re.fullmatch(r"[0-9a-f]{32}", etag):  # a multipart upload's etag is not an md5: its size check covers it
            md5 = hashlib.md5()
            with audio.open("rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    md5.update(chunk)
            if md5.hexdigest() != etag:
                why = f"content hash {md5.hexdigest()} now, etag {etag} when it was discovered"
        if why:
            e = StageError("download", "object_changed",
                           f"{key} changed after it was discovered ({why}); `memo:retry` takes the object as it is now",
                           retryable=False)
            e.observed = {"size": size, "etag": None}
            raise e

    def _transcribe_run(self, tmp: Path, audio: Path, mid: str, key: str, agent: str, audio_s: float | None,
                        levels: dict, lvl: dict, timeouts: int, pre: tuple | None = None) -> dict:
        # pre: (served, fallback, started_at) when the caller already asked the warm server (concurrently with the level probe)
        if pre is not None:
            served, fallback, t1 = pre
        else:
            t1 = time.time()
            served, fallback = self._transcribe_server(audio, mid, key, agent, audio_s, levels)
        if served:
            return {**served, "took": time.time() - t1, "audio_s": audio_s, "levels": lvl}
        timeout = transcribe_timeout(audio_s, timeouts)

        out_md = tmp / (audio.stem + ".md")
        tlog = tmp / "transcribe.log"
        env = {**os.environ, "TRANSCRIBE_DIR": TRANSCRIBE_DIR, "TRANSCRIBE_LOG_FILE": str(tlog)}
        # --output keeps the transcript out of ~/d/Transcripts (--ephemeral only skips S3 archiving)
        cmd = [TRANSCRIBE, str(audio), "--no-diarization", "--ephemeral", "--output", str(out_md)]
        log("transcribe_start", memo_id=mid, key=key, agent=agent, stage="transcribe",
            audio_s=audio_s, timeout_s=timeout, server_skipped=fallback)
        try:
            r = run(cmd, timeout, env=env)
        except subprocess.TimeoutExpired:
            raise StageError("transcribe", "timeout",
                             f"transcribe exceeded {timeout}s for {audio_s}s of audio") from None
        took = time.time() - t1
        if r.returncode != 0:
            raise StageError("transcribe", f"rc_{r.returncode}", f"transcribe failed: {r.stderr.strip()[-400:]}")
        md_path = Path(r.stdout.strip().splitlines()[-1].strip()) if r.stdout.strip() else out_md
        if not md_path.exists():
            md_path = out_md
        if not md_path.exists():
            raise StageError("transcribe", "no_output", f"transcribe wrote no markdown (stdout={r.stdout[-200:]!r})")
        text = parse_transcript(md_path.read_text())
        meta = {}
        for line in r.stderr.splitlines():
            if line.startswith("Transcription-Metadata:"):
                try:
                    meta = json.loads(line.split(":", 1)[1].strip())
                except json.JSONDecodeError:
                    pass
        dev = re.search(r"Device: (\w+)", r.stderr)  # transcribe.py logs "Device: cuda (float16)" / "Device: cpu (int8)"
        meta = {**meta, "device": dev.group(1) if dev else None, "fallback_reason": fallback}
        junk = junk_reason(text, audio_s or meta.get("duration_seconds"), levels)
        if junk:
            raise StageError("transcribe", junk[0], junk[1], retryable=False)
        return {"text": text, "meta": meta, "took": took, "audio_s": audio_s, "levels": lvl}

    def _transcribe_server(self, audio: Path, mid: str, key: str, agent: str, audio_s: float | None,
                           levels: dict) -> tuple[dict | None, str | None]:
        """The fast path: POST the clip to the warm GPU whisper server. ({text, meta}, None) for a usable transcript;
        (None, why) when the CLI must run instead. A junk result (empty, "Thank you.") also goes to the CLI: a second
        opinion costs seconds only on a memo that would otherwise fail."""
        if not WHISPER_URL:
            return None, "server off"
        if audio_s is not None and audio_s > WHISPER_MAX_AUDIO_S:
            return None, f"audio {audio_s:.0f}s is over the server's {WHISPER_MAX_AUDIO_S:.0f}s"
        timeout = WHISPER_TIMEOUT_S + 0.1 * (audio_s or 0)
        t0 = time.time()
        try:
            boundary = uuid.uuid4().hex
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{audio.name.replace(chr(34), "")}"\r\n'
                    "Content-Type: application/octet-stream\r\n\r\n").encode() + audio.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
            req = urllib.request.Request(f"{WHISPER_URL}/v1/audio/transcriptions", data=body, method="POST",
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                d = json.loads(resp.read())
            if not isinstance(d, dict) or not isinstance(d.get("text"), str):
                raise ValueError(f"no text in the response: {str(d)[:120]}")
            text = d["text"].strip()
            if isinstance(levels, concurrent.futures.Future):
                levels = levels.result()  # the level probe ran alongside this request
            junk = junk_reason(text, audio_s or d.get("duration_seconds"), levels)
            if junk:
                raise ValueError(f"{junk[0]} {text[:40]!r}")
        except Exception as e:  # noqa: BLE001 - every failure has the same answer: the CLI runs
            why = f"{type(e).__name__}: {e}"[:240]
            log("whisper_server_fallback", "warn", memo_id=mid, key=key, agent=agent, stage="transcribe",
                ms=int((time.time() - t0) * 1000), timeout_s=round(timeout, 1), reason=why)
            return None, why
        model = re.sub(r"^faster-whisper-|-ct2$", "", str(d.get("model") or "").rsplit("/", 1)[-1]) or None
        meta = {"model": model, "backend": "faster-whisper-server", "device": d.get("device"),
                "language": d.get("language"), "duration_seconds": d.get("duration_seconds"),
                "word_count": len(text.split()), "fallback_reason": None}
        log("whisper_server_done", memo_id=mid, key=key, agent=agent, stage="transcribe",
            ms=int((time.time() - t0) * 1000), model=model, device=meta["device"], audio_s=audio_s)
        return {"text": text, "meta": meta}, None

    def _transcribe_apply(self, m: dict, w: dict) -> None:
        text, meta, took = w["text"], w["meta"], w["took"]
        if len(text) > MAX_TRANSCRIPT_CHARS:
            raise StageError("transcribe", "transcript_too_long",
                             f"transcript is {len(text)} chars, over the {MAX_TRANSCRIPT_CHARS} limit: held, not cut; "
                             "a prompt is never sent shortened", retryable=False)
        m["transcript"] = text
        m["prompt"] = build_prompt(text)
        m["prompt_sha256"] = hashlib.sha256(m["prompt"].encode()).hexdigest()  # saved with the step, before any publish
        self.fact_fast("transcribed", m, {
            "transcript_text": m["transcript"], "transcript_chars": len(text),
            "word_count": meta.get("word_count") or len(text.split()),
            "audio_duration_seconds": meta.get("duration_seconds") or w["audio_s"],
            "processing_seconds": round(took, 2), "model": meta.get("model"),
            "backend": meta.get("backend"), "language": meta.get("language"),
            # which path ran: device "cuda"/"cpu"; fallback_reason set when the warm server was skipped for the CLI
            "device": meta.get("device"), "fallback_reason": meta.get("fallback_reason"), **w.get("levels", {})})
        m.update({k: v for k, v in w.get("levels", {}).items() if v is not None})
        audio_s = meta.get("duration_seconds") or w["audio_s"]
        if isinstance(audio_s, (int, float)):
            m["audio_s"] = round(float(audio_s), 2)
        # The fast desk takes the memo when it is on for this agent and the memo is a car memo it can answer (step_converse
        # checks the rest); shadow decides on the side and changes nothing; anything else is today's path, unchanged.
        route = self.converse_route(m)
        self.done_stage(m, "transcribed", "converse" if route == "on" else "dispatch", ms=took * 1000, chars=len(text),
                        audio_s=meta.get("duration_seconds") or w["audio_s"], model=meta.get("model"),
                        backend=meta.get("backend"), device=meta.get("device"), text=text[:120])
        if route == "shadow":
            self.start_shadow(m)

    # -- the fast in-car conversation desk (worker thread; converse.py) --
    #
    # transcribe -> converse -> speak -> mirror -> done           (reply | propose | cancel | end: no agent command)
    #                        -> speak -> mirror -> dispatch ...   (confirm: the read-back, then the brief as a follow-up)
    #                        -> dispatch -> ... today's path      (direct, a failed ladder, or a memo the desk cannot take)
    # The desk never fails a memo for an LLM reason: every failure falls through to today's path.

    @staticmethod
    def _dispatched_before(m: dict) -> bool:
        return bool(m.get("publish_attempted") or m.get("dispatched_ts") or m.get("command_id") or m.get("followups"))

    def converse_route(self, m: dict) -> str | None:
        """Under the lock, as the transcript lands: "on" (the converse stage), "shadow" (today's path plus a logged side
        decision) or None (today's path). Cheap: the sender, audio length and keys are checked again in step_converse."""
        try:
            s = self.desk.settings()
        except Exception as e:  # noqa: BLE001 - a broken desk config is today's path, never a stopped watcher
            log("converse_config_error", "warn", memo_id=m["memo_id"], key=m["key"], error=f"{type(e).__name__}: {e}"[:200])
            return None
        if s["mode"] == "off" or not self.desk.agent_allowed(s, m.get("agent")) or self._dispatched_before(m):
            return None
        sender = m.get("sender") or {}
        if sender.get("ok") and sender.get("host") != "car":
            return None  # known not to be a car (a browser): today's path without a converse hop
        if isinstance(m.get("audio_s"), (int, float)) and m["audio_s"] > self.desk.max_audio_s:
            return None
        if len(m.get("transcript") or "") > self.desk.max_input_chars:
            return None
        return s["mode"]

    def start_prefetch(self, m: dict) -> None:
        """Under the lock (step_receive): read who sent the memo (S3 metadata) and build the agent's card on a thread of
        its own, while the download and Whisper run."""
        key, agent = m["key"], m["agent"]
        slot = {"done": threading.Event(), "card": None, "sender": None, "at": time.time()}
        self.prefetch[key] = slot

        def work():
            try:
                sender = mc_.s3_sender(key)
                slot["sender"] = sender
                with self.mu:
                    mm = self.s.memos.get(key)
                    if mm is not None and not (mm.get("sender") or {}).get("ok"):
                        mm["sender"] = sender
                slot["card"] = self.desk.cards.build(agent)
            except Exception as e:  # noqa: BLE001 - the desk builds what it needs itself
                log("converse_prefetch_failed", "warn", key=key, agent=agent, error=f"{type(e).__name__}: {e}"[:200])
            finally:
                slot["done"].set()
        threading.Thread(target=work, name="converse-prefetch", daemon=True).start()

    def _sender(self, key: str) -> dict:
        slot = self.prefetch.get(key)
        if slot is not None:
            slot["done"].wait(2.0)
            if (slot.get("sender") or {}).get("ok"):
                return slot["sender"]
        return mc_.s3_sender(key)

    def _card_for(self, key: str, agent: str) -> dict:
        slot = self.prefetch.get(key)
        if slot is not None:
            slot["done"].wait(CONVERSE_CARD_WAIT_S)
            if slot.get("card"):
                return slot["card"]
        return self.desk.cards.build(agent, allow_recall=False)  # the recall only from cache on the critical path

    def _session(self, sender: dict, agent: str, now: float, create: bool = True) -> tuple[str, dict | None, bool]:
        """Lock held. (key, the open conversation of this device and agent, whether it was opened now). An idle one is
        closed first (MEMO_CONVERSE_IDLE_S)."""
        convs = self.s.data.setdefault("conversations", {})
        sk = cv.session_key(sender.get("device"), agent)
        sess = convs.get(sk)
        if sess is not None and now - float(sess.get("last_at") or 0) > self.desk.idle_s:
            self.close_session(sk, "idle")
            sess = None
        opened = False
        if sess is None and create:
            sess = convs[sk] = cv.new_session(agent, sender.get("device"), now)
            opened = True
            log("conversation_opened", conv_id=sess["conv_id"], sid=sess["sid"], agent=agent, device=sender.get("device"))
        return sk, sess, opened

    def _find_session(self, conv_id: str | None) -> dict | None:
        if not conv_id:
            return None
        for sess in (self.s.data.get("conversations") or {}).values():
            if sess.get("conv_id") == conv_id:
                return sess
        return next((x for x in reversed(self.s.data.get("conversations_closed") or []) if x.get("conv_id") == conv_id), None)

    def close_session(self, sk: str, reason: str) -> None:
        """Lock held. The conversation ends (idle, the driver said so): a draft still waiting is never sent and expires."""
        sess = (self.s.data.get("conversations") or {}).pop(sk, None)
        if sess is None:
            return
        now = time.time()
        p = sess.get("pending")
        if isinstance(p, dict) and p.get("state") == "proposed":
            p["state"] = "expired"
            sess["pending"] = None
            log("converse_draft_expired", conv_id=sess["conv_id"], agent=sess.get("agent"), brief_id=p.get("brief_id"),
                title=p.get("title"), reason=f"conversation closed ({reason})", note="never sent")
        sess.update(closed_at=now, closed_reason=reason)
        closed = self.s.data.setdefault("conversations_closed", [])
        closed.append(sess)
        del closed[:-CONVERSE_CLOSED_KEEP]
        log("conversation_closed", conv_id=sess["conv_id"], sid=sess.get("sid"), agent=sess.get("agent"), reason=reason,
            turns=len(cv.driver_turns(sess)), delegations=len(sess.get("delegations") or []))

    def converse_sweep(self) -> None:
        """Tick, lock held, every CONVERSE_SWEEP_S: drafts past their TTL expire (never sent), idle conversations close."""
        now = time.time()
        if now - self.last_conv_sweep < CONVERSE_SWEEP_S:
            return
        self.last_conv_sweep = now
        for sk, sess in list((self.s.data.get("conversations") or {}).items()):
            p = sess.get("pending")
            if (isinstance(p, dict) and p.get("state") == "proposed"
                    and now - max(float(p.get("at") or 0), float(p.get("restored_at") or 0)) > self.desk.draft_ttl_s):
                p["state"] = "expired"
                sess["pending"] = None
                sess["expired"] = {"brief_id": p.get("brief_id"), "title": p.get("title"), "at": now}
                log("converse_draft_expired", conv_id=sess["conv_id"], agent=sess.get("agent"), brief_id=p.get("brief_id"),
                    title=p.get("title"), reason=f"no confirmation within {self.desk.draft_ttl_s:g} s", note="never sent")
            if (isinstance(p, dict) and p.get("state") == "sending"
                    and now - float(p.get("at") or 0) > CONVERSE_SENDING_STUCK_S):
                # a draft "being sent" long after any dispatch could still be retrying: the delegation did not leave
                for x in sess.get("delegations") or []:
                    if x.get("brief_id") == p.get("brief_id") and x.get("state") == "sending":
                        x["state"] = "not_sent"
                p["state"] = "expired"
                sess["pending"] = None
                log("converse_draft_unsent", "warn", conv_id=sess["conv_id"], agent=sess.get("agent"),
                    brief_id=p.get("brief_id"), title=p.get("title"), note="stuck 'sending' with no dispatch: cleared, never sent")
            if now - float(sess.get("last_at") or 0) > self.desk.idle_s:
                self.close_session(sk, "idle")
        for k, slot in list(self.prefetch.items()):
            if now - slot.get("at", now) > 600:
                self.prefetch.pop(k, None)

    def _delegation_board(self, agent: str, now: float) -> str:
        """Lock held. What was sent from the car for this agent in the last 24 h, with its live state, newest progress
        line and result: "how's that going?" is answered from here, with no agent turn."""
        rows = []
        sessions = [*(self.s.data.get("conversations") or {}).values(), *(self.s.data.get("conversations_closed") or [])]
        for sess in sessions:
            if sess.get("agent") != agent:
                continue
            for d in sess.get("delegations") or []:
                if now - float(d.get("at") or 0) > 86400:
                    continue
                state = d.get("state")
                memo = self.s.memos.get(d.get("key") or "")
                fu = next((x for x in (memo or {}).get("followups") or [] if x.get("command_id") == d.get("command_id")), None)
                if fu is not None and state in ("sending", "running"):
                    state = {"dispatching": "sending", "running": "running", "spoken": "done", "failed": "failed",
                             CANCELLED: "cancelled"}.get(fu.get("state"), state)
                text = {"sending": "being sent", "running": "running", "done": "finished", "failed": "did not finish",
                        "not_sent": "NOT sent", "cancelled": "cancelled"}.get(state, state or "?")
                mins = int((now - float(d.get("at") or now)) // 60)
                line = (f"- {d.get('title')} -> {d.get('target_name') or d.get('target')} "
                        f"[{cv.PERM_TEXT.get(d.get('perm'), 'Read-only')}]: {text}, sent "
                        f"{time.strftime('%H:%M', time.localtime(float(d.get('at') or now)))} ({mins} min ago)")
                if memo and state == "running" and memo.get("command_id") == d.get("command_id") and memo.get("progress_text"):
                    line += f"; latest progress: {memo['progress_text'][:200]}"
                if d.get("result"):
                    line += f"; result: {d['result'][:CONVERSE_RESULT_CHARS]}"
                rows.append((float(d.get("at") or 0), line))
        return "\n".join(line for _, line in sorted(rows)[-8:])

    def _recent_memos(self, agent: str, sess: dict | None, exclude: str, now: float) -> str:
        """Lock held. Up to 3 answered memos to this agent from the last 24 h that are not part of this conversation."""
        mine = {t.get("memo_id") for t in (sess or {}).get("turns") or []}
        picks = sorted((x for x in self.s.memos.values()
                        if x.get("agent") == agent and x.get("status") == "done" and x.get("memo_id") not in mine
                        and x.get("key") != exclude and now - float(x.get("detected_ts") or 0) < 86400
                        and x.get("transcript") and x.get("reply_text")),
                       key=lambda x: float(x.get("detected_ts") or 0))[-3:]
        return "\n".join(f"- {time.strftime('%H:%M', time.localtime(float(x.get('detected_ts') or now)))} asked: "
                         f"{x['transcript'][:160]} | answer: {x['reply_text'][:240]}" for x in picks)

    def _conv_snapshot(self, m: dict, sender: dict, now: float) -> dict:
        """Lock held. Copies of what the desk reads for this turn (it runs outside the lock)."""
        _, sess, _ = self._session(sender, m["agent"], now, create=False)
        return {"sess": cv.snapshot(sess) if sess else None, "board": self._delegation_board(m["agent"], now),
                "recent": self._recent_memos(m["agent"], sess, m["key"], now)}

    def step_converse(self, m: dict) -> None:
        """Decide one car turn with the fast desk. The decision is stored on the memo (conv_raw) before it is applied, so a
        restart re-applies it without a second LLM call. Never fails the memo for an LLM reason."""
        t0 = time.time()
        with self.mu:
            if self._cancelled(m):
                return
            key, mid, agent = m["key"], m["memo_id"], m["agent"]
            transcript = m.get("transcript") or ""
            raw = m.get("conv_raw")
            sender = m.get("sender")
            audio_s, dispatched = m.get("audio_s"), self._dispatched_before(m)
            name = m.get("display_name") or mc_.spoken_name(agent)
        s = self.desk.settings()  # the kill switch is read again here: off since the transcript landed = today's path
        if raw is None:
            if not (sender or {}).get("ok"):
                sender = self._sender(key)
                with self.mu:
                    m["sender"] = sender
            why = self.desk.ineligible(s, agent, sender, audio_s, transcript, dispatched)
            if why:
                with self.mu:
                    if self._cancelled(m):
                        return
                    self.prefetch.pop(key, None)
                    log("converse_skipped", memo_id=mid, key=key, agent=agent, reason=why, host=(sender or {}).get("host"),
                        note="today's path: dispatched to the agent as usual")
                    self.done_stage(m, "converse", "dispatch", ms=(time.time() - t0) * 1000, skipped=why)
                return
            hold = self.start_hold_cues(m)   # "One sec." at HOLD_CUE_S if the decision is not in by then
            try:
                now = time.time()
                with self.mu:
                    snap = self._conv_snapshot(m, sender, now)
                card = self._card_for(key, agent)
                raw = self.desk.decide(s, agent=agent, name=name, transcript=transcript, sess=snap["sess"], card=card,
                                       board=snap["board"], recent=snap["recent"], now=now)
                raw["card"] = {k: card.get(k) for k in ("sha256", "built_at", "recall", "chars", "cached")}
                if raw["decision"].get("action") == "tool":
                    # a voice / model switch (the phrase short-circuit or the model's tool call): validated against the
                    # car-desk tool.json contracts and run as the skill's entrypoint now, before the decision is stored, so
                    # a restart re-applies the outcome and never runs the tool twice; what is said is a template
                    raw["tool"] = self.desk.run_tool(agent, name, raw["decision"].get("tool_name"),
                                                     raw["decision"].get("args"), by="car")
                    raw["decision"]["say"] = raw["tool"]["say"]
            except WatcherStopping:
                raise
            except Exception as e:  # noqa: BLE001 - never a failed memo for a desk bug: today's path
                log("converse_error", "warn", memo_id=mid, key=key, agent=agent, error=f"{type(e).__name__}: {e}"[:300])
                raw = {"decision": cv.normalize_decision({"action": "direct"}), "path": "fallback", "lexicon": False,
                       "llm": None, "fallback_reason": f"error: {type(e).__name__}: {e}"[:200]}
            finally:
                if hold is not None:
                    hold.set()   # the decision is in: a hold cue that has not been uploaded yet is dropped
            raw["decided_at"] = time.time()
            raw["sender"] = sender
            with self.mu:
                if not self._cancelled(m):
                    m["conv_raw"] = raw
                    self.s.save()
        with self.mu:
            if self._cancelled(m):
                log("step_dropped_after_cancel", "warn", memo_id=mid, key=key, agent=agent, stage="converse",
                    note="the desk's answer is dropped: nothing is spoken and no turn is recorded")
                return
            self.prefetch.pop(key, None)
            undo = self._apply_snapshot(m)
            try:
                self._converse_apply(m, raw, time.time() - t0)
            except BaseException:
                # the apply mutates the conversation before it publishes: a failure half way puts everything back, so the
                # retry sees the conversation as it was (not a draft "being sent" by a turn that never finished)
                self._apply_restore(m, undo)
                raise

    _APPLY_KEYS = ("delegate", "conv", "reply_text", "reply_stamp", "agent_done_ts", "prompt", "prompt_sha256", "stage", "next_at")

    def _apply_snapshot(self, m: dict) -> dict:
        return {"conversations": copy.deepcopy(self.s.data.get("conversations")),
                "closed": copy.deepcopy(self.s.data.get("conversations_closed")),
                "memo": {k: copy.deepcopy(m[k]) for k in self._APPLY_KEYS if k in m}}

    def _apply_restore(self, m: dict, undo: dict) -> None:
        if undo["conversations"] is not None:
            self.s.data["conversations"] = undo["conversations"]
        else:
            self.s.data.pop("conversations", None)
        if undo["closed"] is not None:
            self.s.data["conversations_closed"] = undo["closed"]
        for k in self._APPLY_KEYS:
            if k in undo["memo"]:
                m[k] = undo["memo"][k]
            else:
                m.pop(k, None)

    def _converse_apply(self, m: dict, raw: dict, took: float) -> None:
        """Lock held. The guard turns the decision into what is said and done; the conversation, the memo and the routed
        fact are written; the memo moves to speak (a fast turn) or dispatch (direct)."""
        now = time.time()
        mid, key, agent, transcript = m["memo_id"], m["key"], m["agent"], m.get("transcript") or ""
        sender = raw.get("sender") or m.get("sender") or {}
        sk, sess, opened = self._session(sender, agent, now)
        s = self.desk.settings()
        dec = raw["decision"]
        final, reasons = cv.guard(dec, sess, transcript, tile=agent, tile_name=m.get("display_name") or mc_.spoken_name(agent),
                                  handoff=s["handoff"], route_fn=mc_.registry_route, names_fn=self.desk.cards, now=now,
                                  draft_ttl_s=self.desk.draft_ttl_s, dedupe_s=self.desk.dedupe_s, memo_id=mid)
        action = final["action"]
        llm = raw.get("llm") or {}
        if reasons:
            log("converse_guard", memo_id=mid, key=key, agent=agent, conv_id=sess["conv_id"], decided=dec.get("action"),
                action=action, reasons=reasons)
        for r in reasons:
            if r in ("handoff_off", "handoff_not_named", "unroutable_target"):
                log("converse_retarget_refused", "warn", memo_id=mid, key=key, agent=agent, conv_id=sess["conv_id"],
                    asked=dec.get("target"), reason=r, note="the work stays with the tile's agent")
        pend = sess.get("pending")
        cs = final.get("cancel_sending")
        if cs is not None:
            final["say"] = self._cancel_sending(sess, cs, mid, final["say"], reasons)
        if final["drop"] and isinstance(pend, dict) and pend.get("state") == "proposed":
            pend["state"] = "dropped"
            sess["pending"] = None
            log("converse_draft_dropped", memo_id=mid, conv_id=sess["conv_id"], brief_id=pend.get("brief_id"),
                title=pend.get("title"), note="never sent")
        if final["draft"] is not None:
            sess["pending"] = final["draft"]
            sess.pop("expired", None)
        sent = final["send"]
        if sent is not None:
            sent["state"] = "sending"
            sent["sent_by_memo"] = mid
            sent["sent_by_key"] = key
            cid = cv.command_id_for(sent["brief_id"])
            # only the driver's turns that built THIS draft (not a withdrawn request, an earlier failed ask, or small talk);
            # the stored brief above them stays verbatim
            words = [(time.strftime("%H:%M:%S", time.localtime(float(t.get("at") or now))), t.get("user") or "")
                     for t in cv.draft_turns(sess, sent, skip_memo=mid)]
            words.append((time.strftime("%H:%M:%S", time.localtime(now)), transcript))
            prompt = cv.render_prompt(sent, words, sess["conv_id"], mid, agent)
            m["delegate"] = {"prompt": prompt, "command_id": cid, "brief_id": sent["brief_id"],
                             "brief_sha256": sent["brief_sha256"], "target": sent["target"],
                             "target_name": sent["target_name"], "title": sent["title"], "perm": sent["perm"],
                             "conv_id": sess["conv_id"]}
            dl = sess.setdefault("delegations", [])
            if not any(x.get("brief_id") == sent["brief_id"] and x.get("state") == "sending" for x in dl):
                dl.append({"brief_id": sent["brief_id"], "brief_sha256": sent["brief_sha256"], "title": sent["title"],
                           "target": sent["target"], "target_name": sent["target_name"], "perm": sent["perm"],
                           "memo_id": mid, "key": key, "command_id": cid, "state": "sending", "at": now})
        turn = {"memo_id": mid, "key": key, "at": now, "user": transcript[:2000],
                "say": final["say"] if action != "direct" else "", "action": action, "path": raw.get("path"),
                "model": llm.get("model"), "route": llm.get("route"), "ms": llm.get("latency_ms"),
                "device": sender.get("device"), "guard": reasons or None}
        tool = raw.get("tool") if isinstance(raw.get("tool"), dict) else None
        if tool is not None:
            turn["tool"] = {"name": tool.get("tool"), "args": tool.get("args"), "ok": tool.get("ok"), "via": tool.get("via")}
        try:
            tile_now = self.desk.tile(agent)
        except Exception:  # noqa: BLE001
            tile_now = {}
        pend_now = sess.get("pending") if isinstance(sess.get("pending"), dict) else None
        if action == "propose" and pend_now is not None and pend_now.get("state") == "proposed":
            turn["readback"] = pend_now.get("brief_id")  # what the driver just heard read back: a bare "yes" confirms this
        n = cv.upsert_turn(sess, turn)
        sess["last_at"] = now
        if action == "direct":
            # today's interactive turn, with the conversation so far in front of the transcript (re-pinned by sha256)
            ctx = cv.context_for_direct(sess, CONVERSE_DIRECT_CONTEXT_CHARS)
            m["prompt"] = (f"{VOICE_PREFIX}[Earlier in this car conversation (speech-to-text): {ctx}] {transcript}"
                           if ctx else build_prompt(transcript))
            m["prompt_sha256"] = hashlib.sha256(m["prompt"].encode()).hexdigest()
        pend = sess.get("pending") if isinstance(sess.get("pending"), dict) else None
        m["conv"] = {"conv_id": sess["conv_id"], "sid": sess["sid"], "turn": n, "action": action, "path": raw.get("path"),
                     "draft_title": (pend or {}).get("title"), "session_key": sk, "opened": opened, "reply_key": None,
                     "decide_ms": int(took * 1000)}
        if action != "direct":
            m["reply_text"] = final["say"]
            stamp = mc_.parse_iso(m.setdefault("reply_stamp", iso(now_utc())))
            m["conv"]["reply_key"] = reply_key_for(stamp, agent, mid)
            m["agent_done_ts"] = now
        if final["close"]:
            self.close_session(sk, "end")
        card = raw.get("card") or {}
        draft = final["draft"] or sent or final.get("already") or {}
        routed_payload = {
            "conv_id": sess["conv_id"], "sid": sess["sid"], "conv_turn": n, "conv_opened": opened, "action": action,
            "decided_action": dec.get("action"), "say": final["say"][:600] if action != "direct" else None,
            "say_chars": len(final["say"]) if action != "direct" else None,
            "title": draft.get("title"), "brief_id": draft.get("brief_id"), "target": draft.get("target"),
            "perm": draft.get("perm"), "delegate_to": (sent or {}).get("target"), "guard": reasons or None,
            "model_answered": llm.get("model"), "requested_model": llm.get("requested_model"), "route": llm.get("route"),
            "attempts": len(llm.get("attempts") or []), "attempt_log": llm.get("attempts") or None,
            "latency_ms": llm.get("latency_ms"), "usage": llm.get("usage"), "cached_tokens": llm.get("cached_tokens"),
            "path": raw.get("path"), "lexicon": bool(raw.get("lexicon")), "fallback_reason": raw.get("fallback_reason"),
            "card_sha256": card.get("sha256"), "recall": card.get("recall"),
            "card_age_s": round(now - float(card["built_at"]), 1) if card.get("built_at") else None,
            "device": sender.get("device"), "decide_ms": int(took * 1000),
            "reply_s3_key": m["conv"]["reply_key"],
            # the tile's settings: the model alias that decided this turn (null = the default ladder), the voice the reply
            # is spoken in (the tile's own after a switch), and a tool call's outcome
            "tile_model": raw.get("tile_model"), "tile_voice": tile_now.get("voice") or VOICE,
            "served_route": llm.get("served_route"),
            "tool": ({k: tool.get(k) for k in ("tool", "args", "ok", "via", "exit", "ms", "error")} if tool else None)}
        log("converse_decided", memo_id=mid, key=key, agent=agent, conv_id=sess["conv_id"], turn=n, action=action,
            path=raw.get("path"), model=llm.get("model"), route=llm.get("route"), llm_ms=llm.get("latency_ms"),
            cached_tokens=llm.get("cached_tokens"), fallback_reason=raw.get("fallback_reason"),
            say=(final["say"] or "")[:120] or None, delegate_to=(sent or {}).get("target"),
            tile_model=raw.get("tile_model"), tool=(tool or {}).get("tool"), tool_ok=(tool or {}).get("ok"))
        self.done_stage(m, "converse", "dispatch" if action == "direct" else "speak", ms=took * 1000, action=action,
                        path=raw.get("path"), model=llm.get("model"), route=llm.get("route"), conv=sess["sid"], turn=n)
        self.fact_async("routed", m, routed_payload)  # last: nothing after it can fail, and the voice does not wait for it

    def _cancel_sending(self, sess: dict, cs: dict, mid: str, say: str, reasons: list[str]) -> str:
        """Lock held. "Cancel that" while the read-back of a confirmed brief is still being spoken: if the brief has not been
        published the delegation is stopped (the draft is dropped, nothing is ever sent) and the driver is told so; if it has
        left, the driver is told that too. Returns what is spoken."""
        other = self.s.memos.get(cs.get("sent_by_key") or "")
        stopped = False
        if other is not None and not other.get("publish_attempted"):
            d = other.get("delegate")
            fu = live_followup(other)
            if d is not None and d.get("brief_id") == cs.get("brief_id"):
                other.pop("delegate", None)  # still in the read-back: it will finish as a plain spoken line
                stopped = True
            elif fu is not None and fu.get("kind") == "delegation" and fu.get("brief_id") == cs.get("brief_id"):
                self.cancel_memo(other)  # between the read-back and the publish
                stopped = True
        if stopped:
            for x in sess.get("delegations") or []:
                if x.get("brief_id") == cs.get("brief_id") and x.get("state") == "sending":
                    x["state"] = "not_sent"
            cs["state"] = "dropped"
            sess["pending"] = None
            log("converse_delegation_cancelled", memo_id=mid, conv_id=sess["conv_id"], brief_id=cs.get("brief_id"),
                title=cs.get("title"), note="cancelled before it left; never sent")
            return cv.SENDING_CANCELLED_LINE
        reasons.append("cancel_too_late")
        return cv.SENDING_TOO_LATE_LINE.format(target=cs.get("target_name") or cs.get("target"))

    def start_shadow(self, m: dict) -> None:
        """Lock held. MEMO_CONVERSE=shadow: the memo goes down today's path untouched; the desk decides on the side and
        only logs what it would have done (converse_shadow). No fact, no state, no speech."""
        key, mid, agent = m["key"], m["memo_id"], m["agent"]
        transcript, name = m.get("transcript") or "", m.get("display_name") or mc_.spoken_name(agent)
        sender0, audio_s = m.get("sender"), m.get("audio_s")

        def work():
            try:
                sender = sender0 if (sender0 or {}).get("ok") else self._sender(key)
                s = self.desk.settings()
                why = self.desk.ineligible({**s, "mode": "on"}, agent, sender, audio_s, transcript, False)
                if why:
                    log("converse_shadow", memo_id=mid, key=key, agent=agent, skipped=why)
                    return
                now = time.time()
                with self.mu:
                    snap = self._conv_snapshot({"agent": agent, "key": key}, sender, now)
                sess = snap["sess"] or cv.new_session(agent, sender.get("device"), now)
                raw = self.desk.decide(s, agent=agent, name=name, transcript=transcript, sess=sess,
                                       card=self._card_for(key, agent), board=snap["board"], recent=snap["recent"], now=now)
                final, reasons = cv.guard(raw["decision"], sess, transcript, tile=agent, tile_name=name,
                                          handoff=s["handoff"], route_fn=mc_.registry_route, names_fn=self.desk.cards,
                                          now=now, draft_ttl_s=self.desk.draft_ttl_s, dedupe_s=self.desk.dedupe_s, memo_id=mid)
                llm = raw.get("llm") or {}
                log("converse_shadow", memo_id=mid, key=key, agent=agent, action=final["action"], path=raw.get("path"),
                    model=llm.get("model"), route=llm.get("route"), llm_ms=llm.get("latency_ms"),
                    fallback_reason=raw.get("fallback_reason"), reasons=reasons or None, say=(final["say"] or "")[:200])
            except Exception as e:  # noqa: BLE001 - shadow never touches the memo
                log("converse_shadow_failed", "warn", memo_id=mid, key=key, error=f"{type(e).__name__}: {e}"[:200])
            finally:
                with self.mu:
                    self.prefetch.pop(key, None)
        threading.Thread(target=work, name="converse-shadow", daemon=True).start()

    def delegation_sent(self, m: dict, fu: dict) -> None:
        """Lock held (_mark_dispatched). The confirmed brief's command is out: the conversation's draft is spent."""
        sess = self._find_session(fu.get("conv_id"))
        if sess is None:
            return
        for d in sess.get("delegations") or []:
            if d.get("brief_id") == fu.get("brief_id") and d.get("state") in ("sending", "not_sent"):
                d.update(state="running", command_id=fu.get("command_id"), dispatched_at=time.time())
        p = sess.get("pending")
        if isinstance(p, dict) and p.get("brief_id") == fu.get("brief_id"):
            p["state"] = "sent"
            sess["pending"] = None
        log("delegation_sent", memo_id=m["memo_id"], key=m["key"], conv_id=fu.get("conv_id"), brief_id=fu.get("brief_id"),
            command_id=fu.get("command_id"), target=fu.get("target"), title=fu.get("title"))

    def delegation_result(self, m: dict, fu: dict) -> None:
        """Lock held (step_mirror). The delegated result was spoken (or its failure was): written back into the
        conversation, so "what did it find?" is a fast turn, not an agent turn."""
        sess = self._find_session(fu.get("conv_id"))
        if sess is None:
            log("delegation_result_unrecorded", "warn", memo_id=m["memo_id"], conv_id=fu.get("conv_id"),
                note="the conversation is gone from state.json (closed ring rotated)")
            return
        result = clean_for_speech(m.get("reply_text") or "", CONVERSE_RESULT_CHARS)
        state = "failed" if fu.get("state") == "failed" else "done"
        for d in sess.get("delegations") or []:
            if d.get("brief_id") == fu.get("brief_id"):
                d.update(state=state, result=result, ended_at=time.time())
        cv.upsert_turn(sess, {"memo_id": f"{m['memo_id']}:result:{fu.get('brief_id')}", "kind": "result", "at": time.time(),
                              "action": "result", "say": result, "title": fu.get("title"), "target": fu.get("target"),
                              "state": state})
        log("delegation_result", memo_id=m["memo_id"], key=m["key"], conv_id=fu.get("conv_id"), brief_id=fu.get("brief_id"),
            state=state, chars=len(result))

    def direct_reply_writeback(self, m: dict) -> None:
        """Lock held (step_mirror). A direct turn's agent reply joins the conversation it was asked in."""
        conv = m.get("conv") or {}
        sess = self._find_session(conv.get("conv_id"))
        for t in (sess or {}).get("turns") or []:
            if t.get("memo_id") == m["memo_id"] and t.get("kind", "driver") == "driver":
                t["agent_reply"] = clean_for_speech(m.get("reply_text") or "", CONVERSE_RESULT_CHARS)

    def restore_draft(self, m: dict, why: str) -> None:
        """Lock held. A confirmed brief that never left (its read-back failed, or the memo was cancelled before the
        publish): the draft goes back to proposed so "send it" works again, and the delegation is marked not_sent."""
        info = m.pop("delegate", None)
        if info is None:
            fu = next((x for x in reversed(m.get("followups") or []) if x.get("kind") == "delegation"), None)
            info = fu
        if not info:
            return False
        sess = self._find_session(info.get("conv_id"))
        if sess is None:
            return False
        for d in sess.get("delegations") or []:
            if d.get("brief_id") == info.get("brief_id") and d.get("state") == "sending":
                d["state"] = "not_sent"
        p = sess.get("pending")
        if isinstance(p, dict) and p.get("brief_id") == info.get("brief_id") and p.get("state") == "sending":
            p["state"], p["restored_at"] = "proposed", time.time()
        log("delegation_restored", "warn", memo_id=m["memo_id"], key=m["key"], conv_id=info.get("conv_id"),
            brief_id=info.get("brief_id"), why=why, note="nothing was sent; the draft is pending again")
        return True

    def _delegation_published(self, m: dict) -> bool:
        """Lock held. May the memo's delegation command have left? Never published: False. Published or unknowable: True."""
        if not m.get("publish_attempted"):
            return False
        try:
            return bool(mc_.journal_row(m.get("command_id")))
        except Exception:  # noqa: BLE001 - cannot tell: leave the memo failed, as for any dispatch
            return True

    def delegation_unsent(self, m: dict, fu: dict, code: str, why: str) -> None:
        """Lock held. A confirmed brief that could not leave: the follow-up fails, the draft is pending again, and the driver
        hears so ("I couldn't send that to X") through the fast reply path, so no 'Sending...' stands uncorrected."""
        fu.update(state="failed", error_code=code, error=why[:300], ended_at=iso(now_utc()))
        self.restore_draft(m, f"the delegation could not be dispatched: {code}")
        name = fu.get("display_name") or fu.get("target") or "that agent"
        for k in self.REPLY_ROUND_KEYS:
            m.pop(k, None)
        self.drop_command(m)
        m["reply_text"] = f"I couldn't send that to {name}, so nothing was sent. Say send it to try again."
        m["agent_done_ts"] = time.time()
        m.update(status="active", stage="speak", next_at=0.0)
        log("delegation_unsent", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], code=code, error=why[:300],
            target=fu.get("target"), brief_id=fu.get("brief_id"), note="nothing was published; the driver is told")
        self.status(m)
        WAKE.set()

    # -- dispatch (worker thread) --

    def _prompt_for_send(self, m: dict) -> str:
        """The exact prompt to dispatch, proven to be the one that was transcribed: its sha256 was recorded with the
        transcript and must still match. A memo with nothing to send is held, never sent empty. A memo whose background
        follow-up is live sends the follow-up's prompt instead, pinned the same way when it was minted."""
        fu = live_followup(m)
        if fu is not None:
            prompt = fu.get("prompt") or ""
            if not prompt or hashlib.sha256(prompt.encode()).hexdigest() != fu.get("prompt_sha256"):
                raise StageError("dispatch", "prompt_changed", f"follow-up {fu.get('n')}'s prompt ({len(prompt)} chars) no "
                                 "longer matches the sha256 recorded when it was minted: held, not sent", retryable=False)
            return prompt
        prompt = m.get("prompt")
        if not prompt:
            if not m.get("transcript"):
                raise StageError("dispatch", "no_transcript", "this memo has no transcript to dispatch (it failed before "
                                 "transcription): `memo:retry` starts it again at receive", retryable=False)
            prompt = m["prompt"] = build_prompt(m["transcript"])
        digest = hashlib.sha256(prompt.encode()).hexdigest()
        if not m.get("prompt_sha256"):
            m["prompt_sha256"] = digest  # a memo transcribed before hashes were recorded: pin what is there now
        elif m["prompt_sha256"] != digest:
            raise StageError("dispatch", "prompt_changed", f"the stored prompt ({len(prompt)} chars) no longer matches the "
                             f"sha256 recorded at transcription ({m['prompt_sha256'][:12]}...): held, not sent", retryable=False)
        return prompt

    def step_dispatch(self, m: dict) -> None:
        with self.mu:
            self._prompt_for_send(m)  # before the lane probe (it sleeps): a memo with nothing to send is held at once
        # Pick the lane once per command id and keep it: the idempotency key, the envelope digest and the
        # journal row all differ by command type, so re-sending one command id on the other subject would be
        # a terminal digest collision. Probed outside the lock (it sleeps between probes).
        if not m.get("lane"):
            if m.get("publish_attempted"):
                m["lane"], m["lane_reason"] = "batch", None  # dispatched before lanes existed
            else:
                m["lane"], m["lane_reason"] = self.choose_lane()
                if m["lane_reason"] and m["lane"] != LANE:
                    log("lane_fallback", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="dispatch",
                        lane=m["lane"], configured=LANE, reason=m["lane_reason"],
                        gateway=mc_.gateway_lanes_text(),
                        note="no puller on the interactive consumer; sending on the batch lane (answer may be late)")
                elif m["lane_reason"]:
                    log("lane_kept", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="dispatch",
                        lane=m["lane"], configured=LANE, reason=m["lane_reason"],
                        gateway=mc_.gateway_lanes_text(),
                        note=((mc_.gateway_state()["detail"] or mc_.GATEWAY_DRAINING_TEXT)
                              + " (queued on the interactive lane, which the gateway fetches first)"
                              if m["lane_reason"] == "gateway_draining_queued_on_interactive"
                              else "no puller on either lane (gateway down or restarting); queued on the interactive "
                                   "lane, which drains first when the gateway reconnects"))
        lane = m["lane"]
        with self.mu:
            if self._cancelled(m):
                # Cancelled while the lane was being probed: this is the last point before the publish where nothing has
                # left the building. (After publish_attempted is set below, a cancel is "after dispatch".)
                log("step_dropped_after_cancel", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="dispatch")
                return
            m.setdefault("command_id", str(uuid.uuid4()))
            cid = m["command_id"]
            # A crash between publish and bookkeeping must not double-dispatch: if the
            # gateway already journaled this command id, it is dispatched.
            if m.get("publish_attempted"):
                try:
                    if mc_.journal_row(cid):
                        log("dispatch_recovered", memo_id=m["memo_id"], key=m["key"], agent=m["agent"],
                            stage="dispatch", command_id=cid, note="journal already has this command")
                        return self._mark_dispatched(m, cid, None, 0)
                except Exception:  # noqa: BLE001
                    pass
            fu = live_followup(m)
            delegation = fu is not None and fu.get("kind") == "delegation"
            # A confirmed brief goes to the agent the driver confirmed (the tile, or one they named aloud); everything
            # else to the memo's own agent, which comes only from the key path.
            target = (fu.get("target") if delegation else None) or m["agent"]
            route = mc_.registry_route(target)
            if route["ok"] is False:
                raise StageError("dispatch", "unknown_agent", route["reason"], retryable=False)
            m["thread_id"] = m["memo_id"]  # unique per memo: the agent session's chat_id (exact reply lookup)
            prompt = self._prompt_for_send(m)
            escalated = memo_escalated(m)
            context = {"memo_id": m["memo_id"], "memo_key": m["key"],
                       "source": "holocene-auto:inbox-watcher", "repo": "holocene", "reason": "voice-inbox"}
            if escalated:
                context["escalated_from_command_id"] = m.get("escalated_from_command_id")
            if delegation:
                # a brief the driver confirmed aloud in the car conversation (the fast desk), sent verbatim
                context.update(reason="voice-delegation", followup_depth=fu.get("n"), conv_id=fu.get("conv_id"),
                               brief_id=fu.get("brief_id"), brief_sha256=fu.get("brief_sha256"),
                               tile_agent_id=m["agent"], perm=fu.get("perm"))
            elif fu is not None:
                # the background half of an answer-then-background reply: same thread, so the agent has the whole talk
                context.update(reason="voice-followup", followup_of=fu.get("of_command_id"), followup_depth=fu.get("n"))
            data = {
                "target_agent_id": target, "prompt": prompt, "thread_id": m["thread_id"],
                "turn_id": None,
                "context": context,
            }
            # The voice turn's model, for this one turn only (see VOICE_MODEL). A delegation runs on the profile's own
            # model unless MEMO_CONVERSE_DELEGATE_MODEL names one (never an Anthropic route).
            model = (fu.get("model") or "") if delegation else FOLLOWUP_MODEL if fu is not None else VOICE_MODEL
            if model:
                data["model"] = model
            m["turn_model"] = model or None
            cmd = [BB_EMIT, "--strict", "--print-ids", "--kind", "command",
                   "--type", mc_.LANE_COMMAND_TYPES[lane],
                   "--source", f"urn:33god:service:{SERVICE}", "--producer", SERVICE, "--service", SERVICE,
                   "--actor-type", "service", "--actor-id", SERVICE,
                   "--correlation", m["memo_id"], "--command-id", cid,
                   "--ordering-key", f"turn:{m['thread_id']}"]
            # An escalation is caused by the command that timed out (its envelope id when known); anything else by the
            # last fact the watcher published for this memo.
            cause = (m.get("escalation_causation") if escalated else None) or m.get("last_fact_id")
            if cause:
                cmd += ["--causation", cause]
            m["publish_attempted"] = True
            self.s.save()
            memo_id, key, agent = m["memo_id"], m["key"], m["agent"]
        live = mc_.gateway_liveness(lane)
        if live.get("draining"):
            log("gateway_draining", "warn", memo_id=memo_id, key=key, agent=agent,
                stage="dispatch", lane=lane, detail=mc_.gateway_liveness_text(live, lane),
                note=(f"{live.get('gateway_label') or 'gateway restarting'}: the command queues in JetStream and runs "
                      "when the gateway takes turns again"))
        elif live.get("ok") is False:
            log("gateway_not_pulling", "warn", memo_id=memo_id, key=key, agent=agent,
                stage="dispatch", lane=lane, detail=mc_.gateway_liveness_text(live, lane),
                note="command will queue in JetStream until the gateway resumes")
        t0 = time.time()
        r = run(cmd, 30, stdin=json.dumps(data))
        ms = (time.time() - t0) * 1000
        if r.returncode != 0:
            raise StageError("dispatch", "bb_emit_failed", f"bb-emit rc={r.returncode}: {r.stderr.strip()[-300:]}")
        try:
            ids = json.loads(r.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            ids = {}
        with self.mu:
            self._mark_dispatched(m, cid, ids, ms, prompt_chars=len(prompt))

    def _mark_dispatched(self, m: dict, cid: str, ids: dict | None, ms: float, prompt_chars: int | None = None) -> None:
        ids = ids or {}
        fu = live_followup(m)
        prompt = (fu or {}).get("prompt") or m.get("prompt") or m.get("transcript", "")
        escalated = memo_escalated(m)
        m["command_envelope_id"] = ids.get("id")
        m["dispatched_ts"] = time.time()
        # An escalated command (or a background follow-up) is a batch turn with no gateway wall clock: the watcher waits
        # for it much longer.
        m["deadline_ts"] = m["dispatched_ts"] + (BATCH_TURN_TIMEOUT_S if long_turn(m) else AGENT_TIMEOUT_S)
        m.pop("dropped_since", None)
        if fu is not None:
            fu.update(state="running", dispatched_at=iso(now_utc()), dispatched_ts=m["dispatched_ts"])
        delegation = fu is not None and fu.get("kind") == "delegation"
        self.fact("dispatched", m, {
            "command_id": cid, "idempotency_key": ids.get("idempotency_key"),
            "command_subject": ids.get("subject") or mc_.LANE_COMMAND_TYPES[memo_lane(m)],
            "lane": memo_lane(m), "lane_reason": m.get("lane_reason"),
            "thread_id": m.get("thread_id"), "prompt_chars": prompt_chars if prompt_chars is not None else len(prompt),
            "prompt_sha256": (fu or {}).get("prompt_sha256") or m.get("prompt_sha256") or hashlib.sha256(prompt.encode()).hexdigest(),
            "voice_prefix": bool(VOICE_PREFIX), "dispatch_ms": int(ms),
            # the model route the command asked the gateway to run this turn on (null: the profile's own)
            "model": m.get("turn_model"),
            **({"escalated_from_command_id": m.get("escalated_from_command_id")} if escalated else {}),
            **({"followup": fu.get("n"), "followup_of_command_id": fu.get("of_command_id"),
                "followup_plan": (fu.get("plan") or "")[:1000]} if fu is not None else {}),
            # a confirmed car-conversation brief: the command went to target_agent_id, asked via the tile's memo
            **({"target_agent_id": fu.get("target") or m["agent"], "tile_agent_id": m["agent"],
                "delegated_to": fu.get("target") or m["agent"], "conv_id": fu.get("conv_id"),
                "brief_id": fu.get("brief_id"), "brief_title": fu.get("title"), "perm": fu.get("perm")}
               if delegation else {})})
        if delegation and not fu.get("delegated_fact"):
            # once per confirmed brief (a recovered dispatch lands here again)
            fu["delegated_fact"] = True
            self.fact_gated("delegated", m, {
                "target_agent_id": fu.get("target") or m["agent"], "tile_agent_id": m["agent"],
                "conv_id": fu.get("conv_id"), "brief_id": fu.get("brief_id"), "brief_sha256": fu.get("brief_sha256"),
                "command_id": cid, "lane": memo_lane(m), "perm": fu.get("perm"), "title": fu.get("title"),
                "prompt_sha256": fu.get("prompt_sha256"), "followup": fu.get("n"), "thread_id": m.get("thread_id")})
            self.delegation_sent(m, fu)
        if self._cancelled(m):
            # The operator cancelled while the publish was in flight: the command is out (the fact above says so), the
            # memo stays cancelled and its reply will not be spoken.
            log("dispatched_after_cancel", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], command_id=cid)
            return
        self.done_stage(m, "dispatched", "await_agent", ms=ms, command_id=cid, target=m["agent"],
                        lane=memo_lane(m))

    # -- waiting for the agent (tick thread: cheap reads) --

    def agent_status(self, m: dict) -> dict:
        """{state: pending|running|done|failed, source, detail, profile}. Correlated by command id / correlationid."""
        cid = m["command_id"]
        out: dict = {"state": "pending", "source": None, "detail": "no execution row yet"}
        try:
            row = mc_.journal_row(cid)
        except Exception as e:  # noqa: BLE001
            row = None
            out["journal_error"] = str(e)[:200]
        if row:
            out["profile"] = row.get("profile")
            st, oc = row["state"], row.get("outcome")
            if st == "completed" and oc == "success":
                mo = next((((e or {}).get("data") or {}).get("model_override") for e in row.get("terminal", [])
                           if isinstance(((e or {}).get("data") or {}).get("model_override"), dict)), None)
                return {**out, "state": "done", "source": "journal", "detail": f"journal completed/success ({row['updated_at']})",
                        **({"model_override": mo} if mo else {})}
            timeout = mc_.turn_timeout_data(row) if st == "completed" else None
            if timeout is not None:
                # The gateway stopped the Hermes turn at its wall clock: a distinct, final outcome.
                return {**out, "state": "failed", "source": "journal", "code": mc_.TURN_TIMEOUT,
                        "detail": mc_.turn_timeout_message(timeout, row.get("lane")), "timeout": timeout}
            if st == "completed":
                return {**out, "state": "failed", "source": "journal", "code": f"agent_{oc}",
                        "detail": mc_.terminal_error(row) or f"journal completed/{oc}"}
            if st.startswith("rejected"):
                return {**out, "state": "failed", "source": "journal", "code": st,
                        "detail": row.get("rejection_reason") or st}
            out.update(state="running", source="journal", detail=f"journal state={st}")
            if row.get("detached_at"):
                # The gateway let the interactive turn run past its wall clock with the slot released: still running.
                out.update(detached=True, detached_at=row["detached_at"],
                           detail=f"journal state={st}, detached at {row['detached_at']} (kept running past the wall clock)")
            # A running row reaches its terminal state in the journal before Candystore hears of it: asking
            # Candystore here only adds a ~0.75 s HTTP call that can land right on top of the completion.
            return out
        # No row (or an unreadable journal): Candystore is the fallback for a turn the journal never recorded. It
        # costs an HTTP round trip, so it is asked at most every SLOW_PROBE_S per memo.
        if time.time() - m.get("cs_checked_ts", 0) < SLOW_PROBE_S:
            return out
        m["cs_checked_ts"] = time.time()
        try:
            for ev in mc_.candystore_events(m["memo_id"]):
                if ev.get("type") not in ("bloodbank.agent.invocation.completed", "bloodbank.agent.invocation.failed"):
                    continue
                d = ev.get("data") or {}
                if d.get("command_id") != cid:
                    continue
                prof = d.get("profile_name") or out.get("profile")
                if ev["type"].endswith(".failed"):
                    code = d.get("error_code") or "invocation_failed"
                    return {**out, "state": "failed", "source": "candystore", "profile": prof, "code": code,
                            "detail": (mc_.turn_timeout_message(d) if code == mc_.TURN_TIMEOUT
                                       else d.get("error_message") or "invocation.failed"),
                            **({"timeout": d} if code == mc_.TURN_TIMEOUT else {})}
                return {**out, "state": "done", "source": "candystore", "profile": prof,
                        "detail": "invocation.completed fact in Candystore"}
        except Exception as e:  # noqa: BLE001
            out["candystore_error"] = str(e)[:200]
        return out

    def cached_liveness(self, m: dict, lane: str) -> dict:
        if time.time() - m.get("live_ts", 0) >= SLOW_PROBE_S or "live" not in m:
            m["live"], m["live_ts"] = mc_.gateway_liveness(lane), time.time()
        return m["live"]

    def can_escalate(self, m: dict, timeout: dict | None = None) -> bool:
        """An interactive turn the gateway stopped may be re-dispatched on the batch lane, once per memo. A batch turn
        that times out (an envelope deadline), a memo that already escalated, and MEMO_BATCH_TURN_TIMEOUT_S=0 (the
        off switch) all fail the memo as a turn timeout, as before. So does a turn the gateway DETACHED at the wall clock
        and later cut off at its detached ceiling: it already ran the whole time a batch turn would, re-running it from
        scratch would only double the wait. (A gateway that cannot detach, or has it off, still stops the turn at the wall
        clock: that is the case the escalation is kept for.)"""
        if (timeout or {}).get("timeout_source") == "detached_ceiling" or (timeout or {}).get("detached") is True:
            return False
        # A stop that says where its budget came from (lane | envelope) and carries no detached flag is THIS attempt's
        # verdict: an earlier attempt of the same command may have detached and been cut off by a restart, and the re-run
        # then stopped at 300 s with max_detached full. That one is escalated like any lane stop (2026-10-22 review).
        stopped_undetached = (timeout or {}).get("timeout_source") in ("lane", "envelope")
        return (BATCH_TURN_TIMEOUT_S > 0 and not m.get("escalated") and memo_lane(m) == "interactive"
                and (stopped_undetached or not detached_now(m)))

    def note_detached(self, m: dict, source: str, at=None, elapsed=None) -> None:
        """The gateway kept this memo's interactive turn running past its wall clock and released the lane slot (instead
        of stopping it, which the watcher would answer with a batch re-run of the same prompt). Once per command: the
        memo is waited for as a long turn (DETACHED_WAIT_S from its dispatch), its reply will be a late one, the car hears
        DETACHED_LINE once and the 30 s progress narration stops."""
        cid = m.get("command_id")
        if not cid or m.get("detached") == cid:
            return
        m["detached"], m["detached_ts"], m["late"] = cid, time.time(), True
        m["deadline_ts"] = max(float(m.get("deadline_ts") or 0), float(m.get("dispatched_ts") or time.time()) + DETACHED_WAIT_S)
        log("memo_detached", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent", command_id=cid,
            source=source, detached_at=str(at) if at else None, elapsed_s=elapsed,
            waited_s=int(time.time() - float(m.get("dispatched_ts") or time.time())), wait_until_s=DETACHED_WAIT_S,
            note="the interactive turn passed the gateway wall clock and keeps running (slot released): no kill, no "
                 "batch re-run; the reply is spoken late")
        self.status(m)
        if DETACHED_LINE and not self._cancelled(m):
            self.narrate_line(m, DETACHED_LINE, "detached")
        self.s.save()

    def unwound(self, m: dict, timeout: dict) -> bool:
        """The gateway reported turn_stopped=false: Hermes did not confirm the timed-out turn stopped, so it may still be
        unwinding on the session a batch turn is about to use. Warn once and give it TURN_UNWIND_WAIT_S; True when that
        has passed (escalate then, as ever), False while waiting."""
        since = m.get("unwind_since")
        if since is None:
            since = m["unwind_since"] = time.time()
            log("turn_not_confirmed_stopped", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                command_id=m.get("command_id"), wait_s=TURN_UNWIND_WAIT_S, elapsed_s=timeout.get("elapsed_seconds"),
                note="the gateway says the timed-out turn may still be unwinding; waiting briefly before escalating to the batch lane")
        if time.time() - since < TURN_UNWIND_WAIT_S:
            m["next_at"] = time.time() + min(AWAIT_POLL_S * 4, max(0.1, TURN_UNWIND_WAIT_S - (time.time() - since)))
            return False
        return True

    def escalate(self, m: dict, st: dict, waited: float) -> None:
        """The interactive turn hit the gateway's wall clock: send the SAME prompt once more on the batch lane.

        The memo is not failed and nothing is said aloud. A fresh command id is persisted BEFORE the publish (step_dispatch
        saves it ahead of bb-emit, and it is saved here too, so a crash cannot mint a second one); the thread id stays the
        memo id, so the Hermes session keeps its context; the prompt is re-checked against its sha256 at send. The
        `dispatched` fact that follows carries lane=batch, lane_reason=turn_timeout_escalated and
        escalated_from_command_id."""
        old = m["command_id"]
        m["escalated"] = True
        m["escalated_from_command_id"] = old
        m["escalation_causation"] = m.get("command_envelope_id") or old  # the timed-out command is the cause
        m["escalated_ts"] = time.time()
        m["command_id"] = str(uuid.uuid4())
        for k in ("publish_attempted", "command_envelope_id", "dropped_since", "last_wait_log", "unwind_since"):
            m.pop(k, None)
        m["lane"], m["lane_reason"] = "batch", ESCALATED_REASON
        self.s.save()
        t = st.get("timeout") or {}
        log("memo_escalated", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
            from_command_id=old, command_id=m["command_id"], from_lane="interactive", lane="batch",
            elapsed_s=t.get("elapsed_seconds"), timeout_s=t.get("timeout_seconds"), detail=st["detail"],
            note="interactive turn hit the gateway wall clock; re-dispatching the same prompt on the batch lane (late reply)")
        self.done_stage(m, "agent", "dispatch", ms=waited * 1000, command_id=old, outcome="turn_timeout_escalated")

    def step_await_agent(self, m: dict) -> None:
        st = self.agent_status(m)
        waited = time.time() - m["dispatched_ts"]
        fu = live_followup(m)
        if st["state"] == "done":
            m["profile"] = st.get("profile") or m["agent"]
            m["agent_seconds"] = round(waited, 2)
            m["agent_done_ts"] = time.time()
            # what the gateway did with data.model: {requested, applied, reason} (absent from a gateway without it)
            m["model_override"] = st.get("model_override")
            if memo_escalated(m) or detached_now(m) or fu is not None:
                # the answer to a long ask comes back on the batch lane, from a detached turn or as the follow-up of a
                # quick answer: it is spoken as a late reply
                m["late"] = True
            if fu is not None:
                fu["agent_done_at"] = iso(now_utc())
            return self.done_stage(m, "agent", "reply", ms=waited * 1000, command_id=m["command_id"],
                                   source=st["source"], profile=m["profile"])
        if st["state"] == "failed":
            if fu is not None:
                # The quick answer was already spoken and promised more: say the background half did not make it.
                return self.followup_failed(m, fu, st.get("code") or "agent_failed", st["detail"], waited)
            if st.get("code") == mc_.TURN_TIMEOUT:
                if self.can_escalate(m, st.get("timeout")):
                    t = st.get("timeout") or {}
                    if t.get("turn_stopped") is False and not self.unwound(m, t):
                        return  # waiting a moment for the stopped-unconfirmed turn to unwind before the batch turn starts
                    return self.escalate(m, st, waited)
                # Not "agent failed": the agent was still working when the gateway ran out its per-turn
                # wall clock and stopped it. Reported on the agent_reply stage (no reply will ever arrive).
                t = st.get("timeout") or {}
                extra = {k: t[k] for k in ("lane", "elapsed_seconds", "timeout_seconds", "timeout_source", "turn_stopped")
                         if t.get(k) is not None}
                if detached_now(m):
                    extra["detached"] = True
                raise StageError("agent_reply", mc_.TURN_TIMEOUT, st["detail"], retryable=False, extra=extra)
            raise StageError("agent", st.get("code", "agent_failed"), f"{st['detail']} (via {st['source']})", retryable=False)
        if st.get("detached"):
            self.note_detached(m, "journal", at=st.get("detached_at"))

        lane = memo_lane(m)
        live = None
        if st["state"] == "pending" and "journal_error" not in st:
            # The gateway consumed the command but wrote no execution row and the consumer is empty:
            # it was terminally rejected (unroutable target, bad envelope). Its only trace is a gateway
            # WARNING, so go and fetch it instead of waiting out the deadline. (Cached per memo: a NATS monitor
            # request every 0.5 s would hold the tick lock for nothing.)
            live = self.cached_liveness(m, lane)
            empty = live.get("ok") is not None and not live.get("error") and not (live.get("num_pending") or 0) \
                and not (live.get("num_ack_pending") or 0)
            if empty and waited >= 20:
                since = m.setdefault("dropped_since", time.time())
                if time.time() - since >= 15:
                    why = mc_.gateway_log_lines([m["command_id"], m["agent"]])
                    if fu is not None:
                        return self.followup_failed(m, fu, "gateway_terminated", "the gateway dropped the follow-up command "
                                                    f"without running it; gateway log: {why[-1] if why else 'nothing'}", waited)
                    raise StageError("agent", "gateway_terminated",
                                     f"gateway consumed command {m['command_id']} without a journal row and the consumer is empty "
                                     f"({lane} consumer pending=0 ack_pending=0): it was rejected before starting, or abandoned after exhausting its redeliveries (max_deliver). "
                                     f"gateway log: {why[-1] if why else 'no matching line in ' + mc_.GATEWAY_UNIT}",
                                     retryable=False)
            else:
                m.pop("dropped_since", None)

        if time.time() >= m["deadline_ts"]:
            # An escalated batch turn (or a follow-up) already has its long deadline: it is not stretched further.
            if waited < QUEUE_MAX_WAIT_S and not long_turn(m):
                live = live or mc_.gateway_liveness(lane)
                ahead = (live.get("num_pending") or 0) + (live.get("num_ack_pending") or 0)
                # A draining gateway pulls nothing for up to 30 min (restart_after_turn_timeout) and then runs the
                # queued command first: that is a queue, not an outage.
                if st["state"] == "running" or (st["state"] == "pending" and (live.get("draining")
                                                                              or (live.get("ok") and ahead > 0))):
                    m["deadline_ts"] = min(time.time() + AGENT_TIMEOUT_S, m["dispatched_ts"] + QUEUE_MAX_WAIT_S)
                    log("deadline_extended", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                        command_id=m["command_id"], waited_s=int(waited), state=st["state"], detail=st["detail"],
                        lane=lane, gateway=mc_.gateway_liveness_text(live, lane),
                        note="command is still queued or running; extending instead of failing")
                    m["next_at"] = time.time() + AWAIT_POLL_S
                    return
            live_text = mc_.gateway_liveness_text(live, lane) if live else mc_.gateway_liveness_text(lane=lane)
            if fu is not None:
                return self.followup_failed(m, fu, "timeout", f"no completed turn after {int(waited)}s ({st['detail']}); "
                                            f"gateway: {live_text}", waited)
            raise StageError("agent_reply", "timeout",
                             f"no completed turn after {int(waited)}s for command {m['command_id']} "
                             f"({st['detail']}); gateway: {live_text}", retryable=False)
        if time.time() - m.get("last_wait_log", 0) >= WAIT_LOG_EVERY_S:
            m["last_wait_log"] = time.time()
            extra = {}
            if st["state"] == "pending":
                extra["gateway"] = mc_.gateway_liveness_text(live, lane) if live else mc_.gateway_liveness_text(lane=lane)
                extra["lane"] = lane
            log("agent_waiting", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                command_id=m["command_id"], waited_s=int(waited), left_s=int(m["deadline_ts"] - time.time()),
                detail=st["detail"], **extra)
        m["next_at"] = time.time() + AWAIT_POLL_S

    def step_reply(self, m: dict) -> None:
        t0 = time.time()
        fu = live_followup(m)
        found = mc_.find_reply(m.get("profile") or m["agent"], m["thread_id"],
                               prompt_sha256=(fu or {}).get("prompt_sha256") or m.get("prompt_sha256"),
                               since=m.get("dispatched_ts"))
        if not found or not found.get("text"):
            raise StageError("agent_reply", "no_reply_text",
                             f"turn completed but no assistant text in {m.get('profile')} session chat_id={m['thread_id']}"
                             f" ({'no session' if not found else 'session ' + found['session_id'] + ' has no assistant text'})")
        ts = found.get("timestamp")
        pts = found.get("prompt_ts")
        stale = isinstance(ts, (int, float)) and (
            (long_turn(m) and ts < m.get("dispatched_ts", 0) - REPLY_FRESH_SLACK_S)
            # a follow-up's prompt row is proven by its sha256: an answer older than it is the quick answer
            or (fu is not None and isinstance(pts, (int, float)) and ts < pts))
        if stale:
            # The escalated turn shares the stopped turn's thread id, so a batch turn that wrote no text leaves the
            # stopped turn's partial output as the newest assistant message. That is not an answer: never speak it.
            # (A follow-up that wrote nothing would likewise find the quick answer, already spoken.)
            if fu is not None:
                return self.followup_failed(m, fu, "no_reply_text", "the background turn completed but wrote no answer",
                                            time.time() - m.get("dispatched_ts", time.time()))
            raise StageError("agent_reply", "no_reply_text",
                             f"the batch turn completed but wrote no assistant text: the newest one in {m.get('profile')} session "
                             f"chat_id={m['thread_id']} predates the escalated command (the stopped turn's partial output)")
        # Answer-then-background: a BACKGROUND: line ends what is spoken now; what follows it is the follow-up's plan.
        answer, plan = split_background(found["text"])
        if plan is not None or answer != found["text"]:
            depth = len(m.get("followups") or [])
            # a delegated brief never hands off again (its target is not the tile; FOLLOWUP_MAX does not apply to it)
            delegated = any(isinstance(x, dict) and x.get("kind") == "delegation" for x in m.get("followups") or [])
            allowed = plan is not None and depth < FOLLOWUP_MAX and not delegated
            log("background_requested" if allowed else "background_refused", "info" if allowed else "warn",
                memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent", command_id=m.get("command_id"),
                followups=depth, max=FOLLOWUP_MAX, plan_chars=len(plan or ""), plan=(plan or "")[:160],
                note=("the quick answer is spoken first, then the plan runs as a background turn on the same thread"
                      if allowed else "the BACKGROUND: line is not spoken and no follow-up is sent"
                      + (" (no instructions after it)" if plan is None else f" (MEMO_FOLLOWUP_MAX={FOLLOWUP_MAX} reached)")))
            if allowed:
                m["background_plan"] = plan
            if not answer.strip():
                if not allowed and fu is not None:
                    # A follow-up that only tried to hand off again: it did not do the work it owes the driver.
                    return self.followup_failed(m, fu, "handoff_refused", "the background turn wrote only a BACKGROUND: "
                                                f"line (MEMO_FOLLOWUP_MAX={FOLLOWUP_MAX} reached) and no answer",
                                                time.time() - m.get("dispatched_ts", time.time()))
                answer = FOLLOWUP_ACK if allowed else NO_HANDOFF_LINE
        m["reply_text"] = answer  # kept whole: compact() trims it to a preview once the memo is done
        m["session_id"] = found["session_id"]
        # Prove the agent was given exactly what we sent.
        sent = ((fu or {}).get("prompt") or m.get("prompt") or m.get("transcript") or "").strip()
        got = (found.get("prompt") or "").strip()
        m["prompt_match"] = (got == sent) if got else None
        if m["prompt_match"] is False:
            log("prompt_mismatch", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                sent_chars=len(sent), agent_saw_chars=len(got), sent=sent[:80], agent_saw=got[:80])
        self.done_stage(m, "reply_text", "speak", ms=(time.time() - t0) * 1000, chars=len(found["text"]),
                        session=found["session_id"], preview=found["text"][:120], prompt_match=m["prompt_match"],
                        background=bool(m.get("background_plan")))

    # -- speak (worker thread) --

    def retract_reply(self, m: dict, rkey: str, ekey: str | None) -> None:
        """A memo:cancel landed while the reply was uploading: take back what just went up (the car's replies/ object, the
        Earshot audio and its text), best effort and logged, so the pad and the phone do not speak a cancelled reply. A
        removed Earshot object is forgotten, so a later `memo:retry` drops a fresh one; one that could not be removed stays
        recorded and is not dropped again."""
        targets = [("reply", mc_.s3_url(rkey), None)] if rkey else []
        # the chunks the car may already be speaking from (replies/...-cNNofMM.opus)
        for ckey in (m.get("voiced_keys") or {}).values():
            targets.append(("reply_chunk", mc_.s3_url(ckey), None))
        if ekey:
            targets.append(("earshot_audio", f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{ekey}", "earshot_key"))
        tkey = m.get("earshot_text_key")
        if tkey:
            targets.append(("earshot_text", f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{tkey}", "earshot_text_key"))
        for what, url, field in targets:
            try:
                r = mc_.mc("rm", "--quiet", url, timeout=30)
                ok, err = r.returncode == 0, r.stderr.strip()[-200:]
            except Exception as e:  # noqa: BLE001 - best effort
                ok, err = False, str(e)[:200]
            log("reply_retracted" if ok else "reply_retract_failed", "info" if ok else "warn", memo_id=m["memo_id"], key=m["key"],
                agent=m["agent"], what=what, object=url, **({} if ok else {"error": err}))
            if ok and field:
                m.pop(field, None)
                if field == "earshot_key":
                    m.pop("earshot_attempted", None)
        m.pop("voiced_keys", None)
        m.pop("reply_up", None)
        self.s.save()

    def _tile_voice(self, agent: str | None, key: str | None, default: str, m: dict | None = None) -> str:
        """The tile's own car voice for this memo's reply, else `default`. Car only: the tile voice is a car setting, so a
        memo the car did not send (a browser memo, or one whose sender cannot be read) keeps the default. The sender is
        read (S3 metadata, once, kept on the memo) only when the tile has a voice of its own."""
        try:
            v = self.desk.voice_for(agent, default)
        except Exception:  # noqa: BLE001 - a broken flag file never stops a reply: the default voice
            return default
        if v == default:
            return v
        with self.mu:
            mm = m if m is not None else self.s.memos.get(key or "")
            sender = (mm or {}).get("sender")
        if not (isinstance(sender, dict) and sender.get("ok")) and key:
            try:
                sender = mc_.s3_sender(key)
            except Exception:  # noqa: BLE001
                sender = {"ok": False}
            if sender.get("ok") and mm is not None:
                with self.mu:
                    if not (mm.get("sender") or {}).get("ok"):
                        mm["sender"] = sender
        if not isinstance(sender, dict) or sender.get("host") != "car":
            log("tile_voice_not_car", key=key, agent=agent, tile_voice=v, used=default,
                host=(sender or {}).get("host") if isinstance(sender, dict) else None,
                note="the tile's voice is a car setting: this memo did not come from the car")
            return default
        return v

    def _reply_voice(self, m: dict) -> str:
        """The voice of this reply, locked at its first render: the tile's own car voice (converse.json `tiles`: memo:voice,
        the car-set-voice skill, "use walken voice") for a memo the car sent, else MEMO_VOX_VOICE. The chunks, the full
        file and every retry of one reply keep it; the memo's next reply round (a follow-up: a new reply_stamp) locks
        again."""
        with self.mu:
            stamp = m.get("reply_stamp")
            vl = m.get("voice_lock")
            if isinstance(vl, dict) and vl.get("stamp") == stamp and vl.get("voice"):
                return vl["voice"]
        v = self._tile_voice(m.get("agent"), m.get("key"), VOICE, m)
        with self.mu:
            vl = m.get("voice_lock")
            if isinstance(vl, dict) and vl.get("stamp") == stamp and vl.get("voice"):
                return vl["voice"]  # another render of this reply locked it first
            m["voice_lock"] = {"stamp": stamp, "voice": v, "requested": v, "fallback": None}
            return v

    def _synth(self, m: dict, text: str, tmp: Path, steps: int | None = None, prio: int | None = None) -> tuple[Path, str]:
        """synthesize() in this reply's locked voice. A voice vox does not know (removed or mistyped) falls back to the
        default voice at once and stays on it for the rest of the reply (voice_lock.fallback), instead of retrying the
        stage for 30 minutes."""
        v = self._reply_voice(m)
        banked = self.phrases.get(text, v, steps)
        if banked is not None:
            out = tmp / "reply.ogg"
            try:
                shutil.copyfile(banked, out)
                self.phrases.hits += 1
                log("phrasebank_hit", memo_id=m.get("memo_id"), voice=v, chars=len(text))
                return out, "phrasebank"
            except OSError:
                pass
        try:
            audio, engine = synthesize(text, tmp, **synth_kw(steps, prio, v))
            self.phrases.put(text, v, steps, audio, engine)
            return audio, engine
        except VoiceNotFound as e:
            if v == VOICE:
                raise
            with self.mu:
                vl = m.setdefault("voice_lock", {"stamp": m.get("reply_stamp"), "requested": v})
                vl.update(voice=VOICE, fallback="voice_not_found")
                log("voice_fallback", "warn", memo_id=m.get("memo_id"), key=m.get("key"), agent=m.get("agent"),
                    requested=v, used=VOICE, error=str(e)[:200], note="vox does not know the tile's voice: the default voice")
            audio, engine = synthesize(text, tmp, **synth_kw(steps, prio, VOICE))
            self.phrases.put(text, VOICE, steps, audio, engine)
            return audio, engine

    def warm_phrases(self) -> None:
        """Start-up, own thread: the fixed lines in the default voice and the tiles' own voices, at the fast desk's steps."""
        if not self.phrases.enabled:
            return
        voices = [VOICE]
        try:
            for t in (self.desk.settings().get("tiles") or {}).values():
                v = t.get("voice") if isinstance(t, dict) else None
                if isinstance(v, str) and v and v not in voices:
                    voices.append(v)
        except Exception:  # noqa: BLE001
            pass

        def render(text: str, voice: str) -> Path:
            d = Path(tempfile.mkdtemp(prefix="memo-phrase-"))
            try:
                audio, engine = synthesize(text, d, **synth_kw(CONVERSE_TTS_STEPS, TtsGate.NARRATION, voice))
                if engine not in PHRASEBANK_ENGINES:
                    raise RuntimeError(f"served by {engine}, not banked")
                keep = d.with_name(d.name + ".ogg")
                shutil.copyfile(audio, keep)
                return keep
            finally:
                shutil.rmtree(d, ignore_errors=True)

        def work():
            t0 = time.time()
            made = 0
            for v in voices:
                made += self.phrases.warm([v], CONVERSE_TTS_STEPS, lambda t, vv: render(t, vv))
            log("phrasebank_warmed", rendered=made, voices=voices, lines=len(self.phrases.lines()), ms=int((time.time() - t0) * 1000))
        threading.Thread(target=work, name="phrasebank-warm", daemon=True).start()

    def _voice_used(self, m: dict) -> tuple[str, str | None]:
        """(the voice this reply was rendered in, the tile's voice it fell back from or None)."""
        with self.mu:
            vl = m.get("voice_lock") if isinstance(m.get("voice_lock"), dict) else {}
        used = vl.get("voice") or VOICE
        return used, (vl.get("requested") if vl.get("fallback") else None)

    def _voice_fields(self, m: dict) -> dict:
        """The voice facts carry: the one the reply was rendered in, and the tile's voice when it fell back from it."""
        used, fell = self._voice_used(m)
        return {"voice": used, **({"voice_requested": fell, "voice_fallback": "voice_not_found"} if fell else {})}

    def step_speak(self, m: dict) -> None:
        """Render the reply and put the car's copy up (replies/...). The phone decision and the replied fact are the next
        stage (step_mirror), on a worker of their own: a reply that waits for a car does not hold up the next voice."""
        with self.mu:
            if m.get("reply_up"):
                # An earlier attempt got the car's copy up and only the phone decision failed (or the service restarted
                # between the two): nothing to render again.
                self.done_stage(m, "tts", "mirror", ms=0, reply_key=m["reply_up"].get("rkey"), resumed=True)
                return
            reply_text, agent, mid, key = m["reply_text"], m["agent"], m["memo_id"], m["key"]
            late = bool(m.get("late"))
            escalated = memo_escalated(m)
            fu_live = live_followup(m)
            followup = fu_live is not None
            delegation = (fu_live or {}).get("kind") == "delegation"
            conv = m.get("conv") if isinstance(m.get("conv"), dict) else {}
            fast = fast_turn(m) and not followup
            name = m.get("display_name") or mc_.spoken_name(agent)
            # One reply key per memo: a retry after a half-finished upload overwrites instead of
            # leaving a second object that the pad would play as a second reply.
            stamp = mc_.parse_iso(m.setdefault("reply_stamp", iso(now_utc())))
        t_speak = time.time()
        body = spoken_summary(reply_text, SPEAK_CHARS) if followup else clean_for_speech(reply_text, SPEAK_CHARS)
        if not body:
            raise StageError("tts", "nothing_to_speak", "reply has no speakable text after cleaning", retryable=False)
        if delegation:
            # a confirmed brief's result, possibly from another agent than the tile: named, with what it was about
            spoken = f"{fu_live.get('display_name') or name}, follow-up on {fu_live.get('title') or 'your request'}. {body}"
        elif followup:
            spoken = f"{name}, follow-up. {body}"
        elif fast:
            # the desk names the agent on the conversation's first turn only; a read-back names its target itself, and a
            # setting switch names the tile in its own line
            first = conv.get("turn") == 1 and conv.get("action") not in ("propose", "confirm", "tool")
            spoken = f"{name}. {body}" if first else body
        else:
            spoken = f"{name}, late reply. {body}" if late else f"{name}. {body}"
        # a fast turn starts speaking sooner: a short first chunk, rendered at fewer vox steps, ahead of other renders
        parts = split_for_speech(spoken, CONVERSE_CHUNK_CHARS, CONVERSE_CHUNK_MIN_CHARS) if fast else split_for_speech(spoken)
        steps = CONVERSE_TTS_STEPS if fast else None
        prio = TtsGate.FAST if fast else TtsGate.REPLY
        tmp = Path(tempfile.mkdtemp(prefix="memo-tts-"))
        try:
            t0 = time.time()
            if len(parts) > 1:
                # The car hears the first sentence while the rest renders; the full file below is joined from the chunks.
                voiced = self._voice_chunks(m, parts, stamp, tmp, t_speak, steps=steps, prio=prio)
                if voiced is None:
                    with self.mu:
                        log("step_dropped_after_cancel", "warn", memo_id=mid, key=key, agent=agent, stage="speak",
                            note="cancelled while the reply was being voiced chunk by chunk; the chunks are taken back")
                        self.retract_reply(m, None, None)
                    return
                audio, engine = voiced
            else:
                audio, engine = self._synth(m, spoken, tmp, steps, prio)
            tts_s = time.time() - t0
            log("stage_done", memo_id=mid, key=key, agent=agent, stage="tts",
                ms=int(tts_s * 1000), engine=engine, bytes=audio.stat().st_size, spoken_chars=len(spoken),
                chunks=len(parts))
            with self.mu:
                if self._cancelled(m):
                    # Cancelled while the voice was being made: nothing has been uploaded yet, so nothing is spoken.
                    log("step_dropped_after_cancel", "warn", memo_id=mid, key=key, agent=agent, stage="speak",
                        note="the reply is neither spoken nor mirrored")
                    if m.get("voiced_keys"):
                        self.retract_reply(m, None, None)
                    return
            rkey = reply_key_for(stamp, agent, mid)
            t1 = time.time()
            r = mc_.mc("cp", "--quiet", str(audio), mc_.s3_url(rkey), timeout=60)
            if r.returncode != 0:
                raise StageError("reply_upload", "mc_cp_failed", f"mc cp rc={r.returncode}: {r.stderr.strip()[-300:]}")
            stat = mc_.s3_stat(rkey)
            if not stat:
                raise StageError("reply_upload", "not_visible", f"uploaded {rkey} but mc stat cannot see it")
            journey = time.time() - m.get("received_ts", m.get("detected_ts", time.time()))
            t_up = time.time()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with self.mu:
            if self._cancelled(m):
                # The cancel landed while the uploads were running: the memo stays cancelled and says nothing more.
                log("speak_cancelled", "warn", memo_id=mid, key=key, agent=agent, reply_key=rkey, earshot_key=None,
                    note="cancelled while the reply was uploading; no replied fact")
                self.retract_reply(m, rkey, None)
                return
            m["reply_key"] = rkey
            if fast and journey > CONVERSE_SLOW_S:
                # a fast turn that took longer than the budget allows: where the time went, for the operator
                log("converse_slow", "warn", memo_id=mid, key=key, agent=agent, journey_s=round(journey, 1),
                    tts_s=round(tts_s, 1), upload_s=round(t_up - t1, 1), chunks=len(parts),
                    decide_ms=(m.get("conv") or {}).get("decide_ms"), path=(m.get("conv") or {}).get("path"),
                    action=(m.get("conv") or {}).get("action"),
                    note="record stop to the reply being up took more than MEMO_CONVERSE_SLOW_S")
            # Everything the phone decision and the replied fact need, persisted with the stage: the decision survives a
            # restart (it resumes from `up_ts`, the moment the car could start), and its audio is fetched back from the
            # car's copy only if the phone is to get one.
            m["reply_up"] = {
                "rkey": rkey, "up_at": iso(now_utc()), "up_ts": (m.get("voiced_first_ts") if len(parts) > 1 else None) or t_up,
                "uploaded_ts": t_up, "audio_bytes": stat["size"], "tts_seconds": round(tts_s, 2), "tts_engine": engine,
                "spoken_chars": len(spoken), "chunks": len(parts), "journey_seconds": round(journey, 2), "t_speak": t_speak,
                "late": late, "escalated": escalated,
                "followup": (live_followup(m) or {}).get("n"), "background": bool(m.get("background_plan")),
                "detached": detached_now(m)}
            if len(parts) == 1 and m.get("voiced_one") != rkey:
                # A reply spoken as one file is "voiced" too, chunk 1 of 1 (its own file): the replied fact waits for the
                # phone-or-car decision, so this is how /voice and memo:trace know from when the car could speak it.
                # Announced once per reply file (its key): a re-speak under a new stamp is announced again, a memo:retry
                # of a finished memo under the same key is not.
                m["voiced_one"] = rkey
                done_ts = m.get("agent_done_ts")
                self.fact_fast("voiced", m, {
                    "reply_s3_key": rkey, "chunk_s3_key": rkey, "chunk": 1, "chunks": 1, "spoken_text": spoken,
                    "spoken_chars": len(spoken), "command_id": m.get("command_id"), "tts_seconds": round(tts_s, 2),
                    "tts_engine": engine, **self._voice_fields(m), "audio_bytes": stat["size"],
                    "since_reply_seconds": round(t_up - t_speak, 2),
                    "since_agent_done_seconds": round(t_up - done_ts, 2) if done_ts else None, "late": late,
                    "followup": (live_followup(m) or {}).get("n")})
            self.done_stage(m, "tts", "mirror", ms=(t_up - t1) * 1000, reply_key=rkey, journey_s=round(journey, 1))

    def step_mirror(self, m: dict) -> None:
        """Who speaks the reply, the car or the phone (the Earshot copy), then the replied fact. Resumable: a restart
        mid-decision re-enters here with the same `reply_up`, and the decision picks up where the clock says it is."""
        with self.mu:
            up = m.get("reply_up")
            agent, mid, key = m["agent"], m["memo_id"], m["key"]
            if not up:
                log("mirror_without_reply", "warn", memo_id=mid, key=key, agent=agent,
                    note="no car copy recorded for this reply: rendering it again")
                m["stage"], m["next_at"] = "speak", 0.0
                self.s.save()
                WAKE.set()
                return
            stamp = mc_.parse_iso(m.setdefault("reply_stamp", iso(now_utc())))
            # decided again on every attempt: the car may be gone by a retry
            m.pop("earshot_skipped", None)
            m.pop("earshot_reason", None)
            rkey, late, escalated = up["rkey"], up["late"], up["escalated"]
        tmp = Path(tempfile.mkdtemp(prefix="memo-mirror-"))
        try:
            def car_copy() -> Path:
                out = tmp / "reply.ogg"
                r = mc_.mc("cp", "--quiet", mc_.s3_url(rkey), str(out), timeout=60)
                if r.returncode != 0 or not out.exists():
                    raise RuntimeError(f"mc cp of the car's copy rc={r.returncode}: {r.stderr.strip()[-200:]}")
                return out
            ekey = self._phone_copy(m, car_copy, stamp, rkey, chunked=up["chunks"] > 1, t_up=up["up_ts"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with self.mu:
            if self._cancelled(m):
                # The cancel landed while the uploads were running: the memo stays cancelled and says nothing more.
                log("speak_cancelled", "warn", memo_id=mid, key=key, agent=agent, reply_key=rkey, earshot_key=ekey,
                    note="cancelled while the reply was uploading; no replied fact")
                self.retract_reply(m, rkey, ekey)
                return
            parts_n = up["chunks"]
            self.fact("replied", m, {
                "reply_s3_key": rkey, "reply_text": m["reply_text"], "reply_chars": len(m["reply_text"]),
                "spoken_chars": up["spoken_chars"], "command_id": m.get("command_id"), "profile": m.get("profile"),
                "session_id": m.get("session_id"), "agent_seconds": m.get("agent_seconds"),
                "tts_seconds": up["tts_seconds"], "tts_engine": up["tts_engine"], **self._voice_fields(m),
                "audio_bytes": up["audio_bytes"], "journey_seconds": up["journey_seconds"],
                "prompt_match": m.get("prompt_match"), "late": late, "escalated": escalated,
                "earshot_key": ekey, "earshot_text_key": m.get("earshot_text_key"),
                # why the phone copy was left out: car_spoke (the car that sent the memo started or finished it) |
                # car_holds (it still held it, live, after MEMO_EARSHOT_HOLD_MAX_S) | no_answer (the upload proxy could
                # not be asked for MEMO_EARSHOT_HOLD_MAX_S: left to the car) | car_released (the phone took it, its
                # Earshot drop failed on every try, and the take was given back so the car may play it); null when mirrored
                "earshot_skipped": m.get("earshot_skipped"),
                # why it went the way it did (phone_copy_decision): car_started | car_holds | claim_failed (left out) or
                # no_car_claim | car_let_go | browser_sender | skip_off (mirrored) | drop_failed (released)
                "earshot_reason": m.get("earshot_reason"),
                # the car's copy was up at reply_up_at; this fact waits for the phone decision (a car that holds it)
                "reply_up_at": up["up_at"], "earshot_wait_seconds": round(time.time() - up["uploaded_ts"], 2),
                # chunked speech: how many chunks the car could start from, and when the first and the last went up
                # (seconds after the reply text was found); null for a reply spoken as one file
                "reply_chunks": parts_n if parts_n > 1 else None,
                "first_chunk_seconds": m.get("voiced_first_s") if parts_n > 1 else None,
                "last_chunk_seconds": m.get("voiced_last_s") if parts_n > 1 else None,
                "full_seconds": round(time.time() - up["t_speak"], 2),
                # answer-then-background: background=true on a quick answer whose BACKGROUND: plan runs next as a
                # follow-up turn (its plan below); followup=N on the reply of follow-up N (followup_failed: it did not
                # finish, and this says so); detached: the interactive turn ran past the gateway's wall clock
                "background": bool(m.get("background_plan")),
                "background_plan": (m.get("background_plan") or "")[:1000] or None,
                "followup": up.get("followup"), "followup_failed": bool(m.get("followup_failed")) or None,
                "followup_of_command_id": (live_followup(m) or {}).get("of_command_id"),
                "detached": bool(up.get("detached")), "model": m.get("turn_model"),
                "model_override": m.get("model_override"),
                # the fast desk's turn this reply belongs to (only on a memo the desk decided)
                **({"conv": {k: m["conv"].get(k) for k in ("conv_id", "sid", "turn", "action", "path")}}
                   if isinstance(m.get("conv"), dict) else {})})
            fu = live_followup(m)
            if fu is not None:
                fu.update(state="failed" if m.get("followup_failed") else "spoken", reply_key=rkey, ended_at=iso(now_utc()))
                m.pop("followup_failed", None)
                if fu.get("kind") == "delegation":
                    self.delegation_result(m, fu)
            elif isinstance(m.get("conv"), dict) and m["conv"].get("action") == "direct":
                self.direct_reply_writeback(m)
            if m.get("delegate"):
                # The read-back ("Sending to <agent>: <title>.") is out: the confirmed brief goes now, once, as a batch
                # follow-up of this memo (FOLLOWUP_MAX does not apply: the driver asked for it aloud).
                self.done_stage(m, "replied", "dispatch", ms=(time.time() - up["uploaded_ts"]) * 1000, reply_key=rkey,
                                journey_s=round(up["journey_seconds"], 1), delegation=True)
                self.start_followup(m, kind="delegation")
                return
            if m.get("background_plan") and FOLLOWUP_MAX > 0:
                # The quick answer is out: the background half starts now, on the same thread, as its own command.
                self.done_stage(m, "replied", "dispatch", ms=(time.time() - up["uploaded_ts"]) * 1000, reply_key=rkey,
                                journey_s=round(up["journey_seconds"], 1), background=True)
                self.start_followup(m)
                return
            m["status"] = "done"
            compact(m)
            self.done_stage(m, "replied", "done", ms=(time.time() - up["uploaded_ts"]) * 1000, reply_key=rkey,
                            journey_s=round(up["journey_seconds"], 1))

    # -- answer-then-background: the follow-up turn --

    # What a reply round leaves on the memo; a follow-up's round starts without it (its reply is a new replies/ object).
    REPLY_ROUND_KEYS = ("reply_text", "reply_key", "reply_up", "reply_stamp", "reply_chunks", "voiced_keys", "voiced_n",
                        "voiced_first_ts", "voiced_first_s", "voiced_last_s", "earshot_key", "earshot_text_key",
                        "earshot_attempted", "earshot_skipped", "earshot_reason", "prompt_match", "agent_seconds",
                        "agent_done_ts", "progress_cmd", "progress_seq", "progress_text", "progress_ts", "progress_full",
                        "model_override", "voice_lock")

    def start_followup(self, m: dict, kind: str = "background") -> None:
        """Under the lock, right after the quick answer's replied fact: mint follow-up N for the memo's BACKGROUND: plan and
        send it through dispatch like any command. Same thread id (the Hermes session holds the whole conversation), a
        fresh command id persisted before the publish, its own prompt pinned by sha256, the FOLLOWUP_LANE (batch: no wall
        clock), and a long deadline. Its reply is spoken as "<agent>, follow-up." into a new replies/ object for the same
        memo, which the car plays after the quick answer (the pad plays every reply unit of a memo it sent).

        kind="delegation": the brief the driver confirmed in the car conversation (m["delegate"], set by the fast desk).
        Its prompt is the stored brief verbatim (pinned by sha256), its command id is uuid5(brief id), it goes to the
        confirmed target on MEMO_CONVERSE_DELEGATE_LANE, and its result is spoken as "<target>, follow-up on <title>."."""
        fus = m.setdefault("followups", [])
        n = len(fus) + 1
        if kind == "delegation":
            d = m.pop("delegate")
            prompt, cid, lane, reason = d["prompt"], d["command_id"], CONVERSE_DELEGATE_LANE, DELEGATION_REASON
            plan = d.get("title") or ""
            fus.append({"n": n, "kind": "delegation", "command_id": cid, "of_command_id": m.get("command_id"),
                        "state": "dispatching", "plan": plan, "prompt": prompt,
                        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "started_at": iso(now_utc()),
                        "started_ts": time.time(), "lane": lane, "target": d["target"], "display_name": d.get("target_name"),
                        "title": d.get("title"), "brief_id": d["brief_id"], "brief_sha256": d["brief_sha256"],
                        "conv_id": d.get("conv_id"), "perm": d.get("perm"), "model": CONVERSE_DELEGATE_MODEL or None})
        else:
            plan = m.pop("background_plan")
            prompt = FOLLOWUP_PREFIX + plan
            cid, lane, reason = str(uuid.uuid4()), FOLLOWUP_LANE, FOLLOWUP_REASON
            fus.append({"n": n, "command_id": cid, "of_command_id": m.get("command_id"), "state": "dispatching",
                        "plan": plan, "prompt": prompt, "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                        "started_at": iso(now_utc()), "started_ts": time.time(), "lane": FOLLOWUP_LANE})
        # A pending phone retry of the quick answer (car off, its Earshot drop failed) keeps going: the follow-up does
        # not repeat the quick answer and may come hours later or fail (2026-10-22 review). It carries its own reply key
        # and stamp (start_phone_retry), so this new reply round does not disturb it.
        for k in self.REPLY_ROUND_KEYS:
            m.pop(k, None)
        self.drop_command(m)
        m["command_id"] = cid
        m["lane"], m["lane_reason"] = lane, reason
        m["late"] = True
        m.update(status="active", stage="dispatch", next_at=0.0)
        log("followup_started", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="dispatch", n=n, kind=kind,
            command_id=cid, of_command_id=fus[-1]["of_command_id"], lane=lane, plan_chars=len(plan),
            plan=plan[:160], target=fus[-1].get("target"),
            note=("the confirmed brief goes now as a batch follow-up; its result is spoken as a follow-up"
                  if kind == "delegation" else
                  "quick answer spoken; the background half runs now on the same thread and is spoken as a follow-up"))
        self.status(m)
        self.s.save()
        WAKE.set()

    def followup_failed(self, m: dict, fu: dict, code: str, detail: str, waited: float) -> None:
        """The follow-up's turn failed, timed out or wrote nothing. The driver was promised a result, so the failure is
        spoken (a short line through the same reply path, flagged followup_failed on the replied fact) instead of the memo
        quietly failing after its answer was already given."""
        fu.update(error_code=code, error=detail[:300])
        log("followup_failed", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent", n=fu.get("n"),
            command_id=m.get("command_id"), code=code, error=detail[:300], waited_s=int(waited))
        m["followup_failed"] = True
        m["reply_text"] = "The background work did not finish" + {
            "timeout": ": it ran out of time.", mc_.TURN_TIMEOUT: ": it ran out of time.",
            "no_reply_text": ": it ended without an answer.",
            "handoff_refused": ": it tried to hand the work off again instead of doing it."}.get(
                code, ". Ask me again when you are parked.")
        self.done_stage(m, "agent", "speak", ms=waited * 1000, command_id=m.get("command_id"), outcome=f"followup_{code}")

    # -- the phone copy (worker thread, inside step_mirror) --

    def _phone_copy(self, m: dict, audio, stamp: datetime, rkey: str, chunked: bool, t_up: float) -> str | None:
        """The reply's Earshot phone copy, once per memo, after the car's copy is up: dropped unless the car that sent the
        memo speaks the reply itself (phone_copy_decision; it may wait out the car's grace window, its hold, or an upload
        proxy that cannot be asked). `audio` fetches the car's copy (called only when the phone is to get one). The Earshot
        key, or None when it was left out (or the drop failed for good: then the phone's take is given back to the car,
        see release_phone). Re-dropping the same key would give it a new LastModified, and Earshot plays that again: an
        earlier attempt that landed unrecorded is recorded instead. WatcherStopping: the service is stopping."""
        with self.mu:
            agent, mid, key, ekey = m["agent"], m["memo_id"], m["key"], m.get("earshot_key")
            reply_text = m["reply_text"]
        if not EARSHOT_CHANNEL or ekey:
            return ekey
        want = earshot_key_for(stamp, agent, mid)
        with self.mu:
            tried = m.get("earshot_attempted") == want
        if tried and earshot_exists(want):
            # An earlier attempt landed but was never recorded (crash, mc timeout after commit).
            with self.mu:
                m["earshot_key"] = want
                twant = earshot_key_for(stamp, agent, mid, ext="txt")
                self.s.save()
            if not m.get("earshot_text_key") and earshot_exists(twant):  # it went up first, so it is there too
                with self.mu:
                    m["earshot_text_key"] = twant
                    self.s.save()
            return want

        def cancelled() -> bool:
            with self.mu:
                return self._cancelled(m)
        with self.mu:
            readback = bool(m.get("delegate"))
        # the read-back of a confirmed delegation never holds the dispatch behind the phone's grace window
        skip, why = phone_copy_decision(mid, key, rkey, t_up, chunked, cancelled, **({"no_wait": True} if readback else {}))
        if skip == "stopped":
            raise WatcherStopping()
        with self.mu:
            m["earshot_reason"] = why
            if skip:
                m["earshot_skipped"] = skip
                self.s.save()
                return None
            m["earshot_attempted"] = want
            self.s.save()  # persisted before the drop, so a crash mid-drop is caught by the check above

        def record_text(tkey, m=m):
            with self.mu:
                m["earshot_text_key"] = tkey
                self.s.save()
        ekey, tries = None, 0
        try:
            path = audio() if callable(audio) else audio
        except Exception as e:  # noqa: BLE001 - the car's copy could not be fetched back: counts as a failed drop
            log("earshot_audio_unavailable", "warn", memo_id=mid, key=key, error=str(e)[:200])
            path = None
        while path is not None and tries < max(1, EARSHOT_DROP_TRIES):
            if tries:
                # An attempt that failed on our side may still have landed (mc timed out after the commit): a second
                # drop would give the key a new LastModified and the phone would play the reply twice.
                if earshot_exists(want):
                    ekey = want
                    break
                delay = EARSHOT_DROP_BACKOFF_S[min(tries - 1, len(EARSHOT_DROP_BACKOFF_S) - 1)]
                log("earshot_drop_retry", "warn", memo_id=mid, key=key, attempt=tries + 1, of=EARSHOT_DROP_TRIES, in_s=delay)
                if not self._pause(delay, cancelled):
                    break
            tries += 1
            # The full text goes up ahead of the audio, so the phone already has it when the audio shows up. Not again
            # if an earlier attempt already left it there.
            with self.mu:
                send_text = None if m.get("earshot_text_key") else reply_text
            ekey = mirror_to_earshot(path, stamp, agent, mid, key, send_text, record_text)
            if ekey:
                break
        if not ekey and tries and earshot_exists(want):
            # The last try may also have landed after its error: releasing it to the car would play the reply twice.
            ekey = want
        if ekey:
            with self.mu:
                m["earshot_key"] = ekey  # recorded even if the replied fact fails, so a retry does not re-drop
                self.s.save()
            return ekey
        with self.mu:
            if self._cancelled(m):
                return None
        # Every try failed: the phone took the reply and has nothing to play, and the car was refused for good. Give the
        # take back so the car may play it, and say so.
        self.release_phone(m, rkey, tries)
        return None

    @staticmethod
    def _pause(seconds: float, cancelled=None) -> bool:
        """Sleep that the service stopping (WatcherStopping) or a cancel ends early; False: cancelled."""
        end = time.time() + seconds
        while time.time() < end:
            if STOP:
                raise WatcherStopping()
            if cancelled is not None and cancelled():
                return False
            time.sleep(min(0.25, max(0.0, end - time.time())))
        return True

    def _release_claim(self, mid: str, rkey: str, budget_s: float) -> tuple[bool, str]:
        """Hand the phone's take back to the upload proxy for up to budget_s: (given back, last error)."""
        t0, err = time.time(), ""
        while True:
            try:
                ans = claim_call(mid, {"by": "watcher", "action": "release", "reply_key": rkey}, reply_key=rkey)
                if ans.get("ok"):
                    return True, ""
                err = f"the proxy answered {json.dumps(ans)[:160]}"
            except Exception as e:  # noqa: BLE001
                err = str(e)[:200]
            if time.time() - t0 >= budget_s:
                return False, err
            self._pause(2.0)

    def release_phone(self, m: dict, rkey: str, tries: int) -> None:
        """The Earshot drop failed on every try after the phone took the reply: hand the take back to the upload proxy
        (it pushes `released` to the car, which then plays the reply it had left to the phone) and record why. A proxy
        that cannot be reached for EARSHOT_RELEASE_BUDGET_S fails the stage, which is retried (the take stays until then).
        With the car off for good nobody claims it: a phone retry is scheduled (phone_retry_step)."""
        mid, key = m["memo_id"], m["key"]
        t0 = time.time()
        ok, err = self._release_claim(mid, rkey, EARSHOT_RELEASE_BUDGET_S)
        if not ok:
            raise StageError("reply_upload", "earshot_release_failed",
                             f"the Earshot drop failed {tries} times and the phone's take could not be given back: {err}")
        with self.mu:
            m["earshot_skipped"], m["earshot_reason"] = "car_released", "drop_failed"
            self.start_phone_retry(m, rkey, tries)
            self.s.save()
        log("earshot_released", "warn", memo_id=mid, key=key, tries=tries, took_s=round(time.time() - t0, 1),
            note=EARSHOT_REASONS["drop_failed"])

    # -- the phone retry: a released reply nobody claims is eventually dropped for the phone again --

    def start_phone_retry(self, m: dict, rkey: str, tries: int) -> None:
        """Called with the lock held, right after the phone's take was given back. A retry still pending for this memo (the
        mirror stage ran again) is kept: its clock and decisions are the truth. A finished one (gave_up, say, and a manual
        memo:retry ran the mirror stage again and its drop failed again) is armed afresh: the reply is heard nowhere
        otherwise. Its decisions are kept in front of the new ones, so the trace tells the whole story."""
        if EARSHOT_RETRY_TOTAL_S <= 0:
            return
        if self.phone_retry_pending(m):
            if m["phone_retry"].get("rkey") == rkey:
                return
            # One retry per memo: the follow-up's own reply was released while the quick answer's retry still runs. The
            # newer reply takes the slot (the older one had its rounds; both failing to drop is an S3 outage).
            self._retry_finish(m, "superseded", f"the memo's newer reply {rkey} was released and needs the phone retry")
        old = m.get("phone_retry") if isinstance(m.get("phone_retry"), dict) else {}
        now = time.time()
        text = None if m.get("earshot_text_key") else (m.get("reply_text") or "")[:EARSHOT_TEXT_MAX_BYTES]
        again = f" (armed again: the earlier retry ended {old.get('outcome', 'unfinished')})" if old else ""
        m["phone_retry"] = {
            "state": "pending", "since_ts": now, "deadline_ts": now + EARSHOT_RETRY_TOTAL_S, "next_at": now + EARSHOT_RETRY_FIRST_S,
            "rounds": 0, "rkey": rkey, "reply_text": text or None, "stamp": m.get("reply_stamp"),
            "decisions": (old.get("decisions") or [])[-30:] + [
                {"at": iso(now_utc()), "decision": "released", "why": f"the Earshot drop failed {tries} times; the take was "
                 f"given back to the car; the phone is tried again in {EARSHOT_RETRY_FIRST_S:g} s if no car claims it, "
                 f"for {EARSHOT_RETRY_TOTAL_S:g} s{again}"}]}

    @staticmethod
    def phone_retry_pending(m: dict) -> bool:
        r = m.get("phone_retry")
        return isinstance(r, dict) and r.get("state") == "pending"

    def _retry_note(self, m: dict, decision: str, why: str, **extra) -> None:
        """Record one decision of the phone retry (state.json, which memo:trace reads, and the journal). A decision that
        repeats the last one (a car that keeps holding it, polled every few seconds) is not written again."""
        r = m["phone_retry"]
        last = r["decisions"][-1] if r["decisions"] else {}
        if last.get("decision") == decision and last.get("why") == why:
            return
        r["decisions"].append({"at": iso(now_utc()), "decision": decision, "why": why, **extra})
        del r["decisions"][:-40]
        if decision in ("drop_failed", "release_failed"):
            r["last_failure"] = why  # what gave_up quotes: the last word may be a proxy blip that says nothing about the drop
        log("phone_retry_decision", "warn" if decision in ("drop_failed", "release_failed", "gave_up") else "info",
            memo_id=m["memo_id"], key=m["key"], decision=decision, why=why, round=r.get("rounds"), **extra)

    def _retry_finish(self, m: dict, outcome: str, why: str, **extra) -> None:
        r = m["phone_retry"]
        self._retry_note(m, outcome, why, **extra)
        r.update(state="done", outcome=outcome, ended_at=iso(now_utc()))
        r.pop("reply_text", None)
        log("phone_retry_done", "warn" if outcome == "gave_up" else "info", memo_id=m["memo_id"], key=m["key"], outcome=outcome,
            rounds=r.get("rounds"), after_s=round(time.time() - r["since_ts"], 1), note=why)

    @staticmethod
    def _retry_got(m: dict, r: dict, ekey: str, same: bool) -> None:
        """Lock held. The phone has the retry's reply: recorded on the retry, and on the memo only while the memo's reply
        round is still that reply's (a follow-up's round must not read the quick answer's Earshot copy as its own)."""
        r["earshot_key"] = ekey
        if same:
            m["earshot_key"] = ekey
            m["earshot_skipped"] = None

    def _phone_mirrored(self, m: dict, r: dict, ekey: str) -> None:
        """Lock held. The phone has the reply after all: the replied fact already went out saying it was left to the car
        (earshot_skipped=car_released), so say what happened to it afterwards (audio.memo.mirrored) for /voice and the other
        readers of the bus. Failure queues it in the outbox like any fact."""
        self.fact("mirrored", m, {
            "reply_s3_key": r.get("rkey"), "earshot_key": ekey,
            "earshot_text_key": r.get("earshot_text_key") or (m.get("earshot_text_key") if m.get("reply_key") == r.get("rkey") else None),
            "rounds": r.get("rounds"), "after_release_seconds": round(time.time() - r["since_ts"], 1),
            "earshot_skipped_before": "car_released"})

    @staticmethod
    def _retry_due(r: dict) -> float:
        """When the next round is due: at its backoff, but never later than the deadline, so a long backoff cannot hold
        a retry that is out of budget open (the round that finds the deadline passed ends it with gave_up)."""
        return min(r.get("next_at", 0), r.get("deadline_ts", float("inf")))

    def schedule_phone_retries(self) -> None:
        """Tick, lock held: start the round of every due phone retry on the decide pool."""
        now = time.time()
        for m in list(self.s.memos.values()):
            if not self.phone_retry_pending(m) or self._retry_due(m["phone_retry"]) > now:
                continue
            tag = f"phone:{m['key']}"
            if tag in self.running or STOP:
                continue
            self.running.add(tag)
            self.pools["decide"].submit(self._exec_phone_retry, m, tag)

    def next_phone_retry_in(self) -> list[float]:
        now = time.time()
        return [self._retry_due(m["phone_retry"]) - now for m in self.s.memos.values()
                if self.phone_retry_pending(m) and f"phone:{m['key']}" not in self.running]

    def _exec_phone_retry(self, m: dict, tag: str) -> None:
        try:
            self.phone_retry_step(m)
        except WatcherStopping:
            log("step_stopped", "warn", memo_id=m["memo_id"], key=m["key"], stage="phone_retry",
                note="the service is stopping: the phone retry resumes from state.json on the next start")
        except Exception as e:  # noqa: BLE001 - a bug or an outage in one round never ends the retry
            with self.mu:
                if self.phone_retry_pending(m):
                    self._retry_note(m, "error", f"{type(e).__name__}: {e}"[:200])
                    m["phone_retry"]["next_at"] = time.time() + 30
        finally:
            WAKE.set()
            with self.mu:
                self.running.discard(tag)
                self.s.save()

    def phone_retry_step(self, m: dict) -> None:
        """One round: look at who has the reply, and if no car does, take it for the phone and drop it again. Stops with
        an outcome as soon as either device has it. A failed drop gives the take back (the car may then claim it) and
        schedules the next round after a longer wait; the deadline ends it with `gave_up` and the reason."""
        with self.mu:
            if not self.phone_retry_pending(m):
                return
            r = m["phone_retry"]
            mid, key, agent, rkey = m["memo_id"], m["key"], m["agent"], r["rkey"]
            # The retry's own reply: a follow-up may have started a new reply round on the memo since (new reply_key,
            # reply_stamp and earshot fields), and those are not this reply's.
            same = m.get("reply_key") == rkey
            if not r.get("stamp") and not same:
                return self._retry_finish(m, "superseded", "armed by an older watcher without its reply's stamp, and the "
                                          "memo moved on to a new reply")
            stamp = mc_.parse_iso(r.get("stamp") or m["reply_stamp"])
            now = time.time()
            if self._cancelled(m):
                return self._retry_finish(m, "cancelled", "the memo was cancelled")
            have = r.get("earshot_key") or (m.get("earshot_key") if same else None)
            if have:
                return self._retry_finish(m, "phone_has_it", f"the Earshot copy is already recorded ({have})")
            if now >= r["deadline_ts"]:
                last = r["decisions"][-1] if r["decisions"] else {}
                fail = r.get("last_failure") or last.get("why", "")
                tail = "" if not last or last.get("why") == fail else f"; last seen: {last.get('decision')}: {last.get('why', '')[:80]}"
                return self._retry_finish(
                    m, "gave_up", f"no device played the reply in {EARSHOT_RETRY_TOTAL_S:g} s after the release: the car never "
                    f"claimed it and {r['rounds']} phone drop(s) failed (last failure: {fail[:130]}){tail}")
        want = earshot_key_for(stamp, agent, mid)
        if earshot_exists(want):
            # An earlier drop landed (despite its error): the phone has it, and a second drop would play it twice.
            with self.mu:
                self._retry_got(m, r, want, same)
                self._phone_mirrored(m, r, want)
                return self._retry_finish(m, "phone_has_it", f"{want} is in the Earshot channel", earshot_key=want)
        try:
            st = claim_call(mid, reply_key=rkey)
        except Exception as e:  # noqa: BLE001
            with self.mu:
                self._retry_note(m, "proxy_unreachable", f"the upload proxy could not be asked who has the reply: {str(e)[:100]}")
                r["next_at"] = time.time() + 10
            return
        with self.mu:
            if st.get("car") in ("started", "ended"):
                return self._retry_finish(m, "car_heard", "a car started the reply after the release: it is heard there, "
                                          "nothing is dropped for the phone", device=st.get("device"))
            if st.get("car_holds"):
                self._retry_note(m, "car_holds", "a live car holds the reply (it reclaimed it after the release): waiting for it",
                                 device=st.get("device"), lease_left_s=st.get("lease_left_s"))
                r["next_at"] = time.time() + 5
                return
            if st.get("settling_s"):
                self._retry_note(m, "settling", "the upload proxy is settling after a restart: no take is granted yet")
                r["next_at"] = time.time() + float(st["settling_s"]) + 1
                return
        try:
            got = claim_call(mid, {"by": "watcher", "action": "take"}, reply_key=rkey)
        except Exception as e:  # noqa: BLE001
            with self.mu:
                self._retry_note(m, "proxy_unreachable", f"the take could not be asked for: {str(e)[:100]}")
                r["next_at"] = time.time() + 10
            return
        if not got.get("ok"):
            with self.mu:
                self._retry_note(m, "take_refused", "a car's hold or start landed first: looking again")
                r["next_at"] = time.time() + 5
            return
        with self.mu:
            r["rounds"] += 1
            n = r["rounds"]
            text = r.get("reply_text")
            self._retry_note(m, "take_granted", f"no car claimed the reply: the phone took it (round {n})")
        ekey, err = None, ""
        tmp = Path(tempfile.mkdtemp(prefix="memo-phone-retry-"))
        try:
            out = tmp / "reply.ogg"
            c = mc_.mc("cp", "--quiet", mc_.s3_url(rkey), str(out), timeout=60)
            if c.returncode != 0 or not out.exists():
                err = f"mc cp of the car's copy rc={c.returncode}: {c.stderr.strip()[-120:]}"
            else:
                def record_text(tkey, m=m):
                    with self.mu:
                        r["earshot_text_key"] = tkey
                        if m.get("reply_key") == rkey:
                            m["earshot_text_key"] = tkey
                        r["reply_text"] = None
                        self.s.save()
                ekey = mirror_to_earshot(out, stamp, agent, mid, key, text, record_text)
                if not ekey and earshot_exists(want):
                    ekey = want  # landed despite its error
                if not ekey:
                    err = "the Earshot drop failed again"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        if ekey:
            with self.mu:
                self._retry_got(m, r, ekey, m.get("reply_key") == rkey)
                self._phone_mirrored(m, r, ekey)
                return self._retry_finish(m, "phone_dropped", f"the phone has the reply after all (round {n}, "
                                          f"{round(time.time() - r['since_ts'])} s after the release)", earshot_key=ekey)
        with self.mu:
            if self._cancelled(m):
                return self._retry_finish(m, "cancelled", "the memo was cancelled")
        # Failed again: the phone's take would leave the car refused, so give it back (a car that is on can claim it)
        ok, rerr = self._release_claim(mid, rkey, EARSHOT_RELEASE_BUDGET_S)
        with self.mu:
            if ok:
                self._retry_note(m, "drop_failed", f"{err} (round {n}); the take was given back to the car")
                r["next_at"] = time.time() + EARSHOT_RETRY_BACKOFF_S[min(n - 1, len(EARSHOT_RETRY_BACKOFF_S) - 1)]
            else:
                self._retry_note(m, "release_failed", f"{err} (round {n}); the take could not be given back: {rerr}")
                r["next_at"] = time.time() + 15

    # -- chunked reply speech (worker thread, inside step_speak) --

    def _voice_chunks(self, m: dict, parts: list[str], stamp: datetime, tmp: Path, t_speak: float,
                      steps: int | None = None, prio: int | None = None) -> tuple[Path, str] | None:
        """Render the reply chunk by chunk, upload each one as soon as it is rendered (on a publisher thread, so the next
        chunk's render starts at once) and announce it (audio.memo.voiced). Then join them into the full reply file.
        (full audio, engine), or None when the memo was cancelled meanwhile (the caller takes the chunks back).
        A failed render or upload raises StageError: the speak stage is retried, re-rendering the same chunk keys.
        steps / prio: a fast desk turn renders at fewer vox steps and ahead of other renders (TtsGate), chunk by chunk."""
        prio = TtsGate.REPLY if prio is None else prio
        with self.mu:
            agent, mid, key = m["agent"], m["memo_id"], m["key"]
            m["reply_chunks"] = len(parts)
        n = len(parts)
        rkey = reply_key_for(stamp, agent, mid)
        pub = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="voiced")
        futures, files, engine = [], [], "unknown"
        try:
            for i, text in enumerate(parts, 1):
                with self.mu:
                    if self._cancelled(m):
                        return None
                for f in futures:  # an upload that already failed stops the renders now, not after all of them
                    if f.done() and f.exception() is not None:
                        raise f.exception()
                d = tmp / f"c{i:02d}"
                d.mkdir()
                t0 = time.time()
                audio, engine = self._synth(m, text, d, steps, prio)
                files.append(audio)
                job = {"i": i, "n": n, "text": text, "audio": audio, "ckey": chunk_key_for(stamp, agent, mid, i, n),
                       "rkey": rkey, "tts_s": time.time() - t0, "engine": engine, "t_speak": t_speak}
                futures.append(pub.submit(self._publish_chunk, m, job))
            for f in futures:
                f.result(timeout=120)  # a failed upload raises here and the stage is retried
        finally:
            pub.shutdown(wait=True)
        with self.mu:
            if self._cancelled(m):
                return None
        full = tmp / "reply.ogg"
        t0 = time.time()
        if concat_ogg(files, full):
            log("reply_joined", memo_id=mid, key=key, agent=agent, chunks=n, bytes=full.stat().st_size,
                ms=int((time.time() - t0) * 1000))
            return full, engine
        # ffmpeg could not join them: the full file is rendered whole, as before chunking (slower, never lost)
        log("reply_join_failed", "warn", memo_id=mid, key=key, agent=agent, chunks=n,
            note="rendering the full reply in one piece instead")
        return self._synth(m, " ".join(parts), tmp, steps, prio)

    def _publish_chunk(self, m: dict, job: dict) -> None:
        """Upload one rendered chunk and publish audio.memo.voiced for it (once per chunk, also across stage retries)."""
        mid, key, agent = m["memo_id"], m["key"], m["agent"]
        # Tagged kind=chunk: a bucket lifecycle rule expires chunks after a day (they only matter until the full file is up,
        # which holds the same audio; `mc ilm rule add --tags kind=chunk --expire-days 1 delo/holocene-auto`).
        r = mc_.mc("cp", "--quiet", "--attr", "Content-Type=audio/ogg", "--tags", CHUNK_TAGS, str(job["audio"]),
                   mc_.s3_url(job["ckey"]), timeout=60)
        if r.returncode != 0:
            raise StageError("reply_upload", "mc_cp_failed", f"chunk {job['i']}/{job['n']}: mc cp rc={r.returncode}: "
                             f"{r.stderr.strip()[-300:]}")
        size = job["audio"].stat().st_size
        with self.mu:
            done = m.setdefault("voiced_keys", {})
            first = str(job["i"]) not in done
            done[str(job["i"])] = job["ckey"]
            if self._cancelled(m):
                return  # the caller sees the cancel and takes every uploaded chunk back
            since = round(time.time() - job["t_speak"], 2)
            m["voiced_n"] = len(done)
            if job["i"] == 1:
                m["voiced_first_s"] = since
                m["voiced_first_ts"] = time.time()  # the car could start from here: the phone copy's grace counts from it
            if job["i"] == job["n"]:
                m["voiced_last_s"] = since
            log("chunk_voiced", memo_id=mid, key=key, agent=agent, stage="tts", chunk=job["i"], chunks=job["n"],
                chunk_key=job["ckey"], tts_ms=int(job["tts_s"] * 1000), since_reply_s=since, bytes=size,
                chars=len(job["text"]))
            if first:
                done_ts = m.get("agent_done_ts")
                self.fact_fast("voiced", m, {
                    "reply_s3_key": job["rkey"], "chunk_s3_key": job["ckey"], "chunk": job["i"], "chunks": job["n"],
                    "spoken_text": job["text"], "spoken_chars": len(job["text"]), "command_id": m.get("command_id"),
                    "tts_seconds": round(job["tts_s"], 2), "tts_engine": job["engine"], **self._voice_fields(m),
                    "audio_bytes": size,
                    "since_reply_seconds": since,
                    "since_agent_done_seconds": round(time.time() - done_ts, 2) if done_ts else None,
                    "late": bool(m.get("late")), "followup": (live_followup(m) or {}).get("n")})
            self.status(m)
            self.s.save()

    # ---- progress: what the agent says it is doing, while the driver waits --------------------------------------
    #
    # The Hermes gateway publishes every interim assistant message of the memo's turn as agent.invocation.progressed
    # (seq 1..n per command). The watcher reads the newest one for every memo whose agent is working, puts it in the
    # car's status object, and speaks it: never in the first NARRATE_FIRST_S of the turn, at most once per NARRATE_GAP_S,
    # always the newest line, never once the turn is done. Runs on its own thread (start_progress_watch); tests call
    # poll_progress() directly.

    def start_progress_watch(self) -> None:
        def loop():
            while not STOP:
                t0 = time.time()
                try:
                    self.poll_progress()
                except Exception as e:  # noqa: BLE001
                    log("progress_poll_failed", "warn", error=f"{type(e).__name__}: {e}"[:200])
                time.sleep(max(0.2, PROGRESS_POLL_S - (time.time() - t0)))
        threading.Thread(target=loop, name="progress", daemon=True).start()

    def poll_progress(self) -> None:
        """One pass over every memo whose agent is working: newest progress line in, maybe one narration out."""
        with self.mu:
            work = [(m["key"], m["memo_id"], m["command_id"],
                     memo_lane(m) == "interactive" and not detached_now(m)
                     and time.time() - float(m.get("dispatched_ts") or time.time()) >= DETACH_PROBE_AFTER_S)
                    for m in self.active() if m.get("stage") == "await_agent" and m.get("command_id")]
        for key, mid, cid, probe_detach in work:
            try:
                events = mc_.progress_events(mid)  # outside the lock: an HTTP call
                if probe_detach:
                    # a gateway that announces a detach with its own fact type (the journal column is read anyway)
                    events = events + mc_.typed_events(mid, mc_.DETACHED_TYPE)
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"[:200]
                if err != self.progress_err:
                    log("progress_read_failed", "warn", memo_id=mid, key=key, error=err,
                        note="Candystore unreachable: the status object keeps its last progress line")
                self.progress_err = err
                continue
            self.progress_err = None
            mine = [e for e in events if (e.get("data") or {}).get("command_id") == cid
                    and isinstance((e.get("data") or {}).get("seq"), int) and not mc_.detached_fact(e)]
            detach = next((e for e in events if mc_.detached_fact(e, cid)), None)
            with self.mu:
                m = self.s.memos.get(key)
                if not m or m.get("stage") != "await_agent" or m.get("command_id") != cid or self._cancelled(m):
                    continue
                if detach is not None:
                    self.note_detached(m, "candystore", at=detach.get("time"),
                                       elapsed=(detach.get("data") or {}).get("elapsed_seconds"))
                if mine:
                    self.apply_progress(m, max(mine, key=lambda e: e["data"]["seq"]))
                if not self.maybe_narrate(m):
                    self.maybe_keepalive(m)

    def apply_progress(self, m: dict, ev: dict) -> None:
        """Adopt a progress fact if it is newer than what the memo has (a new command starts its seq at 1 again)."""
        d = ev.get("data") or {}
        seq, cid = d["seq"], d.get("command_id")
        if m.get("progress_cmd") == cid and seq <= m.get("progress_seq", 0):
            return
        line = clean_for_speech(str(d.get("text") or ""), PROGRESS_LINE_CHARS)
        if not line:
            return
        at = mc_.parse_iso(ev.get("time"))
        m.update(progress_cmd=cid, progress_seq=seq, progress_text=line,
                 progress_ts=at.timestamp() if at else time.time(), progress_full=str(d.get("text") or ""))
        log("progress", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent", command_id=cid, seq=seq,
            elapsed_s=d.get("elapsed_seconds"), text=line[:120])
        self.status(m)

    def narration_due(self, m: dict, now: float | None = None) -> str | None:
        """None when a progress update should be spoken now, else why not (logged by tests, not by the loop)."""
        now = time.time() if now is None else now
        if m.get("stage") != "await_agent" or m.get("status") != "active":
            return "turn_not_running"
        if m["key"] in self.narrating:
            return "render_in_flight"
        if (m.get("narr_pending") or {}).get("cid") == m.get("command_id") and m.get("command_id"):
            return None  # a one-off line (the detach notice) goes out as soon as nothing else is rendering
        if live_followup(m) is not None:
            return "followup"   # background work after the quick answer: nobody is waiting on it, and the car drops it
        if detached_now(m):
            return "detached"   # the driver was told it will be a late reply: no more 30 s updates
        if not m.get("progress_text"):
            return "no_progress"
        if (m.get("narr_cmd"), m.get("narr_src_seq")) == (m.get("progress_cmd"), m.get("progress_seq")):
            return "already_spoken"
        if m.get("narr_count", 0) - m.get("hold_count", 0) >= NARRATE_MAX:
            return "max_reached"
        if now < float(m.get("dispatched_ts") or now) + NARRATE_FIRST_S:
            return "too_early"
        if now < float(m.get("narr_last_ts") or 0) + NARRATE_GAP_S:
            return "too_soon"
        return None

    def narrate_line(self, m: dict, text: str, tag: str) -> None:
        """Under the lock: say one fixed line in the car for the memo's current command (as a progress clip, the next in
        its sequence), as soon as no other render for it is in flight."""
        m["narr_pending"] = {"text": text, "tag": tag, "cid": m.get("command_id")}
        self.maybe_narrate(m)

    def maybe_narrate(self, m: dict) -> bool:
        """Under the lock: start one narration render for this memo if one is due. True when it started."""
        if self.narration_due(m) is not None:
            return False
        n = m.get("narr_count", 0) + 1
        name = m.get("display_name") or mc_.spoken_name(m["agent"])
        pend = m.pop("narr_pending", None)
        if pend:
            line = clean_for_speech(pend["text"], NARRATE_CHARS)
            job = {"key": m["key"], "mid": m["memo_id"], "agent": m["agent"], "cid": m["command_id"],
                   "seq": m.get("progress_seq", 0), "n": n, "spoken": f"{name}, {line}", "line": line, "tag": pend["tag"]}
        else:
            line = clean_for_speech(m.get("progress_full") or m["progress_text"], NARRATE_CHARS)
            job = {"key": m["key"], "mid": m["memo_id"], "agent": m["agent"], "cid": m["progress_cmd"],
                   "seq": m["progress_seq"], "n": n, "spoken": f"{name}: {line}", "line": line}
        self.narrating.add(m["key"])
        # Claimed now, not when the upload lands: the gap runs from the decision, so a slow vox cannot cause two
        # renders of the same memo back to back.
        m["narr_last_ts"] = time.time()
        self.pools["narrate"].submit(self._narrate_job, job)
        return True

    def _narrate_job(self, job: dict) -> None:
        try:
            self._narrate(job)
        except Exception as e:  # noqa: BLE001
            log("narration_failed", "warn", memo_id=job["mid"], key=job["key"], agent=job["agent"], n=job["n"],
                error=f"{type(e).__name__}: {e}"[:300])
        finally:
            with self.mu:
                self.narrating.discard(job["key"])

    def _still_working(self, m: dict | None, job: dict) -> str | None:
        """None while the memo's turn (the same command) is still running, else why the narration is dropped."""
        if m is None or self._cancelled(m):
            return "cancelled"
        if m.get("command_id") != job["cid"]:
            return "command_changed"
        if m.get("stage") != "await_agent":
            return "turn_finished"
        return None

    def _narrate(self, job: dict) -> None:
        key, mid = job["key"], job["mid"]
        tmp = Path(tempfile.mkdtemp(prefix="memo-progress-"))
        try:
            t0 = time.time()
            # the tile's own car voice for a car memo (unless MEMO_PROGRESS_VOICE pins narration to one voice); an unknown
            # one falls back
            voice = PROGRESS_VOICE
            if not os.environ.get("MEMO_PROGRESS_VOICE"):
                voice = self._tile_voice(job["agent"], key, PROGRESS_VOICE)
            try:
                audio, engine = synthesize(job["spoken"], tmp, voice=voice, steps=PROGRESS_TTS_STEPS,
                                           **synth_kw(None, TtsGate.NARRATION))
            except VoiceNotFound:
                if voice == PROGRESS_VOICE:
                    raise
                voice = PROGRESS_VOICE
                audio, engine = synthesize(job["spoken"], tmp, voice=voice, steps=PROGRESS_TTS_STEPS,
                                           **synth_kw(None, TtsGate.NARRATION))
            tts_s = time.time() - t0
            with self.mu:
                why = self._still_working(self.s.memos.get(key), job)
            if why:
                # Nothing is spoken once the turn is done: the reply is next, and a progress line after it is noise.
                log("narration_dropped", memo_id=mid, key=key, agent=job["agent"], n=job["n"], seq=job["seq"], reason=why,
                    tts_ms=int(tts_s * 1000))
                return
            pkey = mc_.progress_key_for(key, job["n"], mid)
            r = mc_.mc("cp", "--quiet", "--attr", "Content-Type=audio/ogg", str(audio), mc_.s3_url(pkey), timeout=30)
            if r.returncode != 0:
                raise RuntimeError(f"mc cp rc={r.returncode}: {r.stderr.strip()[-200:]}")
            size = audio.stat().st_size
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with self.mu:
            m = self.s.memos.get(key)
            why = self._still_working(m, job)
            if why in ("cancelled", "command_changed"):
                log("narration_dropped", memo_id=mid, key=key, agent=job["agent"], n=job["n"], seq=job["seq"], reason=why,
                    progress_key=pkey, note="uploaded before the memo moved on; the car drops a stale update")
                return
            # A turn that finished during the upload keeps the object: the reply is still rendering, and the car's
            # speech arbiter drops a progress update that would play after the reply.
            m.update(narr_count=job["n"], narr_key=pkey, narr_cmd=job["cid"], narr_src_seq=job["seq"],
                     narr_text=job["line"], narr_last_ts=time.time(), narr_hold=None)
            elapsed = time.time() - float(m.get("dispatched_ts") or time.time())
            log("narrated", memo_id=mid, key=key, agent=job["agent"], stage="agent", n=job["n"], seq=job["seq"],
                progress_key=pkey, tts_ms=int(tts_s * 1000), engine=engine, elapsed_s=round(elapsed, 1),
                text=job["line"][:120])
            self.fact("narrated", m, {
                "command_id": job["cid"], "seq": job["seq"], "narration": job["n"], "progress_s3_key": pkey,
                "spoken_text": job["spoken"], "elapsed_seconds": round(max(0.0, elapsed), 1),
                "tts_seconds": round(tts_s, 2), "tts_engine": engine, "voice": voice, "audio_bytes": size,
                # null for a progress line the agent wrote; "detached" for the one-off "still on it" notice
                "kind": job.get("tag")})
            self.status(m)
            self.s.save()


    # ---- hold cue: a very short spoken line while the driver waits and nothing else is being said (HOLOC-23) ----------
    #
    # Two gaps used to be silent. (1) The desk's decision: ack:stopped, then nothing until the answer (3-7 s typical, 12 s at
    # the timeout). (2) A turn the desk handed to the full agent: the "heard" echo, then nothing until the first narration,
    # NARRATE_FIRST_S after dispatch. The hold cue fills both with a <1 s line ("One sec.", "Still on it.") in the tile's voice,
    # rendered once per voice (PhraseBank) and played by the pad as a progress clip named <memo>-<n>h.ogg.
    #   - desk wait: a thread per desk call says line 1 at HOLD_CUE_S and line 2 at HOLD_CUE2_S unless the decision is in. A
    #     cue is checked three times (before the render, after it, after the upload) and dropped if the decision arrived: the
    #     answer never waits behind a stale cue.
    #   - fall-through: poll_progress asks maybe_keepalive for every converse "direct" turn that is waiting on its agent.
    # The pad's speech queue ranks a progress clip below the echo and the reply, drops it once the memo has its reply, and the
    # pad itself drops a hold cue while the driver is recording or arming.

    def hold_line(self, agent: str, lines: tuple[str, ...]) -> str | None:
        """A line from `lines`, never the one this tile's car heard last and never one that rendered too long (None: no line)."""
        with self.mu:
            pool = tuple(x for x in lines if x not in self.hold_long)
            if not pool:
                return None
            line = cv.pick_hold_line(pool, self.hold_last.get(agent))
            self.hold_last[agent] = line
        return line

    def _hold_prime(self, m: dict, text: str) -> None:
        """While the cue waits for its mark: if the tile voice's render of `text` is not in the PhraseBank (a voice changed at run
        time, a line added), render and bank it now, so the cue is a file copy at the mark instead of a 1.5-3.5 s live render."""
        try:
            if not self.phrases.enabled or not self.phrases.banked(text):
                return
            voice = self._tile_voice(m["agent"], m["key"], VOICE, m)
            if self.phrases.get(text, voice, CONVERSE_TTS_STEPS) is not None:
                return
            tmp = Path(tempfile.mkdtemp(prefix="memo-holdp-"))
            try:
                audio, engine = synthesize(text, tmp, **synth_kw(CONVERSE_TTS_STEPS, TtsGate.NARRATION, voice))
                self.phrases.put(text, voice, CONVERSE_TTS_STEPS, audio, engine)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        except Exception as e:  # noqa: BLE001 - priming is a courtesy: the cue renders on demand
            log("hold_cue_prime_failed", memo_id=m.get("memo_id"), error=f"{type(e).__name__}: {e}"[:160])

    def start_hold_cues(self, m: dict) -> threading.Event | None:
        """Called as the desk call starts. The Event to set the moment the decision is in (None: hold cues are off)."""
        if HOLD_CUE_S <= 0:
            return None
        done = threading.Event()
        t0 = time.time()
        mid, key = m["memo_id"], m["key"]

        def still(mm: dict) -> str | None:
            if done.is_set():
                return "answer_ready"
            if self._cancelled(mm):
                return "cancelled"
            return None if mm.get("stage") == "converse" else "stage_moved"

        def work():
            try:
                for tag, at, lines in (("hold_cue", HOLD_CUE_S, cv.HOLD_CUE_LINES), ("hold_cue2", HOLD_CUE2_S, cv.HOLD_CUE2_LINES)):
                    if at <= 0:
                        continue
                    line = self.hold_line(m["agent"], lines)
                    if line is None:
                        continue
                    self._hold_prime(m, line)   # during the wait, not after the mark
                    if done.wait(max(0.0, at - (time.time() - t0))) or STOP:
                        return
                    n = self._hold_claim(m, still)
                    if n is not None:
                        self._hold_run(m, n, line, tag, still, since=t0, cid=None)
            except Exception as e:  # noqa: BLE001 - a cue is a courtesy: never a stopped memo
                log("hold_cue_failed", "warn", memo_id=mid, key=key, error=f"{type(e).__name__}: {e}"[:300])
        threading.Thread(target=work, name="hold-cue", daemon=True).start()
        return done

    def _hold_claim(self, m: dict, still) -> int | None:
        """Under no lock: claim the memo's render slot for one hold cue (None: dropped, nothing claimed). n is the clip number."""
        with self.mu:
            why = still(m)
            if why is None and m["key"] in self.narrating:
                why = "render_in_flight"
            if why:
                log("hold_cue_dropped", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], reason=why, stage="claim")
                return None
            self.narrating.add(m["key"])
            return m.get("narr_count", 0) + 1

    def _hold_run(self, m: dict, n: int, text: str, tag: str, still, since: float, cid: str | None) -> None:
        """Render (PhraseBank first), re-check, upload, re-check, announce. The claim from _hold_claim is released here."""
        key, mid, agent = m["key"], m["memo_id"], m["agent"]
        tmp = Path(tempfile.mkdtemp(prefix="memo-hold-"))
        try:
            t0 = time.time()
            voice = self._tile_voice(agent, key, VOICE, m)
            audio = banked = None
            for v in ((voice, VOICE) if voice != VOICE else (voice,)):
                hit = self.phrases.get(text, v, CONVERSE_TTS_STEPS)
                if hit is not None:
                    audio = tmp / "hold.ogg"
                    try:
                        shutil.copyfile(hit, audio)
                        voice, banked, engine = v, True, "phrasebank"
                        self.phrases.hits += 1
                        break
                    except OSError:
                        audio = None
                try:
                    audio, engine = synthesize(text, tmp, **synth_kw(CONVERSE_TTS_STEPS, TtsGate.NARRATION, v))
                    self.phrases.put(text, v, CONVERSE_TTS_STEPS, audio, engine)
                    voice = v
                    break
                except VoiceNotFound:
                    if v == VOICE:
                        raise
                    voice = VOICE  # the tile's voice is gone: the default one
            tts_s = time.time() - t0
            clip_s = (mc_.probe_audio(audio).get("duration") if audio else None)
            if clip_s is not None and clip_s > HOLD_MAX_CLIP_S:
                with self.mu:
                    self.hold_long.add(text)
                log("hold_cue_dropped", memo_id=mid, key=key, agent=agent, reason="too_long", stage="rendered", voice=voice,
                    clip_s=round(clip_s, 2), max_s=HOLD_MAX_CLIP_S, text=text,
                    note="a long cue holds the pad's speech queue: dropped, and this line is not used again until restart")
                return
            with self.mu:
                why = still(m)
            if why:
                log("hold_cue_dropped", memo_id=mid, key=key, agent=agent, reason=why, stage="rendered", tts_ms=int(tts_s * 1000),
                    note="the answer is ready: a stale cue is never uploaded")
                return
            pkey = mc_.progress_key_for(key, n, mid, hold=True)
            r = mc_.mc("cp", "--quiet", "--attr", "Content-Type=audio/ogg", str(audio), mc_.s3_url(pkey), timeout=30)
            if r.returncode != 0:
                raise RuntimeError(f"mc cp rc={r.returncode}: {r.stderr.strip()[-200:]}")
            size = audio.stat().st_size
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            with self.mu:
                self.narrating.discard(key)
        with self.mu:
            why = still(m)
            if why:
                removed = False
                try:   # the decision landed during the upload: the object must not stay listed for the pad to pick up
                    removed = mc_.mc("rm", "--quiet", mc_.s3_url(pkey), timeout=15).returncode == 0
                except Exception:  # noqa: BLE001
                    pass
                log("hold_cue_dropped", memo_id=mid, key=key, agent=agent, reason=why, stage="uploaded", progress_key=pkey,
                    removed=removed, note="uploaded just before the answer: the object is removed so the pad cannot play it")
                return
            # the pad's cursor moves; narr_cmd / narr_last_ts / narr_src_seq stay the agent narration's. The clip is a hold cue:
            # its own text and kind in the status block (not the previous real line paired with the hold clip's key), and it is
            # counted apart so NARRATE_MAX still means real narrations.
            m.update(narr_count=n, narr_key=pkey, narr_text=text, narr_hold=tag, hold_count=m.get("hold_count", 0) + 1)
            elapsed = time.time() - since
            log("hold_cue", memo_id=mid, key=key, agent=agent, stage="converse" if cid is None else "agent", n=n, tag=tag,
                progress_key=pkey, tts_ms=int(tts_s * 1000), engine=engine, elapsed_s=round(elapsed, 1), voice=voice, text=text)
            self.fact_fast("narrated", m, {
                "command_id": cid, "seq": n, "narration": n, "progress_s3_key": pkey, "spoken_text": text,
                "elapsed_seconds": round(max(0.0, elapsed), 1), "tts_seconds": round(tts_s, 2), "tts_engine": engine,
                "voice": voice, "audio_bytes": size, "kind": tag})
            self.status(m)
            self.s.save()

    def maybe_keepalive(self, m: dict) -> bool:
        """Under the lock, from poll_progress: a turn the desk handed to the full agent says "Still on it." when it has been
        quiet HOLD_FALL_FIRST_S after dispatch and every HOLD_FALL_GAP_S after that (at most HOLD_FALL_MAX), until the agent's
        own narration starts. True when one was started."""
        conv = m.get("conv")
        if HOLD_CUE_S <= 0 or HOLD_FALL_MAX <= 0 or not (isinstance(conv, dict) and conv.get("action") == "direct"):
            return False
        cid = m.get("command_id")
        if (not cid or m.get("stage") != "await_agent" or m.get("status") != "active" or m["key"] in self.narrating
                or live_followup(m) is not None or detached_now(m) or m.get("narr_cmd") == cid):
            return False
        ka = m.get("hold_ka")
        if not isinstance(ka, dict) or ka.get("cid") != cid:
            ka = m["hold_ka"] = {"cid": cid, "n": 0, "last": None}
        if ka["n"] >= HOLD_FALL_MAX:
            return False
        now = time.time()
        due = (float(ka["last"]) + HOLD_FALL_GAP_S) if ka["last"] else (float(m.get("dispatched_ts") or now) + HOLD_FALL_FIRST_S)
        if now < due:
            return False
        ka["n"] += 1
        ka["last"] = now
        dispatched = float(m.get("dispatched_ts") or now)

        def still(mm: dict) -> str | None:
            if mm.get("narr_cmd") == cid:
                return "agent_narrating"   # the agent's own first narration took over while the cue rendered
            return self._still_working(mm, {"cid": cid})

        self.narrating.add(m["key"])   # the render slot, claimed here under the caller's lock (poll_progress)
        n = m.get("narr_count", 0) + 1
        pool = tuple(x for x in cv.HOLD_CUE2_LINES if x not in self.hold_long)
        if not pool:
            self.narrating.discard(m["key"])
            return False
        line = cv.pick_hold_line(pool, self.hold_last.get(m["agent"]))
        self.hold_last[m["agent"]] = line
        self.pools["narrate"].submit(self._hold_job, m, n, line, still, dispatched, cid)
        return True

    def _hold_job(self, m: dict, n: int, line: str, still, since: float, cid: str) -> None:
        try:
            self._hold_run(m, n, line, "hold_keepalive", still, since=since, cid=cid)
        except Exception as e:  # noqa: BLE001
            log("hold_cue_failed", "warn", memo_id=m["memo_id"], key=m["key"], error=f"{type(e).__name__}: {e}"[:300])
            with self.mu:
                self.narrating.discard(m["key"])


# ------------------------------------------------------------------ earshot mirror

def earshot_key_for(stamp: datetime, agent: str, mid: str, channel: str = "", ext: str = "ogg") -> str:
    """The Earshot object for a memo's reply: dated like the reply, carrying agent and memo id so the device's
    beacons for it join back to the memo. ext="txt" is its sibling holding the full reply text."""
    ch = channel or EARSHOT_CHANNEL
    return f"{ch}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}{stamp.microsecond // 1000:03d}Z-{agent}-{mid}.{ext}"


def earshot_exists(ekey: str) -> bool:
    try:
        return mc_.mc("stat", f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{ekey}", timeout=20).returncode == 0
    except Exception:  # noqa: BLE001 - unknown: assume absent, so the reply still reaches the phone
        return False


def cap_earshot_text(text: str) -> tuple[str, bool]:
    """The sibling text as the phone can take it: at most EARSHOT_TEXT_MAX_BYTES of UTF-8 including a closing note that
    says it was cut and where the whole reply is. (text, was_cut)."""
    raw = text.encode("utf-8")
    if len(raw) <= EARSHOT_TEXT_MAX_BYTES:
        return text, False
    note = EARSHOT_TEXT_CUT_NOTE.encode("utf-8")
    head = raw[:max(0, EARSHOT_TEXT_MAX_BYTES - len(note))].decode("utf-8", errors="ignore")  # never half a character
    return head + EARSHOT_TEXT_CUT_NOTE, True


def upload_earshot_text(text: str, stamp: datetime, agent: str, mid: str, key: str) -> str | None:
    """Drop the FULL reply text next to where its audio will land: same key, .txt, text/plain; charset=utf-8. Fail-open
    like the audio mirror: the phone still gets the audio without it. Capped at EARSHOT_TEXT_MAX_BYTES (the phone
    abandons a bigger one), with a note pointing at Holocene /voice for the rest."""
    tkey = earshot_key_for(stamp, agent, mid, ext="txt")
    t0 = time.time()
    text, cut = cap_earshot_text(text)
    if cut:
        log("earshot_text_truncated", "warn", memo_id=mid, key=key, earshot_key=tkey, max_bytes=EARSHOT_TEXT_MAX_BYTES,
            note="the reply is longer than the phone reads; the rest is in Holocene /voice")
    try:
        with tempfile.TemporaryDirectory(prefix="memo-etext-") as d:
            f = Path(d) / "reply.txt"
            f.write_text(text, encoding="utf-8")
            # mc splits --attr on ";", so the value is quoted to keep "; charset=utf-8" in one piece
            r = mc_.mc("cp", "--quiet", "--attr", f'Content-Type="{EARSHOT_TEXT_TYPE}"', str(f),
                       f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{tkey}", timeout=60)
    except Exception as e:  # noqa: BLE001 - fail-open
        log("earshot_text_failed", memo_id=mid, key=key, earshot_key=tkey, error=str(e)[:200])
        return None
    if r.returncode != 0:
        log("earshot_text_failed", memo_id=mid, key=key, earshot_key=tkey,
            error=f"mc cp rc={r.returncode}: {r.stderr.strip()[-200:]}")
        return None
    log("earshot_text_mirrored", memo_id=mid, key=key, earshot_key=tkey, chars=len(text), ms=int((time.time() - t0) * 1000))
    return tkey


def claim_call(memo_id: str, body: dict | None = None, reply_key: str | None = None) -> dict:
    """The upload proxy's claim on one reply of a memo: POST a request (body), or GET where it stands. Raises on failure.
    reply_key names the reply: claims are per reply file, and a memo's follow-up is a second reply with a claim of its own
    (without it the proxy answers for the memo's newest claim)."""
    if body is None:
        q = f"?memo={urllib.parse.quote(memo_id, safe='')}" + (f"&reply={urllib.parse.quote(reply_key, safe='')}" if reply_key else "")
        req = urllib.request.Request(f"{CLAIM_URL}{q}", headers={"Accept": "application/json"})
    else:
        req = urllib.request.Request(CLAIM_URL, method="POST", headers={"Content-Type": "application/json", "Accept": "application/json"},
                                     data=json.dumps({"memo_id": memo_id, **({"reply_key": reply_key} if reply_key else {}),
                                                      **body}).encode())
    with urllib.request.urlopen(req, timeout=CLAIM_TIMEOUT_S) as r:
        ans = json.loads(r.read().decode("utf-8", "replace"))
    if not isinstance(ans, dict):
        raise ValueError("claim answer is not an object")
    return ans


# Why the phone copy went the way it did, as memo:trace and /voice word it.
EARSHOT_REASONS = {
    "car_started": "the car that sent the memo started (or finished) it",
    "car_holds": f"the car that sent the memo still held it, live, {int(EARSHOT_HOLD_MAX_S)} s after it was up",
    "no_car_claim": f"no car claimed it within {EARSHOT_CAR_GRACE_S:g} s of its first audio being up",
    "car_let_go": "the car held it, then stopped renewing its hold before playing it (switched off)",
    "browser_sender": "it was sent from a browser, which is not in the car",
    "claim_failed": (f"the upload proxy could not be asked who speaks it for {int(EARSHOT_HOLD_MAX_S)} s: left to the car, "
                     "which speaks a reply only with the proxy's yes"),
    "skip_off": "MEMO_EARSHOT_SKIP_CAR=0 mirrors every reply",
    "delegation_readback": ("the \"Sending to ...\" read-back of a confirmed delegation is the car's: the delegation does not "
                            "wait for the phone decision, and the result is mirrored on its own"),
    "drop_failed": (f"the phone took it, but its Earshot drop failed {EARSHOT_DROP_TRIES} times: the take was given back so the "
                    "car may play it"),
}


def phone_copy_decision(mid: str, key: str, rkey: str, t_up: float, chunked: bool, cancelled=None,
                        clock=time.time, sleep=time.sleep, no_wait: bool = False) -> tuple[str | None, str]:
    """Who speaks the reply in the cabin, the car that sent the memo or the phone's Earshot copy: (skip, why).

    skip "car_spoke" (why car_started), "car_holds" or "no_answer" (why claim_failed) leaves the phone copy out; skip
    None mirrors it, why no_car_claim | car_let_go | browser_sender | skip_off (EARSHOT_REASONS); skip "cancelled": the
    memo was cancelled. The watcher OFFERS the reply to the proxy's arbiter (a one-file reply is pushed to the car right
    then), then TAKES it for the phone once nobody started it and no live car holds it, EARSHOT_CAR_GRACE_S after its
    first audio was up (t_up). The take is atomic at the proxy: a car whose hold or start lands first keeps it, and a car
    that comes back after the take is refused and leaves the reply to the phone. So it waits the grace window when no
    car claims it, and as long as a live car holds it (recording, another reply playing; at most EARSHOT_HOLD_MAX_S).

    Only a granted take mirrors. A proxy that cannot be asked (the offer, a poll or the take fails) is waited for: the
    car may be speaking the reply on its live hold meanwhile (it reads the reply from S3, not through the proxy). Once
    the proxy answers again, a take waits EARSHOT_SETTLE_S more, so the car's re-sent start and renewed holds land
    first. Still unanswered at EARSHOT_HOLD_MAX_S: left to the car ("no_answer"), never mirrored blind.

    no_wait (the "Sending to <agent>: <title>." read-back of a confirmed delegation): decided at once, never waited for. The
    offer still goes to the proxy (it pushes the line to the car); a browser sender is still mirrored; a car that already
    started it keeps the phone copy out; anything else leaves the line to the car (skip "delegation_readback"): the
    delegation is dispatched right after this decision, so nothing here may hold it for a grace window, a hold or a
    proxy that cannot be asked (2026-10-22: the agent started 22.6 s after "Send it" behind the 20 s grace). The
    delegated RESULT is a reply of its own and is mirrored the usual way."""
    if not EARSHOT_SKIP_CAR:
        return None, "skip_off"
    link = {"down_at": None, "back_at": None, "fails": 0}

    def ask(body=None):
        try:
            ans = claim_call(mid, body, reply_key=rkey)
        except Exception as e:  # noqa: BLE001 - the proxy is waited for, below
            link["fails"] += 1
            if link["down_at"] is None:
                link["down_at"] = clock()
                log("earshot_car_check_failed", "warn", memo_id=mid, key=key, source="claim", error=str(e)[:200],
                    note="who speaks the reply waits for the upload proxy; the phone copy is not sent blind")
            return None
        if link["down_at"] is not None:
            log("earshot_car_check_back", memo_id=mid, key=key, source="claim", down_s=round(clock() - link["down_at"], 1),
                fails=link["fails"], settle_s=EARSHOT_SETTLE_S)
            link["down_at"], link["back_at"] = None, clock()
        return ans

    def settled() -> bool:
        return link["down_at"] is None and (link["back_at"] is None or clock() - link["back_at"] >= EARSHOT_SETTLE_S)

    def done(skip, why, st=None):
        waited = round(clock() - t_up, 1)
        if skip and skip not in ("cancelled", "stopped"):
            log("earshot_skipped", memo_id=mid, key=key, reason=skip, why=why, waited_s=waited, device=(st or {}).get("device"),
                proxy_fails=link["fails"] or None, note=EARSHOT_REASONS.get(why, why))
        elif not skip:
            log("earshot_mirror_decided", memo_id=mid, key=key, why=why, waited_s=waited, proxy_fails=link["fails"] or None,
                note=EARSHOT_REASONS.get(why, why))
        return skip, why

    def gone() -> bool:
        return cancelled is not None and cancelled()

    def halted():
        """The service is stopping (or the memo was cancelled): the decision ends now, whatever it waits for. A stop is
        not a verdict: the stage resumes the decision on the next start from the same t_up."""
        if STOP:
            return done("stopped", "stopped")
        if gone():
            return done("cancelled", "cancelled")
        return None

    offer = {"by": "watcher", "action": "offer", "reply_key": rkey, "key": key, "announce": not chunked}
    st = ask(offer)
    while st is None:  # the offer (and with it the one-file reply's push to the car) waits for the proxy
        if (h := halted()) is not None:
            return h
        if no_wait:
            return done("delegation_readback", "delegation_readback")
        if clock() - t_up >= EARSHOT_HOLD_MAX_S:
            return done("no_answer", "claim_failed")
        sleep(EARSHOT_POLL_S)
        st = ask(offer)
    if st.get("sender_host") == "browser" and not st.get("car"):
        return done(None, "browser_sender", st)
    while True:
        if (h := halted()) is not None:
            return h
        if st.get("car") in ("started", "ended"):
            return done("car_spoke", "car_started", st)
        if no_wait:
            return done("delegation_readback", "delegation_readback", st)
        waited = clock() - t_up
        live = link["down_at"] is None
        if waited >= EARSHOT_HOLD_MAX_S:
            if not live:
                return done("no_answer", "claim_failed", st)
            if st.get("car_holds"):
                return done("car_holds", "car_holds", st)
        if (live and settled() and not st.get("car_holds") and not st.get("settling_s")
                and (st.get("held_ever") or waited >= EARSHOT_CAR_GRACE_S)):
            nxt = ask({"by": "watcher", "action": "take"})
            if nxt is not None and nxt.get("ok"):
                return done(None, "car_let_go" if nxt.get("held_ever") else "no_car_claim", nxt)
            if nxt is not None:
                st = nxt  # a car's hold or start landed first, or the proxy is settling: look again
                if st.get("car") in ("started", "ended"):
                    continue
        sleep(EARSHOT_POLL_S)
        nxt = ask()
        if nxt is not None:
            st = nxt


def mirror_to_earshot(audio: Path, stamp: datetime, agent: str, mid: str, key: str,
                      text: str | None = None, on_text=None) -> str | None:
    """Drop the reply into the Earshot channel: the full text first (when given), then the audio. Fail-open: the car's
    replies/ object is the reply of record, so a mirror failure is logged and never fails the memo. A text that
    uploaded is reported through on_text(key) at once, so it is recorded even if the audio then fails."""
    if not EARSHOT_CHANNEL:
        return None
    if text:
        tkey = upload_earshot_text(text, stamp, agent, mid, key)
        if tkey and on_text is not None:
            try:
                on_text(tkey)
            except Exception as e:  # noqa: BLE001 - bookkeeping must not stop the audio
                log("earshot_text_unrecorded", "warn", memo_id=mid, key=key, earshot_key=tkey, error=str(e)[:200])
    ekey = earshot_key_for(stamp, agent, mid)
    t0 = time.time()
    try:
        r = mc_.mc("cp", "--quiet", str(audio), f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{ekey}", timeout=60)
    except Exception as e:  # noqa: BLE001 - fail-open
        log("earshot_mirror_failed", memo_id=mid, key=key, earshot_key=ekey, error=str(e)[:200])
        return None
    if r.returncode != 0:
        log("earshot_mirror_failed", memo_id=mid, key=key, earshot_key=ekey,
            error=f"mc cp rc={r.returncode}: {r.stderr.strip()[-200:]}")
        return None
    log("earshot_mirrored", memo_id=mid, key=key, earshot_key=ekey, ms=int((time.time() - t0) * 1000))
    return ekey


# ------------------------------------------------------------------ text + tts helpers

def build_prompt(transcript: str) -> str:
    return f"{VOICE_PREFIX}{transcript}"


def parse_transcript(md: str) -> str:
    """Strip HeyMa frontmatter/headers; keep the spoken content."""
    lines, in_fm = [], False
    for line in md.splitlines():
        if line.strip() == "---":
            in_fm = not in_fm
            continue
        if in_fm or line.startswith("#"):
            continue
        s = line.strip()
        if s and not s.startswith("**Speaker"):
            lines.append(s)
    return " ".join(lines)


def clean_for_speech(text: str, limit: int) -> str:
    t = re.sub(r"```[\s\S]*?```", " ", text)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", "link", t)
    t = re.sub(r"[*_#>|]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > limit:
        cut = t[:limit]
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        t = cut[: end + 1] if end > limit // 2 else cut.rsplit(" ", 1)[0] + "..."
    return t


def spoken_summary(text: str, limit: int) -> str:
    """What is said aloud of a follow-up's reply. A background turn writes a full report and, as FOLLOWUP_PREFIX asks,
    ENDS with a spoken summary: when the whole text is over `limit`, its closing paragraphs (as many as fit) are spoken,
    not its head (2026-10-22 sim: a 7140-char README report spoke its title and the first list items, while its last
    paragraph was the summary). A reply that fits is spoken whole, as any reply."""
    whole = clean_for_speech(text, 10 ** 9)
    if len(whole) <= limit:
        return whole
    picked: list[str] = []
    for para in reversed([p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]):
        c = clean_for_speech(para, 10 ** 9)
        if not c:
            continue
        if picked and len(" ".join([c, *picked])) > limit:
            break
        picked.insert(0, c)
    return clean_for_speech(" ".join(picked), limit) if picked else clean_for_speech(text, limit)


def reply_key_for(stamp: datetime, agent: str, mid: str) -> str:
    """replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>.ogg: the reply of record (one per memo)."""
    return f"{REPLIES_PREFIX}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}Z-{agent}-{mid}.ogg"


def chunk_key_for(stamp: datetime, agent: str, mid: str, i: int, n: int) -> str:
    """replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>-c<ii>of<nn>.opus: chunk i of n of the same reply. It sorts
    just before the full file (a '-' sorts before '.'), so a listing shows a reply's chunks first and its full file last;
    the count in the name lets a pad that only lists (no push) know when it has them all."""
    return f"{REPLIES_PREFIX}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}Z-{agent}-{mid}-c{i:02d}of{n:02d}.opus"


_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+(?=\S)")


def _cut_at(text: str, room: int) -> tuple[str, str]:
    """Split one over-long sentence: the head (at most `room` characters) ends at a clause mark when there is one past
    40% of the room, else at a word boundary, else hard."""
    if len(text) <= room:
        return text, ""
    window = text[:room]
    cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "), window.rfind(" - "))
    if cut < room * 0.4:
        cut = window.rfind(" ")
        head = text[:cut] if cut > 0 else window
    else:
        head = text[:cut + 1]
    return head.strip(), text[len(head):].strip()


def split_for_speech(spoken: str, limits: tuple[int, ...] | None = None, min_chars: int | None = None) -> list[str]:
    """The spoken reply as the chunks it is voiced in: [spoken] when chunking is off or the reply is short, else
    sentence-packed chunks whose size limit grows (limits[i] for chunk i, the last limit for the rest). A chunk ends at a
    sentence end where it can; a sentence that does not fit is cut at a clause mark or a word. The name prefix always
    stays in the first chunk, and a tiny last chunk joins the one before it."""
    limits = limits or CHUNK_CHARS
    min_chars = CHUNK_MIN_CHARS if min_chars is None else min_chars
    s = re.sub(r"\s+", " ", spoken or "").strip()
    if not s:
        return []
    if not REPLY_CHUNKS or len(s) <= min_chars:
        return [s]
    queue = [x for x in _SENTENCE_END.split(s) if x]
    chunks: list[str] = []
    cur = ""
    while queue:
        sent = queue.pop(0)
        lim = limits[min(len(chunks), len(limits) - 1)]
        room = lim - (len(cur) + 1 if cur else 0)
        if len(sent) <= room:
            cur = f"{cur} {sent}" if cur else sent
            continue
        if cur and len(cur) >= lim * 0.4:
            chunks.append(cur)  # a sentence end is a better place to stop than mid-sentence
            cur = ""
            queue.insert(0, sent)
            continue
        head, tail = _cut_at(sent, max(room, 1))
        cur = f"{cur} {head}" if cur else head
        chunks.append(cur)
        cur = ""
        if tail:
            queue.insert(0, tail)
    if cur:
        chunks.append(cur)
    if len(chunks) > 1 and len(chunks[-1]) < CHUNK_TAIL_CHARS:
        tail = chunks.pop()
        chunks[-1] = f"{chunks[-1]} {tail}"
    if len(chunks) > CHUNK_MAX:
        chunks = chunks[:CHUNK_MAX - 1] + [" ".join(chunks[CHUNK_MAX - 1:])]
    return chunks


def concat_ogg(files: list[Path], out: Path) -> bool:
    """Join the chunk files into one Ogg/Opus reply (re-encoded, so the joined stream has clean timestamps)."""
    if not files:
        return False
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{str(f)}'\n" for f in files), encoding="utf-8")
    try:
        r = subprocess.run([mc_.FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                            "-i", str(lst), "-c:a", "libopus", "-b:a", "40k", "-vn", str(out)],
                           capture_output=True, text=True, timeout=60)
    except Exception as e:  # noqa: BLE001
        log("reply_join_error", "warn", error=f"{type(e).__name__}: {e}"[:200])
        return False
    if r.returncode != 0:
        log("reply_join_error", "warn", rc=r.returncode, error=r.stderr.strip()[-200:])
        return False
    return out.exists() and out.stat().st_size >= 200


class TtsGate:
    """One vox render at a time from this watcher, highest priority first: a fast desk turn, then replies and follow-up
    results, then spoken progress. vox renders on one GPU, one request at a time (two concurrent renders each take twice
    as long, 2026-10-20), so this costs no throughput; what it buys is order. The gate is held for ONE synthesize call and
    released between chunks, so a fast turn queued behind a 3-chunk follow-up starts after the current chunk, not all 3.
    Waiters of equal priority go in arrival order."""

    FAST, REPLY, NARRATION = 0, 1, 2

    def __init__(self):
        self._cv = threading.Condition()
        self._busy = False
        self._queue: list[tuple[int, int]] = []
        self._seq = 0

    @contextlib.contextmanager
    def hold(self, prio: int):
        with self._cv:
            self._seq += 1
            me = (prio, self._seq)
            heapq.heappush(self._queue, me)
            while self._busy or self._queue[0] != me:
                self._cv.wait(1.0)
            heapq.heappop(self._queue)
            self._busy = True
        try:
            yield
        finally:
            with self._cv:
                self._busy = False
                self._cv.notify_all()

    def waiting(self) -> int:
        with self._cv:
            return len(self._queue)


TTS_GATE = TtsGate()


def synth_kw(steps: int | None, prio: int | None, voice: str | None = None) -> dict:
    """synthesize()'s optional arguments, only those that differ from a plain reply render (a tile's own voice is passed;
    the default voice is not)."""
    kw = {}
    if steps:
        kw["steps"] = steps
    if prio is not None and prio != TtsGate.REPLY:
        kw["prio"] = prio
    if voice and voice != VOICE:
        kw["voice"] = voice
    return kw


def fixed_lines() -> list[str]:
    """The desk's lines that never change with the turn (converse.py), the texts the PhraseBank keeps rendered."""
    names = ("NOTHING_PENDING_LINE", "DROPPED_LINE", "NOTHING_TO_CANCEL_LINE", "END_LINE", "EXPIRED_LINE",
             "SENDING_CANCELLED_LINE", "DRAFT_CHANGED_LINE", "DIDNT_CATCH_LINE")
    lines = [v for v in (getattr(cv, n, None) for n in names) if isinstance(v, str) and v and "{" not in v]
    lines += [*cv.HOLD_CUE_LINES, *cv.HOLD_CUE2_LINES]  # the hold cues (also pre-rendered per voice)
    out: list[str] = []
    for line in lines:  # a long line is voiced in chunks: each chunk is what the bank is asked for
        for part in split_for_speech(clean_for_speech(line, SPEAK_CHARS), CONVERSE_CHUNK_CHARS, CONVERSE_CHUNK_MIN_CHARS):
            if part not in out:
                out.append(part)
    return out


class PhraseBank:
    """Pre-rendered audio of fixed utterances, per (voice, steps, text), on disk under <state>/phrases/. A lookup is a file
    check; a miss renders as usual and a fixed line is kept after its first render. Never raises: a broken bank is a miss."""

    def __init__(self, directory: Path, lines=fixed_lines, enabled: bool = True):
        self.dir = directory
        self.lines = lines
        self.enabled = enabled
        self.hits = 0

    @staticmethod
    def norm(text: str) -> str:
        return re.sub(r"\s+", " ", text or "").strip()

    def _path(self, text: str, voice: str, steps: int | None) -> Path:
        h = hashlib.sha256(f"{voice}|{steps or 0}|{self.norm(text)}".encode()).hexdigest()[:24]
        return self.dir / f"{h}.ogg"

    def banked(self, text: str) -> bool:
        return self.norm(text) in {self.norm(x) for x in self.lines()}

    def get(self, text: str, voice: str, steps: int | None) -> Path | None:
        if not self.enabled or not self.banked(text):
            return None
        p = self._path(text, voice, steps)
        try:
            return p if p.stat().st_size >= 200 else None
        except OSError:
            return None

    def put(self, text: str, voice: str, steps: int | None, audio: Path, engine: str | None = None) -> None:
        if not self.enabled or not self.banked(text):
            return
        if engine is not None and engine not in PHRASEBANK_ENGINES:
            log("phrasebank_skip", "warn", engine=engine, voice=voice, chars=len(text), note="fallback engine render not banked")
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            p = self._path(text, voice, steps)
            tmp = p.with_suffix(".tmp")
            shutil.copyfile(audio, tmp)
            os.replace(tmp, p)
        except OSError:
            pass

    def warm(self, voices: list[str], steps: int | None, render) -> int:
        """Render every fixed line that is not on disk for each voice, one at a time at the lowest vox priority, and stop at
        once if anything with a higher priority is waiting. render(text, voice) -> audio Path. Returns the lines rendered."""
        n = 0
        for voice in voices:
            for text in self.lines():
                if STOP or TTS_GATE.waiting():
                    return n
                if self.get(text, voice, steps) is not None:
                    continue
                try:
                    self.put(text, voice, steps, render(text, voice))
                    n += 1
                except Exception as e:  # noqa: BLE001 - vox down or voice unknown: the line renders on demand later
                    log("phrasebank_warm_failed", "warn", voice=voice, error=f"{type(e).__name__}: {e}"[:160])
                    return n
        return n


class VoiceNotFound(StageError):
    """vox does not know the voice asked for (a tile's voice that was removed or mistyped): the render falls back to the
    default voice at once, never into the 1800 s TTS retry budget."""


def synthesize(text: str, tmp: Path, voice: str | None = None, steps: int | None = None,
               prio: int = TtsGate.REPLY) -> tuple[Path, str]:
    """vox /synthesize-url -> OGG/Opus file. Returns (path, engine that served it). `steps` trades quality for speed
    (diffusion steps; vox defaults to 10): progress updates and fast desk turns use fewer. `prio` orders it in TTS_GATE.
    Raises VoiceNotFound when vox says the voice does not exist (HTTP 500 "voice 'x' not found")."""
    body = {"text": text, "voice": voice or VOICE}
    if steps:
        body["steps"] = steps
    req = urllib.request.Request(f"{mc_.VOX_URL}/synthesize-url", method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with TTS_GATE.hold(prio):
            with urllib.request.urlopen(req, timeout=120) as resp:
                meta = json.loads(resp.read())
            with urllib.request.urlopen(meta["audio_url"], timeout=60) as resp:
                blob = resp.read()
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            detail = ""
        if re.search(r"voice\s+'[^']*'\s+not found", detail, re.I):
            raise VoiceNotFound("tts", "voice_not_found", f"vox: {detail}", retryable=False) from e
        raise StageError("tts", "vox_failed", f"vox synth failed: HTTPError {e.code}: {detail or e.reason}") from e
    except Exception as e:  # noqa: BLE001
        raise StageError("tts", "vox_failed", f"vox synth failed: {type(e).__name__}: {e}") from e
    if len(blob) < 200:
        raise StageError("tts", "vox_empty", f"vox returned {len(blob)} bytes")
    out = tmp / "reply.ogg"
    out.write_bytes(blob)
    return out, meta.get("engine", "unknown")


# ------------------------------------------------------------------ main

# ---- wake listener (HOLOC-23 phase 2) ---------------------------------------------------------------------------
# The upload proxy POSTs /wake {key, size, etag, uploaded_at} the moment it has stored a memo, so the memo starts then
# instead of at the next `mc ls` tick (0.7 s typical, 6 s p50 on a loaded host; the main loop is also BLOCKED for the
# whole listing, so a stage that finished meanwhile waited too). The hint is exactly one listing entry: discover() takes
# it like a listing and skips keys it knows (memo ids are uuid5 of the key), so a hint plus the poll can never start a
# memo twice. Fail-open: no hint, a bad hint, a closed port -> the poll finds the memo as before. MEMO_WAKE_PORT=0 off.
WAKE_PORT = int(os.environ.get("MEMO_WAKE_PORT", "8697"))
WAKE_KEY_RE = re.compile(r"^inbox/[A-Za-z0-9_.-]+/\d{4}/\d{2}/\d{2}/[^/\\\x00-\x1f]+$")


def wake_entry(raw) -> dict | None:
    """The listing entry for one hint body, or None when it is not a plausible inbox audio object."""
    if not isinstance(raw, dict):
        return None
    key, size = raw.get("key"), raw.get("size")
    if (not isinstance(key, str) or len(key) > 300 or not WAKE_KEY_RE.match(key) or ".." in key.split("/")
            or not key.lower().endswith(mc_.AUDIO_EXTS)):
        return None
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        return None
    etag = raw.get("etag")
    etag = etag if isinstance(etag, str) and re.fullmatch(r"[0-9a-f]{32}", etag) else None
    when = mc_.parse_iso(raw.get("uploaded_at")) if isinstance(raw.get("uploaded_at"), str) else None
    return {"key": key, "size": size, "etag": etag, "last_modified": when or now_utc()}


def wake_apply(w: "Watcher", entry: dict) -> bool:
    """Discover the memo and run its quick stage now, in the caller's thread, under the watcher lock. The main loop may
    be inside a 2 s listing, so waiting for it to notice WAKE would waste the time this exists to save."""
    with w.mu:
        before = len(w.s.memos)
        w.discover(([entry], None))
        m = w.s.memos.get(entry["key"])
        new = len(w.s.memos) > before
        # tick()'s own gate for a memo: active, not running, due. receive is inline, transcribe goes to its pool.
        for _ in range(2):
            if (new and m and m.get("status") == "active" and m["stage"] in ("receive", "transcribe")
                    and m["key"] not in w.running and m.get("next_at", 0) <= time.time() and not STOP):
                w.advance(m)
    WAKE.set()
    if new and m:
        log("wake_hint", memo_id=m["memo_id"], key=entry["key"], agent=m.get("agent"), stage=m.get("stage"),
            note="started by the upload proxy's hint, not the listing")
    return new


def start_wake_listener(w: "Watcher", port: int = WAKE_PORT) -> "http.server.ThreadingHTTPServer | None":
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            entry = None
            try:
                n = min(int(self.headers.get("Content-Length", 0)), 4096)
                entry = wake_entry(json.loads(self.rfile.read(n) or b"{}")) if self.path == "/wake" else None
            except (ValueError, OSError):
                pass
            self.send_response(202 if entry else 400)  # answered first: the proxy never waits for the work below
            self.send_header("Content-Length", "0")
            self.end_headers()
            if entry:
                try:
                    wake_apply(w, entry)
                except Exception as e:  # noqa: BLE001 - the poll still finds it
                    log("wake_failed", "warn", key=entry["key"], error=f"{type(e).__name__}: {e}"[:200])

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_):
            pass

    if port <= 0:
        return None
    try:
        srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        log("wake_listener_unavailable", "warn", port=port, error=str(e)[:200], note="the 1 s poll still finds every memo")
        return None
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="wake-listener", daemon=True).start()
    log("wake_listener", port=port)
    return srv


# Early push to the car (HOLOC-23 phase 2): a fact reaches the pad through bb-emit -> NATS -> the proxy's SSE (0.12-0.25 s of
# subprocess for each of voiced / transcribed). push_hint() tells the proxy the same thing over loopback HTTP (~2 ms) just
# before the fact is emitted; the proxy pushes it at once and drops the NATS copy as a duplicate. Fail-open and bounded: a
# proxy that is down or slow costs nothing but the time it would have saved. `data` must carry the keys the fact carries
# (chunk_s3_key / reply_s3_key / progress_s3_key, chunk, chunks, narration, seq) or the duplicate is not recognised.
# Off unless MEMO_PUSH_HINT_URL is set (the unit sets it): a test, a bench or a hand run never reaches the live proxy. A watcher on
# any bucket but the live one (MEMO_PUSH_HINT_BUCKET, default holocene-auto) never hints either, so a scratch-bucket A/B that
# copied the unit's environment cannot push its memos into the car's replay ring.
PUSH_HINT_URL = os.environ.get("MEMO_PUSH_HINT_URL", "")
if BUCKET != os.environ.get("MEMO_PUSH_HINT_BUCKET", "holocene-auto"):
    PUSH_HINT_URL = ""
PUSH_HINT_TIMEOUT_S = float(os.environ.get("MEMO_PUSH_HINT_TIMEOUT_S", "0.3"))
PUSH_HINT_ACTIONS = ("received", "transcribed", "dispatched", "narrated", "voiced", "replied")


def push_hint(action: str, memo_id: str, data: dict, url: str | None = None) -> bool:
    url = PUSH_HINT_URL if url is None else url
    if not url or action not in PUSH_HINT_ACTIONS:
        return False
    try:
        req = urllib.request.Request(url, data=json.dumps({"action": action, "memo_id": memo_id, "data": data},
                                                          separators=(",", ":"), default=str).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=PUSH_HINT_TIMEOUT_S) as r:
            return r.status == 202
    except Exception:  # noqa: BLE001 - the fact itself still reaches the car through NATS
        return False


def main() -> int:
    global STOP
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="run a single tick and exit")
    ap.add_argument("--drain", action="store_true",
                    help="with --once: keep ticking until no memo is active (or --drain-timeout)")
    ap.add_argument("--drain-timeout", type=int, default=1500)
    # S3 inbox listing period. A listing of inbox/ is one mc call (~0.2 s for tens of objects), so 1 s is cheap; it
    # was 5 s, which averaged 2.5 s of pure waiting before a car memo was even noticed.
    ap.add_argument("--poll", type=float, default=float(os.environ.get("MEMO_POLL_S", "1")))
    args = ap.parse_args()

    def _stop(*_):
        global STOP
        STOP = True  # nothing else: WAKE.set() takes a lock the interrupted frame may hold; the loop waits <= TICK_S
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    # One watcher per state dir: two processes would dispatch the same memo twice (different command ids).
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock = open(STATE_DIR / "lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("already_running", "error", state_dir=str(STATE_DIR),
            note="another watcher holds the lock (holocene-inbox-watcher.service?); stop it first or use `mise run memo:trace`")
        return 3
    lock.write(str(os.getpid()))
    lock.flush()

    state = State(STATE_DIR)
    w = Watcher(state)
    w.lane_probe = LaneProbe()
    w.lane_probe.start()
    w.status_writer.start()
    w.start_progress_watch()
    # The fast desk: bb-emit must accept its two facts before they are ever queued, and its keys are read once now (off
    # the critical path, memory only) so the heartbeat can say whether they work before the switch is flipped on.
    w.check_contracts()
    threading.Thread(target=w.desk.warm_keys, name="converse-keys", daemon=True).start()
    cs = w.desk.settings()
    log("starting", lane=LANE, poll_s=args.poll, state=str(state.path), bucket=BUCKET, agent_timeout_s=AGENT_TIMEOUT_S,
        first_start=state.fresh, converse=cs["mode"], converse_source=cs["source"],
        converse_routes=[r["id"] for r in cs["routes"]], converse_refused=[r.get("id") for r in cs["refused"]] or None,
        converse_tiles={a: {k: t.get(k) for k in ("voice", "model") if t.get(k)} for a, t in (cs.get("tiles") or {}).items()} or None,
        converse_budget_s=w.desk.budget_s)
    while True:
        try:
            w.baseline_if_first_start()
            break
        except Exception as e:  # noqa: BLE001
            log("baseline_failed", "error", error=str(e)[:300], note="retrying; no state created from a failed listing")
            if STOP or args.once:
                return 1
            time.sleep(10)

    # after the baseline: on a first start the existing inbox objects are baselined, never replayed as "new" by the watch thread
    w.start_discovery_watch()
    start_wake_listener(w)   # also after the baseline: a hint must never create a memo the baseline then overwrites
    w.warm_phrases()
    deadline = time.time() + args.drain_timeout
    last_discover = 0.0
    while not STOP:
        # S3 is listed every --poll seconds; pending steps run every second so a stage
        # never waits a whole poll interval for the next one.
        # A slow or failing MinIO is listed less often: at least twice the last listing's duration apart.
        period = max(args.poll, 2 * w.last_list_s)
        do_discover = time.time() - last_discover >= period
        failed = False
        try:
            w.tick(discover=do_discover)
        except Exception as e:  # noqa: BLE001
            failed = True
            log("tick_error", "error", error=f"{type(e).__name__}: {e}")
        if do_discover:
            last_discover = time.time()  # stamped after the tick, so a slow listing is not followed by another at once
        if args.once and not (args.drain and w.active() and time.time() < deadline):
            break
        if failed:
            time.sleep(1)  # a tick that raises before advancing would otherwise spin at the 0.05 s floor
            continue
        WAKE.wait(w.sleep_for(period - (time.time() - last_discover)))
        WAKE.clear()
    w.shutdown(wait=args.once)
    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

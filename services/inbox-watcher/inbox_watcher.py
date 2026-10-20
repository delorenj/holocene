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
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memo_common as mc_  # noqa: E402
from memo_common import (  # noqa: E402
    BB_EMIT, BUCKET, CANCELLED, ESCALATED_REASON, REPLIES_PREFIX, STATE_DIR, agent_from_key, cancel_after_dispatch,
    iso, memo_escalated, memo_id_for, now_utc, rescue_open, resume_for, truncated_by_old_watcher,
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
MAX_ATTEMPTS = int(os.environ.get("MEMO_MAX_ATTEMPTS", "3"))
MIN_AUDIO_S = float(os.environ.get("MEMO_MIN_AUDIO_S", "0.7"))
SILENT_MAX_DBFS = mc_.SILENT_MAX_DBFS  # loudest-sample line below which a recording is silent (see memo_common)
# Prepended to the transcript so the agent knows it is speech-to-text, not typed text, and that the driver hears what it
# says while it works: the gateway publishes every sentence the model writes next to a tool call
# (agent.invocation.progressed) and the watcher speaks the newest one every 30 s. Without the ask most memo turns write
# none (measured 2026-10-20: 0-4 of 8-18 tool rounds carried text), and a 2-minute turn is 2 minutes of silence.
VOICE_PREFIX = os.environ.get("MEMO_VOICE_PREFIX", "[Voice memo transcript - speech-to-text, may contain recognition errors. "
                              "The driver hears your progress aloud while you work: before each tool call, write one short "
                              "sentence saying what you are about to do.] ")
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
# The phone copy is left out for a memo whose sending car is live (it speaks the reply itself, and a paired phone plays
# through the car's speakers): the upload proxy knows which car sent a memo and whether its push stream is open.
# MEMO_EARSHOT_SKIP_CAR=0 mirrors every reply again.
EARSHOT_SKIP_CAR = os.environ.get("MEMO_EARSHOT_SKIP_CAR", "1") != "0"
PRESENCE_URL = os.environ.get("MEMO_PAD_PRESENCE_URL", "https://agent-pad.delo.sh/upload/presence")
PRESENCE_TIMEOUT_S = float(os.environ.get("MEMO_PAD_PRESENCE_TIMEOUT_S", "4"))
NOTIFIED_TYPE = "bloodbank.audio.memo.notified"
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
BACKOFF = {"download": 10, "transcribe": 20, "dispatch": 10, "agent_reply": 5, "tts": 15, "reply_upload": 10}

# Stages that fail for infrastructure reasons (S3, NATS, vox) retry on a TIME budget, not a count:
# a minute of vox trouble after the agent already ran must not strand the work. Backoff is capped at 300 s.
_budget = os.environ.get("MEMO_RETRY_BUDGET_S")
RETRY_BUDGET_S = {"download": 600, "dispatch": 900, "tts": 1800, "reply_upload": 1800}
if _budget is not None:
    RETRY_BUDGET_S = {k: float(_budget) for k in RETRY_BUDGET_S}

# Where a failed memo resumes when `memo:retry` (or the late rescue) revives it.
RESUME_STAGE = {"receive": "receive", "download": "transcribe", "transcribe": "transcribe", "dispatch": "dispatch",
                "agent": "dispatch", "agent_reply": "reply", "tts": "speak", "reply_upload": "speak"}
FAIL_STAGE = {"receive": "receive", "transcribe": "transcribe", "dispatch": "dispatch", "await_agent": "agent",
              "reply": "agent_reply", "speak": "tts"}
SLOW_STAGES = {"transcribe": "transcribe", "dispatch": "io", "speak": "io"}  # run off the tick thread

STOP = False


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
    for k in ("live", "live_ts", "cs_checked_ts"):  # await-stage probe caches
        m.pop(k, None)


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
        r = subprocess.run([mc_.MC_BIN, "pipe", "--quiet", "--attr", STATUS_ATTR, mc_.s3_url(key)],
                           input=body, capture_output=True, timeout=20)
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"[:200]
    if r.returncode != 0:
        return False, f"mc pipe rc={r.returncode}: {r.stderr.decode('utf-8', 'replace').strip()[-200:]}"
    return True, ""


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
    if stage == "dispatch":
        # an escalated memo goes back through dispatch on its way to the batch lane: the agent is still on it
        return "working" if m.get("escalated") else "heard"
    if stage == "await_agent":
        return "working"
    if stage in ("reply", "speak"):
        return "replying"
    return "received"


def memo_started_ts(m: dict) -> float:
    """When the memo started, for the car's 'Working 1:20': the upload (the device's Stop & Send), else detection."""
    up = mc_.parse_iso(m.get("uploaded_at"))
    return up.timestamp() if up else float(m.get("detected_ts") or time.time())


def status_doc(m: dict) -> dict:
    """The car's status document for one memo (schema: services/inbox-watcher/README.md, "Status object")."""
    now = time.time()
    started = memo_started_ts(m)
    stage = car_stage(m)
    heard = re.sub(r"\s+", " ", m.get("transcript") or "").strip()[:HEARD_CHARS] or None
    doc = {
        "v": 1, "memo_id": m["memo_id"], "agent": m.get("agent"),
        "agent_name": m.get("display_name") or (m.get("agent") or "").replace("-", " ") or None,
        "s3_key": m["key"], "stage": stage, "heard": heard,
        "progress": m.get("progress_text"), "progress_seq": m.get("progress_seq", 0),
        "progress_at": iso(m["progress_ts"]) if m.get("progress_ts") else None,
        # the newest progress clip: progress/<day>/<memo_id>-<spoken_seq>.ogg (1..n per memo, the pad's playback cursor)
        "spoken_seq": m.get("narr_count") or None, "spoken_key": m.get("narr_key"),
        "narration": ({"n": m["narr_count"], "key": m.get("narr_key"), "seq": m.get("narr_src_seq"),
                       "at": iso(m["narr_last_ts"]) if m.get("narr_last_ts") else None, "text": m.get("narr_text")}
                      if m.get("narr_count") else None),
        "started_at": iso(started), "dispatched_at": iso(m["dispatched_ts"]) if m.get("dispatched_ts") else None,
        "updated_at": iso(now), "elapsed_s": round(max(0.0, now - started), 1),
        "command_id": m.get("command_id"), "lane": m.get("lane"),
        "late": bool(m.get("late")), "escalated": bool(m.get("escalated")),
        "reply_key": m.get("reply_key"),
    }
    if m.get("reply_chunks"):
        # the reply is being spoken chunk by chunk: how many it has and how many are up (replies/...-cNNofMM.opus)
        doc["reply_chunks"] = {"n": m["reply_chunks"], "voiced": m.get("voiced_n", 0)}
    if stage == "failed":
        code = m.get("failed_code") or m.get("status")
        doc["error_code"] = code
        doc["error"] = (m.get("failed_message") or str(code))[:300]
    return doc


def rescue_closes_at(m: dict) -> float:
    """When a failed memo stops being watched for a late reply. The window runs from the command's own deadline for an
    escalated batch turn (a turn that ends at its 2 h deadline would otherwise find the 2 h window already shut and
    its reply dropped), and from the dispatch for everything else."""
    start = m.get("deadline_ts") if memo_escalated(m) and m.get("deadline_ts") else m.get("dispatched_ts", 0)
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
                      # spoken progress renders on its own worker: a 2 s vox call never holds up a stage
                      "narrate": concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="narrate")}
        self.last_rescue = 0.0
        self.lane_probe: LaneProbe | None = None  # started by main(); tests leave it off
        self.status_writer = StatusWriter()       # its thread is started by main(); tests drain() it
        self.narrating: set[str] = set()          # memo keys with a progress render in flight
        self.progress_err: str | None = None

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
        for p in self.pools.values():
            p.shutdown(wait=wait, cancel_futures=not wait)

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
        if stage in ("receive", "transcribe"):
            # A new prompt is a new ask: nothing of the old command, or of the escalation it went through, carries over.
            self.drop_command(m)
            for k in ("escalated", "escalated_from_command_id", "escalated_ts", "late", "rescue_closed"):
                m.pop(k, None)
        elif stage == "dispatch" and (failed == "agent" or (failed == "agent_reply" and m.get("failed_code") == mc_.TURN_TIMEOUT)):
            was_escalated = bool(m.get("escalated"))  # the old command was rejected or failed: send a fresh one
            self.drop_command(m)
            if was_escalated:
                # Sticky lane: a memo that already escalated is a long ask. Its retry rides the batch lane (reason
                # unchanged) instead of timing out on the interactive one with no escalation left.
                m["lane"], m["lane_reason"] = "batch", ESCALATED_REASON
        if stage == "await_agent":
            # an escalated command is a batch turn: it is waited for as long as it was the first time
            m["deadline_ts"] = time.time() + (BATCH_TURN_TIMEOUT_S if memo_escalated(m) else AGENT_TIMEOUT_S)
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
        if after and memo_escalated(m) and not m.get("publish_attempted") and stage not in ("await_agent", "reply", "speak"):
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
                if st.get("code") == mc_.TURN_TIMEOUT and self.can_escalate(m):
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
        listing = self.list_inbox() if discover else None
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
            self.s.save()
            counts: dict[str, int] = {}
            for m in self.s.memos.values():
                counts[m["status"]] = counts.get(m["status"], 0) + 1
            self.s.heartbeat({
                "lane": LANE, "lanes": self.lane_probe.snapshot() if self.lane_probe else {},
                "memos": counts, "outbox": len(self.s.data["outbox"]),
                "active": [{"memo_id": m["memo_id"], "key": m["key"], "stage": m["stage"],
                            "running": m["key"] in self.running,
                            "step_s": int(time.time() - m["step_started_ts"]) if m.get("step_started_ts") else None}
                           for m in self.active()]})

    def sleep_for(self, until_discover: float) -> float:
        """Seconds the main loop may sleep: until the earliest due memo or the next listing, never above TICK_S."""
        now = time.time()
        with self.mu:
            due = [m.get("next_at", 0) - now for m in self.active() if m["key"] not in self.running]
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
        step = {"receive": self.step_receive, "transcribe": self.step_transcribe,
                "dispatch": self.step_dispatch, "await_agent": self.step_await_agent,
                "reply": self.step_reply, "speak": self.step_speak}[stage]
        t0 = time.time()
        try:
            step(m)
        except StageError as e:
            with self.mu:
                self._settle_error(m, e)
        except Exception as e:  # noqa: BLE001
            with self.mu:
                self._settle_error(m, StageError(FAIL_STAGE[stage], "unexpected", f"{type(e).__name__}: {e}", True))
        finally:
            WAKE.set()  # a step ended: let the main loop pick up what it unblocked (first, so a failing save cannot skip it)
            with self.mu:
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
            m["status"] = "failed"
            m["failed_stage"] = e.stage
            m["failed_code"] = e.code
            m["failed_message"] = e.message[:300]
            m["resume_stage"] = ("await_agent" if e.stage == "agent_reply" and e.code == "timeout" and m.get("command_id")
                                 else "dispatch" if e.stage == "agent_reply" and e.code == mc_.TURN_TIMEOUT  # fresh command
                                 else RESUME_STAGE.get(e.stage, "receive"))
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
        self.fact("received", m, {"size_bytes": m.get("size"), "content_type": ctype,
                                  "uploaded_at": m.get("uploaded_at"), "detected_at": iso(det),
                                  "detect_lag_ms": lag})
        m["received_ts"] = time.time()
        # Fail in 1 ms, not after 45 s of Whisper and a 10 minute wait: the gateway consumes a command
        # for an unroutable agent and drops it without a journal row or a fact.
        route = mc_.registry_route(m["agent"])
        if route["ok"] is False:
            raise StageError("dispatch", "unknown_agent", route["reason"], retryable=False)
        m["display_name"] = mc_.spoken_name(m["agent"], route)
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

            # Fail fast on audio nothing can decode, and size the timeout from the real duration.
            probe = mc_.probe_audio(audio)
            if probe["ok"] is False:
                raise StageError("transcribe", "undecodable_audio", f"ffprobe cannot read the upload: {probe['error']}", retryable=False)
            audio_s = probe["duration"]
            if probe["ok"] and audio_s is not None and audio_s < MIN_AUDIO_S:
                raise StageError("transcribe", "too_short", f"recording is {audio_s:.2f}s (< {MIN_AUDIO_S}s): an accidental tap, not a prompt",
                                 retryable=False)

            # Measure the level BEFORE spending a transcription: a dead microphone (a corked emulator capture, a
            # revoked permission, a muted car mic) records a perfectly valid file of digital silence, and "the
            # transcript is empty" says nothing about why. Every later failure of this stage carries the levels.
            levels = mc_.measure_levels(audio)
            lvl = level_fields(levels)
            log("audio_level", memo_id=mid, key=key, agent=agent, stage="transcribe", audio_s=audio_s, **lvl,
                measured=levels["ok"], error=levels["error"])
            silent = silent_reason(levels, audio_s)
            if silent:
                raise StageError("transcribe", silent[0], silent[1], retryable=False,
                                 extra={**lvl, "audio_duration_seconds": round(audio_s, 2) if audio_s is not None else None})
            try:
                return self._transcribe_run(tmp, audio, mid, key, agent, audio_s, levels, lvl, timeouts)
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
                        levels: dict, lvl: dict, timeouts: int) -> dict:
        timeout = transcribe_timeout(audio_s, timeouts)

        out_md = tmp / (audio.stem + ".md")
        tlog = tmp / "transcribe.log"
        env = {**os.environ, "TRANSCRIBE_DIR": TRANSCRIBE_DIR, "TRANSCRIBE_LOG_FILE": str(tlog)}
        # --output keeps the transcript out of ~/d/Transcripts (--ephemeral only skips S3 archiving)
        cmd = [TRANSCRIBE, str(audio), "--no-diarization", "--ephemeral", "--output", str(out_md)]
        log("transcribe_start", memo_id=mid, key=key, agent=agent, stage="transcribe",
            audio_s=audio_s, timeout_s=timeout)
        t1 = time.time()
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
        junk = junk_reason(text, audio_s or meta.get("duration_seconds"), levels)
        if junk:
            raise StageError("transcribe", junk[0], junk[1], retryable=False)
        return {"text": text, "meta": meta, "took": took, "audio_s": audio_s, "levels": lvl}

    def _transcribe_apply(self, m: dict, w: dict) -> None:
        text, meta, took = w["text"], w["meta"], w["took"]
        if len(text) > MAX_TRANSCRIPT_CHARS:
            raise StageError("transcribe", "transcript_too_long",
                             f"transcript is {len(text)} chars, over the {MAX_TRANSCRIPT_CHARS} limit: held, not cut; "
                             "a prompt is never sent shortened", retryable=False)
        m["transcript"] = text
        m["prompt"] = build_prompt(text)
        m["prompt_sha256"] = hashlib.sha256(m["prompt"].encode()).hexdigest()  # saved with the step, before any publish
        self.fact("transcribed", m, {
            "transcript_text": m["transcript"], "transcript_chars": len(text),
            "word_count": meta.get("word_count") or len(text.split()),
            "audio_duration_seconds": meta.get("duration_seconds") or w["audio_s"],
            "processing_seconds": round(took, 2), "model": meta.get("model"),
            "backend": meta.get("backend"), "language": meta.get("language"), **w.get("levels", {})})
        m.update({k: v for k, v in w.get("levels", {}).items() if v is not None})
        self.done_stage(m, "transcribed", "dispatch", ms=took * 1000, chars=len(text),
                        audio_s=meta.get("duration_seconds") or w["audio_s"], model=meta.get("model"),
                        text=text[:120])

    # -- dispatch (worker thread) --

    def _prompt_for_send(self, m: dict) -> str:
        """The exact prompt to dispatch, proven to be the one that was transcribed: its sha256 was recorded with the
        transcript and must still match. A memo with nothing to send is held, never sent empty."""
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
                        note="no puller on either lane (gateway down or restarting); queued on the interactive lane, "
                             "which drains first when the gateway reconnects")
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
            route = mc_.registry_route(m["agent"])
            if route["ok"] is False:
                raise StageError("dispatch", "unknown_agent", route["reason"], retryable=False)
            m["thread_id"] = m["memo_id"]  # unique per memo: the agent session's chat_id (exact reply lookup)
            prompt = self._prompt_for_send(m)
            escalated = memo_escalated(m)
            context = {"memo_id": m["memo_id"], "memo_key": m["key"],
                       "source": "holocene-auto:inbox-watcher", "repo": "holocene", "reason": "voice-inbox"}
            if escalated:
                context["escalated_from_command_id"] = m.get("escalated_from_command_id")
            data = {
                "target_agent_id": m["agent"], "prompt": prompt, "thread_id": m["thread_id"],
                "turn_id": None,
                "context": context,
            }
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
        if live.get("ok") is False:
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
        prompt = m.get("prompt") or m.get("transcript", "")
        escalated = memo_escalated(m)
        m["command_envelope_id"] = ids.get("id")
        m["dispatched_ts"] = time.time()
        # An escalated command is a batch turn with no gateway wall clock: the watcher waits for it much longer.
        m["deadline_ts"] = m["dispatched_ts"] + (BATCH_TURN_TIMEOUT_S if escalated else AGENT_TIMEOUT_S)
        m.pop("dropped_since", None)
        self.fact("dispatched", m, {
            "command_id": cid, "idempotency_key": ids.get("idempotency_key"),
            "command_subject": ids.get("subject") or mc_.LANE_COMMAND_TYPES[memo_lane(m)],
            "lane": memo_lane(m), "lane_reason": m.get("lane_reason"),
            "thread_id": m.get("thread_id"), "prompt_chars": prompt_chars if prompt_chars is not None else len(prompt),
            "prompt_sha256": m.get("prompt_sha256") or hashlib.sha256(prompt.encode()).hexdigest(),
            "voice_prefix": bool(VOICE_PREFIX), "dispatch_ms": int(ms),
            **({"escalated_from_command_id": m.get("escalated_from_command_id")} if escalated else {})})
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
                return {**out, "state": "done", "source": "journal", "detail": f"journal completed/success ({row['updated_at']})"}
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

    def can_escalate(self, m: dict) -> bool:
        """An interactive turn the gateway stopped may be re-dispatched on the batch lane, once per memo. A batch turn
        that times out (an envelope deadline), a memo that already escalated, and MEMO_BATCH_TURN_TIMEOUT_S=0 (the
        off switch) all fail the memo as a turn timeout, as before."""
        return BATCH_TURN_TIMEOUT_S > 0 and not m.get("escalated") and memo_lane(m) == "interactive"

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
        if st["state"] == "done":
            m["profile"] = st.get("profile") or m["agent"]
            m["agent_seconds"] = round(waited, 2)
            m["agent_done_ts"] = time.time()
            if memo_escalated(m):
                m["late"] = True  # the answer to a long ask comes back on the batch lane: it is spoken as a late reply
            return self.done_stage(m, "agent", "reply", ms=waited * 1000, command_id=m["command_id"],
                                   source=st["source"], profile=m["profile"])
        if st["state"] == "failed":
            if st.get("code") == mc_.TURN_TIMEOUT:
                if self.can_escalate(m):
                    t = st.get("timeout") or {}
                    if t.get("turn_stopped") is False and not self.unwound(m, t):
                        return  # waiting a moment for the stopped-unconfirmed turn to unwind before the batch turn starts
                    return self.escalate(m, st, waited)
                # Not "agent failed": the agent was still working when the gateway ran out its per-turn
                # wall clock and stopped it. Reported on the agent_reply stage (no reply will ever arrive).
                t = st.get("timeout") or {}
                extra = {k: t[k] for k in ("lane", "elapsed_seconds", "timeout_seconds", "timeout_source", "turn_stopped")
                         if t.get(k) is not None}
                raise StageError("agent_reply", mc_.TURN_TIMEOUT, st["detail"], retryable=False, extra=extra)
            raise StageError("agent", st.get("code", "agent_failed"), f"{st['detail']} (via {st['source']})", retryable=False)

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
                    raise StageError("agent", "gateway_terminated",
                                     f"gateway consumed command {m['command_id']} without a journal row and the consumer is empty "
                                     f"({lane} consumer pending=0 ack_pending=0): it was rejected before starting, or abandoned after exhausting its redeliveries (max_deliver). "
                                     f"gateway log: {why[-1] if why else 'no matching line in ' + mc_.GATEWAY_UNIT}",
                                     retryable=False)
            else:
                m.pop("dropped_since", None)

        if time.time() >= m["deadline_ts"]:
            # An escalated batch turn already has its long deadline: it is not stretched further.
            if waited < QUEUE_MAX_WAIT_S and not memo_escalated(m):
                live = live or mc_.gateway_liveness(lane)
                ahead = (live.get("num_pending") or 0) + (live.get("num_ack_pending") or 0)
                if st["state"] == "running" or (st["state"] == "pending" and live.get("ok") and ahead > 0):
                    m["deadline_ts"] = min(time.time() + AGENT_TIMEOUT_S, m["dispatched_ts"] + QUEUE_MAX_WAIT_S)
                    log("deadline_extended", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                        command_id=m["command_id"], waited_s=int(waited), state=st["state"], detail=st["detail"],
                        lane=lane, gateway=mc_.gateway_liveness_text(live, lane),
                        note="command is still queued or running; extending instead of failing")
                    m["next_at"] = time.time() + AWAIT_POLL_S
                    return
            live_text = mc_.gateway_liveness_text(live, lane) if live else mc_.gateway_liveness_text(lane=lane)
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
        found = mc_.find_reply(m.get("profile") or m["agent"], m["thread_id"],
                               prompt_sha256=m.get("prompt_sha256"), since=m.get("dispatched_ts"))
        if not found or not found.get("text"):
            raise StageError("agent_reply", "no_reply_text",
                             f"turn completed but no assistant text in {m.get('profile')} session chat_id={m['thread_id']}"
                             f" ({'no session' if not found else 'session ' + found['session_id'] + ' has no assistant text'})")
        ts = found.get("timestamp")
        if memo_escalated(m) and isinstance(ts, (int, float)) and ts < m.get("dispatched_ts", 0) - REPLY_FRESH_SLACK_S:
            # The escalated turn shares the stopped turn's thread id, so a batch turn that wrote no text leaves the
            # stopped turn's partial output as the newest assistant message. That is not an answer: never speak it.
            raise StageError("agent_reply", "no_reply_text",
                             f"the batch turn completed but wrote no assistant text: the newest one in {m.get('profile')} session "
                             f"chat_id={m['thread_id']} predates the escalated command (the stopped turn's partial output)")
        m["reply_text"] = found["text"]  # kept whole: compact() trims it to a preview once the memo is done
        m["session_id"] = found["session_id"]
        # Prove the agent was given exactly what we sent.
        sent = (m.get("prompt") or m.get("transcript") or "").strip()
        got = (found.get("prompt") or "").strip()
        m["prompt_match"] = (got == sent) if got else None
        if m["prompt_match"] is False:
            log("prompt_mismatch", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="agent",
                sent_chars=len(sent), agent_saw_chars=len(got), sent=sent[:80], agent_saw=got[:80])
        self.done_stage(m, "reply_text", "speak", ms=(time.time() - t0) * 1000, chars=len(found["text"]),
                        session=found["session_id"], preview=found["text"][:120], prompt_match=m["prompt_match"])

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
        self.s.save()

    def step_speak(self, m: dict) -> None:
        with self.mu:
            reply_text, agent, mid, key = m["reply_text"], m["agent"], m["memo_id"], m["key"]
            late = bool(m.get("late"))
            escalated = memo_escalated(m)
            name = m.get("display_name") or mc_.spoken_name(agent)
            # One reply key per memo: a retry after a half-finished upload overwrites instead of
            # leaving a second object that the pad would play as a second reply.
            stamp = mc_.parse_iso(m.setdefault("reply_stamp", iso(now_utc())))
        t_speak = time.time()
        body = clean_for_speech(reply_text, SPEAK_CHARS)
        if not body:
            raise StageError("tts", "nothing_to_speak", "reply has no speakable text after cleaning", retryable=False)
        spoken = f"{name}, late reply. {body}" if late else f"{name}. {body}"
        parts = split_for_speech(spoken)
        tmp = Path(tempfile.mkdtemp(prefix="memo-tts-"))
        try:
            t0 = time.time()
            if len(parts) > 1:
                # The car hears the first sentence while the rest renders; the full file below is joined from the chunks.
                voiced = self._voice_chunks(m, parts, stamp, tmp, t_speak)
                if voiced is None:
                    with self.mu:
                        log("step_dropped_after_cancel", "warn", memo_id=mid, key=key, agent=agent, stage="speak",
                            note="cancelled while the reply was being voiced chunk by chunk; the chunks are taken back")
                        self.retract_reply(m, None, None)
                    return
                audio, engine = voiced
            else:
                audio, engine = synthesize(spoken, tmp)
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
            # The phone copy goes up alongside the car's, not after it: it is the faster path to an ear.
            # Once per memo: re-dropping the same key would give it a new LastModified, and Earshot plays that again.
            mirror = None
            with self.mu:
                m.pop("earshot_skipped", None)  # decided again on every attempt: the car may be gone by a retry
            if EARSHOT_CHANNEL and not m.get("earshot_key"):
                want = earshot_key_for(stamp, agent, mid)
                with self.mu:
                    tried = m.get("earshot_attempted") == want
                if tried and earshot_exists(want):
                    # An earlier attempt landed but was never recorded (crash, mc timeout after commit): a second
                    # drop would get a new LastModified and the phone would say it twice.
                    with self.mu:
                        m["earshot_key"] = want
                        self.s.save()
                    twant = earshot_key_for(stamp, agent, mid, ext="txt")
                    if not m.get("earshot_text_key") and earshot_exists(twant):  # it went up first, so it is there too
                        with self.mu:
                            m["earshot_text_key"] = twant
                            self.s.save()
                else:
                    with self.mu:
                        m["earshot_attempted"] = want
                        self.s.save()  # persisted before the drop, so a crash mid-drop is caught by the check above

                    def record(f, m=m):
                        if f.exception() is None and f.result():
                            with self.mu:
                                m["earshot_key"] = f.result()
                                self.s.save()

                    def record_text(tkey, m=m):
                        with self.mu:
                            m["earshot_text_key"] = tkey
                            self.s.save()
                    # The full text goes up ahead of the audio, inside the mirror thread, so the phone already has it
                    # when the audio shows up. Not again if an earlier attempt already left it there.
                    text = None if m.get("earshot_text_key") else reply_text

                    # A car that sent this memo and is live speaks the reply itself; the phone, paired with that car,
                    # would play the same reply through the same speakers 10+ s into the car's own playback, or into the
                    # driver's next recording. Decided on the mirror thread, so the car's copy is not held up by it.
                    def mirror_or_skip(m=m, audio=audio, stamp=stamp, agent=agent, mid=mid, key=key, text=text,
                                       chunked=len(parts) > 1):
                        why = car_speaks_reply(mid, key, chunked)
                        if not why:
                            return mirror_to_earshot(audio, stamp, agent, mid, key, text, record_text)
                        with self.mu:
                            m["earshot_skipped"] = why
                            m.pop("earshot_attempted", None)
                            self.s.save()
                        return None
                    mirror = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="earshot")
                    mirrored = mirror.submit(mirror_or_skip)
                    mirrored.add_done_callback(record)
            try:
                r = mc_.mc("cp", "--quiet", str(audio), mc_.s3_url(rkey), timeout=60)
                if r.returncode != 0:
                    raise StageError("reply_upload", "mc_cp_failed", f"mc cp rc={r.returncode}: {r.stderr.strip()[-300:]}")
                stat = mc_.s3_stat(rkey)
                if not stat:
                    raise StageError("reply_upload", "not_visible", f"uploaded {rkey} but mc stat cannot see it")
            finally:
                # Wait for the mirror before the temp audio is removed, whatever happened to the car copy.
                ekey = m.get("earshot_key")
                if mirror is not None:
                    try:
                        ekey = mirrored.result(timeout=90)
                    except Exception:  # noqa: BLE001 - fail-open, already logged inside
                        ekey = None
                    mirror.shutdown(wait=False)
                if ekey:
                    with self.mu:
                        m["earshot_key"] = ekey  # recorded even if the car copy failed, so a retry does not re-drop
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with self.mu:
            if self._cancelled(m):
                # The cancel landed while the uploads were running: the memo stays cancelled and says nothing more.
                log("speak_cancelled", "warn", memo_id=mid, key=key, agent=agent, reply_key=rkey, earshot_key=ekey,
                    note="cancelled while the reply was uploading; no replied fact")
                self.retract_reply(m, rkey, ekey)
                return
            m["reply_key"] = rkey
            journey = time.time() - m.get("received_ts", m.get("detected_ts", time.time()))
            self.fact("replied", m, {
                "reply_s3_key": rkey, "reply_text": m["reply_text"], "reply_chars": len(m["reply_text"]),
                "spoken_chars": len(spoken), "command_id": m.get("command_id"), "profile": m.get("profile"),
                "session_id": m.get("session_id"), "agent_seconds": m.get("agent_seconds"),
                "tts_seconds": round(tts_s, 2), "tts_engine": engine, "voice": VOICE,
                "audio_bytes": stat["size"], "journey_seconds": round(journey, 2),
                "prompt_match": m.get("prompt_match"), "late": late, "escalated": escalated,
                "earshot_key": ekey, "earshot_text_key": m.get("earshot_text_key"),
                # why the phone copy was left out: car_spoke (the sending car already started it) | car_live (it is
                # connected and will); null when it was mirrored (or the mirror is off)
                "earshot_skipped": m.get("earshot_skipped"),
                # chunked speech: how many chunks the car could start from, and when the first and the last went up
                # (seconds after the reply text was found); null for a reply spoken as one file
                "reply_chunks": len(parts) if len(parts) > 1 else None,
                "first_chunk_seconds": m.get("voiced_first_s") if len(parts) > 1 else None,
                "last_chunk_seconds": m.get("voiced_last_s") if len(parts) > 1 else None,
                "full_seconds": round(time.time() - t_speak, 2)})
            m["status"] = "done"
            compact(m)
            self.done_stage(m, "replied", "done", ms=(time.time() - t1) * 1000, reply_key=rkey,
                            journey_s=round(journey, 1))

    # -- chunked reply speech (worker thread, inside step_speak) --

    def _voice_chunks(self, m: dict, parts: list[str], stamp: datetime, tmp: Path, t_speak: float) -> tuple[Path, str] | None:
        """Render the reply chunk by chunk, upload each one as soon as it is rendered (on a publisher thread, so the next
        chunk's render starts at once) and announce it (audio.memo.voiced). Then join them into the full reply file.
        (full audio, engine), or None when the memo was cancelled meanwhile (the caller takes the chunks back).
        A failed render or upload raises StageError: the speak stage is retried, re-rendering the same chunk keys."""
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
                audio, engine = synthesize(text, d)
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
        return synthesize(" ".join(parts), tmp)

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
            if job["i"] == job["n"]:
                m["voiced_last_s"] = since
            log("chunk_voiced", memo_id=mid, key=key, agent=agent, stage="tts", chunk=job["i"], chunks=job["n"],
                chunk_key=job["ckey"], tts_ms=int(job["tts_s"] * 1000), since_reply_s=since, bytes=size,
                chars=len(job["text"]))
            if first:
                done_ts = m.get("agent_done_ts")
                self.fact("voiced", m, {
                    "reply_s3_key": job["rkey"], "chunk_s3_key": job["ckey"], "chunk": job["i"], "chunks": job["n"],
                    "spoken_text": job["text"], "spoken_chars": len(job["text"]), "command_id": m.get("command_id"),
                    "tts_seconds": round(job["tts_s"], 2), "tts_engine": job["engine"], "voice": VOICE, "audio_bytes": size,
                    "since_reply_seconds": since,
                    "since_agent_done_seconds": round(time.time() - done_ts, 2) if done_ts else None,
                    "late": bool(m.get("late"))})
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
            work = [(m["key"], m["memo_id"], m["command_id"]) for m in self.active()
                    if m.get("stage") == "await_agent" and m.get("command_id")]
        for key, mid, cid in work:
            try:
                events = mc_.progress_events(mid)  # outside the lock: an HTTP call
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"[:200]
                if err != self.progress_err:
                    log("progress_read_failed", "warn", memo_id=mid, key=key, error=err,
                        note="Candystore unreachable: the status object keeps its last progress line")
                self.progress_err = err
                continue
            self.progress_err = None
            mine = [e for e in events if (e.get("data") or {}).get("command_id") == cid
                    and isinstance((e.get("data") or {}).get("seq"), int)]
            with self.mu:
                m = self.s.memos.get(key)
                if not m or m.get("stage") != "await_agent" or m.get("command_id") != cid or self._cancelled(m):
                    continue
                if mine:
                    self.apply_progress(m, max(mine, key=lambda e: e["data"]["seq"]))
                self.maybe_narrate(m)

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
        if not m.get("progress_text"):
            return "no_progress"
        if (m.get("narr_cmd"), m.get("narr_src_seq")) == (m.get("progress_cmd"), m.get("progress_seq")):
            return "already_spoken"
        if m.get("narr_count", 0) >= NARRATE_MAX:
            return "max_reached"
        if now < float(m.get("dispatched_ts") or now) + NARRATE_FIRST_S:
            return "too_early"
        if now < float(m.get("narr_last_ts") or 0) + NARRATE_GAP_S:
            return "too_soon"
        return None

    def maybe_narrate(self, m: dict) -> bool:
        """Under the lock: start one narration render for this memo if one is due. True when it started."""
        if self.narration_due(m) is not None:
            return False
        n = m.get("narr_count", 0) + 1
        name = m.get("display_name") or mc_.spoken_name(m["agent"])
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
            audio, engine = synthesize(job["spoken"], tmp, voice=PROGRESS_VOICE, steps=PROGRESS_TTS_STEPS)
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
                     narr_text=job["line"], narr_last_ts=time.time())
            elapsed = time.time() - float(m.get("dispatched_ts") or time.time())
            log("narrated", memo_id=mid, key=key, agent=job["agent"], stage="agent", n=job["n"], seq=job["seq"],
                progress_key=pkey, tts_ms=int(tts_s * 1000), engine=engine, elapsed_s=round(elapsed, 1),
                text=job["line"][:120])
            self.fact("narrated", m, {
                "command_id": job["cid"], "seq": job["seq"], "narration": job["n"], "progress_s3_key": pkey,
                "spoken_text": job["spoken"], "elapsed_seconds": round(max(0.0, elapsed), 1),
                "tts_seconds": round(tts_s, 2), "tts_engine": engine, "voice": PROGRESS_VOICE, "audio_bytes": size})
            self.status(m)
            self.s.save()


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


def car_speaks_reply(mid: str, key: str, chunked: bool = True) -> str | None:
    """Why the reply's Earshot phone copy is left out, or None to mirror it.
    "car_live": the memo came from a car whose push stream is open right now (the upload proxy's /upload/presence), so
    it speaks the reply itself. "car_spoke": the car's speech queue already started this memo's reply
    (audio.memo.notified reply/start; only the car app sends those), asked only for a chunked reply (a single file is
    uploaded alongside this mirror, so no car can have started it) and only when the sender is not known to be a browser.
    Fail-open: anything unknown or unreachable mirrors, as before."""
    if not EARSHOT_SKIP_CAR:
        return None
    host = None
    try:
        url = f"{PRESENCE_URL}?memo={urllib.parse.quote(mid, safe='')}&key={urllib.parse.quote(key, safe='')}"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}),
                                    timeout=PRESENCE_TIMEOUT_S) as r:
            ans = json.loads(r.read().decode("utf-8", "replace"))
        if isinstance(ans, dict):
            host = ans.get("host")
            if ans.get("car_live") is True:
                log("earshot_skipped", memo_id=mid, key=key, reason="car_live", device=ans.get("device"), since=ans.get("since"),
                    note="the sending car is connected and speaks it itself")
                return "car_live"
    except Exception as e:  # noqa: BLE001 - fail-open
        log("earshot_car_check_failed", "warn", memo_id=mid, key=key, source="presence", error=str(e)[:200])
    if not chunked or host == "browser":
        return None
    try:
        for e in mc_.typed_events(mid, NOTIFIED_TYPE):
            d = e.get("data") or {}
            if d.get("utterance") == "reply" and d.get("decision") in ("start", "started"):
                log("earshot_skipped", memo_id=mid, key=key, reason="car_spoke", note="the sending car already speaks it")
                return "car_spoke"
    except Exception as e:  # noqa: BLE001 - fail-open
        log("earshot_car_check_failed", "warn", memo_id=mid, key=key, source="candystore", error=str(e)[:200])
    return None


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


def synthesize(text: str, tmp: Path, voice: str | None = None, steps: int | None = None) -> tuple[Path, str]:
    """vox /synthesize-url -> OGG/Opus file. Returns (path, engine that served it). `steps` trades quality for speed
    (diffusion steps; vox defaults to 10): progress updates use fewer."""
    body = {"text": text, "voice": voice or VOICE}
    if steps:
        body["steps"] = steps
    req = urllib.request.Request(f"{mc_.VOX_URL}/synthesize-url", method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            meta = json.loads(resp.read())
        with urllib.request.urlopen(meta["audio_url"], timeout=60) as resp:
            blob = resp.read()
    except Exception as e:  # noqa: BLE001
        raise StageError("tts", "vox_failed", f"vox synth failed: {type(e).__name__}: {e}") from e
    if len(blob) < 200:
        raise StageError("tts", "vox_empty", f"vox returned {len(blob)} bytes")
    out = tmp / "reply.ogg"
    out.write_bytes(blob)
    return out, meta.get("engine", "unknown")


# ------------------------------------------------------------------ main

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
    log("starting", lane=LANE, poll_s=args.poll, state=str(state.path), bucket=BUCKET, agent_timeout_s=AGENT_TIMEOUT_S,
        first_start=state.fresh)
    while True:
        try:
            w.baseline_if_first_start()
            break
        except Exception as e:  # noqa: BLE001
            log("baseline_failed", "error", error=str(e)[:300], note="retrying; no state created from a failed listing")
            if STOP or args.once:
                return 1
            time.sleep(10)

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

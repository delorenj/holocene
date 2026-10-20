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
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memo_common as mc_  # noqa: E402
from memo_common import (  # noqa: E402
    BB_EMIT, BUCKET, REPLIES_PREFIX, STATE_DIR, agent_from_key, iso, memo_id_for, now_utc,
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
# Floor for the transcribe timeout; the real timeout scales with the audio (see transcribe_timeout()).
TRANSCRIBE_TIMEOUT_S = int(os.environ.get("MEMO_TRANSCRIBE_TIMEOUT_S", "420"))
TRANSCRIBE_RATIO = float(os.environ.get("MEMO_TRANSCRIBE_RATIO", "8"))  # CPU large-v3 measured ~5x realtime
TRANSCRIBE_MAX_S = int(os.environ.get("MEMO_TRANSCRIBE_MAX_S", "7200"))
MAX_ATTEMPTS = int(os.environ.get("MEMO_MAX_ATTEMPTS", "3"))
MIN_AUDIO_S = float(os.environ.get("MEMO_MIN_AUDIO_S", "0.7"))
SILENT_MAX_DBFS = mc_.SILENT_MAX_DBFS  # loudest-sample line below which a recording is silent (see memo_common)
# Prepended to the transcript so the agent knows it is speech-to-text, not typed text.
VOICE_PREFIX = os.environ.get("MEMO_VOICE_PREFIX", "[Voice memo transcript - speech-to-text, may contain recognition errors] ")
# Whisper's usual output on noise or an accidental tap: never a real prompt.
HALLUCINATIONS = {"thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching", "you", "bye",
                  "bye bye", "okay", "ok", "uh", "um", "hmm", "mm", "mhm", "oh", "ah", "so"}
MAX_AGE_S = int(float(os.environ.get("MEMO_MAX_AGE_HOURS", "24")) * 3600)
SPEAK_CHARS = int(os.environ.get("MEMO_SPEAK_CHARS", "500"))
# A prompt is never shortened: a transcript over this many characters (about 40 hours of speech, far above any
# real memo) is held with a clear error instead of being sent cut. The old 20000-char slice silently dropped the
# tail of a long memo (about 2 hours of speech) and sent the agent half a sentence as if it were the whole ask.
MAX_TRANSCRIPT_CHARS = int(os.environ.get("MEMO_MAX_TRANSCRIPT_CHARS", "200000"))
# Every spoken reply is also dropped into this Earshot channel (s3://earshot/<channel>/), so it plays on the phone
# and its last hop (detected / started / finished on the device) shows up in memo:trace. Empty turns it off.
EARSHOT_BUCKET = os.environ.get("MEMO_EARSHOT_BUCKET", "earshot")
EARSHOT_CHANNEL = os.environ.get("MEMO_EARSHOT_CHANNEL", "phone")
WAIT_LOG_EVERY_S = 30
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
    for k in ("live", "live_ts", "cs_checked_ts"):  # await-stage probe caches
        m.pop(k, None)


def resume_for(m: dict) -> str:
    """Where `memo:retry` restarts a failed memo. A memo with no transcript cannot dispatch (it failed at receive,
    for an unroutable agent, before any audio was heard): it starts over at receive."""
    stage = m.get("resume_stage") or "receive"
    if stage == "dispatch" and not m.get("transcript"):
        return "receive"
    return stage


def truncated_by_old_watcher(m: dict) -> bool:
    """A failed memo whose prompt was cut to exactly 300 characters by the old compact() and never carried a prompt
    hash: its full text is gone, so retrying would send the agent half a prompt."""
    return (m.get("status") == "failed" and not m.get("prompt_sha256") and isinstance(m.get("prompt"), str)
            and len(m["prompt"]) == 300 and m.get("resume_stage") in ("dispatch", "await_agent"))


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
                      "io": concurrent.futures.ThreadPoolExecutor(2, thread_name_prefix="io")}
        self.last_rescue = 0.0
        self.lane_probe: LaneProbe | None = None  # started by main(); tests leave it off

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
            self.s.save()

    # ---- control + rescue ------------------------------------------------

    def revive(self, m: dict, stage: str, why: str) -> None:
        failed = m.get("failed_stage")
        if stage == "dispatch" and (failed == "agent" or (failed == "agent_reply" and m.get("failed_code") == mc_.TURN_TIMEOUT)):
            m.pop("command_id", None)       # the old command was rejected or failed: send a fresh one
            m.pop("publish_attempted", None)
            m.pop("lane", None)             # a fresh command id may pick a fresh lane
            m.pop("lane_reason", None)
        if stage == "await_agent":
            m["deadline_ts"] = time.time() + AGENT_TIMEOUT_S
        if m.get("failed_code") == "object_changed" and m.get("observed_object"):
            # The operator asked for this memo again: take the object as it is now as the one to transcribe.
            obs = m.pop("observed_object")
            m["size"], m["etag"] = obs["size"], obs.get("etag")
        if failed:
            m["attempts"].pop(failed, None)
            m.get("first_fail", {}).pop(failed, None)
        for k in ("failed_stage", "failed_code", "resume_stage"):
            m.pop(k, None)
        m.update(status="active", stage=stage, next_at=0.0)
        log("memo_revived", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage, why=why)
        self.s.save()

    def process_control(self) -> None:
        """`memo:retry <memo>` drops a file here; the watcher owns state.json, so it does the reset."""
        cdir = STATE_DIR / "control"
        if not cdir.is_dir():
            return
        for f in sorted(cdir.glob("retry-*")):
            mid = f.name[len("retry-"):]
            m = next((x for x in self.s.memos.values() if x["memo_id"] == mid), None)
            try:
                f.unlink()
            except OSError:
                pass
            if m is None:
                log("retry_refused", "warn", memo_id=mid, reason="unknown memo")
            elif m["key"] in self.running or m.get("status") == "active":
                log("retry_refused", "warn", memo_id=mid, key=m["key"], reason=f"memo is {m.get('status')} at {m.get('stage')}, not failed")
            elif m.get("status") not in ("failed", "skipped"):
                log("retry_refused", "warn", memo_id=mid, key=m["key"], reason=f"memo status is {m.get('status')}")
            elif m.get("agent") is None:
                log("retry_refused", "warn", memo_id=mid, key=m["key"], reason="no agent in the key path")
            elif truncated_by_old_watcher(m):
                log("retry_refused", "warn", memo_id=mid, key=m["key"],
                    reason="its prompt was cut to 300 characters by an older watcher: re-upload the recording instead")
            else:
                self.revive(m, resume_for(m), "memo:retry")

    def rescue_late(self) -> None:
        """A memo that hit the agent deadline may still complete (the command stayed queued). Speak it late."""
        if time.time() - self.last_rescue < 20:
            return
        self.last_rescue = time.time()
        for m in list(self.s.memos.values()):
            if (m.get("status") != "failed" or m.get("failed_stage") != "agent_reply" or m.get("failed_code") != "timeout"
                    or not m.get("command_id") or m.get("rescue_closed") or m["key"] in self.running):
                continue
            if time.time() - m.get("dispatched_ts", 0) > RESCUE_WINDOW_S:
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
                self.on_error(m, e)
        except Exception as e:  # noqa: BLE001
            with self.mu:
                self.on_error(m, StageError(FAIL_STAGE[stage], "unexpected", f"{type(e).__name__}: {e}", True))
        finally:
            WAKE.set()  # a step ended: let the main loop pick up what it unblocked (first, so a failing save cannot skip it)
            with self.mu:
                m["last_step_ms"] = int((time.time() - t0) * 1000)
                m.pop("step_started_ts", None)
                self.running.discard(m["key"])
                self.s.save()

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
            m["resume_stage"] = ("await_agent" if e.stage == "agent_reply" and e.code == "timeout" and m.get("command_id")
                                 else "dispatch" if e.stage == "agent_reply" and e.code == mc_.TURN_TIMEOUT  # fresh command
                                 else RESUME_STAGE.get(e.stage, "receive"))
            m["resume_stage"] = resume_for(m)
            compact(m)
            log("memo_failed", "error", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300], attempt=n,
                retry_with=f"mise run memo:retry {m['memo_id']}")

    def done_stage(self, m: dict, stage: str, nxt: str, ms: float | None = None, **extra) -> None:
        log("stage_done", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage,
            next=nxt, ms=int(ms) if ms is not None else None, **extra)
        m["stage"] = nxt
        m["next_at"] = 0.0
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
        import uuid
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
            data = {
                "target_agent_id": m["agent"], "prompt": prompt, "thread_id": m["thread_id"],
                "turn_id": None,
                "context": {"memo_id": m["memo_id"], "memo_key": m["key"],
                            "source": "holocene-auto:inbox-watcher", "repo": "holocene", "reason": "voice-inbox"},
            }
            cmd = [BB_EMIT, "--strict", "--print-ids", "--kind", "command",
                   "--type", mc_.LANE_COMMAND_TYPES[lane],
                   "--source", f"urn:33god:service:{SERVICE}", "--producer", SERVICE, "--service", SERVICE,
                   "--actor-type", "service", "--actor-id", SERVICE,
                   "--correlation", m["memo_id"], "--command-id", cid,
                   "--ordering-key", f"turn:{m['thread_id']}"]
            if m.get("last_fact_id"):
                cmd += ["--causation", m["last_fact_id"]]
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
        m["command_envelope_id"] = ids.get("id")
        m["dispatched_ts"] = time.time()
        m["deadline_ts"] = m["dispatched_ts"] + AGENT_TIMEOUT_S
        m.pop("dropped_since", None)
        self.fact("dispatched", m, {
            "command_id": cid, "idempotency_key": ids.get("idempotency_key"),
            "command_subject": ids.get("subject") or mc_.LANE_COMMAND_TYPES[memo_lane(m)],
            "lane": memo_lane(m), "lane_reason": m.get("lane_reason"),
            "thread_id": m.get("thread_id"), "prompt_chars": prompt_chars if prompt_chars is not None else len(prompt),
            "prompt_sha256": m.get("prompt_sha256") or hashlib.sha256(prompt.encode()).hexdigest(),
            "voice_prefix": bool(VOICE_PREFIX), "dispatch_ms": int(ms)})
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

    def step_await_agent(self, m: dict) -> None:
        st = self.agent_status(m)
        waited = time.time() - m["dispatched_ts"]
        if st["state"] == "done":
            m["profile"] = st.get("profile") or m["agent"]
            m["agent_seconds"] = round(waited, 2)
            return self.done_stage(m, "agent", "reply", ms=waited * 1000, command_id=m["command_id"],
                                   source=st["source"], profile=m["profile"])
        if st["state"] == "failed":
            if st.get("code") == mc_.TURN_TIMEOUT:
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
            if waited < QUEUE_MAX_WAIT_S:
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
        found = mc_.find_reply(m.get("profile") or m["agent"], m["thread_id"])
        if not found or not found.get("text"):
            raise StageError("agent_reply", "no_reply_text",
                             f"turn completed but no assistant text in {m.get('profile')} session chat_id={m['thread_id']}"
                             f" ({'no session' if not found else 'session ' + found['session_id'] + ' has no assistant text'})")
        m["reply_text"] = found["text"][:20000]
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

    def step_speak(self, m: dict) -> None:
        with self.mu:
            reply_text, agent, mid, key = m["reply_text"], m["agent"], m["memo_id"], m["key"]
            late = bool(m.get("late"))
            name = m.get("display_name") or mc_.spoken_name(agent)
            # One reply key per memo: a retry after a half-finished upload overwrites instead of
            # leaving a second object that the pad would play as a second reply.
            stamp = mc_.parse_iso(m.setdefault("reply_stamp", iso(now_utc())))
        body = clean_for_speech(reply_text, SPEAK_CHARS)
        if not body:
            raise StageError("tts", "nothing_to_speak", "reply has no speakable text after cleaning", retryable=False)
        spoken = f"{name}, late reply. {body}" if late else f"{name}. {body}"
        tmp = Path(tempfile.mkdtemp(prefix="memo-tts-"))
        try:
            t0 = time.time()
            audio, engine = synthesize(spoken, tmp)
            tts_s = time.time() - t0
            log("stage_done", memo_id=mid, key=key, agent=agent, stage="tts",
                ms=int(tts_s * 1000), engine=engine, bytes=audio.stat().st_size, spoken_chars=len(spoken))
            rkey = f"{REPLIES_PREFIX}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}Z-{agent}-{mid}.ogg"
            t1 = time.time()
            # The phone copy goes up alongside the car's, not after it: it is the faster path to an ear.
            # Once per memo: re-dropping the same key would give it a new LastModified, and Earshot plays that again.
            mirror = None
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
                else:
                    with self.mu:
                        m["earshot_attempted"] = want
                        self.s.save()  # persisted before the drop, so a crash mid-drop is caught by the check above

                    def record(f, m=m):
                        if f.exception() is None and f.result():
                            with self.mu:
                                m["earshot_key"] = f.result()
                                self.s.save()
                    mirror = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="earshot")
                    mirrored = mirror.submit(mirror_to_earshot, audio, stamp, agent, mid, key)
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
            m["reply_key"] = rkey
            journey = time.time() - m.get("received_ts", m.get("detected_ts", time.time()))
            self.fact("replied", m, {
                "reply_s3_key": rkey, "reply_text": m["reply_text"], "reply_chars": len(m["reply_text"]),
                "spoken_chars": len(spoken), "command_id": m.get("command_id"), "profile": m.get("profile"),
                "session_id": m.get("session_id"), "agent_seconds": m.get("agent_seconds"),
                "tts_seconds": round(tts_s, 2), "tts_engine": engine, "voice": VOICE,
                "audio_bytes": stat["size"], "journey_seconds": round(journey, 2),
                "prompt_match": m.get("prompt_match"), "late": late, "earshot_key": ekey})
            m["status"] = "done"
            compact(m)
            self.done_stage(m, "replied", "done", ms=(time.time() - t1) * 1000, reply_key=rkey,
                            journey_s=round(journey, 1))


# ------------------------------------------------------------------ earshot mirror

def earshot_key_for(stamp: datetime, agent: str, mid: str, channel: str = "") -> str:
    """The Earshot object for a memo's reply: dated like the reply, carrying agent and memo id so the device's
    beacons for it join back to the memo."""
    ch = channel or EARSHOT_CHANNEL
    return f"{ch}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}{stamp.microsecond // 1000:03d}Z-{agent}-{mid}.ogg"


def earshot_exists(ekey: str) -> bool:
    try:
        return mc_.mc("stat", f"{mc_.S3_ALIAS}/{EARSHOT_BUCKET}/{ekey}", timeout=20).returncode == 0
    except Exception:  # noqa: BLE001 - unknown: assume absent, so the reply still reaches the phone
        return False


def mirror_to_earshot(audio: Path, stamp: datetime, agent: str, mid: str, key: str) -> str | None:
    """Drop the reply into the Earshot channel. Fail-open: the car's replies/ object is the reply of record, so a
    mirror failure is logged and never fails the memo."""
    if not EARSHOT_CHANNEL:
        return None
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


def synthesize(text: str, tmp: Path) -> tuple[Path, str]:
    """vox /synthesize-url -> OGG/Opus file. Returns (path, engine that served it)."""
    req = urllib.request.Request(f"{mc_.VOX_URL}/synthesize-url", method="POST",
                                 data=json.dumps({"text": text, "voice": VOICE}).encode(),
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

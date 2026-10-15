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
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
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

AGENT_TIMEOUT_S = int(os.environ.get("MEMO_AGENT_TIMEOUT_S", "600"))
TRANSCRIBE_TIMEOUT_S = int(os.environ.get("MEMO_TRANSCRIBE_TIMEOUT_S", "420"))
MAX_ATTEMPTS = int(os.environ.get("MEMO_MAX_ATTEMPTS", "3"))
MAX_AGE_S = int(float(os.environ.get("MEMO_MAX_AGE_HOURS", "24")) * 3600)
SPEAK_CHARS = int(os.environ.get("MEMO_SPEAK_CHARS", "500"))
WAIT_LOG_EVERY_S = 30
AWAIT_POLL_S = float(os.environ.get("MEMO_AWAIT_POLL_S", "3"))

# Retry backoff base seconds per failure stage (doubles each attempt, capped).
BACKOFF = {"download": 10, "transcribe": 20, "dispatch": 10, "agent_reply": 5, "tts": 15, "reply_upload": 10}

STOP = False


# ------------------------------------------------------------------ logging

def log(event: str, level: str = "info", **fields) -> None:
    rec = {"ts": iso(now_utc()), "svc": SERVICE, "level": level, "event": event}
    rec.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)


class StageError(Exception):
    """A failure attributed to a pipeline stage (the `stage` of the failed fact)."""

    def __init__(self, stage: str, code: str, message: str, retryable: bool = True):
        super().__init__(message)
        self.stage, self.code, self.message, self.retryable = stage, code, message, retryable


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
        if not self.fresh:
            self.data = json.loads(self.path.read_text())
            self.data.setdefault("memos", {})
            self.data.setdefault("outbox", [])

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1, default=str))
        os.replace(tmp, self.path)

    @property
    def memos(self) -> dict:
        return self.data["memos"]

    def heartbeat(self, extra: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        rec = {"pid": os.getpid(), "ts": iso(now_utc()), **extra}
        tmp = self.heartbeat_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, indent=1))
        os.replace(tmp, self.heartbeat_path)


# ------------------------------------------------------------------ the watcher

class Watcher:
    def __init__(self, state: State):
        self.s = state
        self.last_list_err = None

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
        while box:
            rec = box[0]
            try:
                self._emit_raw(rec)
            except Exception as e:  # noqa: BLE001
                log("outbox_blocked", "warn", memo_id=rec["memo_id"], stage=rec["action"],
                    error=str(e)[:200], outbox=len(box))
                return
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

    def discover(self) -> None:
        try:
            objs = mc_.s3_list_inbox()
        except Exception as e:  # noqa: BLE001
            msg = str(e)[:300]
            if msg != self.last_list_err:  # do not spam an outage every tick
                log("s3_list_failed", "error", stage="receive", error=msg)
            self.last_list_err = msg
            return
        self.last_list_err = None
        for o in objs:
            key = o["key"]
            if key in self.s.memos:
                continue
            agent = agent_from_key(key)
            mid = memo_id_for(key)
            age = (now_utc() - o["last_modified"]).total_seconds() if o["last_modified"] else 0
            m = {"memo_id": mid, "key": key, "agent": agent, "size": o["size"],
                 "uploaded_at": iso(o["last_modified"]), "detected_ts": time.time(),
                 "attempts": {}, "next_at": 0.0, "status": "active", "stage": "receive"}
            self.s.memos[key] = m
            if agent is None:
                m.update(status="skipped", stage="skipped")
                log("skipped", "warn", memo_id=mid, key=key, stage="receive", reason="no agent id in key path")
            elif age > MAX_AGE_S:
                m.update(status="skipped", stage="skipped")
                log("skipped", "warn", memo_id=mid, key=key, agent=agent, stage="receive",
                    reason=f"older than {MAX_AGE_S // 3600}h ({int(age)}s)")
            else:
                log("discovered", memo_id=mid, key=key, agent=agent, stage="receive", bytes=o["size"],
                    age_s=round(age, 1))
            self.s.save()

    # ---- step machinery --------------------------------------------------

    def active(self) -> list[dict]:
        return sorted((m for m in self.s.memos.values() if m.get("status") == "active"),
                      key=lambda m: m["key"])

    def tick(self) -> None:
        self.flush_outbox()
        self.discover()
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
        self.s.heartbeat({"memos": counts, "outbox": len(self.s.data["outbox"]),
                          "active": [{"memo_id": m["memo_id"], "key": m["key"], "stage": m["stage"]} for m in self.active()]})

    def advance(self, m: dict) -> None:
        stage = m["stage"]
        step = {"receive": self.step_receive, "transcribe": self.step_transcribe,
                "dispatch": self.step_dispatch, "await_agent": self.step_await_agent,
                "reply": self.step_reply, "speak": self.step_speak}[stage]
        t0 = time.time()
        try:
            step(m)
        except StageError as e:
            self.on_error(m, e)
        except Exception as e:  # noqa: BLE001
            fail_stage = {"receive": "receive", "transcribe": "transcribe", "dispatch": "dispatch",
                          "await_agent": "agent", "reply": "agent_reply", "speak": "tts"}[stage]
            self.on_error(m, StageError(fail_stage, "unexpected", f"{type(e).__name__}: {e}", True))
        finally:
            m["last_step_ms"] = int((time.time() - t0) * 1000)
            self.s.save()

    def on_error(self, m: dict, e: StageError) -> None:
        n = m["attempts"][e.stage] = m["attempts"].get(e.stage, 0) + 1
        retry = e.retryable and n < MAX_ATTEMPTS
        data = {"stage": e.stage, "error_code": e.code, "error_message": e.message[:800],
                "retryable": retry, "attempt": n}
        if m.get("command_id"):
            data["command_id"] = m["command_id"]
        self.fact("failed", m, data)
        if retry:
            delay = min(300, BACKOFF.get(e.stage, 10) * (2 ** (n - 1)))
            m["next_at"] = time.time() + delay
            log("stage_failed", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300], attempt=n, retry_in_s=delay)
        else:
            m["status"] = "failed"
            m["failed_stage"] = e.stage
            log("memo_failed", "error", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=e.stage,
                code=e.code, error=e.message[:300], attempt=n)

    def done_stage(self, m: dict, stage: str, nxt: str, ms: float | None = None, **extra) -> None:
        log("stage_done", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage=stage,
            next=nxt, ms=int(ms) if ms is not None else None, **extra)
        m["stage"] = nxt
        m["next_at"] = 0.0

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
        self.done_stage(m, "received", "transcribe", size=m.get("size"), detect_lag_ms=lag)

    def step_transcribe(self, m: dict) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="memo-"))
        try:
            audio = tmp / Path(m["key"]).name
            t0 = time.time()
            r = mc_.mc("cp", "--quiet", mc_.s3_url(m["key"]), str(audio), timeout=90)
            if r.returncode != 0 or not audio.exists():
                raise StageError("download", "mc_cp_failed", f"mc cp rc={r.returncode}: {r.stderr.strip()[-300:]}")
            log("stage_done", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="download",
                ms=int((time.time() - t0) * 1000), bytes=audio.stat().st_size)

            out_md = tmp / (audio.stem + ".md")
            tlog = tmp / "transcribe.log"
            env = {**os.environ, "TRANSCRIBE_DIR": TRANSCRIBE_DIR, "TRANSCRIBE_LOG_FILE": str(tlog)}
            # --output keeps the transcript out of ~/d/Transcripts (--ephemeral only skips S3 archiving)
            cmd = [TRANSCRIBE, str(audio), "--no-diarization", "--ephemeral", "--output", str(out_md)]
            log("transcribe_start", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="transcribe")
            t1 = time.time()
            try:
                r = run(cmd, TRANSCRIBE_TIMEOUT_S, env=env)
            except subprocess.TimeoutExpired:
                raise StageError("transcribe", "timeout", f"transcribe exceeded {TRANSCRIBE_TIMEOUT_S}s") from None
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
            if not text.strip():
                raise StageError("transcribe", "empty_transcript",
                                 "transcript is empty (silence or unrecognised audio)", retryable=False)
            m["transcript"] = text[:20000]
            self.fact("transcribed", m, {
                "transcript_text": m["transcript"], "transcript_chars": len(text),
                "word_count": meta.get("word_count") or len(text.split()),
                "audio_duration_seconds": meta.get("duration_seconds"),
                "processing_seconds": round(took, 2), "model": meta.get("model"),
                "backend": meta.get("backend"), "language": meta.get("language")})
            self.done_stage(m, "transcribed", "dispatch", ms=took * 1000, chars=len(text),
                            audio_s=meta.get("duration_seconds"), model=meta.get("model"),
                            text=text[:120])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def step_dispatch(self, m: dict) -> None:
        import uuid
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
        m["thread_id"] = m["memo_id"]  # unique per memo: the agent session's chat_id (exact reply lookup)
        data = {
            "target_agent_id": m["agent"], "prompt": m["transcript"], "thread_id": m["thread_id"],
            "turn_id": None,
            "context": {"memo_id": m["memo_id"], "memo_key": m["key"],
                        "source": "holocene-auto:inbox-watcher", "repo": "holocene", "reason": "voice-inbox"},
        }
        live = mc_.gateway_liveness()
        if live.get("ok") is False:
            log("gateway_not_pulling", "warn", memo_id=m["memo_id"], key=m["key"], agent=m["agent"],
                stage="dispatch", detail=mc_.gateway_liveness_text(live),
                note="command will queue in JetStream until the gateway resumes")
        cmd = [BB_EMIT, "--strict", "--print-ids", "--kind", "command",
               "--type", "bloodbank.cmd.agent.invocation.start",
               "--source", f"urn:33god:service:{SERVICE}", "--producer", SERVICE, "--service", SERVICE,
               "--actor-type", "service", "--actor-id", SERVICE,
               "--correlation", m["memo_id"], "--command-id", cid,
               "--ordering-key", f"turn:{m['thread_id']}"]
        if m.get("last_fact_id"):
            cmd += ["--causation", m["last_fact_id"]]
        m["publish_attempted"] = True
        self.s.save()
        t0 = time.time()
        r = run(cmd, 30, stdin=json.dumps(data))
        ms = (time.time() - t0) * 1000
        if r.returncode != 0:
            raise StageError("dispatch", "bb_emit_failed", f"bb-emit rc={r.returncode}: {r.stderr.strip()[-300:]}")
        try:
            ids = json.loads(r.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            ids = {}
        self._mark_dispatched(m, cid, ids, ms, prompt_chars=len(m["transcript"]))

    def _mark_dispatched(self, m: dict, cid: str, ids: dict | None, ms: float, prompt_chars: int | None = None) -> None:
        ids = ids or {}
        m["command_envelope_id"] = ids.get("id")
        m["dispatched_ts"] = time.time()
        m["deadline_ts"] = m["dispatched_ts"] + AGENT_TIMEOUT_S
        self.fact("dispatched", m, {
            "command_id": cid, "idempotency_key": ids.get("idempotency_key"),
            "command_subject": ids.get("subject") or "bloodbank.cmd.agent.invocation.start",
            "thread_id": m.get("thread_id"), "prompt_chars": prompt_chars if prompt_chars is not None else len(m.get("transcript", "")),
            "dispatch_ms": int(ms)})
        self.done_stage(m, "dispatched", "await_agent", ms=ms, command_id=cid, target=m["agent"])

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
            if st == "completed":
                return {**out, "state": "failed", "source": "journal", "code": f"agent_{oc}",
                        "detail": mc_.terminal_error(row) or f"journal completed/{oc}"}
            if st.startswith("rejected"):
                return {**out, "state": "failed", "source": "journal", "code": st,
                        "detail": row.get("rejection_reason") or st}
            out.update(state="running", source="journal", detail=f"journal state={st}")
        try:
            for ev in mc_.candystore_events(m["memo_id"]):
                if ev.get("type") not in ("bloodbank.agent.invocation.completed", "bloodbank.agent.invocation.failed"):
                    continue
                d = ev.get("data") or {}
                if d.get("command_id") != cid:
                    continue
                prof = d.get("profile_name") or out.get("profile")
                if ev["type"].endswith(".failed"):
                    return {**out, "state": "failed", "source": "candystore", "profile": prof,
                            "code": d.get("error_code") or "invocation_failed",
                            "detail": d.get("error_message") or "invocation.failed"}
                return {**out, "state": "done", "source": "candystore", "profile": prof,
                        "detail": "invocation.completed fact in Candystore"}
        except Exception as e:  # noqa: BLE001
            out["candystore_error"] = str(e)[:200]
        return out

    def step_await_agent(self, m: dict) -> None:
        st = self.agent_status(m)
        waited = time.time() - m["dispatched_ts"]
        if st["state"] == "done":
            m["profile"] = st.get("profile") or m["agent"]
            m["agent_seconds"] = round(waited, 2)
            return self.done_stage(m, "agent", "reply", ms=waited * 1000, command_id=m["command_id"],
                                   source=st["source"], profile=m["profile"])
        if st["state"] == "failed":
            raise StageError("agent", st.get("code", "agent_failed"), f"{st['detail']} (via {st['source']})", retryable=False)
        if time.time() >= m["deadline_ts"]:
            live = mc_.gateway_liveness_text()
            raise StageError("agent_reply", "timeout",
                             f"no completed turn after {int(waited)}s for command {m['command_id']} "
                             f"({st['detail']}); gateway: {live}", retryable=False)
        if time.time() - m.get("last_wait_log", 0) >= WAIT_LOG_EVERY_S:
            m["last_wait_log"] = time.time()
            extra = {}
            if st["state"] == "pending":
                extra["gateway"] = mc_.gateway_liveness_text()
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
        self.done_stage(m, "reply_text", "speak", ms=(time.time() - t0) * 1000, chars=len(found["text"]),
                        session=found["session_id"], preview=found["text"][:120])

    def step_speak(self, m: dict) -> None:
        spoken = clean_for_speech(m["reply_text"], SPEAK_CHARS)
        if not spoken:
            raise StageError("tts", "nothing_to_speak", "reply has no speakable text after cleaning", retryable=False)
        tmp = Path(tempfile.mkdtemp(prefix="memo-tts-"))
        try:
            t0 = time.time()
            audio, engine = synthesize(spoken, tmp)
            tts_s = time.time() - t0
            log("stage_done", memo_id=m["memo_id"], key=m["key"], agent=m["agent"], stage="tts",
                ms=int(tts_s * 1000), engine=engine, bytes=audio.stat().st_size, spoken_chars=len(spoken))
            stamp = now_utc()
            rkey = (f"{REPLIES_PREFIX}/{stamp:%Y/%m/%d}/{stamp:%H%M%S}Z-{m['agent']}-{m['memo_id'][:8]}.ogg")
            t1 = time.time()
            r = mc_.mc("cp", "--quiet", str(audio), mc_.s3_url(rkey), timeout=60)
            if r.returncode != 0:
                raise StageError("reply_upload", "mc_cp_failed", f"mc cp rc={r.returncode}: {r.stderr.strip()[-300:]}")
            stat = mc_.s3_stat(rkey)
            if not stat:
                raise StageError("reply_upload", "not_visible", f"uploaded {rkey} but mc stat cannot see it")
            m["reply_key"] = rkey
            journey = time.time() - m.get("received_ts", m.get("detected_ts", time.time()))
            self.fact("replied", m, {
                "reply_s3_key": rkey, "reply_text": m["reply_text"], "reply_chars": len(m["reply_text"]),
                "spoken_chars": len(spoken), "command_id": m.get("command_id"), "profile": m.get("profile"),
                "session_id": m.get("session_id"), "agent_seconds": m.get("agent_seconds"),
                "tts_seconds": round(tts_s, 2), "tts_engine": engine, "voice": VOICE,
                "audio_bytes": stat["size"], "journey_seconds": round(journey, 2)})
            m["status"] = "done"
            self.done_stage(m, "replied", "done", ms=(time.time() - t1) * 1000, reply_key=rkey,
                            journey_s=round(journey, 1))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ text + tts helpers

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
    ap.add_argument("--poll", type=int, default=int(os.environ.get("MEMO_POLL_S", "5")))
    args = ap.parse_args()

    def _stop(*_):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    state = State(STATE_DIR)
    w = Watcher(state)
    log("starting", poll_s=args.poll, state=str(state.path), bucket=BUCKET, agent_timeout_s=AGENT_TIMEOUT_S,
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
    while not STOP:
        try:
            w.tick()
        except Exception as e:  # noqa: BLE001
            log("tick_error", "error", error=f"{type(e).__name__}: {e}")
        if args.once and not (args.drain and w.active() and time.time() < deadline):
            break
        time.sleep(args.poll)
    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Upload proxy for Agent Pad: accepts audio PUTs, forwards to S3 with credentials.

Static apps can't hold S3 secrets. This tiny proxy accepts the same PUT the
browser was doing anonymously, adds MinIO credentials, and forwards to the
real S3 bucket. Runs inside the agent-pad compose stack.

Only allows writes under holocene-auto/inbox/ and holocene-auto/replies/.

Observability (first hop of the voice memo journey):
- ONE structured JSON log line per request (accepted or rejected) on stdout:
  `docker logs agent-pad-upload` -> {"event":"upload","key":...,"bytes":...,
  "memo_id":...,"status":200,"ms":...}. memo_id is the same uuid5 the inbox
  watcher derives from the key, so a log line joins to the rest of the journey.
- For inbox uploads, a bloodbank.audio.memo.uploaded fact is published over raw
  NATS (stdlib only, fail-open). correlationid = memo_id.

Last hop (playback on the device): the Agent Pad POSTs a tiny beacon to
/upload/played when it starts / finishes playing a spoken reply (or cannot).
The proxy logs it and publishes bloodbank.audio.memo.played (phase started|ended)
or bloodbank.audio.memo.failed (stage playback, retryable). The memo id is parsed
from the reply key replies/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<agent>-<memo_id>.ogg.

First hop (on the device, before any bytes reach us): the pad POSTs /upload/client-event for the
things only it can see: record started/stopped (bytes, duration), recording failed (mic, empty
capture), upload failed after retries. The proxy logs each one (event "client"); the failures also
publish bloodbank.audio.memo.failed (stage record | upload) keyed by the key the memo WOULD have had,
so a memo that never reached S3 still has a memo_id and a place in memo:trace and /voice.
A PUT whose body is shorter than its Content-Length (cell drop mid-upload) is rejected 400 and
published as failed(stage upload) instead of being stored as a complete memo.

Capture levels: the pad measures the input level while it records (peak / RMS in dBFS) and sends them as
the `X-Holocene-Capture` header on the PUT (JSON). They land in audio.memo.uploaded `data.capture`, so a
memo that arrives silent can be told apart from one that was spoken. A recording whose peak stayed under
-60 dBFS never reaches the PUT: the pad holds it back and POSTs `record_silent`, which the proxy logs and
publishes as failed(stage record, error_code silent_capture, retryable false) with `data.capture`.
"""
import re

import json
import os
import socket
import threading
import time
import urllib.parse
import uuid
import http.server
import socketserver
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

S3_ALIAS = "delo"
S3_BUCKET = "holocene-auto"
ALLOWED_PREFIXES = ["inbox/", "replies/"]
PORT = 8080

MC_BIN = os.environ.get("MC_BIN", "/usr/local/bin/mc")
NATS_HOST = os.environ.get("NATS_HOST", "host.docker.internal")
NATS_PORT = int(os.environ.get("NATS_PORT", "4222"))
EMIT_FACTS = os.environ.get("EMIT_FACTS", "1") != "0"
SERVICE = "agent-pad-upload"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(event: str, **fields) -> None:
    rec = {"ts": now_iso(), "svc": SERVICE, "event": event}
    rec.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)


# ---------------------------------------------------------------- memo identity

def memo_id_for(key: str) -> str:
    """Same derivation as services/inbox-watcher/memo_common.py: one id per memo."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"s3://{S3_BUCKET}/{key}"))


def agent_from_key(key: str):
    parts = key.split("/")
    return parts[1] if len(parts) >= 6 and parts[0] == "inbox" and parts[1] else None


# ---------------------------------------------------------------- bloodbank fact

CAPTURE_HEADER = "X-Holocene-Capture"
SILENCE_DBFS = -60.0  # a whole recording quieter than this heard nothing; agreed with the pad and the watcher


def parse_capture(raw):
    """Validated capture levels {peak_dbfs, rms_dbfs, samples?, source?, sent_anyway?} from the pad, or None.

    Accepts the header's JSON text or an already-parsed dict. Anything malformed is dropped, never guessed.
    """
    try:
        c = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    except ValueError:
        return None
    if not isinstance(c, dict):
        return None
    out = {}
    for name in ("peak_dbfs", "rms_dbfs"):
        v = c.get(name)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
            return None
        out[name] = round(max(-120.0, min(6.0, float(v))), 1)
    samples = c.get("samples")
    if isinstance(samples, int) and not isinstance(samples, bool) and 0 <= samples <= 10_000_000:
        out["samples"] = samples
    if isinstance(c.get("source"), str) and c["source"]:
        out["source"] = c["source"][:20]
    if c.get("sent_anyway") is True:
        out["sent_anyway"] = True
    return out


def build_uploaded_envelope(key: str, size: int, content_type: str, user_agent: str, upload_ms: float, capture=None) -> dict:
    memo_id = memo_id_for(key)
    ce_type = "bloodbank.audio.memo.uploaded"
    env = {
        "specversion": "1.0",
        "id": str(uuid.uuid4()),
        "source": f"urn:33god:service:{SERVICE}",
        "type": ce_type,
        "subject": "bloodbank.evt.audio.memo.uploaded",
        "time": now_iso(),
        "datacontenttype": "application/json",
        "correlationid": memo_id,
        "causationid": None,
        "producer": SERVICE,
        "service": SERVICE,
        "domain": "audio",
        "schemaref": f"{ce_type}.v1",
        "dataschema": f"apicurio://holyfields/{ce_type}/versions/1",
        "kind": "event",
        "actor": {"type": "service", "agent_id": f"bloodbank.service.{SERVICE}", "cli": None, "provider": None, "model": None},
        "ordering_key": f"memo:{memo_id}",
        "data": {
            "memo_id": memo_id, "s3_key": key, "target_agent_id": agent_from_key(key),
            "occurred_at": now_iso(), "bytes": size, "content_type": content_type,
            "client_user_agent": user_agent, "upload_ms": round(upload_ms, 1),
        },
    }
    if capture:
        env["data"]["capture"] = capture
    return env


# ---------------------------------------------------------------- playback beacon

REPLY_KEY_RE = re.compile(
    r"^replies/(\d{4})/(\d{2})/(\d{2})/(\d{2})(\d{2})(\d{2})Z-(?P<agent>.+)-(?P<memo>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(ogg|webm|m4a|mp3)$")
PHASES = ("started", "ended", "blocked", "error", "skipped")


def parse_reply_key(key: str):
    """(memo_id, agent, rendered_at) from a reply key, or None for keys without a full memo id."""
    m = REPLY_KEY_RE.match(key or "")
    if not m:
        return None
    y, mo, d, h, mi, sec = (int(m.group(i)) for i in range(1, 7))
    try:
        rendered = datetime(y, mo, d, h, mi, sec, tzinfo=timezone.utc)
    except ValueError:
        rendered = None
    return m.group("memo"), m.group("agent"), rendered


def _envelope(action: str, memo_id: str, data: dict) -> dict:
    ce_type = f"bloodbank.audio.memo.{action}"
    return {
        "specversion": "1.0", "id": str(uuid.uuid4()), "source": f"urn:33god:service:{SERVICE}",
        "type": ce_type, "subject": f"bloodbank.evt.audio.memo.{action}", "time": now_iso(),
        "datacontenttype": "application/json", "correlationid": memo_id, "causationid": None,
        "producer": SERVICE, "service": SERVICE, "domain": "audio",
        "schemaref": f"{ce_type}.v1", "dataschema": f"apicurio://holyfields/{ce_type}/versions/1", "kind": "event",
        "actor": {"type": "service", "agent_id": f"bloodbank.service.{SERVICE}", "cli": None, "provider": None, "model": None},
        "ordering_key": f"memo:{memo_id}", "data": {"memo_id": memo_id, "occurred_at": now_iso(), **data},
    }


def build_playback_envelope(beacon: dict, user_agent: str):
    """Bloodbank envelope for a pad playback beacon, or None when the beacon cannot be tied to a memo."""
    key = beacon.get("reply_key")
    parsed = parse_reply_key(key)
    phase = beacon.get("phase")
    if not parsed or phase not in PHASES:
        return None
    memo_id, agent, rendered = parsed
    age_ms = int((datetime.now(timezone.utc) - rendered).total_seconds() * 1000) if rendered else None
    if phase in ("started", "ended"):
        secs = beacon.get("seconds")
        return _envelope("played", memo_id, {
            "target_agent_id": agent, "reply_s3_key": key, "phase": phase,
            "played_seconds": round(float(secs), 2) if isinstance(secs, (int, float)) and secs >= 0 else None,
            "client_user_agent": user_agent[:200], "reply_age_ms": age_ms if age_ms is None or age_ms >= 0 else 0})
    code = {"blocked": "autoplay_blocked", "skipped": "not_played"}.get(phase, "playback_error")
    default_msg = {"blocked": "sound is locked: tap the pad once",
                   "skipped": "the pad chose not to play this reply"}.get(phase, "audio element error")
    return _envelope("failed", memo_id, {
        "target_agent_id": agent, "s3_key": key, "reply_s3_key": key, "stage": "playback", "error_code": code,
        "error_message": str(beacon.get("error") or default_msg)[:300],
        "retryable": True, "attempt": 1, "client_user_agent": user_agent[:200]})


WHEEL_KEYS_MAX_BYTES = 32768
WHEEL_KEYS_MAX_LINES = 200


def wheel_key_lines(ev: dict) -> list:
    """The inspector lines of a wheel_keys upload: strings only, bounded count and length, control chars dropped."""
    raw = ev.get("lines")
    if not isinstance(raw, list):
        return []
    return [re.sub(r"[\x00-\x1f\x7f]", " ", x)[:300] for x in raw[:WHEEL_KEYS_MAX_LINES] if isinstance(x, str)]


CLIENT_EVENTS = ("record_started", "record_stopped", "record_failed", "record_silent", "upload_failed", "upload_recovered")
KEY_RE = re.compile(r"^inbox/[^/]+/\d{4}/\d{2}/\d{2}/[^/]+\.(ogg|webm|m4a|mp3|wav|opus|mp4)$")


def build_client_envelope(ev: dict, user_agent: str):
    """failed(stage record|upload) for a device-side failure, or None for log-only events / bad input."""
    key = ev.get("key")
    kind = ev.get("event")
    if not isinstance(key, str) or not KEY_RE.match(key) or kind not in ("record_failed", "record_silent", "upload_failed"):
        return None
    stage = "upload" if kind == "upload_failed" else "record"
    attempts = ev.get("attempts")
    capture = parse_capture(ev.get("capture"))
    if kind == "record_silent":
        # The pad held the recording back: nothing was uploaded, so this is the whole story of the memo.
        peak = capture["peak_dbfs"] if capture else None
        return _envelope("failed", memo_id_for(key), {
            "target_agent_id": agent_from_key(key), "s3_key": key, "stage": "record", "error_code": "silent_capture",
            "error_message": ("no sound reached the microphone"
                              + (f" (peak {peak} dBFS, threshold {SILENCE_DBFS:g})" if peak is not None else ""))[:300],
            "retryable": False, "attempt": 1, "client_user_agent": user_agent[:200], "source": "agent-pad",
            **({"capture": capture} if capture else {})})
    return _envelope("failed", memo_id_for(key), {
        "target_agent_id": agent_from_key(key), "s3_key": key, "stage": stage,
        "error_code": str(ev.get("code") or kind)[:60], "error_message": str(ev.get("error") or kind)[:300],
        "retryable": bool(ev.get("retryable", kind == "upload_failed")),
        "attempt": attempts if isinstance(attempts, int) and attempts >= 1 else 1,
        "client_user_agent": user_agent[:200], "source": "agent-pad", **({"capture": capture} if capture else {})})


def publish_async(env: dict, key: str) -> None:
    if not EMIT_FACTS:
        return

    def work():
        try:
            nats_publish(env["subject"], json.dumps(env, separators=(",", ":")).encode())
            log("fact_published", key=key, memo_id=env["correlationid"], fact=f"audio.memo.{env['type'].rsplit('.', 1)[1]}",
                fact_id=env["id"])
        except Exception as e:  # noqa: BLE001 - fail open
            log("fact_failed", key=key, memo_id=env["correlationid"], error=str(e)[:200], nats=f"{NATS_HOST}:{NATS_PORT}")
    threading.Thread(target=work, daemon=True).start()


def nats_publish(subject: str, body: bytes, timeout: float = 3.0) -> None:
    with socket.create_connection((NATS_HOST, NATS_PORT), timeout=timeout) as s:
        f = s.makefile("rwb", buffering=0)
        f.readline()  # INFO
        f.write(b'CONNECT {"verbose":false,"pedantic":false,"name":"agent-pad-upload","lang":"py-stdlib"}\r\n')
        f.write(b"PUB " + subject.encode() + b" " + str(len(body)).encode() + b"\r\n" + body + b"\r\n")
        f.write(b"PING\r\n")
        f.flush()
        while True:
            line = f.readline()
            if not line:
                raise IOError("NATS closed before PONG")
            if line.startswith(b"PONG"):
                return
            if line.startswith(b"-ERR"):
                raise IOError(line.decode(errors="replace").strip())


def emit_uploaded_async(key: str, size: int, content_type: str, user_agent: str, upload_ms: float, capture=None) -> None:
    if not EMIT_FACTS or not key.startswith("inbox/") or agent_from_key(key) is None:
        return

    def work():
        env = build_uploaded_envelope(key, size, content_type, user_agent, upload_ms, capture)
        try:
            nats_publish(env["subject"], json.dumps(env, separators=(",", ":")).encode())
            log("fact_published", key=key, memo_id=env["correlationid"], fact="audio.memo.uploaded", fact_id=env["id"])
        except Exception as e:  # noqa: BLE001 — fail open: the upload already succeeded
            log("fact_failed", key=key, memo_id=env["correlationid"], fact="audio.memo.uploaded", error=str(e)[:200],
                nats=f"{NATS_HOST}:{NATS_PORT}")

    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- http

class Handler(http.server.BaseHTTPRequestHandler):
    def _reject(self, code: int, reason: str, key=None, **extra):
        log("upload", key=key, memo_id=memo_id_for(key) if key else None, status=code, reason=reason,
            remote=self.client_address[0], ua=self.headers.get("User-Agent"), **extra)
        self.send_error(code, reason)

    def do_PUT(self):
        t0 = time.time()
        # Parse the path: /upload/<key>
        if not self.path.startswith("/upload/"):
            return self._reject(404, "not found")

        key = urllib.parse.unquote(self.path[len("/upload/"):])
        if not any(key.startswith(p) for p in ALLOWED_PREFIXES) or ".." in key.split("/"):
            return self._reject(403, "key not allowed", key=key)

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0 or content_length > 50 * 1024 * 1024:
            return self._reject(400, "invalid content length", key=key, content_length=content_length)

        body = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "application/octet-stream")
        ua = self.headers.get("User-Agent", "")
        raw_capture = self.headers.get(CAPTURE_HEADER)
        capture = parse_capture(raw_capture[:512]) if raw_capture else None
        if len(body) != content_length:
            # The client went away mid-body (a cell drop in the car). Storing the prefix would hand the
            # watcher a cut-off recording and dispatch half a sentence to an agent as a real prompt.
            log("upload", key=key, memo_id=memo_id_for(key), agent=agent_from_key(key), status=400, reason="short_body",
                bytes=len(body), content_length=content_length, ms=int((time.time() - t0) * 1000),
                remote=self.client_address[0], ua=ua)
            if key.startswith("inbox/") and agent_from_key(key):
                publish_async(_envelope("failed", memo_id_for(key), {
                    "target_agent_id": agent_from_key(key), "s3_key": key, "stage": "upload", "error_code": "short_body",
                    "error_message": f"connection ended after {len(body)} of {content_length} bytes; nothing was stored",
                    "retryable": True, "attempt": 1, "client_user_agent": ua[:200]}), key)
            try:
                self.send_error(400, "short body")
            except OSError:
                pass
            return
        if key.endswith(".ogg") and not body.startswith(b"OggS"):
            return self._reject(400, "not_ogg", key=key, bytes=len(body))

        # Write to temp file, then mc cp
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(key).suffix) as f:
            f.write(body)
            tmp_path = f.name

        try:
            t1 = time.time()
            result = subprocess.run(
                [MC_BIN, "cp", "--quiet", tmp_path, f"{S3_ALIAS}/{S3_BUCKET}/{key}"],
                capture_output=True, text=True, timeout=30,
            )
            s3_ms = (time.time() - t1) * 1000
            if result.returncode != 0:
                log("upload", key=key, memo_id=memo_id_for(key), bytes=len(body), status=502, reason="s3 upload failed",
                    error=result.stderr.strip()[:200], ms=int((time.time() - t0) * 1000), ua=ua)
                self.send_error(502, f"s3 upload failed: {result.stderr[:100]}")
                return
            log("upload", key=key, memo_id=memo_id_for(key), agent=agent_from_key(key), bytes=len(body), status=200,
                content_type=content_type, s3_ms=int(s3_ms), ms=int((time.time() - t0) * 1000),
                peak_dbfs=capture and capture["peak_dbfs"], rms_dbfs=capture and capture["rms_dbfs"],
                sent_anyway=capture and capture.get("sent_anyway"), remote=self.client_address[0], ua=ua)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            emit_uploaded_async(key, len(body), content_type, ua, s3_ms, capture)
        finally:
            os.unlink(tmp_path)

    def _client_event(self):
        """Device-side event: POST /upload/client-event {event, key, error?, code?, bytes?, duration_ms?, attempts?, retryable?, capture?}."""
        try:
            n = int(self.headers.get("Content-Length", 0))
            ev = json.loads(self.rfile.read(min(n, WHEEL_KEYS_MAX_BYTES)) or b"{}")
            if not isinstance(ev, dict):
                raise ValueError("not an object")
        except (ValueError, json.JSONDecodeError):
            log("client", status=400, reason="bad json", remote=self.client_address[0])
            return self.send_error(400, "bad json")
        ua = self.headers.get("User-Agent", "")
        if ev.get("event") == "wheel_keys":
            return self._wheel_keys(ev, ua)
        key, kind = ev.get("key"), ev.get("event")
        capture = parse_capture(ev.get("capture"))
        ok = isinstance(key, str) and KEY_RE.match(key) and kind in CLIENT_EVENTS
        log("client", key=key if ok else str(key)[:200], memo_id=memo_id_for(key) if ok else None, agent=agent_from_key(key) if ok else None,
            client_event=kind, status=200 if ok else 202, error=ev.get("error"), code=ev.get("code"), bytes=ev.get("bytes"),
            duration_ms=ev.get("duration_ms"), attempts=ev.get("attempts"),
            peak_dbfs=capture and capture["peak_dbfs"], rms_dbfs=capture and capture["rms_dbfs"], remote=self.client_address[0], ua=ua)
        self.send_response(200 if ok else 202)
        self.send_header("Content-Length", "0")
        self.end_headers()
        env = build_client_envelope(ev, ua) if ok else None
        if env:
            publish_async(env, key)

    def _wheel_keys(self, ev: dict, ua: str):
        """Steering-wheel key inspector upload from Holocene Auto (Diagnostics, parked): key/scroll/session lines.

        Log-only: one `wheel_keys` line per upload and one `wheel_key` line per input, so
        `docker logs agent-pad-upload | grep wheel_key` shows which codes the Civic's buttons really send.
        No audio, no memo, nothing published.
        """
        lines = wheel_key_lines(ev)
        log("wheel_keys", status=200, lines=len(lines), app=str(ev.get("app"))[:80], device=str(ev.get("device"))[:80],
            installer=str(ev.get("installer"))[:60], session=str(ev.get("session"))[:10], mapping=str(ev.get("mapping"))[:400],
            remote=self.client_address[0], ua=ua[:120])
        for line in lines:
            log("wheel_key", line=line)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        """Playback beacon from the pad: POST /upload/played {reply_key, phase, seconds?, error?}."""
        if self.path == "/upload/client-event":
            return self._client_event()
        if self.path != "/upload/played":
            return self._reject(404, "not found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            beacon = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            log("playback", status=400, reason="bad json", remote=self.client_address[0])
            return self.send_error(400, "bad json")
        ua = self.headers.get("User-Agent", "")
        env = build_playback_envelope(beacon if isinstance(beacon, dict) else {}, ua)
        if env is None:
            log("playback", status=202, reason="ignored: reply key has no memo id or phase unknown",
                reply_key=str(beacon.get("reply_key"))[:200] if isinstance(beacon, dict) else None,
                phase=beacon.get("phase") if isinstance(beacon, dict) else None, remote=self.client_address[0])
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        log("playback", key=beacon["reply_key"], memo_id=env["correlationid"], phase=beacon["phase"], status=200,
            error=beacon.get("error"), remote=self.client_address[0], ua=ua)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
        if EMIT_FACTS:
            def work():
                try:
                    nats_publish(env["subject"], json.dumps(env, separators=(",", ":")).encode())
                    log("fact_published", key=beacon["reply_key"], memo_id=env["correlationid"],
                        fact=f"audio.memo.{env['type'].rsplit('.', 1)[1]}", fact_id=env["id"])
                except Exception as e:  # noqa: BLE001 — fail open
                    log("fact_failed", key=beacon["reply_key"], memo_id=env["correlationid"], error=str(e)[:200],
                        nats=f"{NATS_HOST}:{NATS_PORT}")
            threading.Thread(target=work, daemon=True).start()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404, "not found")

    def log_message(self, format, *args):
        pass  # structured logging above replaces the default access log


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    log("starting", port=PORT, nats=f"{NATS_HOST}:{NATS_PORT}", emit_facts=EMIT_FACTS)
    with ThreadedServer(("", PORT), Handler) as srv:
        srv.serve_forever()

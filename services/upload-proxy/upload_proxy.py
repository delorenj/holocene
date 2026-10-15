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
"""

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

def build_uploaded_envelope(key: str, size: int, content_type: str, user_agent: str, upload_ms: float) -> dict:
    memo_id = memo_id_for(key)
    ce_type = "bloodbank.audio.memo.uploaded"
    return {
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


def emit_uploaded_async(key: str, size: int, content_type: str, user_agent: str, upload_ms: float) -> None:
    if not EMIT_FACTS or not key.startswith("inbox/") or agent_from_key(key) is None:
        return

    def work():
        env = build_uploaded_envelope(key, size, content_type, user_agent, upload_ms)
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
                remote=self.client_address[0], ua=ua)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            emit_uploaded_async(key, len(body), content_type, ua, s3_ms)
        finally:
            os.unlink(tmp_path)

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

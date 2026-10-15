#!/usr/bin/env python3
"""Upload proxy for Agent Pad: accepts audio PUTs, forwards to S3 with credentials.

Static apps can't hold S3 secrets. This tiny proxy accepts the same PUT the
browser was doing anonymously, adds MinIO credentials, and forwards to the
real S3 bucket. Runs inside the agent-pad compose stack.

Only allows writes under holocene-auto/inbox/ and holocene-auto/replies/.
"""

import os
import sys
import urllib.parse
import http.server
import socketserver
import subprocess
import tempfile
from pathlib import Path

S3_ALIAS = "delo"
S3_BUCKET = "holocene-auto"
ALLOWED_PREFIXES = ["inbox/", "replies/"]
PORT = 8080

MC_BIN = os.environ.get("MC_BIN", "/usr/local/bin/mc")


def log(msg: str):
    print(f"[upload-proxy] {msg}", flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        # Parse the path: /upload/<key>
        if not self.path.startswith("/upload/"):
            self.send_error(404, "not found")
            return

        key = urllib.parse.unquote(self.path[len("/upload/"):])
        if not any(key.startswith(p) for p in ALLOWED_PREFIXES):
            self.send_error(403, "key not allowed")
            return

        # Read the body
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0 or content_length > 50 * 1024 * 1024:
            self.send_error(400, "invalid content length")
            return

        body = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "application/octet-stream")

        # Write to temp file, then mc cp
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(key).suffix) as f:
            f.write(body)
            tmp_path = f.name

        try:
            result = subprocess.run(
                [MC_BIN, "cp", "--quiet", tmp_path,
                 f"{S3_ALIAS}/{S3_BUCKET}/{key}"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                log(f"mc cp failed for {key}: {result.stderr[:200]}")
                self.send_error(502, f"s3 upload failed: {result.stderr[:100]}")
                return
            log(f"uploaded {key} ({len(body)} bytes)")
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
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
        pass  # suppress default logging


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    log(f"starting on :{PORT}")
    with ThreadedServer(("", PORT), Handler) as srv:
        srv.serve_forever()

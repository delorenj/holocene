"""Private Jev consumer. No memo, bus, bucket, model, scheduler or device provisioning."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from collections.abc import Callable

ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SESSION = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
TTL = 7200
MAX_JSON = 16384
MAX_AUDIO = 2 * 1024 * 1024
FIELDS = ("agentId", "sourceSessionId", "sourceThreadId", "sourceEventIds", "sourceAt", "generatedAt", "asOf", "status")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_json(url, bearer):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer}"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=5) as res:
        body = res.read(MAX_JSON + 1)
        if res.status != 200 or len(body) > MAX_JSON:
            raise ValueError("unavailable")
        return json.loads(body)


def stamp(raw):
    if not isinstance(raw, str) or not raw.endswith("Z"):
        raise ValueError("timestamp")
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()


def project(raw, agent, session=None, now=None):
    """Validate attribution and independent source/projection age, never freshen old substance."""
    now = time.time() if now is None else now
    if not isinstance(raw, dict) or raw.get("agentId") != agent or raw.get("status") not in ("available", "missing", "stale"):
        raise ValueError("attribution")
    if session and raw.get("sourceSessionId") != session:
        # Missing exact sessions may echo the requested session; anything else is never a substitute.
        raise ValueError("session")
    out = {k: raw.get(k) for k in FIELDS}
    if raw["status"] != "available":
        return out
    if not SESSION.fullmatch(str(raw.get("sourceSessionId") or "")) or not SESSION.fullmatch(str(raw.get("sourceThreadId") or "")):
        raise ValueError("session")
    events = raw.get("sourceEventIds")
    if not isinstance(events, list) or not 1 <= len(events) <= 16 or any(not isinstance(e, str) or not SESSION.fullmatch(e) for e in events):
        raise ValueError("evidence")
    ages = [now - stamp(raw.get(k)) for k in ("sourceAt", "generatedAt", "asOf")]
    if any(age < -5 for age in ages):
        raise ValueError("future")
    if any(age > TTL for age in ages):
        return {**out, "status": "stale"}
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 1200 or any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise ValueError("text")
    out["text"] = text.strip()
    identity = {k: out[k] for k in ("agentId", "sourceSessionId", "sourceThreadId", "sourceEventIds", "sourceAt", "text")}
    out["digestId"] = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return out


class Consumer:
    def __init__(self, devices, desk, render: Callable[[str, Path, str], bytes], jev_url="http://127.0.0.1:8768", fetch=read_json, clock=time.time, route=None):
        u = urllib.parse.urlsplit(jev_url)
        if u.scheme != "http" or u.hostname != "127.0.0.1" or u.path not in ("", "/") or u.query or u.fragment or u.username:
            raise ValueError("Jev must be loopback")
        self.devices = {k: v for k, v in devices.items() if isinstance(v, str) and len(v) >= 32}
        self.desk, self.render, self.jev_url, self.fetch, self.clock = desk, render, jev_url.rstrip("/"), fetch, clock
        self.route = route
        self.slots = threading.BoundedSemaphore(2)

    def authorized(self, header):
        return isinstance(header, str) and any(hmac.compare_digest(header.encode("utf-8"), f"Bearer {v}".encode("utf-8")) for v in self.devices.values())

    def read(self, path, header):
        if not self.authorized(header):
            return 401, {"error": "unauthorized"}
        url = urllib.parse.urlsplit(path)
        q = urllib.parse.parse_qs(url.query, keep_blank_values=True)
        summary = url.path == "/v1/pad-summary"
        if url.path not in ("/v1/pad-digest", "/v1/pad-summary") or set(q) - {"agentId", "sourceSessionId", "digestId"} or any(len(v) != 1 for v in q.values()):
            return 400, {"error": "invalid_request"}
        agent, session, version = (q.get(k, [None])[0] for k in ("agentId", "sourceSessionId", "digestId"))
        if not ID.fullmatch(agent or "") or (session is not None and not SESSION.fullmatch(session)) or (summary and (not session or not re.fullmatch(r"[0-9a-f]{64}", version or ""))) or (not summary and version is not None):
            return 400, {"error": "invalid_request"}
        # Registry memo capability is the shared roster authority; no cached/invented identity.
        from memo_common import registry_route
        if not (self.route or registry_route)(agent).get("ok"):
            return 404, {"error": "unavailable"}
        if not self.slots.acquire(blocking=False):
            return 503, {"error": "unavailable"}
        try:
            query = urllib.parse.urlencode({"agentId": agent, **({"sourceSessionId": session} if session else {})})
            digest = project(self.fetch(f"{self.jev_url}/v1/agent-session-digest?{query}", header[7:]), agent, session, self.clock())
            if not summary:
                return 200, digest
            if digest.get("status") != "available" or digest.get("digestId") != version:
                return 409, {"error": "digest_changed"}
            # Same assignment adapter as Auto replies. Transport-specific overrides were retired:
            # rendered Flume/Hermes tts.voice wins, then the owner's emergency/catalog fallback.
            choice = self.desk.voice_choice(agent, os.environ.get("MEMO_VOX_VOICE", "rick"), check_catalog=True)
            voice = choice.get("effective_voice")
            if not isinstance(voice, str) or not voice:
                return 200, {"agentId": agent, "sourceSessionId": session, "digestId": version, "status": "voice_unavailable"}
            with tempfile.TemporaryDirectory(prefix="pad-summary-") as tmp:
                audio = self.render(digest["text"], Path(tmp), voice)
                if not audio or len(audio) > MAX_AUDIO:
                    raise ValueError("audio")
            # Render latency must not turn a once-fresh digest into eligible speech.
            if project(self.fetch(f"{self.jev_url}/v1/agent-session-digest?{query}", header[7:]), agent, session, self.clock()).get("digestId") != version:
                return 409, {"error": "digest_changed"}
            after = self.desk.voice_choice(agent, os.environ.get("MEMO_VOX_VOICE", "rick"), check_catalog=True)
            if after.get("effective_voice") != voice or after.get("source") != choice.get("source"):
                return 409, {"error": "voice_changed"}
            return 200, {"agentId": agent, "sourceSessionId": session, "digestId": version, "status": "available",
                         "voice": voice, "voiceSource": choice["source"], "ext": "ogg", "audio": base64.b64encode(audio).decode()}
        except Exception:
            return 503, {"error": "unavailable"}
        finally:
            self.slots.release()


def server(consumer, port=8769):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            code, body = consumer.read(self.path, self.headers.get("Authorization"))
            payload = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            self.send_error(405)

        def log_message(self, format, *args):
            pass
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    # Explicitly opt in only after HOLOC-73 provisions native per-device credentials.
    if os.environ.get("HOLOCENE_PAD_DIGEST_ENABLED") != "1":
        raise SystemExit("private digest reads disabled (HOLOC-73)")
    from converse import Desk
    from inbox_watcher import synthesize, TtsGate
    devices = json.loads(os.environ.get("JEV_DIGEST_DEVICES", "{}"))
    if not devices:
        raise SystemExit("private digest reads disabled: no devices")
    desk = Desk(Path(os.environ.get("MEMO_STATE_DIR", str(Path.home() / ".local/state/holocene-auto"))))
    def render(text, tmp, voice):
        path, _ = synthesize(text, tmp, voice=voice, prio=TtsGate.REPLY, timeout=12, max_bytes=MAX_AUDIO)
        return path.read_bytes()
    server(Consumer(devices, desk, render), int(os.environ.get("HOLOCENE_PAD_DIGEST_PORT", "8769"))).serve_forever()


if __name__ == "__main__":
    main()

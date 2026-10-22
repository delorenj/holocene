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
A PUT under inbox/<agent>/ for an agent the gateway cannot route is rejected 422 "unroutable agent <id>" and not
stored, so the pad shows "NOT sent" instead of SENT for a memo the watcher would only hold; it also publishes
failed(stage upload, unknown_agent, retryable false), at most once an hour per key. The routable list is the pad's
own roster (MEMO_PAD_ROSTER_DIR/roster.json, regenerated every 2 min by the pad-roster timer and mounted here as a
DIRECTORY - a single-file bind mount pins the inode, so the old registry mount never saw the writer's os.replace).
An id is refused only on positive knowledge: it is in the roster's `skipped` list, or it is absent from `agents`
while the roster is under ROSTER_FRESH_S old. A missing, unreadable or stale roster fails OPEN (the PUT is
accepted, one log line): a broken check never blocks a memo.
A PUT whose body is shorter than its Content-Length (cell drop mid-upload) is rejected 400 and
published as failed(stage upload) instead of being stored as a complete memo.

Capture levels: the pad measures the input level while it records (peak / RMS in dBFS) and sends them as
the `X-Holocene-Capture` header on the PUT (JSON). They land in audio.memo.uploaded `data.capture`, so a
memo that arrives silent can be told apart from one that was spoken. A recording whose peak stayed under
-60 dBFS never reaches the PUT: the pad holds it back and POSTs `record_silent`, which the proxy logs and
publishes as failed(stage record, error_code silent_capture, retryable false) with `data.capture`.

Earshot (bucket channel that plays on the phone, repo delorenj/earshot): the phone POSTs one beacon per phase
to /upload/heard {channel, key, phase detected|started|finished|failed|missed, at, last_modified, device,
app_version, error?, clock_skew_ms?}. The proxy validates the shape, logs one JSON line (event "heard",
status 200 | 400) and publishes bloodbank.audio.earshot.<detected|started|ended|failed|skipped>
(finished -> ended, missed -> skipped; data.phase keeps the device's own word), fail-open.
`earshot trace` reads those log lines.
phase "heartbeat" (about one a minute while the listener is alive) is liveness only: validated, logged and
persisted, but it publishes NO Bloodbank fact. `earshot status` reads the persisted heartbeats so a dead
listener is distinguishable from no drops.
Every accepted beacon is ALSO appended, one JSON object per line, to EARSHOT_BEACON_JSONL (the compose stack
bind-mounts it at /var/lib/earshot/beacons.jsonl; host side ~/.local/share/earshot/beacons/). The docker log
rotates and dies with the container; this file survives recreation. Rotated at 64 MB with one .old
generation. `earshot trace|status` read it first and fall back to docker logs.

Push channel for the car: GET /upload/events is a Server-Sent Events stream of the memo facts the pad can act on
(received, transcribed, dispatched, narrated, voiced, replied, failed, and agent.invocation.progressed of a memo turn),
read from one core NATS subscription and reduced to ids and keys. See PushHub below and the inbox-watcher README,
"The reply, sentence by sentence, pushed to the car".

Who sent a memo, and is that car live: the pad names its device (X-Holocene-Device, a random id it keeps) and host
(X-Holocene-Host: car | browser) on the PUT and on its push stream (/upload/events?device=&host=). The proxy keeps them
with the memo (in memory, and as S3 metadata on the inbox object, so a restart loses nothing) and in the
audio.memo.uploaded fact (device_id, device_host). GET /upload/presence?memo=<memo_id>&key=<inbox key> answers whether
the memo came from a car whose push stream is open right now. See Presence below.

Who speaks a reply in the cabin, the car or the phone's Earshot copy: POST /upload/claim (ReplyClaims below, one claim
per reply file: a memo's follow-up is a second reply with its own). The car
holds the reply on a renewed lease while it waits and claims its start; the inbox watcher takes it for the phone only
when no car holds it after a grace window. Exactly one of them speaks it (a paired phone plays through the car's
speakers: the same reply twice, or a reply into the next recording), and a car switched off right after the agent
finished lets go within the lease, so the phone still speaks it. Neither speaks without the proxy's yes, so the claims
are written through to CLAIM_STATE_FILE and read back at start, and every take waits CLAIM_SETTLE_S after a start.
"""
import re

import json
import os
import queue
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

MEMO_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def memo_id_for(key: str) -> str:
    """Same derivation as services/inbox-watcher/memo_common.py: one id per memo."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"s3://{S3_BUCKET}/{key}"))


def agent_from_key(key: str):
    parts = key.split("/")
    return parts[1] if len(parts) >= 6 and parts[0] == "inbox" and parts[1] else None


# ---------------------------------------------------------------- agent routing (the pad roster, re-read on change)

# The same roster.json the pad's web UI shows (regenerated every 2 min by the holocene-pad-roster timer). The
# compose stack mounts the roster DIRECTORY read-only; outside the container the default is the host path.
PAD_ROSTER_DIR = Path(os.environ.get("MEMO_PAD_ROSTER_DIR", Path.home() / ".local/share/holocene-auto/pad-roster"))
# An id that is absent from `agents` is refused only while the roster itself is this fresh: a stale roster says
# nothing about an agent hired since. (A `skipped` entry is positive knowledge and refuses at any age.)
ROSTER_FRESH_S = int(os.environ.get("MEMO_ROSTER_FRESH_S", "600"))

_roster_cache: dict = {"stamp": None, "roster": None}


def _roster() -> dict | None:
    """Parsed roster.json, re-read whenever the file changes (a directory mount sees the writer's os.replace,
    unlike the old single-file registry mount). None when missing or unreadable."""
    try:
        p = PAD_ROSTER_DIR / "roster.json"
        st = p.stat()
        stamp = (st.st_mtime_ns, st.st_size)
        if _roster_cache["stamp"] != stamp:
            _roster_cache["roster"] = json.loads(p.read_text(encoding="utf-8"))
            _roster_cache["stamp"] = stamp
        return _roster_cache["roster"] if isinstance(_roster_cache["roster"], dict) else None
    except (OSError, ValueError):
        return None


def agent_route(agent: str) -> dict:
    """{ok: True|False|None, reason} from the pad roster. None = could not tell (roster missing, unreadable or
    stale): the caller accepts the upload, so a broken check never blocks a memo."""
    try:
        r = _roster()
    except Exception as e:  # noqa: BLE001 - fail open
        return {"ok": None, "reason": f"route check unavailable: {type(e).__name__}: {e}"[:200]}
    if r is None:
        return {"ok": None, "reason": f"pad roster unreadable: {PAD_ROSTER_DIR}/roster.json"}
    for s in r.get("skipped") or []:
        if isinstance(s, dict) and s.get("id") == agent:
            return {"ok": False, "reason": str(s.get("reason") or f"{agent!r} is skipped in the pad roster")[:200]}
    agents = r.get("agents")
    ids = {a.get("id") for a in agents if isinstance(a, dict)} if isinstance(agents, list) else set()
    if agent in ids:
        return {"ok": True, "reason": None}
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(str(r.get("generated_at", "")).replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        age = None
    if age is not None and age <= ROSTER_FRESH_S:
        return {"ok": False, "reason": f"{agent!r} is not in the pad roster (generated {int(age)}s ago): the gateway cannot route it"}
    return {"ok": None, "reason": "pad roster is stale; absence from it is not proof of unroutable"}


_UNROUTABLE_PUBLISHED: dict = {}   # key -> time of the last failed fact: the pad re-PUTs a rejected memo every 30 s
UNROUTABLE_FACT_EVERY_S = 3600


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


# ---------------------------------------------------------------- who sent it (device), and is that car live

DEVICE_HEADER = "X-Holocene-Device"
HOST_HEADER = "X-Holocene-Host"
DEVICE_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
HOST_KINDS = ("car", "browser")


def clean_device(device, host):
    """(device id or None, host kind or None) from what a pad sent; anything malformed is dropped, never guessed."""
    d = device if isinstance(device, str) and DEVICE_RE.match(device) else None
    h = host if isinstance(host, str) and host in HOST_KINDS else None
    return d, h


# A pad's stream ends at PUSH_MAX_AGE_S and the pad reconnects about 3 s later (retry: 3000): a device whose last stream
# closed this recently is still live. Kept short because an edge (Cloudflare) can hold a dead client's stream open until
# the proxy itself recycles it, so "live" lags a car that was switched off by at most PUSH_MAX_AGE_S + this.
PRESENCE_GRACE_S = float(os.environ.get("PRESENCE_GRACE_S", "30"))
PRESENCE_MEMOS = 2000


class Presence:
    """Which devices hold a push stream right now (or did a moment ago), and which device sent which memo."""

    def __init__(self, grace_s: float = PRESENCE_GRACE_S, memos_max: int = PRESENCE_MEMOS):
        self._lock = threading.Lock()
        self._devices: dict = {}   # device -> {"host", "open", "since", "closed_at"}
        self._memos: dict = {}     # memo_id -> (device, host)  (insertion ordered, bounded)
        self.grace_s = grace_s
        self._max = memos_max

    def opened(self, device, host, now: float | None = None) -> None:
        if not device:
            return
        now = time.time() if now is None else now
        with self._lock:
            d = self._devices.setdefault(device, {"host": host, "open": 0, "since": now, "closed_at": None})
            if d["open"] == 0 and (d["closed_at"] is None or now - d["closed_at"] > self.grace_s):
                d["since"] = now
            d["open"] += 1
            d["host"] = host or d["host"]

    def closed(self, device, now: float | None = None) -> None:
        if not device:
            return
        now = time.time() if now is None else now
        with self._lock:
            d = self._devices.get(device)
            if d:
                d["open"] = max(0, d["open"] - 1)
                d["closed_at"] = now

    def sent(self, memo_id: str, device, host) -> None:
        if not memo_id or not (device or host):
            return
        with self._lock:
            self._memos.pop(memo_id, None)
            self._memos[memo_id] = (device, host)
            while len(self._memos) > self._max:
                self._memos.pop(next(iter(self._memos)))

    def sender(self, memo_id: str):
        with self._lock:
            return self._memos.get(memo_id)

    def live(self, device, now: float | None = None) -> dict:
        """{live, host, streams, since} for a device (live: a stream is open, or closed within grace_s)."""
        now = time.time() if now is None else now
        with self._lock:
            d = self._devices.get(device) if device else None
            if not d:
                return {"live": False, "host": None, "streams": 0, "since": None}
            ok = d["open"] > 0 or (d["closed_at"] is not None and now - d["closed_at"] <= self.grace_s)
            return {"live": ok, "host": d["host"], "streams": d["open"],
                    "since": datetime.fromtimestamp(d["since"], timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if ok else None}

    def devices(self, now: float | None = None) -> list:
        with self._lock:
            names = list(self._devices)
        return [{"device": n, **self.live(n, now)} for n in names]


PRESENCE = Presence()


# ---------------------------------------------------------------- reply claims: who speaks a reply in the cabin

# The car that sent a memo speaks its reply itself, and a phone paired with that car plays the reply's Earshot copy
# through the same speakers. Exactly one of them may speak it, so both ask here and the answer is atomic:
# - The car (the pad page, host "car") HOLDS the reply as soon as it knows of it and renews the hold every few seconds
#   while it waits in its queue (behind a recording or another reply); it STARTS it when it plays it. A hold is a
#   lease: it lapses CLAIM_LEASE_S after the last renewal, so a car that was switched off lets go within that time
#   (presence could not tell: an edge keeps a dead car's push stream open for minutes).
# - The inbox watcher OFFERS the reply when its audio is up (a one-file reply is also pushed to the car right then),
#   and TAKES it for the phone once the car's grace window passed with no live hold. A take is refused while the car
#   holds or has started the reply. Granted, it is final: a car that comes back later is refused its hold and its
#   start, and leaves the reply to the phone. The car is the one that skips, because the page is deployed live here
#   and the phone (Earshot) plays whatever lands in its channel.
# The car's playback beacons and speech-queue starts also count as a start: a page from before claims still wins.
#
# Neither side speaks without this arbiter's yes, so it must never forget and never answer from a blank memory:
# - The state is written through to CLAIM_STATE_FILE (a host-mounted directory) on every change and read back at
#   start, so a restart keeps every hold, start and take (a take forgotten by a restart would let a car that comes back
#   speak a reply the phone already played; a start forgotten would let the phone take a reply the car is speaking).
# - For CLAIM_SETTLE_S after a start every take is refused ("settling"): a car that played a reply on its live hold
#   while the proxy was down re-sends its start, and a waiting car renews its holds, within a few seconds of the proxy
#   answering again, so they land before the phone can take what the car already has.
CLAIM_LEASE_S = float(os.environ.get("CLAIM_LEASE_S", "20"))
CLAIM_SETTLE_S = float(os.environ.get("CLAIM_SETTLE_S", "10"))
CLAIM_STATE_FILE = os.environ.get("CLAIM_STATE_FILE", "")  # empty: memory only
CLAIM_KEEP_S = 2 * 86400  # a claim this old is not read back (the car never plays a reply that old)
CLAIM_MEMOS = 2000  # claims kept (one per reply file; a memo with a follow-up has two)
CLAIM_ACTIONS = {"car": ("hold", "start", "end", "release"), "watcher": ("offer", "take", "release")}
CLAIM_FIELDS = ("owner", "car", "lease_until", "held_at", "started_at", "device", "offered_at", "phone_at", "released_at",
                "touched", "memo_id", "reply_key")
# A claim is PER REPLY FILE, not per memo (2026-10-22 review): a memo's answer-then-background follow-up is a second reply
# file of the same memo. Kept per memo, the quick answer's "car ended" decided the follow-up too: the watcher read
# car_spoke at once and the phone never got a follow-up that landed after the car was switched off. Every request that
# names the reply (reply_key: the car always, the watcher's offer/take/release/poll, the pad's ?reply= look) gets that
# reply's own claim. One that names only the memo (a page or watcher from before this) gets the memo's newest claim.


class ReplyClaims:
    """Per reply file: who owns it (car | phone | nobody yet), and the car's hold lease. Bounded; written through to
    state_file (when given) on every change and read back at start; every take refused for settle_s after boot_at.
    Every method takes the memo id and, optionally, the reply key: with it the claim is that reply's own; without it, the
    memo's newest claim (see CLAIM_FIELDS)."""

    def __init__(self, lease_s: float = CLAIM_LEASE_S, memos_max: int = CLAIM_MEMOS, state_file: str | None = None,
                 settle_s: float = CLAIM_SETTLE_S, boot_at: float | None = None):
        self._lock = threading.Lock()
        self._m: dict = {}   # reply key (or, for a memo-only claim, memo id) -> state (insertion ordered, bounded)
        self.lease_s = lease_s
        self._max = memos_max
        self.state_file = state_file or None
        self.settle_s = settle_s
        self.boot_at = time.time() if boot_at is None else boot_at
        self.loaded = self._load()  # claims read back (0: no file yet), None: the file could not be read

    @staticmethod
    def _key_memo(ck: str):
        """The memo id a claim key belongs to (a memo id, or a reply key), or None for a key that is neither."""
        if isinstance(ck, str) and MEMO_UUID_RE.match(ck):
            return ck
        parsed = parse_reply_key(ck) if isinstance(ck, str) else None
        return parsed[0] if parsed else None

    def _load(self) -> int | None:
        if not self.state_file:
            return 0
        try:
            with open(self.state_file, encoding="utf-8") as f:
                doc = json.load(f)
        except FileNotFoundError:
            return 0
        except (OSError, ValueError) as e:
            log("claims_load_failed", file=self.state_file, error=str(e)[:200],
                note="starting empty; every take waits out the settle window")
            return None
        memos = doc.get("memos") if isinstance(doc, dict) else None
        if not isinstance(memos, dict):
            log("claims_load_failed", file=self.state_file, error="no memos object")
            return None
        cutoff = self.boot_at - CLAIM_KEEP_S
        for ck, st in memos.items():
            mid = self._key_memo(ck)
            if mid and isinstance(st, dict) and (st.get("touched") or 0) >= cutoff:
                # a v1 file is keyed by memo id: such a claim stays the memo's (memo-only lookups), not any reply's
                self._m[ck] = {**{k: st.get(k) for k in CLAIM_FIELDS}, "memo_id": mid,
                               "reply_key": ck if ck != mid else None}
        while len(self._m) > self._max:
            self._m.pop(next(iter(self._m)))
        return len(self._m)

    def _save(self) -> None:
        """Write the whole state through (atomic rename), under the lock, before the answer goes out."""
        if not self.state_file:
            return
        tmp = f"{self.state_file}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"v": 2, "saved_at": time.time(), "memos": self._m}, f, separators=(",", ":"))
            os.replace(tmp, self.state_file)
        except OSError as e:
            log("claims_save_failed", file=self.state_file, error=str(e)[:200])

    def _claims_of(self, memo_id: str) -> list:
        return [ck for ck, st in self._m.items() if st.get("memo_id") == memo_id]

    def _find(self, memo_id: str, reply_key: str | None, prefer_phone: bool = False) -> tuple[str, dict | None]:
        """(claim key, state or None). The reply's own claim; memo-only: the memo's newest one (prefer_phone: the one the
        phone owns, if any: a pad from before ?reply= asks whether the phone still has the reply it left to it)."""
        if reply_key:
            return reply_key, self._m.get(reply_key)
        cks = self._claims_of(memo_id)
        if prefer_phone:
            owned = [ck for ck in cks if self._m[ck].get("owner") == "phone"]
            cks = owned or cks
        return (cks[-1], self._m[cks[-1]]) if cks else (memo_id, None)

    def _state(self, memo_id: str, reply_key: str | None = None) -> dict:
        ck, st = self._find(memo_id, reply_key)
        if st is None:
            st = {k: None for k in CLAIM_FIELDS}
            st["memo_id"], st["reply_key"] = memo_id, reply_key
            self._m[ck] = st
            while len(self._m) > self._max:
                self._m.pop(next(iter(self._m)))
        return st

    def _view(self, memo_id: str, st: dict | None, now: float, reply_key: str | None = None) -> dict:
        st = st or {}
        left = (st["lease_until"] - now) if st.get("car") == "held" and st.get("lease_until") else 0.0
        return {"memo_id": memo_id, "reply_key": st.get("reply_key") or reply_key, "owner": st.get("owner"),
                "car": st.get("car"), "car_holds": left > 0,
                "lease_left_s": round(max(0.0, left), 1), "held_ever": st.get("held_at") is not None,
                "device": st.get("device"), "offered": st.get("offered_at") is not None,
                "released": st.get("released_at") is not None,
                "since_offer_s": round(now - st["offered_at"], 1) if st.get("offered_at") else None,
                "settling_s": round(max(0.0, self.boot_at + self.settle_s - now), 1)}

    def view(self, memo_id: str, now: float | None = None, reply_key: str | None = None,
             prefer_phone: bool = False) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            return self._view(memo_id, self._find(memo_id, reply_key, prefer_phone)[1], now, reply_key)

    def car(self, memo_id: str, action: str, device=None, now: float | None = None, reply_key: str | None = None) -> dict:
        """The car holds (renews its lease), starts or ends the reply. ok False: the phone took it, the car leaves it."""
        now = time.time() if now is None else now
        with self._lock:
            st = self._state(memo_id, reply_key)
            if st["owner"] == "phone":
                return {**self._view(memo_id, st, now), "ok": False}
            st["owner"] = "car"
            st["device"] = device or st["device"]
            st["held_at"] = st["held_at"] or now
            if action == "hold":
                if st["car"] not in ("started", "ended"):
                    st["car"], st["lease_until"] = "held", now + self.lease_s
            elif action == "start":
                if st["car"] != "ended":
                    st["car"] = "started"
                st["started_at"] = st["started_at"] or now
            elif action == "end":
                st["car"] = "ended"
                st["started_at"] = st["started_at"] or now
            elif action == "release":
                # The car gives the reply up before it started it (playback failed, or it will not play it): the hold
                # ends now, so the phone may take it at once instead of after the lease lapses. A reply the car started
                # is not released: it was heard.
                if st["car"] not in ("started", "ended"):
                    st["car"], st["lease_until"], st["owner"] = None, None, None
            st["touched"] = now
            self._save()
            return {**self._view(memo_id, st, now), "ok": True}

    def played(self, memo_id: str, phase: str, device=None, now: float | None = None, reply_key: str | None = None) -> bool:
        """The car reports it played the reply (beacon / speech start): recorded as its start or end. False: the phone
        had taken it (a page from before claims, or a car that ignored the refusal): the reply was heard twice."""
        if phase not in ("start", "end"):
            return True
        now = time.time() if now is None else now
        with self._lock:
            st = self._find(memo_id, reply_key)[1]
            if st is not None and st["owner"] == "phone":
                return False
        return self.car(memo_id, phase, device, now, reply_key)["ok"]

    def offer(self, memo_id: str, now: float | None = None, reply_key: str | None = None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            st = self._state(memo_id, reply_key)
            if not st["offered_at"]:
                st["offered_at"] = st["touched"] = now
                self._save()
            return {**self._view(memo_id, st, now), "ok": True}

    def release(self, memo_id: str, now: float | None = None, reply_key: str | None = None) -> dict:
        """The watcher gives the phone's take back (the Earshot drop failed, so the phone has nothing to play): the car may
        hold and start the reply again. Only the phone's take is released; a reply the car owns is left as it is."""
        now = time.time() if now is None else now
        with self._lock:
            st = self._state(memo_id, reply_key)
            if st["owner"] == "phone":
                st["owner"], st["phone_at"], st["released_at"], st["touched"] = None, None, now, now
                self._save()
            return {**self._view(memo_id, st, now), "ok": True}

    def take(self, memo_id: str, now: float | None = None, reply_key: str | None = None) -> dict:
        """The phone takes the reply: granted unless the car holds a live lease on it, or started (or ended) it, and
        never while the arbiter is settling after a start (a car's re-sent start or hold may still be on its way)."""
        now = time.time() if now is None else now
        with self._lock:
            st = self._state(memo_id, reply_key)
            if st["owner"] != "phone":
                if st["car"] in ("started", "ended") or (st["car"] == "held" and (st["lease_until"] or 0) > now):
                    return {**self._view(memo_id, st, now), "ok": False}
                if now < self.boot_at + self.settle_s:
                    return {**self._view(memo_id, st, now), "ok": False, "settling": True}
                st["owner"], st["phone_at"], st["touched"] = "phone", now, now
                self._save()
            return {**self._view(memo_id, st, now), "ok": True}


# CLAIMS (the live arbiter) is built below parse_reply_key: reading a v2 state file back needs it.


def claim_request(body, claims: "ReplyClaims" = None, presence: "Presence" = None, lookup=None, hub=None):
    """POST /upload/claim, pure: (status, answer). See ReplyClaims. The watcher's offer also answers who sent the memo
    (sender_host car | browser | null) and, with announce, pushes a one-file reply to the car at once."""
    claims = claims or CLAIMS
    if not isinstance(body, dict):
        return 400, {"error": "not an object"}
    by, action = body.get("by"), body.get("action")
    if action not in CLAIM_ACTIONS.get(by, ()):
        return 400, {"error": "bad by/action"}
    reply_key = body.get("reply_key") if isinstance(body.get("reply_key"), str) else None
    parsed = parse_reply_key(reply_key) if reply_key else None
    memo_id = body.get("memo_id") if isinstance(body.get("memo_id"), str) else (parsed[0] if parsed else None)
    if not memo_id or not MEMO_UUID_RE.match(memo_id) or (parsed and parsed[0] != memo_id):
        return 400, {"error": "bad memo id or reply key"}
    rk = reply_key if parsed else None  # the reply's own claim; a memo-only request gets the memo's newest
    if by == "car":
        device, _ = clean_device(body.get("device"), None)
        return 200, claims.car(memo_id, action, device, reply_key=rk)
    if action == "take":
        return 200, claims.take(memo_id, reply_key=rk)
    if action == "release":
        ans = claims.release(memo_id, reply_key=rk)
        if parsed and ans.get("owner") is None:
            # the car that left the reply to the phone listens for this: it plays the reply after all
            (hub or PUSH).publish({"fact": "released", "memo_id": memo_id, "at": now_iso(), "reply_s3_key": reply_key,
                                   **({"agent": parsed[1][:80]} if parsed[1] else {})})
        return 200, ans
    ans = claims.offer(memo_id, reply_key=rk)
    key = body.get("key") if isinstance(body.get("key"), str) and KEY_RE.match(body.get("key")) else None
    device, host = memo_sender(memo_id, key, presence, lookup)
    ans.update({"sender_host": host, "sender_device": device})
    if body.get("announce") is True and parsed:
        (hub or PUSH).publish({"fact": "offered", "memo_id": memo_id, "at": now_iso(), "reply_s3_key": reply_key,
                               **({"agent": parsed[1][:80]} if parsed[1] else {})})
        ans["announced"] = True
    return 200, ans


def stored_sender(key: str):
    """(device, host) from the inbox object's S3 metadata (the PUT stores them), for a memo uploaded before a restart."""
    try:
        r = subprocess.run([MC_BIN, "stat", "--json", f"{S3_ALIAS}/{S3_BUCKET}/{key}"], capture_output=True, text=True, timeout=10)
        meta = (json.loads(r.stdout.strip().splitlines()[-1]).get("metadata") or {}) if r.returncode == 0 else {}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    low = {str(k).lower(): v for k, v in meta.items()}
    d, h = clean_device(low.get("x-amz-meta-holocene-device"), low.get("x-amz-meta-holocene-host"))
    return (d, h) if d or h else None


def memo_sender(memo_id: str, key: str | None, presence: "Presence" = None, lookup=None, source: list | None = None):
    """(device, host) that uploaded the memo: from this process's memory, else the inbox object's S3 metadata."""
    presence = presence or PRESENCE
    who = presence.sender(memo_id)
    src = "upload" if who else None
    if not who and key:
        who = (lookup or stored_sender)(key)
        if who:
            src = "s3_metadata"
            presence.sent(memo_id, *who)
    if source is not None:
        source.append(src)
    return who or (None, None)


def presence_answer(memo_id: str, key: str | None, presence: "Presence" = None, lookup=None) -> dict:
    """GET /upload/presence: did this memo come from a car whose push stream is live? Unknown sender: car_live false."""
    presence = presence or PRESENCE
    src: list = []
    device, host = memo_sender(memo_id, key, presence, lookup, src)
    source = src[0]
    state = presence.live(device) if device else {"live": False, "host": None, "streams": 0, "since": None}
    return {"memo_id": memo_id, "device": device, "host": host, "source": source, **state,
            "car_live": host == "car" and state["live"]}


def build_uploaded_envelope(key: str, size: int, content_type: str, user_agent: str, upload_ms: float, capture=None,
                            device=None, host=None) -> dict:
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
    if device:
        env["data"]["device_id"] = device
    if host:
        env["data"]["device_host"] = host
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


# The live arbiter, read back from CLAIM_STATE_FILE: built here, after parse_reply_key, which reading its keys needs.
CLAIMS = ReplyClaims(state_file=CLAIM_STATE_FILE)


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
        chunks = beacon.get("chunks")
        return _envelope("played", memo_id, {
            "target_agent_id": agent, "reply_s3_key": key, "phase": phase,
            "played_seconds": round(float(secs), 2) if isinstance(secs, (int, float)) and secs >= 0 else None,
            "client_user_agent": user_agent[:200], "reply_age_ms": age_ms if age_ms is None or age_ms >= 0 else 0,
            # the car spoke this reply from its chunks (replies/...-cNNofMM.opus) rather than the full file
            **({"chunks": chunks} if isinstance(chunks, int) and not isinstance(chunks, bool) and 1 < chunks <= 99 else {})})
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


SPEECH_ACTIONS = ("queued", "deferred", "start", "end", "halt", "drop", "ignored", "mic", "chunk", "wait")
SPEECH_MEMO_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def speech_decision(raw):
    """A speech-queue decision from the car, bounded and typed, or None."""
    if not isinstance(raw, dict) or raw.get("action") not in SPEECH_ACTIONS:
        return None
    clean = lambda v, n: re.sub(r"[\x00-\x1f\x7f]", " ", v)[:n] if isinstance(v, str) else None
    out = {"speech_action": raw["action"], "speech_kind": clean(raw.get("kind"), 20), "speech_id": clean(raw.get("id"), 200),
           "speech_reason": clean(raw.get("reason"), 80), "mic": clean(raw.get("mic"), 12)}
    for k in ("seq", "at", "mono_ms"):
        v = raw.get(k)
        if isinstance(v, int) and not isinstance(v, bool):
            out["device_at" if k == "at" else k] = v
    memo = raw.get("memo_id")
    if isinstance(memo, str) and SPEECH_MEMO_RE.match(memo):
        out["memo_id"] = memo
    return out


# Published as facts: what was said (or refused) for a memo. "queued" is the arbiter's bookkeeping (the start that
# follows carries waited_ms), "ignored" names no utterance and "mic" no memo, "chunk" / "wait" are the steps inside one
# chunked reply (seq = the chunk): those stay in the log.
SPEECH_FACT_ACTIONS = ("start", "end", "halt", "drop", "deferred")


def build_speech_envelope(d: dict, memo_id: str, key: str | None, user_agent: str):
    """bloodbank.audio.memo.notified for one memo-tied speech decision, or None for log-only ones."""
    if d.get("speech_action") not in SPEECH_FACT_ACTIONS:
        return None
    at = d.get("device_at")
    device_at = None
    if isinstance(at, int) and 1_000_000_000_000 <= at < 10_000_000_000_000:  # epoch milliseconds
        device_at = datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    mic = d.get("mic")
    return _envelope("notified", memo_id, {
        "s3_key": key, "target_agent_id": agent_from_key(key) if key else None,
        "utterance": d.get("speech_kind") or "unknown", "decision": d["speech_action"],
        "reason": d.get("speech_reason") or None, "utterance_id": d.get("speech_id") or None,
        "device_at": device_at, "recording": (mic in ("arming", "recording")) if isinstance(mic, str) else None,
        "mic": mic, "seq": d.get("seq"), "mono_ms": d.get("mono_ms"),
        "client_user_agent": user_agent[:200] or None, "source": "holocene-auto"})


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


# ---------------------------------------------------------------- earshot beacon

EARSHOT_BUCKET = "earshot"
EARSHOT_PHASES = {"detected": "detected", "started": "started", "finished": "ended", "failed": "failed", "missed": "skipped"}
HEARTBEAT_PHASE = "heartbeat"   # liveness only: logged + persisted, never published as a fact
EARSHOT_CHANNEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")
MAX_SKEW_MS = 86_400_000        # a phone more than a day off its clock has bigger problems
# Compose bind-mounts this into the container; empty = stdout logging only (dev).
EARSHOT_JSONL = os.environ.get("EARSHOT_BEACON_JSONL", "")
EARSHOT_JSONL_MAX_BYTES = 64 * 1024 * 1024


def persist_heard(rec: dict) -> None:
    """Append one accepted beacon to the durable JSONL (host-mounted volume). Fail-open: a mount or
    disk problem must never cost the phone its 200."""
    if not EARSHOT_JSONL:
        return
    try:
        p = Path(EARSHOT_JSONL)
        try:
            if p.stat().st_size > EARSHOT_JSONL_MAX_BYTES:
                old = p.with_name(p.name + ".old")
                try:
                    old.unlink()
                except OSError:
                    pass
                os.replace(p, old)
        except OSError:
            pass  # missing file on first write is normal
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":"), default=str) + "\n")
    except OSError as e:
        log("beacon_jsonl_failed", error=str(e)[:200], path=EARSHOT_JSONL)


def earshot_event_id(key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"s3://{EARSHOT_BUCKET}/{key}"))


def _rfc3339(v) -> bool:
    if not isinstance(v, str) or not RFC3339_RE.match(v):
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _clean_skew(v):
    """(ms, None) for a sane clock_skew_ms, else (None, reason)."""
    if v is None:
        return None, None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return None, "bad clock_skew_ms"
    ms = int(round(v))
    if abs(ms) > MAX_SKEW_MS:
        return None, "bad clock_skew_ms"
    return ms, None


def validate_heard(beacon):
    """(clean beacon, None) for a well-formed earshot beacon, else (None, reason).

    Required: channel, phase, at, device, app_version. For the five playback phases also key (under
    that channel) and last_modified. phase "heartbeat" is liveness: key and last_modified optional
    (validated when present). Optional on every beacon: error, clock_skew_ms (phone clock minus
    server clock, ms). Anything else is dropped.
    """
    if not isinstance(beacon, dict):
        return None, "body is not a JSON object"
    channel, key, phase = beacon.get("channel"), beacon.get("key"), beacon.get("phase")
    if not isinstance(channel, str) or not EARSHOT_CHANNEL_RE.match(channel):
        return None, "bad channel"
    heartbeat = phase == HEARTBEAT_PHASE
    if phase not in EARSHOT_PHASES and not heartbeat:
        return None, "bad phase"
    key_bad = (not isinstance(key, str) or not 0 < len(key) <= 512 or not key.startswith(channel + "/")
               or len(key) == len(channel) + 1 or ".." in key.split("/") or re.search(r"[\x00-\x1f\x7f]", key))
    if key is None:
        if not heartbeat:
            return None, "bad key"
    elif key_bad:
        return None, "bad key"
    last_modified = beacon.get("last_modified")
    if last_modified is None:
        if not heartbeat:
            return None, "bad last_modified"
    elif not _rfc3339(last_modified):
        return None, "bad last_modified"
    if not _rfc3339(beacon.get("at")):
        return None, "bad at"
    for f in ("device", "app_version"):
        v = beacon.get(f)
        if not isinstance(v, str) or not 0 < len(v) <= 80:
            return None, f"bad {f}"
    err = beacon.get("error")
    if err is not None and not isinstance(err, str):
        return None, "bad error"
    skew, why = _clean_skew(beacon.get("clock_skew_ms"))
    if why:
        return None, why
    clean = {"channel": channel, "phase": phase, "at": beacon["at"],
             "device": beacon["device"], "app_version": beacon["app_version"]}
    if key is not None:
        clean["key"] = key
    if last_modified is not None:
        clean["last_modified"] = last_modified
    if err:
        clean["error"] = re.sub(r"[\x00-\x1f\x7f]", " ", err)[:300]
    if skew is not None:
        clean["clock_skew_ms"] = skew
    return clean, None


def build_heard_envelope(beacon: dict, user_agent: str) -> dict:
    """bloodbank.audio.earshot.<action> fact for a validated beacon (see validate_heard)."""
    action = EARSHOT_PHASES[beacon["phase"]]
    event_id = earshot_event_id(beacon["key"])
    ce_type = f"bloodbank.audio.earshot.{action}"
    return {
        "specversion": "1.0", "id": str(uuid.uuid4()), "source": f"urn:33god:service:{SERVICE}",
        "type": ce_type, "subject": f"bloodbank.evt.audio.earshot.{action}", "time": now_iso(),
        "datacontenttype": "application/json", "correlationid": event_id, "causationid": None,
        "producer": SERVICE, "service": SERVICE, "domain": "audio",
        "schemaref": f"{ce_type}.v1", "dataschema": f"apicurio://holyfields/{ce_type}/versions/1", "kind": "event",
        "actor": {"type": "service", "agent_id": f"bloodbank.service.{SERVICE}", "cli": None, "provider": None, "model": None},
        "ordering_key": f"earshot:{event_id}",
        "data": {**beacon, "event_id": event_id, "occurred_at": now_iso(), "client_user_agent": user_agent[:200]},
    }


def publish_async(env: dict, key: str) -> None:
    if not EMIT_FACTS:
        return

    def work():
        try:
            nats_publish(env["subject"], json.dumps(env, separators=(",", ":")).encode())
            log("fact_published", key=key, memo_id=env["correlationid"], fact=env["type"][len("bloodbank."):],
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


def emit_uploaded_async(key: str, size: int, content_type: str, user_agent: str, upload_ms: float, capture=None,
                        device=None, host=None) -> None:
    if not EMIT_FACTS or not key.startswith("inbox/") or agent_from_key(key) is None:
        return

    def work():
        env = build_uploaded_envelope(key, size, content_type, user_agent, upload_ms, capture, device, host)
        try:
            nats_publish(env["subject"], json.dumps(env, separators=(",", ":")).encode())
            log("fact_published", key=key, memo_id=env["correlationid"], fact="audio.memo.uploaded", fact_id=env["id"])
        except Exception as e:  # noqa: BLE001 — fail open: the upload already succeeded
            log("fact_failed", key=key, memo_id=env["correlationid"], fact="audio.memo.uploaded", error=str(e)[:200],
                nats=f"{NATS_HOST}:{NATS_PORT}")

    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- push channel for the car (SSE)
#
# GET /upload/events is a Server-Sent Events stream: one `memo` event per voice-memo fact the car can act on, read from
# NATS (core subscription, stdlib) and reduced to the ids and keys the pad needs, so a new reply, reply chunk, progress
# clip or stage change reaches the car the moment it is published instead of on the pad's next 2 s poll. The pad keeps
# polling as the fallback; this only makes it early. A `beat` event every PUSH_HEARTBEAT_S keeps Cloudflare and Traefik
# from closing an idle stream and tells the pad whether NATS is behind it; every event has an id (<boot>-<n>) so a
# reconnect with Last-Event-ID replays what it missed from a short ring (a new boot replays nothing: the pad re-polls).

PUSH_SUBJECTS = ("bloodbank.evt.audio.memo.>", "bloodbank.evt.agent.invocation.progressed")
# What the car can act on. uploaded / notified / played are the pad's own doing: never echoed back to it.
PUSH_FACTS = ("received", "transcribed", "dispatched", "narrated", "voiced", "replied", "failed")
PUSH_HEARTBEAT_S = float(os.environ.get("PUSH_HEARTBEAT_S", "15"))
PUSH_MAX_CLIENTS = int(os.environ.get("PUSH_MAX_CLIENTS", "32"))
# A stream is recycled (the client reconnects ~3 s later and Last-Event-ID replays the gap). Short, so a stream an edge
# keeps open for a client that is gone (Cloudflare held one for 10 min) stops counting as a live car soon (Presence).
PUSH_MAX_AGE_S = float(os.environ.get("PUSH_MAX_AGE_S", "180"))
PUSH_RING = 200
PUSH_NATS_IDLE_S = 150.0   # the server PINGs every 2 min: silence longer than this is a dead connection
PUSH_KEY_PREFIX = {"reply_s3_key": "replies/", "chunk_s3_key": "replies/", "progress_s3_key": "progress/"}


def push_event(env) -> dict | None:
    """The compact event the car gets for one NATS envelope, or None when it is nothing the car acts on."""
    if not isinstance(env, dict):
        return None
    ce_type = env.get("type") if isinstance(env.get("type"), str) else ""
    data = env.get("data") if isinstance(env.get("data"), dict) else {}
    at = env.get("time") if isinstance(env.get("time"), str) else None
    if ce_type == "bloodbank.agent.invocation.progressed":
        ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
        memo = ctx.get("memo_id")
        if not isinstance(memo, str) or not MEMO_UUID_RE.match(memo):
            return None  # a turn that is not a voice memo's
        seq = data.get("seq")
        return {"fact": "progressed", "memo_id": memo, "at": at,
                **({"seq": seq} if isinstance(seq, int) and not isinstance(seq, bool) else {})}
    if not ce_type.startswith("bloodbank.audio.memo."):
        return None
    action = ce_type.rsplit(".", 1)[1]
    if action not in PUSH_FACTS:
        return None
    memo = data.get("memo_id") or env.get("correlationid")
    if not isinstance(memo, str) or not MEMO_UUID_RE.match(memo):
        return None
    out = {"fact": action, "memo_id": memo, "at": at}
    agent = data.get("target_agent_id")
    if isinstance(agent, str) and agent:
        out["agent"] = agent[:80]
    for k, prefix in PUSH_KEY_PREFIX.items():
        v = data.get(k)
        if isinstance(v, str) and v.startswith(prefix) and ".." not in v.split("/") and len(v) <= 300:
            out[k] = v
    for k in ("chunk", "chunks", "narration", "seq"):
        v = data.get(k)
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            out[k] = v
    for k in ("stage", "error_code"):
        v = data.get(k)
        if action == "failed" and isinstance(v, str):
            out[k] = v[:60]
    return out


class PushClient:
    def __init__(self):
        self.q = queue.Queue(maxsize=256)
        self.overflow = False   # events were dropped: the client is told to re-poll


class PushHub:
    """Fan-out of push events to every open stream, plus a short replay ring."""

    def __init__(self, ring: int = PUSH_RING, max_clients: int = PUSH_MAX_CLIENTS):
        self._lock = threading.Lock()
        self._clients: set = set()
        self._ring: list = []
        self._ring_max = ring
        self._max = max_clients
        self._n = 0
        self.boot = uuid.uuid4().hex[:8]
        self.nats_up = False
        self.published = 0

    def publish(self, ev: dict) -> str:
        with self._lock:
            self._n += 1
            ev_id = f"{self.boot}-{self._n}"
            self._ring.append((self._n, ev_id, ev))
            del self._ring[:-self._ring_max]
            self.published += 1
            for c in self._clients:
                try:
                    c.q.put_nowait((ev_id, ev))
                except Exception:  # noqa: BLE001 - full: drop, the client re-polls
                    c.overflow = True
        return ev_id

    def subscribe(self, last_id: str | None):
        """(client, backlog) or None when the hub is full. The backlog is what a reconnect with Last-Event-ID missed."""
        with self._lock:
            if len(self._clients) >= self._max:
                return None
            c = PushClient()
            self._clients.add(c)
            backlog = []
            if isinstance(last_id, str) and "-" in last_id:
                boot, _, n = last_id.rpartition("-")
                if boot == self.boot and n.isdigit():
                    backlog = [(i, e) for k, i, e in self._ring if k > int(n)]
            return c, backlog

    def unsubscribe(self, c) -> None:
        with self._lock:
            self._clients.discard(c)

    def clients(self) -> int:
        with self._lock:
            return len(self._clients)


PUSH = PushHub()


def sse_frame(event: str, data: dict, ev_id: str | None = None) -> bytes:
    head = f"id: {ev_id}\n" if ev_id else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def handle_nats_msg(subject: str, payload: bytes, hub: PushHub = PUSH) -> dict | None:
    try:
        env = json.loads(payload)
    except ValueError:
        return None
    ev = push_event(env)
    if ev:
        hub.publish(ev)
    return ev


def nats_read_loop(rf, write, hub: PushHub = PUSH) -> None:
    """Read NATS protocol lines until the connection ends: MSG -> handle, PING -> PONG, -ERR -> raise."""
    while True:
        line = rf.readline()
        if not line:
            raise IOError("NATS closed the connection")
        if line.startswith(b"MSG "):
            parts = line.split()
            size = int(parts[-1])
            payload = rf.read(size + 2)[:size]
            handle_nats_msg(parts[1].decode(errors="replace"), payload, hub)
        elif line.startswith(b"PING"):
            write(b"PONG\r\n")
        elif line.startswith(b"-ERR"):
            raise IOError(line.decode(errors="replace").strip())


def nats_subscribe_forever(hub: PushHub = PUSH) -> None:
    """Keep one core NATS subscription to the memo facts alive for the push channel (reconnect with backoff)."""
    backoff, last_err = 1.0, None
    while True:
        try:
            with socket.create_connection((NATS_HOST, NATS_PORT), timeout=10) as s:
                s.settimeout(PUSH_NATS_IDLE_S)
                rf = s.makefile("rb")
                rf.readline()  # INFO
                subs = "".join(f"SUB {subj} {i}\r\n" for i, subj in enumerate(PUSH_SUBJECTS, 1))
                s.sendall(b'CONNECT {"verbose":false,"pedantic":false,"name":"agent-pad-push","lang":"py-stdlib"}\r\n'
                          + subs.encode() + b"PING\r\n")
                hub.nats_up = True
                backoff = 1.0
                if last_err is not None:
                    log("push_nats_up", nats=f"{NATS_HOST}:{NATS_PORT}", subjects=list(PUSH_SUBJECTS))
                    last_err = None
                nats_read_loop(rf, s.sendall, hub)
        except Exception as e:  # noqa: BLE001 - the pad keeps polling; this only makes it early
            hub.nats_up = False
            err = f"{type(e).__name__}: {e}"[:200]
            if err != last_err:
                log("push_nats_down", error=err, nats=f"{NATS_HOST}:{NATS_PORT}", retry_s=backoff)
            last_err = err
            time.sleep(backoff)
            backoff = min(backoff * 2, 15.0)


# ---------------------------------------------------------------- http

class Handler(http.server.BaseHTTPRequestHandler):
    def _reject(self, code: int, reason: str, key=None, **extra):
        log("upload", key=key, memo_id=memo_id_for(key) if key else None, status=code, reason=reason,
            remote=self.client_address[0], ua=self.headers.get("User-Agent"), **extra)
        self.send_error(code, reason)

    def _reject_unroutable(self, key: str, agent: str, reason: str, ua: str):
        """422 for a memo no agent will ever answer. Not stored (the watcher would only hold it); the body was already
        read, so the pad sees the status instead of a reset connection."""
        shown = re.sub(r"[^A-Za-z0-9_.-]", "?", agent)[:40]
        log("upload", key=key, memo_id=memo_id_for(key), agent=agent, status=422, reason="unroutable_agent", detail=reason,
            remote=self.client_address[0], ua=ua)
        now = time.time()
        if len(_UNROUTABLE_PUBLISHED) > 1000:
            _UNROUTABLE_PUBLISHED.clear()
        if now - _UNROUTABLE_PUBLISHED.get(key, 0) >= UNROUTABLE_FACT_EVERY_S:
            _UNROUTABLE_PUBLISHED[key] = now
            publish_async(_envelope("failed", memo_id_for(key), {
                "target_agent_id": agent, "s3_key": key, "stage": "upload", "error_code": "unknown_agent",
                "error_message": reason[:300], "retryable": False, "attempt": 1, "client_user_agent": ua[:200],
                "source": "agent-pad"}), key)
        try:
            # JSON body: over HTTP/2 (Cloudflare, Traefik) the status line's reason phrase does not reach the pad.
            body = json.dumps({"error": "unroutable_agent", "reason": f"unroutable agent {shown}"}).encode()
            self.send_response(422, f"unroutable agent {shown}")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

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
        device, host = clean_device(self.headers.get(DEVICE_HEADER), self.headers.get(HOST_HEADER))
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
        agent = agent_from_key(key) if key.startswith("inbox/") else None
        if agent:
            route = agent_route(agent)
            if route["ok"] is False:
                return self._reject_unroutable(key, agent, route["reason"], ua)
            if route["ok"] is None:
                log("route_check_skipped", key=key, memo_id=memo_id_for(key), agent=agent, reason=route["reason"],
                    note="accepted: the route check fails open")

        # Write to temp file, then mc cp
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(key).suffix) as f:
            f.write(body)
            tmp_path = f.name

        try:
            t1 = time.time()
            # Who sent it rides along as object metadata, so it outlives this process (Presence, stored_sender).
            attrs = ";".join(f"X-Amz-Meta-Holocene-{n}={v}" for n, v in (("Device", device), ("Host", host)) if v)
            result = subprocess.run(
                [MC_BIN, "cp", "--quiet", *(["--attr", attrs] if attrs and key.startswith("inbox/") else []),
                 tmp_path, f"{S3_ALIAS}/{S3_BUCKET}/{key}"],
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
                sent_anyway=capture and capture.get("sent_anyway"), device=device, host=host,
                remote=self.client_address[0], ua=ua)
            if key.startswith("inbox/"):
                PRESENCE.sent(memo_id_for(key), device, host)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            emit_uploaded_async(key, len(body), content_type, ua, s3_ms, capture, device, host)
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
        if ev.get("event") == "speech":
            return self._speech(ev, ua)
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

    def _speech(self, ev: dict, ua: str):
        """One decision of the car's speech queue (SpeechArbiter): logged, and published as audio.memo.notified when it
        is tied to a memo. With the device's wall clock `at` on every start/end/halt, overlap between utterances (or with
        a recording) is auditable from here; the fact puts the ack / echo / progress / reply timing on the memo's
        journey (memo:trace, Holocene /voice). `mic` decisions name no memo: log only."""
        d = speech_decision(ev.get("speech"))
        key = ev.get("key")
        key = key if isinstance(key, str) and KEY_RE.match(key) else None
        memo_id = (d or {}).get("memo_id") or (memo_id_for(key) if key else None)
        log("speech", status=200 if d else 202, key=key, memo_id=memo_id,
            remote=self.client_address[0], ua=ua[:120], **{k: v for k, v in (d or {}).items() if k != "memo_id"})
        self.send_response(200 if d else 202)
        self.send_header("Content-Length", "0")
        self.end_headers()
        env = build_speech_envelope(d, memo_id, key, ua) if d and memo_id else None
        if env:
            publish_async(env, key or memo_id)
        if d and memo_id and d.get("speech_kind") == "reply" and d.get("speech_action") in ("start", "end"):
            # The reply utterance's id is its reply key: settle THAT reply's claim, not the memo's newest (a quick
            # answer's late start must not land on its follow-up). Ids that are not a full reply key fall back to the memo.
            parsed = parse_reply_key(d.get("speech_id") or "")
            rkey = d["speech_id"] if parsed and parsed[0] == memo_id else None
            if not CLAIMS.played(memo_id, d["speech_action"], reply_key=rkey):
                log("claim_conflict", memo_id=memo_id, by="car", action=d["speech_action"], source="speech", key=rkey,
                    note="the car spoke a reply the phone had taken: it was heard twice")

    def _heard(self):
        """Earshot device beacon: POST /upload/heard {channel,key?,phase,at,last_modified?,device,
        app_version,error?,clock_skew_ms?}. Every accepted beacon is logged AND persisted to the
        mounted JSONL (history survives container recreation). Heartbeats stop there: one a minute
        per device must not flood the bus, so no Bloodbank fact for them."""
        ua = self.headers.get("User-Agent", "")
        try:
            n = int(self.headers.get("Content-Length", 0))
            raw = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            raw = None
        beacon, why = validate_heard(raw) if raw is not None else (None, "bad json")
        if beacon is None:
            log("heard", status=400, reason=why, remote=self.client_address[0], ua=ua[:120])
            return self.send_error(400, why)
        rec = {"ts": now_iso(), "svc": SERVICE, "event": "heard", "status": 200,
               "remote": self.client_address[0], "ua": ua[:120], **beacon}
        if beacon.get("phase") == HEARTBEAT_PHASE:
            print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)
            persist_heard(rec)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        env = build_heard_envelope(beacon, ua)
        rec["event_id"] = env["correlationid"]
        print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)
        persist_heard(rec)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
        publish_async(env, beacon["key"])

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

    def _json_reply(self, code: int, body: dict) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _claim(self):
        """POST /upload/claim {by: car|watcher, action: hold|start|end|offer|take, memo_id | reply_key, device?, key?,
        announce?}: who speaks the reply in the cabin (ReplyClaims). GET /upload/claim?memo=<id>: where it stands."""
        if self.command == "GET":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            memo = (q.get("memo") or [""])[0]
            reply = (q.get("reply") or [""])[0] or None
            parsed = parse_reply_key(reply) if reply else None
            if not MEMO_UUID_RE.match(memo) or (reply and (not parsed or parsed[0] != memo)):
                return self.send_error(400, "bad memo id or reply key")
            # ?reply=: that reply's own claim. Memo only (a pad from before per-reply claims asking whether the phone
            # still has the reply it left to it): the claim the phone owns, else the memo's newest.
            return self._json_reply(200, CLAIMS.view(memo, reply_key=reply, prefer_phone=reply is None))
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(min(n, 4096)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            body = None
        code, ans = claim_request(body)
        b = body if isinstance(body, dict) else {}
        log("claim", status=code, memo_id=ans.get("memo_id"), reply_key=ans.get("reply_key"), by=str(b.get("by"))[:10],
            action=str(b.get("action"))[:10],
            ok=ans.get("ok"), owner=ans.get("owner"), car=ans.get("car"), lease_left_s=ans.get("lease_left_s"),
            device=ans.get("device"), sender_host=ans.get("sender_host"), announced=ans.get("announced"),
            error=ans.get("error"), remote=self.client_address[0])
        self._json_reply(code, ans)

    def do_POST(self):
        """Playback beacon from the pad: POST /upload/played {reply_key, phase, seconds?, error?}."""
        if self.path == "/upload/client-event":
            return self._client_event()
        if self.path == "/upload/heard":
            return self._heard()
        if self.path == "/upload/claim":
            return self._claim()
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
        phase = {"started": "start", "ended": "end"}.get(beacon["phase"])
        if phase and not CLAIMS.played(env["correlationid"], phase, reply_key=beacon["reply_key"]):
            log("claim_conflict", memo_id=env["correlationid"], by="car", action=phase, source="playback",
                key=beacon["reply_key"], note="the car played a reply the phone had taken: it was heard twice")
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
        if self.path == "/upload/events" or self.path.startswith("/upload/events?"):
            return self._events()
        if self.path == "/upload/presence" or self.path.startswith("/upload/presence?"):
            return self._presence()
        if self.path.startswith("/upload/claim?"):
            return self._claim()
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404, "not found")

    def _presence(self):
        """GET /upload/presence?memo=<memo_id>[&key=<inbox key>]: was this memo sent from a car whose push stream is live
        (the watcher skips the Earshot phone copy then). Without memo: every device the proxy has seen, for debugging."""
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        memo = (q.get("memo") or [""])[0]
        key = (q.get("key") or [""])[0]
        key = key if KEY_RE.match(key) else None
        if memo and not MEMO_UUID_RE.match(memo):
            return self.send_error(400, "bad memo id")
        body = presence_answer(memo, key) if memo else {"devices": PRESENCE.devices()}
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
        if memo:
            log("presence", memo_id=memo, key=key, device=body.get("device"), host=body.get("host"), live=body.get("live"),
                car_live=body.get("car_live"), source=body.get("source"), remote=self.client_address[0])

    def _events(self):
        """GET /upload/events: the car's push channel (Server-Sent Events). See PushHub."""
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        last = self.headers.get("Last-Event-ID") or (q.get("last") or [None])[0]
        ua = (self.headers.get("User-Agent") or "")[:120]
        device, host = clean_device((q.get("device") or [None])[0], (q.get("host") or [None])[0])
        sub = PUSH.subscribe(last)
        if sub is None:
            log("push", status=503, reason="too many streams", remote=self.client_address[0], ua=ua)
            return self.send_error(503, "too many streams")
        client, backlog = sub
        PRESENCE.opened(device, host)
        t0 = time.time()
        sent = 0
        why = "closed"
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # retry: the browser's reconnect delay. The comment line pushes the first bytes through any buffering hop.
            self.wfile.write(b"retry: 3000\n: " + b" " * 2048 + b"\n\n")
            self.wfile.write(sse_frame("hello", {"boot": PUSH.boot, "nats": PUSH.nats_up, "replayed": len(backlog),
                                                 "beat_s": PUSH_HEARTBEAT_S}))
            for ev_id, ev in backlog:
                self.wfile.write(sse_frame("memo", ev, ev_id))
                sent += 1
            log("push", status=200, phase="open", replayed=len(backlog), streams=PUSH.clients(), nats=PUSH.nats_up,
                device=device, host=host, remote=self.client_address[0], ua=ua)
            while time.time() - t0 < PUSH_MAX_AGE_S:
                try:
                    ev_id, ev = client.q.get(timeout=PUSH_HEARTBEAT_S)
                    self.wfile.write(sse_frame("memo", ev, ev_id))
                    sent += 1
                except queue.Empty:
                    self.wfile.write(sse_frame("beat", {"nats": PUSH.nats_up, "t": now_iso()}))
                if client.overflow:
                    client.overflow = False
                    self.wfile.write(sse_frame("resync", {"reason": "overflow"}))
            why = "max_age"
        except OSError:
            why = "client_gone"
        finally:
            PUSH.unsubscribe(client)
            PRESENCE.closed(device)
            log("push", status=200, phase="close", reason=why, sent=sent, s=int(time.time() - t0),
                device=device, remote=self.client_address[0])

    def log_message(self, format, *args):
        pass  # structured logging above replaces the default access log


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    log("starting", port=PORT, nats=f"{NATS_HOST}:{NATS_PORT}", emit_facts=EMIT_FACTS, push_boot=PUSH.boot,
        claims_file=CLAIM_STATE_FILE or None, claims_loaded=CLAIMS.loaded, claims_settle_s=CLAIMS.settle_s)
    threading.Thread(target=nats_subscribe_forever, name="push-nats", daemon=True).start()
    with ThreadedServer(("", PORT), Handler) as srv:
        srv.serve_forever()

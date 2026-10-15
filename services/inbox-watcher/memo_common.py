"""Shared pieces of the voice memo pipeline: ids, S3 listing, and the read-side
probes for each hop (Candystore, gateway journal, Hermes sessions, NATS).

Used by inbox_watcher.py (the service) and memo_trace.py (the operator tool) so
both look at every hop the same way. Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

BUCKET = os.environ.get("MEMO_BUCKET", "holocene-auto")
S3_ALIAS = os.environ.get("MEMO_S3_ALIAS", "delo")
INBOX_PREFIX = "inbox"
REPLIES_PREFIX = "replies"
S3_PUBLIC_BASE = os.environ.get("MEMO_S3_PUBLIC_BASE", "https://s3.delo.sh/holocene-auto")

HOME = Path.home()
STATE_DIR = Path(os.environ.get("MEMO_STATE_DIR", HOME / ".local/state/holocene-auto/inbox-watcher"))
GATEWAY_DB = Path(os.environ.get("MEMO_GATEWAY_DB", HOME / ".hermes/bloodbank-hermes-gateway-state.sqlite3"))
HERMES_PROFILES = Path(os.environ.get("MEMO_HERMES_PROFILES", HOME / ".hermes/profiles"))
CANDYSTORE_URL = os.environ.get("MEMO_CANDYSTORE_URL", "http://127.0.0.1:8683")
NATS_MONITOR_URL = os.environ.get("MEMO_NATS_MONITOR_URL", "http://127.0.0.1:8222")
VOX_URL = os.environ.get("MEMO_VOX_URL", "https://vox.delo.sh")
GATEWAY_CONSUMER = "bloodbank-hermes-gateway"
COMMAND_STREAM = "BLOODBANK_COMMANDS"
UPLOAD_CONTAINER = "agent-pad-upload"
WATCHER_UNIT = "holocene-inbox-watcher.service"

MC_BIN = os.environ.get("MC_BIN") or shutil.which("mc") or "/usr/local/bin/mc"
BB_EMIT = os.environ.get("BB_EMIT", "/home/delorenj/code/33GOD/bloodbank/bin/bb-emit")

AUDIO_EXTS = (".ogg", ".webm", ".m4a", ".mp3", ".wav", ".opus", ".mp4")


# ---------------------------------------------------------------- identity

def memo_id_for(key: str) -> str:
    """One id per memo: the Bloodbank correlationid of every stage fact and of the command."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"s3://{BUCKET}/{key}"))


def agent_from_key(key: str) -> str | None:
    """inbox/<agent>/<yyyy>/<mm>/<dd>/<file>. The ONLY source of the target agent."""
    parts = key.split("/")
    if len(parts) >= 6 and parts[0] == INBOX_PREFIX and parts[1]:
        return parts[1]
    return None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | float | None) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, (int, float)):
        dt = datetime.fromtimestamp(dt, timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        pass
    m = re.match(r"(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?", s)
    if m:
        try:
            return datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}{m.group(3) or ''}+00:00")
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------- S3 (mc)

def mc(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([MC_BIN, *args], capture_output=True, text=True, timeout=timeout)


def s3_url(key: str) -> str:
    return f"{S3_ALIAS}/{BUCKET}/{key}"


def s3_list_inbox() -> list[dict]:
    """Every audio object under inbox/: {key, size, last_modified(datetime)}."""
    r = mc("ls", "--recursive", "--json", s3_url(INBOX_PREFIX), timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"mc ls failed rc={r.returncode}: {r.stderr.strip()[:200]}")
    out = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get("type") != "file":
            continue
        rel = o.get("key", "")
        if not rel.lower().endswith(AUDIO_EXTS):
            continue
        out.append({
            "key": f"{INBOX_PREFIX}/{rel}",
            "size": int(o.get("size", 0)),
            "last_modified": parse_iso(o.get("lastModified")),
        })
    return out


def s3_stat(key: str) -> dict | None:
    """{key,size,last_modified} or None when the object does not exist."""
    r = mc("stat", "--json", s3_url(key), timeout=30)
    if r.returncode != 0:
        return None
    try:
        o = json.loads(r.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return None
    if o.get("status") == "error":
        return None
    return {"key": key, "size": int(o.get("size", 0)), "last_modified": parse_iso(o.get("lastModified"))}


def s3_find_inbox_key(fragment: str) -> str | None:
    """Resolve a key, a file name, or a memo_id (full or 8+ char prefix) to an inbox key."""
    frag = fragment.strip()
    for o in sorted(s3_list_inbox(), key=lambda x: x["last_modified"] or now_utc(), reverse=True):
        k = o["key"]
        if k == frag or k.endswith("/" + frag) or memo_id_for(k).startswith(frag.lower()) or frag in k:
            return k
    return None


# ---------------------------------------------------------------- HTTP json

def http_json(url: str, timeout: float = 5.0):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


# ---------------------------------------------------------------- Candystore

def candystore_events(correlation_id: str, limit: int = 200) -> list[dict]:
    """Every projected Bloodbank event with this correlationid, oldest first."""
    url = f"{CANDYSTORE_URL}/events?correlationid={urllib.parse.quote(correlation_id)}&limit={limit}"
    body = http_json(url, timeout=8)
    events = body.get("events", [])
    return sorted(events, key=lambda e: e.get("time") or "")


# ---------------------------------------------------------------- gateway journal

def journal_row(command_id: str) -> dict | None:
    """The gateway's execution row for this exact command id (never 'latest for profile')."""
    if not GATEWAY_DB.exists():
        raise FileNotFoundError(f"gateway journal missing: {GATEWAY_DB}")
    db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True, timeout=5)
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT command_id, profile, state, outcome, rejection_reason, rejected_at, "
            "created_at, updated_at, terminal_events FROM executions WHERE command_id=?",
            (command_id,),
        ).fetchone()
    finally:
        db.close()
    if row is None:
        return None
    d = dict(row)
    terminal = []
    if d.get("terminal_events"):
        try:
            terminal = json.loads(d["terminal_events"])
        except json.JSONDecodeError:
            terminal = []
    d["terminal"] = terminal
    d.pop("terminal_events", None)
    return d


def terminal_error(row: dict) -> str | None:
    """error_code/error_message the gateway put on a failed terminal event, if any."""
    for env in row.get("terminal", []):
        data = (env or {}).get("data") or {}
        if data.get("error_message") or data.get("error_code"):
            return f"{data.get('error_code') or 'error'}: {data.get('error_message') or ''}".strip()
    return row.get("rejection_reason")


# ---------------------------------------------------------------- Hermes session (reply text)

def profile_db(profile: str) -> Path:
    return HERMES_PROFILES / profile / "state.db"


def find_reply(profile: str, thread_id: str) -> dict | None:
    """The agent's final reply for the session the gateway opened for this thread_id.

    Gateway contract: source 'bloodbank', chat_id = data.thread_id of the command.
    Because the watcher picks a unique thread_id per memo, this is exact: no
    'latest session' / mtime guessing. Returns {session_id, text, timestamp} or None.
    """
    path = profile_db(profile)
    if not path.exists():
        raise FileNotFoundError(f"hermes state.db missing for profile {profile}: {path}")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        db.row_factory = sqlite3.Row
        sess = db.execute(
            "SELECT id FROM sessions WHERE source='bloodbank' AND chat_id=? ORDER BY started_at DESC LIMIT 1",
            (thread_id,),
        ).fetchone()
        if sess is None:
            # chat_id column may not exist on very old schemas; fall back to session_key
            sess = db.execute(
                "SELECT id FROM sessions WHERE source='bloodbank' AND session_key LIKE ? ORDER BY started_at DESC LIMIT 1",
                (f"%:{thread_id}",),
            ).fetchone()
        if sess is None:
            return None
        msg = db.execute(
            "SELECT content, timestamp FROM messages WHERE session_id=? AND role='assistant' "
            "AND content IS NOT NULL AND TRIM(content) <> '' AND COALESCE(active,1)=1 "
            "ORDER BY timestamp DESC, id DESC LIMIT 1",
            (sess["id"],),
        ).fetchone()
    finally:
        db.close()
    if msg is None:
        return {"session_id": sess["id"], "text": None, "timestamp": None}
    return {"session_id": sess["id"], "text": msg["content"].strip(), "timestamp": msg["timestamp"]}


# ---------------------------------------------------------------- NATS / gateway liveness

def gateway_liveness() -> dict:
    """Is anything pulling bloodbank.cmd.agent.invocation.start? num_waiting >= 1 means yes."""
    try:
        body = http_json(f"{NATS_MONITOR_URL}/jsz?consumers=true&streams=true", timeout=4)
    except Exception as e:  # noqa: BLE001
        return {"ok": None, "error": f"nats monitor unreachable: {e}"}
    for acct in body.get("account_details", []):
        for st in acct.get("stream_detail", []):
            if st.get("name") != COMMAND_STREAM:
                continue
            for c in st.get("consumer_detail", []):
                if c.get("name") == GATEWAY_CONSUMER:
                    return {
                        "ok": (c.get("num_waiting", 0) or 0) >= 1,
                        "num_waiting": c.get("num_waiting", 0),
                        "num_pending": c.get("num_pending", 0),
                        "num_ack_pending": c.get("num_ack_pending", 0),
                        "delivered": (c.get("delivered") or {}).get("stream_seq"),
                    }
            return {"ok": False, "error": f"consumer {GATEWAY_CONSUMER} not registered on {COMMAND_STREAM}"}
    return {"ok": None, "error": f"stream {COMMAND_STREAM} not found"}


def gateway_liveness_text(info: dict | None = None) -> str:
    info = info or gateway_liveness()
    if info.get("error"):
        return info["error"]
    verdict = "pulling" if info["ok"] else "NOBODY PULLING (gateway bloodbank platform down?)"
    return (f"{verdict}; consumer {GATEWAY_CONSUMER}: waiting={info['num_waiting']} "
            f"pending={info['num_pending']} ack_pending={info['num_ack_pending']}")

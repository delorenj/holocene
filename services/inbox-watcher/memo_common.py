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
# Two gateway lanes, one durable consumer each (bloodbank/docs/interactive-command-lane.md).
# interactive = a human is waiting (voice memos), reserved slots; batch = grooming and PM fan-out.
GATEWAY_CONSUMERS = {
    "interactive": "bloodbank-hermes-gateway-interactive",
    "batch": "bloodbank-hermes-gateway",
}
LANE_COMMAND_TYPES = {
    "interactive": "bloodbank.cmd.agent.invocation.invoke",
    "batch": "bloodbank.cmd.agent.invocation.start",
}
LANES = tuple(GATEWAY_CONSUMERS)
GATEWAY_CONSUMER = GATEWAY_CONSUMERS["batch"]  # the original single lane; kept for old imports


def lane_from_subject(subject: str | None) -> str | None:
    """interactive | batch from a command subject; None when it names neither."""
    for lane, t in LANE_COMMAND_TYPES.items():
        if subject and subject.endswith(t.split("bloodbank.cmd.", 1)[1]):
            return lane
    return None
COMMAND_STREAM = "BLOODBANK_COMMANDS"
UPLOAD_CONTAINER = "agent-pad-upload"
WATCHER_UNIT = "holocene-inbox-watcher.service"

REGISTRY_PATH = Path(os.environ.get("MEMO_AGENT_REGISTRY", HOME / ".hermes/agents-registry.yaml"))
GATEWAY_UNIT = os.environ.get("MEMO_GATEWAY_UNIT", "hermes-gateway.service")
FFPROBE = os.environ.get("MEMO_FFPROBE", "ffprobe")

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


# ---------------------------------------------------------------- agent routing

def registry_route(agent_id: str) -> dict:
    """Can the Bloodbank gateway route a command to this agent? Mirrors ProfileResolver in
    bloodbank/services/hermes-gateway (registry row with profile_name, bloodbank not disabled,
    gateway_scope fleet, target_agent_id equal to the row id).

    {ok: True|False|None, profile, display_name, reason}. ok=None means "could not tell"
    (no PyYAML, registry unreadable): callers must not block on it.
    """
    try:
        import yaml  # type: ignore
        parsed = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))
        agents = parsed["agents"]
    except Exception as e:  # noqa: BLE001
        return {"ok": None, "profile": None, "display_name": None, "reason": f"registry unreadable: {type(e).__name__}: {e}"[:200]}
    row = agents.get(agent_id) if isinstance(agents, dict) else None
    if not isinstance(row, dict):
        return {"ok": False, "profile": None, "display_name": None,
                "reason": f"{agent_id!r} is not in {REGISTRY_PATH.name}: the gateway would consume the command and drop it"}
    name = row.get("display_name") if isinstance(row.get("display_name"), str) else None
    bb = row.get("bloodbank")
    profile = row.get("profile_name")
    if not (isinstance(profile, str) and profile.strip() and isinstance(bb, dict)):
        return {"ok": False, "profile": None, "display_name": name, "reason": f"{agent_id!r} has no profile_name/bloodbank block in the registry"}
    if bb.get("enabled", True) is not True:
        return {"ok": False, "profile": profile, "display_name": name, "reason": f"{agent_id!r} has bloodbank.enabled={bb.get('enabled')!r} (default-deny)"}
    if bb.get("gateway_scope") != "fleet" or bb.get("target_agent_id") != agent_id:
        return {"ok": False, "profile": profile, "display_name": name,
                "reason": f"{agent_id!r} bloodbank block is not fleet scope with target_agent_id={agent_id!r}"}
    return {"ok": True, "profile": profile.strip(), "display_name": name, "reason": None}


def spoken_name(agent_id: str, route: dict | None = None) -> str:
    """Short name to say aloud: registry display_name ('Holocene PM'), else the id with spaces."""
    route = route or registry_route(agent_id)
    name = (route.get("display_name") or "").split("\u2014")[0].split(" - ")[0].strip()
    return name or agent_id.replace("-", " ")


# ---------------------------------------------------------------- audio probe

def probe_audio(path: Path) -> dict:
    """{ok, duration, error} from ffprobe. ok=None when ffprobe itself is unavailable (never blocks)."""
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return {"ok": None, "duration": None, "error": f"{FFPROBE} not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": None, "duration": None, "error": "ffprobe timed out"}
    if r.returncode != 0:
        return {"ok": False, "duration": None, "error": (r.stderr.strip() or "ffprobe failed")[-300:]}
    try:
        return {"ok": True, "duration": float(r.stdout.strip().splitlines()[0]), "error": None}
    except (ValueError, IndexError):
        return {"ok": False, "duration": None, "error": f"ffprobe gave no duration: {r.stdout.strip()[:100]!r}"}


# ---------------------------------------------------------------- S3 (mc)

def mc(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([MC_BIN, *args], capture_output=True, text=True, timeout=timeout)


def s3_url(key: str) -> str:
    return f"{S3_ALIAS}/{BUCKET}/{key}"


def s3_list_inbox() -> list[dict]:
    """Every audio object under inbox/: {key, size, last_modified(datetime)}."""
    r = mc("ls", "--recursive", "--json", s3_url(INBOX_PREFIX) + "/", timeout=60)
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
        if o.get("status") == "error":
            raise RuntimeError(f"mc ls reported an error: {str(o)[:200]}")
        if o.get("type") != "file":
            continue
        rel = o.get("key", "")
        # mc intermittently reports the key relative to the bucket instead of the listed prefix
        # (about 1 listing in 15), which doubled the prefix and made the watcher chase phantom
        # objects. An agent id is never "inbox", so strip the prefix once if it is there.
        if rel.startswith(INBOX_PREFIX + "/"):
            rel = rel[len(INBOX_PREFIX) + 1:]
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

def _has_column(db: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in db.execute(f"PRAGMA table_info({table})"))


def journal_row(command_id: str) -> dict | None:
    """The gateway's execution row for this exact command id (never 'latest for profile')."""
    if not GATEWAY_DB.exists():
        raise FileNotFoundError(f"gateway journal missing: {GATEWAY_DB}")
    db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True, timeout=5)
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT command_id, profile, state, outcome, rejection_reason, rejected_at, "
            "created_at, updated_at, terminal_events"
            + (", lane" if _has_column(db, "executions", "lane") else "")
            + (", failure_code" if _has_column(db, "executions", "failure_code") else "")
            + " FROM executions WHERE command_id=?",
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


TURN_TIMEOUT = "turn_timeout"


def turn_timeout_data(row: dict) -> dict | None:
    """The gateway's failed-fact payload when it closed this execution because the lane's
    per-turn wall clock expired (journal failure_code = turn_timeout), else None."""
    if row.get("failure_code") != TURN_TIMEOUT:
        return None
    for env in row.get("terminal", []):
        data = (env or {}).get("data") or {}
        if data.get("error_code") == TURN_TIMEOUT:
            return data
    return {"error_code": TURN_TIMEOUT}


def turn_timeout_message(data: dict, lane: str | None = None) -> str:
    """One human line for a turn timeout: the gateway's own message, else rebuilt from its fields."""
    msg = data.get("error_message")
    if msg:
        return str(msg)
    lane = data.get("lane") or lane or "interactive"
    elapsed, limit = data.get("elapsed_seconds"), data.get("timeout_seconds")
    return (f"agent turn timed out after {elapsed if elapsed is not None else '?'}s on {lane} lane"
            + (f" (limit {limit}s)" if limit is not None else ""))


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
    'latest session' / mtime guessing. Returns {session_id, text, timestamp, prompt (the first user message: what the agent was
    actually given)} or None.
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
        user = db.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY timestamp ASC, id ASC LIMIT 1",
            (sess["id"],),
        ).fetchone()
        prompt = user["content"] if user else None
        msg = db.execute(
            "SELECT content, timestamp FROM messages WHERE session_id=? AND role='assistant' "
            "AND content IS NOT NULL AND TRIM(content) <> '' AND COALESCE(active,1)=1 "
            "ORDER BY timestamp DESC, id DESC LIMIT 1",
            (sess["id"],),
        ).fetchone()
    finally:
        db.close()
    if msg is None:
        return {"session_id": sess["id"], "text": None, "timestamp": None, "prompt": prompt}
    return {"session_id": sess["id"], "text": msg["content"].strip(), "timestamp": msg["timestamp"], "prompt": prompt}


# ---------------------------------------------------------------- gateway log (why a command vanished)

def gateway_log_lines(needles: list[str], since: str = "-3 hours", lines: int = 6) -> list[str]:
    """Gateway journal lines that mention any needle (command id, target agent id).

    The gateway's only record of a command it consumed and dropped (unroutable target) is a
    WARNING in its own journal; no execution row and no fact exist for it."""
    try:
        r = subprocess.run(["journalctl", "--user", "-u", GATEWAY_UNIT, "--no-pager", "-o", "short-iso", "--since", since],
                           capture_output=True, text=True, timeout=30)
    except Exception:  # noqa: BLE001
        return []
    hits = [ln for ln in r.stdout.splitlines()
            if any(n and n in ln for n in needles) and ("Bloodbank" in ln or "bloodbank" in ln)]
    return hits[-lines:]


# ---------------------------------------------------------------- NATS / gateway liveness

def _consumer_info(c: dict) -> dict:
    # idle puller = parked pull request (num_waiting); busy puller = messages in flight
    # (max_ack_pending saturated parks nothing, so waiting=0 with ack_pending>0 is healthy)
    return {
        "ok": (c.get("num_waiting", 0) or 0) >= 1 or (c.get("num_ack_pending", 0) or 0) >= 1,
        "num_waiting": c.get("num_waiting", 0),
        "num_pending": c.get("num_pending", 0),
        "num_ack_pending": c.get("num_ack_pending", 0),
        "max_ack_pending": (c.get("config") or {}).get("max_ack_pending"),
        "delivered": (c.get("delivered") or {}).get("stream_seq"),
    }


def gateway_lanes() -> dict[str, dict]:
    """{lane: liveness} for every gateway lane from ONE monitor read.

    Each value is {"ok": bool|None, "lane", "consumer", "num_waiting", "num_pending", "num_ack_pending",
    "max_ack_pending", "delivered"} or {"ok": False|None, "error": ...}. ok is True when that lane's
    consumer has a puller, False when it is registered-but-unpulled or missing, None when the monitor
    could not be read (diagnostic only: callers must not treat None as down)."""
    out: dict[str, dict] = {}
    try:
        body = http_json(f"{NATS_MONITOR_URL}/jsz?consumers=true&streams=true&config=true", timeout=4)
    except Exception as e:  # noqa: BLE001
        return {lane: {"ok": None, "lane": lane, "consumer": name, "error": f"nats monitor unreachable: {e}"}
                for lane, name in GATEWAY_CONSUMERS.items()}
    consumers: dict[str, dict] | None = None
    for acct in body.get("account_details", []):
        for st in acct.get("stream_detail", []):
            if st.get("name") == COMMAND_STREAM:
                consumers = {c.get("name"): c for c in st.get("consumer_detail", [])}
    for lane, name in GATEWAY_CONSUMERS.items():
        if consumers is None:
            out[lane] = {"ok": None, "lane": lane, "consumer": name, "error": f"stream {COMMAND_STREAM} not found"}
        elif name in consumers:
            out[lane] = {"lane": lane, "consumer": name, **_consumer_info(consumers[name])}
        else:
            out[lane] = {"ok": False, "lane": lane, "consumer": name,
                         "error": f"consumer {name} not registered on {COMMAND_STREAM}"}
    return out


def gateway_liveness(lane: str = "batch") -> dict:
    """Is anything pulling this lane's consumer? num_waiting >= 1 (or work in flight) means yes.

    The lane defaults to batch so old callers keep their meaning; every memo path passes its own lane."""
    if lane not in GATEWAY_CONSUMERS:
        raise ValueError(f"unknown gateway lane {lane!r}")
    return gateway_lanes()[lane]


def gateway_liveness_text(info: dict | None = None, lane: str = "batch") -> str:
    info = info or gateway_liveness(lane)
    lane = info.get("lane") or lane
    consumer = info.get("consumer") or GATEWAY_CONSUMERS.get(lane, lane)
    if info.get("error"):
        return f"{'NOBODY PULLING ' + lane + ': ' if info.get('ok') is False else ''}{info['error']}"
    slots = f"/{info['max_ack_pending']}" if info.get("max_ack_pending") else ""
    waiting, pending, ack = (info.get(k) or 0 for k in ("num_waiting", "num_pending", "num_ack_pending"))
    if info.get("ok"):
        verdict = f"pulling (busy: {ack}{slots} in flight, {pending} queued ahead)" if ack else "pulling (idle)"
    else:
        verdict = f"NOBODY PULLING {lane} (gateway bloodbank platform down or {lane} lane disabled?)"
    return f"{lane}: {verdict}; consumer {consumer}: waiting={waiting} pending={pending} ack_pending={ack}"


def gateway_lanes_text(lanes: dict[str, dict] | None = None) -> str:
    """One line for both lanes: 'interactive: pulling, 1/2 in flight, 0 queued | batch: pulling, 4/4 in flight, 17 queued'."""
    lanes = lanes or gateway_lanes()
    parts = []
    for lane in LANES:
        info = lanes.get(lane) or {}
        if info.get("ok") is None:
            parts.append(f"{lane}: unknown ({info.get('error', 'no data')})")
        elif not info["ok"]:
            parts.append(f"{lane}: NOBODY PULLING")
        else:
            slots = f"/{info['max_ack_pending']}" if info.get("max_ack_pending") else ""
            parts.append(f"{lane}: pulling, {info['num_ack_pending']}{slots} in flight, {info['num_pending']} queued")
    return " | ".join(parts)

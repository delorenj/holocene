"""Shared pieces of the voice memo pipeline: ids, S3 listing, and the read-side
probes for each hop (Candystore, gateway journal, Hermes sessions, NATS).

Used by inbox_watcher.py (the service) and memo_trace.py (the operator tool) so
both look at every hop the same way. Stdlib only.
"""

from __future__ import annotations

import hashlib
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
# Per-memo status for the car (status/<yyyy>/<mm>/<dd>/<memo_id>.json, the inbox key's date) and the spoken progress
# updates (progress/<yyyy>/<mm>/<dd>/<memo_id>-<n>.ogg). Both live in holocene-auto, which the pad reads anonymously;
# neither is in the Earshot bucket, so the phone never plays a progress update.
STATUS_PREFIX = "status"
PROGRESS_PREFIX = "progress"
# One interim assistant message of a running turn, published by the Hermes gateway (bloodbank services/hermes-gateway).
PROGRESS_TYPE = "bloodbank.agent.invocation.progressed"
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
FFMPEG = os.environ.get("MEMO_FFMPEG", "ffmpeg")
# A recording whose LOUDEST sample is below this is silent: the microphone delivered no sound, so Whisper is not
# worth a run. Chosen from the bucket (2026-10-16): every real recording peaks at -16 dBFS or louder, the two
# dead-mic recordings from the corked emulator capture peak at -73 / -75, digital silence reads -91. Room noise
# from a live mic sits around -45 to -35, far above this line, so a quiet room is still "audible but no words".
SILENT_MAX_DBFS = float(os.environ.get("MEMO_SILENT_MAX_DBFS", "-60"))

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


def memo_day(key: str) -> str:
    """<yyyy>/<mm>/<dd> of an inbox key (the day the device recorded it), so the car can name its memo's status and
    progress objects from the key it uploaded. A key without a date (never dispatched anyway) uses today, UTC."""
    parts = key.split("/")
    if len(parts) >= 6 and parts[0] == INBOX_PREFIX and all(p.isdigit() for p in parts[2:5]):
        return "/".join(parts[2:5])
    return datetime.now(timezone.utc).strftime("%Y/%m/%d")


def status_key_for(key: str, memo_id: str | None = None) -> str:
    """status/<yyyy>/<mm>/<dd>/<memo_id>.json: the memo's live status, rewritten on every stage change."""
    return f"{STATUS_PREFIX}/{memo_day(key)}/{memo_id or memo_id_for(key)}.json"


def progress_key_for(key: str, n: int, memo_id: str | None = None) -> str:
    """progress/<yyyy>/<mm>/<dd>/<memo_id>-<n>.ogg: the memo's n-th spoken progress update (1..n per memo, so an
    escalated memo's second command never overwrites the first one's)."""
    return f"{PROGRESS_PREFIX}/{memo_day(key)}/{memo_id or memo_id_for(key)}-{n}.ogg"


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


# ---------------------------------------------------------------- memo retry (shared by the watcher and memo_trace)

def resume_for(m: dict) -> str:
    """Where `memo:retry` restarts a failed memo. A memo with no transcript cannot dispatch (it failed at receive,
    for an unroutable agent, before any audio was heard): it starts over at receive."""
    stage = m.get("resume_stage") or "receive"
    if stage == "dispatch" and not m.get("transcript"):
        return "receive"
    return stage


def truncated_by_old_watcher(m: dict) -> bool:
    """A failed memo whose prompt was cut to exactly 300 characters by the old compact() and never carried a prompt
    hash: its full text is gone from state.json. The audio is still in the inbox, so `memo:retry` revives it at
    'transcribe' (transcript/prompt/prompt_sha256 dropped) rather than re-sending the cut prompt."""
    return (m.get("status") == "failed" and not m.get("prompt_sha256") and isinstance(m.get("prompt"), str)
            and len(m["prompt"]) == 300 and m.get("resume_stage") in ("dispatch", "await_agent"))


# ---------------------------------------------------------------- escalation + cancel (shared by the watcher and memo_trace)

# lane_reason on a command the watcher re-dispatched on the batch lane after the interactive turn hit its wall clock.
ESCALATED_REASON = "turn_timeout_escalated"
# data.stage / data.error_code of the failed fact that ends a memo the operator cancelled (`memo:cancel`).
CANCELLED = "cancelled"


def memo_escalated(m: dict) -> bool:
    """True while the memo's command in flight (or about to be published) is the batch re-dispatch that followed an
    interactive turn timeout. A fresh command (memo:retry) clears lane_reason, so it is no longer an escalated one."""
    return m.get("lane_reason") == ESCALATED_REASON


# ---------------------------------------------------------------- answer-then-background (shared by the watcher and memo_trace)

# lane_reason on the command the watcher dispatched for a voice reply's BACKGROUND: line: the agent answered in a minute
# and handed the long part to a background turn on the same thread, whose reply is spoken later as a follow-up.
FOLLOWUP_REASON = "voice_followup"
# A follow-up still owed to the driver: published (or about to be) and not yet spoken, failed or cancelled.
FOLLOWUP_LIVE = ("dispatching", "running")


def live_followup(m: dict) -> dict | None:
    """The memo's follow-up in flight (the newest entry of m["followups"] while it is dispatching or running), else None.
    While one is live the memo's command_id IS the follow-up's command (after the quick answer was spoken)."""
    fus = m.get("followups") or []
    fu = fus[-1] if fus else None
    return fu if isinstance(fu, dict) and fu.get("state") in FOLLOWUP_LIVE else None


def long_turn(m: dict) -> bool:
    """The memo's command in flight is a long batch turn with no gateway wall clock: the escalated re-dispatch, or a
    background follow-up. The watcher gives it BATCH_TURN_TIMEOUT_S and never stretches that further."""
    return memo_escalated(m) or live_followup(m) is not None


# ---------------------------------------------------------------- detach (the gateway keeps an interactive turn past its wall clock)

DETACHED_TYPE = "bloodbank.agent.invocation.detached"


def detached_fact(ev: dict, command_id: str | None = None) -> bool:
    """A gateway fact saying this command's interactive turn passed the lane's wall clock and was DETACHED (kept running
    with its slot released, no kill, no re-run): agent.invocation.detached, or agent.invocation.progressed with
    data.detached=true. Either shape is accepted, so the watcher does not care which one the gateway settles on."""
    d = ev.get("data") or {}
    if command_id is not None and d.get("command_id") != command_id:
        return False
    return ev.get("type") == DETACHED_TYPE or d.get("detached") is True


def cancel_after_dispatch(m: dict) -> bool:
    """Has ANY command of this memo been (or may it have been) published? Then a cancel cannot undo it: the agent may
    still run and only its reply is held back. That is also true between an escalation (which un-marks the publish
    for the new batch command) and the batch publish, and for a revived memo whose earlier command went out
    (dispatched_ts survives a revive). Only a memo that never sent anything (stage receive/transcribe/dispatch, no
    publish attempted, no earlier dispatch) is cancelled with nothing sent."""
    return (bool(m.get("publish_attempted")) or bool(m.get("escalated")) or bool(m.get("dispatched_ts"))
            or m.get("stage") in ("await_agent", "reply", "speak", "mirror"))


def rescue_open(m: dict) -> bool:
    """A failed memo whose agent deadline passed but whose command the watcher still watches for a late reply."""
    return bool(m.get("status") == "failed" and m.get("failed_stage") == "agent_reply" and m.get("failed_code") == "timeout"
                and m.get("command_id") and not m.get("rescue_closed"))


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


def measure_levels(path: Path) -> dict:
    """{ok, mean_dbfs, max_dbfs, error} from ffmpeg volumedetect (one decode pass, a few ms for a voice memo).

    mean_dbfs is the RMS-style mean volume, max_dbfs the loudest sample, both in dBFS (0 = full scale; digital
    silence reads about -91). ok=None when ffmpeg itself is unavailable or timed out: the level is diagnostic and
    must never block a transcription. ok=False when ffmpeg ran but gave no readings (no audio stream)."""
    try:
        r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af", "volumedetect",
                            "-f", "null", "-"], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return {"ok": None, "mean_dbfs": None, "max_dbfs": None, "error": f"{FFMPEG} not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": None, "mean_dbfs": None, "max_dbfs": None, "error": "ffmpeg volumedetect timed out"}
    mean = re.search(r"mean_volume:\s*(-?[0-9.]+|-?inf)\s*dB", r.stderr)
    peak = re.search(r"max_volume:\s*(-?[0-9.]+|-?inf)\s*dB", r.stderr)
    if not (mean and peak):
        return {"ok": False, "mean_dbfs": None, "max_dbfs": None,
                "error": (r.stderr.strip().splitlines() or ["ffmpeg gave no volume readings"])[-1][:200]}
    floor = -96.0  # -inf (an all-zero stream) is reported as the 16-bit floor so it stays a finite JSON number
    vals = [max(floor, float(x.group(1))) if "inf" not in x.group(1) else floor for x in (mean, peak)]
    return {"ok": True, "mean_dbfs": round(vals[0], 1), "max_dbfs": round(vals[1], 1), "error": None}


def fmt_dbfs(v) -> str:
    return f"{v:.0f} dBFS" if isinstance(v, (int, float)) else "? dBFS"


def level_text(max_dbfs, mean_dbfs=None, duration=None) -> str:
    """'max -73 dBFS, mean -83 dBFS over 6.4 s' for messages and trace lines."""
    bits = [f"max {fmt_dbfs(max_dbfs)}"]
    if mean_dbfs is not None:
        bits.append(f"mean {fmt_dbfs(mean_dbfs)}")
    out = ", ".join(bits)
    return f"{out} over {duration:.1f} s" if isinstance(duration, (int, float)) else out


# ---------------------------------------------------------------- S3 (mc)

def mc(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([MC_BIN, *args], capture_output=True, text=True, timeout=timeout)


def s3_url(key: str) -> str:
    return f"{S3_ALIAS}/{BUCKET}/{key}"


def s3_list_inbox(timeout: int = 60) -> list[dict]:
    """Every audio object under inbox/: {key, size, last_modified(datetime)}."""
    r = mc("ls", "--recursive", "--json", s3_url(INBOX_PREFIX) + "/", timeout=timeout)
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
            "etag": (o.get("etag") or "").strip('"') or None,
        })
    return out


def s3_read_json(key: str) -> dict | None:
    """A small JSON object from the bucket (a memo's status object), or None when it is missing or unreadable."""
    try:
        r = mc("cat", s3_url(key), timeout=20)
    except Exception:  # noqa: BLE001
        return None
    if r.returncode != 0:
        return None
    try:
        out = json.loads(r.stdout)
    except ValueError:
        return None
    return out if isinstance(out, dict) else None


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
    return {"key": key, "size": int(o.get("size", 0)), "last_modified": parse_iso(o.get("lastModified")),
            "etag": (o.get("etag") or "").strip('"') or None}


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


def typed_events(correlation_id: str, ce_type: str, limit: int = 200, timeout: float = 4) -> list[dict]:
    """The projected events of ONE type for this correlationid, oldest first (an indexed query, unlike the whole trace)."""
    url = (f"{CANDYSTORE_URL}/events?correlationid={urllib.parse.quote(correlation_id)}"
           f"&type={urllib.parse.quote(ce_type)}&limit={limit}")
    body = http_json(url, timeout=timeout)
    return sorted(body.get("events", []), key=lambda e: e.get("time") or "")


def progress_events(correlation_id: str, limit: int = 200) -> list[dict]:
    """The gateway's agent.invocation.progressed facts for this correlationid (every command of the memo), oldest first.
    One cheap indexed query (~20 ms), so the watcher can ask every second or two while a turn runs."""
    url = (f"{CANDYSTORE_URL}/events?correlationid={urllib.parse.quote(correlation_id)}"
           f"&type={urllib.parse.quote(PROGRESS_TYPE)}&limit={limit}")
    body = http_json(url, timeout=4)
    return sorted(body.get("events", []), key=lambda e: e.get("time") or "")


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
            # set by a gateway that detached the interactive turn at its wall clock instead of stopping it
            + (", detached_at" if _has_column(db, "executions", "detached_at") else "")
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


def _user_prompt(rows: list, prompt_sha256: str | None, since: float | None) -> str | None:
    """The user message that is THIS command's prompt in a session that may hold several (an escalated or retried
    command shares the memo's thread id, so the session): the newest one whose sha256 is the sent prompt's, else the
    newest at or after the command's dispatch (a little slack for clock skew), else the newest there is."""
    row, _ = _user_prompt_row(rows, prompt_sha256, since)
    return row["content"] if row is not None else None


def _user_prompt_row(rows: list, prompt_sha256: str | None, since: float | None) -> tuple:
    """(row, how) for _user_prompt: how is "sha256" when the row is proven to be the sent prompt, else "since" / "newest"."""
    if not rows:
        return None, None
    if prompt_sha256:
        for r in reversed(rows):
            c = r["content"] or ""
            if prompt_sha256 in (hashlib.sha256(c.strip().encode()).hexdigest(), hashlib.sha256(c.encode()).hexdigest()):
                return r, "sha256"
    if since is not None:
        late = [r for r in rows if isinstance(r["timestamp"], (int, float)) and r["timestamp"] >= since - 2.0]
        if late:
            return late[-1], "since"
    return rows[-1], "newest"


def find_reply(profile: str, thread_id: str, prompt_sha256: str | None = None, since: float | None = None) -> dict | None:
    """The agent's final reply for the session the gateway opened for this thread_id.

    Gateway contract: source 'bloodbank', chat_id = data.thread_id of the command.
    Because the watcher picks a unique thread_id per memo, this is exact: no
    'latest session' / mtime guessing. Returns {session_id, text, timestamp, prompt (the user message the agent was
    actually given for the command: see _user_prompt; prompt_sha256 / since identify the command)} or None.
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
        users = db.execute(
            "SELECT content, timestamp FROM messages WHERE session_id=? AND role='user' ORDER BY timestamp ASC, id ASC",
            (sess["id"],),
        ).fetchall()
        prow, how = _user_prompt_row(users, prompt_sha256, since)
        prompt = prow["content"] if prow is not None else None
        # when the prompt row is proven (sha256), its time: an assistant message older than it answers an earlier prompt
        prompt_ts = prow["timestamp"] if prow is not None and how == "sha256" else None
        msg = db.execute(
            "SELECT content, timestamp FROM messages WHERE session_id=? AND role='assistant' "
            "AND content IS NOT NULL AND TRIM(content) <> '' AND COALESCE(active,1)=1 "
            "ORDER BY timestamp DESC, id DESC LIMIT 1",
            (sess["id"],),
        ).fetchone()
    finally:
        db.close()
    if msg is None:
        return {"session_id": sess["id"], "text": None, "timestamp": None, "prompt": prompt, "prompt_ts": prompt_ts}
    return {"session_id": sess["id"], "text": msg["content"].strip(), "timestamp": msg["timestamp"], "prompt": prompt,
            "prompt_ts": prompt_ts}


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

# hermes-gateway writes its own runtime state here (gateway_state: starting|running|draining|stopped|..., pid,
# restart_requested, active_agents). While it drains for a reload/restart (up to restart_after_turn_timeout, 120 s here),
# a stop, or a maintenance drain, the Bloodbank plugin stops pulling both lanes on purpose: commands stay queued and run
# when the gateway takes turns again. A freshly started process pulls nothing until its Bloodbank lanes connect (~1 min).
GATEWAY_STATE_FILE = Path(os.environ.get("MEMO_GATEWAY_STATE_FILE", HOME / ".hermes/gateway_state.json"))
# Hermes' external-drain marker (gateway/drain_control.py): present = a maintenance drain, not a restart.
GATEWAY_DRAIN_MARKER = Path(os.environ.get("MEMO_GATEWAY_DRAIN_MARKER", HOME / ".hermes/.drain_request.json"))
GATEWAY_DRAIN_MARKER_MAX_AGE_S = 3600.0  # Hermes ignores an older marker (DRAIN_REQUEST_MAX_AGE_SECONDS)
# kind -> (short label for one-line lane summaries, the sentence memo:trace and /voice show)
GATEWAY_KINDS = {
    "restart_drain": ("gateway restarting (draining)",
                      "gateway restarting (draining), memo queued; it runs when the gateway is back"),
    "shutdown_drain": ("gateway stopping (draining)",
                       "gateway stopping (draining), memo queued; it runs when the gateway is started again"),
    "maintenance_drain": ("gateway paused for maintenance (draining)",
                          "gateway paused for maintenance (draining), memo queued; it runs when the drain is released"),
    "restarting": ("gateway restarting",
                   "gateway restarting, memo queued; it runs when the gateway is back"),
    "starting": ("gateway starting",
                 "gateway starting, memo queued; it runs once its Bloodbank lanes connect"),
}
GATEWAY_DRAINING_TEXT = GATEWAY_KINDS["restart_drain"][1]
GATEWAY_RESTARTING_TEXT = GATEWAY_KINDS["restarting"][1]
# A "stopped, restart requested" or "starting" state older than this is a gateway that never came back, not a restart.
GATEWAY_RESTART_STALE_S = float(os.environ.get("MEMO_GATEWAY_RESTART_STALE_S", "600"))


def _pid_alive(pid) -> bool | None:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _maintenance_drain(now: datetime) -> bool:
    """Hermes' external-drain marker is present and young enough for Hermes to honour it."""
    try:
        body = json.loads(GATEWAY_DRAIN_MARKER.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except Exception:  # noqa: BLE001 - unreadable marker: Hermes treats it as a drain request too
        return True
    requested = parse_iso(body.get("requested_at")) if isinstance(body, dict) else None
    return requested is None or (now - requested).total_seconds() <= GATEWAY_DRAIN_MARKER_MAX_AGE_S


def gateway_state(now: datetime | None = None) -> dict:
    """What hermes-gateway says about itself, from its gateway_state.json.

    {"state", "kind", "queued", "draining", "restarting", "starting", "restart_requested", "active_agents",
    "updated_at", "label", "detail"}. draining = the live process waits for in-flight turns before it restarts
    (kind restart_drain), stops (shutdown_drain) or resumes after a maintenance action (maintenance_drain);
    restarting = between the old process and the new one after a requested restart; starting = the new process is up
    (a live writer saying "starting", restart_requested or not) but its Bloodbank lanes are not connected yet. queued = any of them: nobody pulls on purpose and a queued memo runs
    when the gateway takes turns again. A missing or unreadable file is {"state": None, "queued": False, ...}."""
    base = {"state": None, "kind": None, "queued": False, "draining": False, "restarting": False, "starting": False,
            "restart_requested": None, "active_agents": None, "updated_at": None, "label": None, "detail": None}
    try:
        raw = json.loads(GATEWAY_STATE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {**base, "error": f"no {GATEWAY_STATE_FILE}"}
    except Exception as e:  # noqa: BLE001
        return {**base, "error": f"unreadable {GATEWAY_STATE_FILE}: {e}"[:200]}
    if not isinstance(raw, dict):
        return {**base, "error": f"unexpected {GATEWAY_STATE_FILE} content"}
    now = now or now_utc()
    state = raw.get("gateway_state")
    restart = raw.get("restart_requested") is True
    pid = raw.get("pid")
    alive = _pid_alive(pid)
    updated = parse_iso(raw.get("updated_at"))
    age = (now - updated).total_seconds() if updated else None
    fresh = age is not None and age <= GATEWAY_RESTART_STALE_S
    draining = state == "draining" and alive is not False
    bloodbank = (raw.get("platforms") or {}).get("bloodbank") if isinstance(raw.get("platforms"), dict) else None
    bloodbank_fatal = (isinstance(bloodbank, dict) and bloodbank.get("writer_pid") == pid
                       and bloodbank.get("state") == "fatal")
    # A live writer that says "starting" is the NEW process, even though a reload leaves restart_requested=true in
    # the file it writes: it is starting (its lanes connect in ~1 min), not "restarting" for the minutes after.
    starting = not draining and state == "starting" and alive is True and fresh and not bloodbank_fatal
    restarting = not draining and not starting and restart and state in ("draining", "stopped", "starting") and fresh
    kind = None
    if draining:
        kind = "restart_drain" if restart else "maintenance_drain" if _maintenance_drain(now) else "shutdown_drain"
    elif restarting:
        kind = "restarting"
    elif starting:
        kind = "starting"
    active = raw.get("active_agents") if isinstance(raw.get("active_agents"), int) else None
    label = detail = None
    if kind:
        label, detail = GATEWAY_KINDS[kind]
        if draining and active:
            detail += f" (waiting on {active} in-flight turn{'s' if active != 1 else ''})"
    return {**base, "state": state, "kind": kind, "queued": kind is not None, "draining": draining,
            "restarting": restarting, "starting": starting, "restart_requested": restart, "active_agents": active,
            "updated_at": raw.get("updated_at"), "label": label, "detail": detail}


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
    gw = gateway_state()
    if gw["queued"]:
        # Not pulling new work on purpose (in-flight turns still finish): the gateway is draining, restarting or still
        # starting, and a queued memo runs when it takes turns again. ok keeps its meaning (a puller or work in flight);
        # draining (kept as the key every reader knows) says why nothing is pulled. A starting process whose lane
        # already pulls (a parked pull request, num_waiting >= 1) is simply pulling. Work in flight does not count
        # here: a command the old process NAKed (shutdown_interrupt: retry) stays ack_pending with nobody pulling
        # until the new process fetches it again, and that is still a restart.
        for info in out.values():
            if info.get("ok") is None or ((gw["starting"] or gw["restarting"]) and (info.get("num_waiting") or 0) >= 1):
                continue
            info.update(draining=True, gateway_state=gw["state"], gateway_kind=gw["kind"],
                        gateway_label=gw["label"], gateway_detail=gw["detail"])
    return out


def gateway_liveness(lane: str = "batch") -> dict:
    """Is anything pulling this lane's consumer? num_waiting >= 1 (or work in flight) means yes.

    The lane defaults to batch so old callers keep their meaning; every memo path passes its own lane."""
    if lane not in GATEWAY_CONSUMERS:
        raise ValueError(f"unknown gateway lane {lane!r}")
    return gateway_lanes()[lane]


def _held_text(info: dict, short: bool = False) -> str:
    """What ack_pending means on a lane that is not pulling: turns still finishing while the gateway drains, but
    commands waiting for the next process once the old one is gone (a NAKed cut-off turn), or just fetched."""
    if str(info.get("gateway_kind") or "").endswith("_drain") or not info.get("num_ack_pending"):
        return "in flight" if short else "in flight finishing"
    return "held for re-run"


def gateway_liveness_text(info: dict | None = None, lane: str = "batch") -> str:
    info = info or gateway_liveness(lane)
    lane = info.get("lane") or lane
    consumer = info.get("consumer") or GATEWAY_CONSUMERS.get(lane, lane)
    slots = f"/{info['max_ack_pending']}" if info.get("max_ack_pending") else ""
    waiting, pending, ack = (info.get(k) or 0 for k in ("num_waiting", "num_pending", "num_ack_pending"))
    if info.get("draining"):
        busy = f", {ack}{slots} {_held_text(info)}" if ack else ""
        return (f"{lane}: {info.get('gateway_detail') or GATEWAY_DRAINING_TEXT}{busy}; consumer {consumer}: "
                f"waiting={waiting} pending={pending} ack_pending={ack}")
    if info.get("error"):
        return f"{'NOBODY PULLING ' + lane + ': ' if info.get('ok') is False else ''}{info['error']}"
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
        elif info.get("draining"):
            slots = f"/{info['max_ack_pending']}" if info.get("max_ack_pending") else ""
            parts.append(f"{lane}: {info.get('gateway_label') or GATEWAY_KINDS['restart_drain'][0]}, "
                         f"{info.get('num_ack_pending') or 0}{slots} {_held_text(info, short=True)}, "
                         f"{info.get('num_pending') or 0} queued")
        elif not info["ok"]:
            parts.append(f"{lane}: NOBODY PULLING")
        else:
            slots = f"/{info['max_ack_pending']}" if info.get("max_ack_pending") else ""
            parts.append(f"{lane}: pulling, {info['num_ack_pending']}{slots} in flight, {info['num_pending']} queued")
    return " | ".join(parts)

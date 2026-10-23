"""converse: the fast in-car conversation desk (HOLOC-23).

A car memo for an allowlisted agent tile, once transcribed, goes to a fast model (DeepSeek v4.1 flash on Hyper, with
non-Anthropic gateway rungs behind it) instead of straight to the agent. The model returns ONE JSON decision:

    {"say", "action": reply|propose|confirm|cancel|direct|end, "target", "title", "brief": {goal, context[], done_when[]},
     "perm": read_only|changes_ok|deploy_ok}

and deterministic code (guard) decides what is spoken and what, if anything, is sent:

- reply / end: spoken through the watcher's normal speak path; no Hermes command.
- propose: a draft brief is stored and READ BACK from a template (what is heard is what would be sent); nothing is sent.
- confirm: only with a pending draft, an affirmative transcript and no negation; the stored draft is sent verbatim (its
  sha256 is checked), once (a duplicate sha is refused), as a batch follow-up with a uuid5 command id.
- cancel: the pending draft is dropped.
- direct: today's interactive agent turn, with the earlier conversation added to its prompt.

This module is pure logic plus the HTTP ladder; the watcher (inbox_watcher.py) owns state, stages and facts.

THE NEVER-ANTHROPIC RULE: no rung may name Claude, Anthropic, Sonnet, Opus, Haiku, Fable or automaticai/auto (in either
gateway spelling: the gateway rewrites aai/<x> to automaticai/<x>, so aai/auto/orchestrator is the same pool). A configured
route that matches FORBIDDEN_MODEL_RE is refused when the routes are parsed, and an answer whose `model` field matches (or
is not a string at all) is thrown away and counted as a failure of that rung. The one exception (2026-10-22, operator):
exactly `automaticai/auto/fast` and `automaticai/free` (or aai/auto/fast, aai/free), and only on a route that carries the
scoped holocene-converse gateway token (MEMO_CONVERSE_SCOPED_KEY_REFS), whose scope holds no Anthropic route. Such a rung
is used only while a scope proof (GET /models with that token lists no Anthropic id) is fresh, and its answer must name
the route that served it (X-AutomaticAI-Route), that route must not be forbidden, and it must be one of the names the
proof listed. What bounds the PICK differs: the gateway intersects auto/fast's candidates with the token's scope before it
sends anything, but automaticai/free only checks that the free family is in scope and then picks from its whole free
policy (ops/routes.json free.members; none Anthropic today). For free, the desk's bound is after the fact: an answer from a
route outside the proven scope is never used (route_out_of_scope). The free alias is opt-in per tile.

Per tile (agent) the flag file carries `tiles: {<agent>: {voice, model}}`: the car reply voice and the desk model alias
(car_desk_aliases.json), written under an fcntl lock by `memo_trace.py voice|model`, the car-desk skills and the desk's own
phrase short-circuit ("use walken voice", "switch to deepseek pro"). A decision may also be action `tool` with `tool_name`
and `args`, validated against the tool.json contracts of the car-desk skill scope and run as the skill's entrypoint.

Keys never live in a file: a route carries an op:// reference, read with `op read` on first use and kept in memory only.
Stdlib only.
"""

from __future__ import annotations

import contextlib
import copy
import fcntl
import hashlib
import http.client
import json
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import unicodedata
import uuid
from pathlib import Path

# ---------------------------------------------------------------- the never-Anthropic rule

FORBIDDEN_MODEL_RE = re.compile(
    r"(claude|anthropic|sonnet|opus|haiku|fable|^(?:automaticai/)?auto(?:[/_-]|$)|^automaticai/auto|(?:^|/)openrouter/auto(?:[/_-]|$))",
    re.IGNORECASE | re.MULTILINE)
_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff\u00ad"), None)


def _clean_name(name: str) -> str:
    """The name every check reads: NFKC, no zero-width characters, trimmed, and the gateway's own alias spelling made
    canonical. The gateway's CanonicalModel rewrites `aai/<x>` to `automaticai/<x>`, so `aai/auto/orchestrator` IS the
    orchestrator pool and `aai/auto/fast` IS the router: a check that only knew `automaticai/` would let them through."""
    t = unicodedata.normalize("NFKC", name).translate(_ZERO_WIDTH).strip()
    if t[:4].lower() == "aai/":
        t = "automaticai/" + t[4:]
    return t


def forbidden(name) -> bool:
    """True for any model, route id or host that names an Anthropic model, the automaticai/auto pool or an OpenRouter auto
    router, in either gateway spelling (automaticai/ or aai/). The name is NFKC-normalised and stripped of zero-width
    characters first, and a name with any non-ASCII character is refused outright (no real model id has one; a look-alike
    letter must not slip past the pattern). None (no name at all: a direct provider that omits `model`) is not forbidden;
    any other value that is not a string is (an answer whose `model` is a list or an object cannot be checked)."""
    if name is None:
        return False
    if not isinstance(name, str):
        return True
    t = _clean_name(name)
    return (not t.isascii()) or bool(FORBIDDEN_MODEL_RE.search(t))


# Anthropic by name only (no auto pattern): what a token's scope listing (GET /models) must not contain. The listing of
# an auto-scoped token names the auto family itself, which is fine; a Claude route in it is not.
ANTHROPIC_RE = re.compile(r"(claude|anthropic|sonnet|opus|haiku|fable)", re.IGNORECASE)
# The only router names a rung may use, and only on a scoped token (MEMO_CONVERSE_SCOPED_KEY_REFS). Never bare
# automaticai/auto (an orchestrator-class request, frontier tier), never /orchestrator or /subagent, never openrouter/auto.
SCOPED_AUTO_MODELS = ("automaticai/auto/fast", "automaticai/free")
# The holocene-converse gateway token (id 88): its scope is Claude-free, so auto/fast and free can only pick from it.
DEFAULT_SCOPED_KEY_REFS = ("op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse",)


def scoped_auto(name) -> bool:
    """Exactly automaticai/auto/fast or automaticai/free, in either gateway spelling (aai/auto/fast, aai/free): the router
    names a scoped token may use."""
    return isinstance(name, str) and _clean_name(name) in SCOPED_AUTO_MODELS


# Key items the car desk must never use again (operator decision 2026-10-22): the Hindsight-shared Hyper key. An old
# routes override (a runs/*.json evidence file passed to memo:converse --routes-file) that names it is refused.
RETIRED_KEY_ITEMS = ("tflaecgcrdgxrh2ovgi5ysjkzq",)


def retired_ref(ref: str) -> bool:
    parts = (ref or "").split("/")
    return len(parts) > 3 and parts[3] in RETIRED_KEY_ITEMS


def scoped_key_refs(env=None) -> tuple[str, ...]:
    env = os.environ if env is None else env
    raw = env.get("MEMO_CONVERSE_SCOPED_KEY_REFS")
    if raw is None:
        return DEFAULT_SCOPED_KEY_REFS
    return tuple(x.strip() for x in str(raw).split(",") if x.strip().startswith("op://"))


MODES = ("off", "shadow", "on")
HANDOFF_MODES = ("named", "off")
ACTIONS = ("reply", "propose", "confirm", "cancel", "direct", "end", "tool")
FAST_ACTIONS = ("reply", "propose", "confirm", "cancel", "end", "tool")
PERMS = ("read_only", "changes_ok", "deploy_ok")
PERM_TEXT = {"read_only": "Read-only", "changes_ok": "Code changes OK, no deploy", "deploy_ok": "Changes and deploy OK"}
PERM_RULE = {
    "read_only": ("Read-only: inspect, read and report. Make no code change, commit, push, deploy, restart or other change "
                  "to a live system."),
    "changes_ok": ("Code changes are OK (edit, test, commit and push to the repository). No deploy, restart or other change "
                   "to a live system."),
    "deploy_ok": "Code changes and a deploy or restart are OK: the driver asked for them aloud.",
}
# uuid5 namespace of every id this desk mints (brief ids and delegation command ids)
NS = uuid.uuid5(uuid.NAMESPACE_URL, "urn:33god:holocene:converse")

# Prepended to every delegated brief. Carries the follow-up prefix's rules: the work runs unattended from a speech-to-text
# conversation, so it never changes a live system unless the Permission section (clamped by the driver's own words) allows.
DELEGATE_PREFIX = os.environ.get("MEMO_CONVERSE_DELEGATE_PREFIX", (
    "[Delegated from the driver's car conversation with the fast desk. The driver heard the brief below read back and "
    "confirmed it aloud. Do the work now, in full, without asking questions; nobody is waiting on the line. Do it yourself: "
    "never delegate to a subagent (delegate_task). Never run vox-speak or any text-to-speech yourself. Run no deploy, "
    "restart, push or other change to a live system unless the Permission section below allows it; the driver's words came "
    "through speech-to-text, so where anything is unclear do only the read-only part and say what you left undone. Your "
    "final message is spoken to the driver as a follow-up: end it with a spoken summary of the result in two to four "
    "sentences, and do not write a BACKGROUND: line.]\n\n"))


def _env_float(env, name: str, default: float) -> float:
    try:
        return float(env.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(env, name: str, default: int) -> int:
    try:
        return int(float(env.get(name, default)))
    except (TypeError, ValueError):
        return default


def _list(raw) -> list[str] | str:
    """'a, b' -> ['a', 'b']; '*' -> '*'; a JSON list is taken as is."""
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw if str(x).strip()]
    else:
        items = [x.strip() for x in str(raw or "").split(",") if x.strip()]
    return "*" if "*" in items else items


def _log_default(event: str, level: str = "info", **fields) -> None:
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "svc": "converse", "level": level, "event": event}
    rec.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(rec, separators=(",", ":"), default=str), flush=True)


# ---------------------------------------------------------------- routes

def parse_routes(raw, scoped_refs: tuple | list | None = None) -> tuple[list[dict], list[dict]]:
    """(usable routes, refused [{id, model, reason}]) from MEMO_CONVERSE_ROUTES (a JSON list, or the list itself).

    A route: {id, base_url, key_ref (op://...), model, timeout_s, temperature, reasoning_effort, max_tokens}. Refused:
    a forbidden model, id or host (the never-Anthropic rule), a key_ref that is not an op:// reference (a pasted key is a
    plaintext credential), no model, a base_url that is not http(s). Order is the ladder order.

    automaticai/auto/fast and automaticai/free are allowed only on a route whose key_ref is one of `scoped_refs`
    (MEMO_CONVERSE_SCOPED_KEY_REFS: the holocene-converse token, whose scope holds no Anthropic route); such a route is
    marked scoped_auto (the ladder then wants a scope proof and the served route's header)."""
    scoped_refs = tuple(scoped_key_refs() if scoped_refs is None else scoped_refs)
    refused: list[dict] = []
    if raw is None or raw == "":
        return [], []
    try:
        items = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError as e:
        return [], [{"id": None, "model": None, "reason": f"routes are not JSON: {e}"[:200]}]
    if not isinstance(items, list):
        return [], [{"id": None, "model": None, "reason": "routes must be a JSON list"}]
    out: list[dict] = []
    seen: set[str] = set()
    for i, r in enumerate(items):
        if not isinstance(r, dict):
            refused.append({"id": None, "model": None, "reason": f"route #{i + 1} is not an object"})
            continue
        rid = str(r.get("id") or f"r{i + 1}").strip()
        # the canonical spelling (aai/ -> automaticai/, no zero-width characters): what is checked is what is sent
        model = _clean_name(str(r.get("model") or ""))
        base = str(r.get("base_url") or "").strip().rstrip("/")
        ref = str(r.get("key_ref") or "").strip()
        host = urllib.parse.urlsplit(base).hostname or ""
        netloc = urllib.parse.urlsplit(base).netloc
        is_scoped = scoped_auto(model)
        why = None
        if not model:
            why = "no model"
        elif is_scoped and ref not in scoped_refs:
            why = ("auto_unscoped: automaticai/auto/fast and automaticai/free only on the scoped holocene-converse token "
                   "(MEMO_CONVERSE_SCOPED_KEY_REFS)")
        elif (forbidden(model) and not is_scoped) or forbidden(rid) or forbidden(host):
            why = "forbidden_model: the never-Anthropic rule (claude|anthropic|sonnet|opus|haiku|fable|automaticai/auto)"
        elif not base.startswith(("https://", "http://")) or not host:
            why = f"base_url {base!r} is not http(s)"
        elif ref and not ref.startswith("op://"):
            why = "key_ref must be an op:// reference (never a key)"
        elif retired_ref(ref):
            why = "key_retired: the Hindsight Hyper item is no longer used by the car desk (operator decision 2026-10-22)"
        elif rid in seen:
            why = f"duplicate route id {rid!r}"
        if why:
            refused.append({"id": rid, "model": model or None, "reason": why})
            continue
        effort = r.get("reasoning_effort")
        try:
            timeout_s = max(0.5, float(r.get("timeout_s") or 4))
            temperature = float(r["temperature"]) if r.get("temperature") is not None else 0.3
            max_tokens = int(r.get("max_tokens") or 700)
            if not (timeout_s < 600 and 0 <= temperature <= 2 and 1 <= max_tokens <= 100000):
                raise ValueError("out of range")
        except (TypeError, ValueError, OverflowError) as e:
            # a hand-edited flag file or unit env must turn this route off, never raise out of settings()
            refused.append({"id": rid, "model": model, "reason": f"timeout_s/temperature/max_tokens is not a number in range: {e}"[:200]})
            continue
        seen.add(rid)
        out.append({
            "id": rid, "base_url": base, "host": netloc, "key_ref": ref, "model": model,
            "timeout_s": timeout_s, "temperature": temperature,
            "reasoning_effort": str(effort).strip().lower() if effort else None,
            "max_tokens": max_tokens, "scoped_auto": is_scoped,
        })
    return out, refused


def ref_label(ref: str) -> str:
    """An op:// reference without its field, for logs and the heartbeat (the ref is not a secret; the value is)."""
    parts = (ref or "").split("/")
    return "/".join(parts[:4]) if len(parts) > 4 else (ref or "-")


# ---------------------------------------------------------------- keys (memory only)

def op_read(ref: str) -> str:
    """`op read <ref>`: the value, or raise. The error never carries the value (op prints none on failure)."""
    r = subprocess.run(["op", "read", "--no-newline", ref], capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise RuntimeError(f"op read rc={r.returncode}: {r.stderr.strip()[-200:]}")
    return r.stdout


class KeyCache:
    """op:// reference -> key, read lazily on first use and kept in memory only. An unreadable reference is off for
    retry_s, then read again; a 401 re-reads it once (invalidate). Never logs a value."""

    def __init__(self, reader=None, retry_s: float = 300.0, clock=time.time):
        self._reader = reader or op_read
        self._retry_s, self._clock = retry_s, clock
        self._vals: dict[str, str] = {}
        self._bad: dict[str, tuple[float, str]] = {}  # ref -> (retry at, error)
        self._lock = threading.Lock()

    def get(self, ref: str, timeout: float | None = None) -> str | None:
        """The key, or None when the reference is unreadable (off until its retry time). With `timeout` the read (`op read`,
        up to 20 s) runs on a thread the caller waits on for at most that long: a slow op never holds a car turn past its
        budget, and the read still completes in the background and fills the cache for the next turn."""
        if not ref:
            return ""  # a route with no key (a local endpoint): no Authorization header
        with self._lock:
            if ref in self._vals:
                return self._vals[ref]
            bad = self._bad.get(ref)
            if bad and bad[0] > self._clock():
                return None
        if timeout is None:
            return self._load(ref)
        box: list = []
        t = threading.Thread(target=lambda: box.append(self._load(ref)), name="converse-key-read", daemon=True)
        t.start()
        t.join(max(0.05, timeout))
        return box[0] if box else None

    def _load(self, ref: str) -> str | None:
        try:
            val = (self._reader(ref) or "").strip()
            err = None if val else "empty value"
        except Exception as e:  # noqa: BLE001
            val, err = "", f"{type(e).__name__}: {e}"[:200]
        with self._lock:
            if err:
                self._bad[ref] = (self._clock() + self._retry_s, err)
                return None
            self._vals[ref] = val
            self._bad.pop(ref, None)
            return val

    def invalidate(self, ref: str) -> None:
        with self._lock:
            self._vals.pop(ref, None)
            self._bad.pop(ref, None)

    def status(self, ref: str) -> str:
        """ok | unreadable | unread (never tried) | none (the route has no key)."""
        if not ref:
            return "none"
        with self._lock:
            if ref in self._vals:
                return "ok"
            bad = self._bad.get(ref)
            if bad and bad[0] > self._clock():
                return "unreadable"  # past its retry time it is only "unread": the next turn reads it again
        return "unread"

    def error(self, ref: str) -> str | None:
        with self._lock:
            b = self._bad.get(ref)
        return b[1] if b else None


# ---------------------------------------------------------------- circuit breaker

BILLING_OPEN_S = 600.0  # a 402 (out of credit) skips that rung for ten minutes; a top-up is noticed within that


class Breaker:
    """fails failures of one rung within window_s open it for open_s: the ladder skips it meanwhile."""

    def __init__(self, fails: int = 3, window_s: float = 120.0, open_s: float = 60.0, clock=time.time):
        self.fails, self.window_s, self.open_s, self._clock = fails, window_s, open_s, clock
        self._hist: dict[str, list[float]] = {}
        self._open: dict[str, float] = {}
        self._lock = threading.Lock()

    def is_open(self, rid: str) -> bool:
        with self._lock:
            return self._open.get(rid, 0.0) > self._clock()

    def open_until(self, rid: str) -> float | None:
        with self._lock:
            t = self._open.get(rid)
        return t if t and t > self._clock() else None

    def fail(self, rid: str) -> bool:
        """Count a failure; True when it opened the breaker."""
        now = self._clock()
        with self._lock:
            h = [t for t in self._hist.get(rid, []) if now - t < self.window_s] + [now]
            self._hist[rid] = h
            if len(h) >= self.fails and self._open.get(rid, 0.0) <= now:
                self._open[rid] = now + self.open_s
                self._hist[rid] = []
                return True
        return False

    def trip(self, rid: str, secs: float) -> None:
        """Open a rung for `secs` at once (an account that is out of credit stays out: 402 is not retried every minute)."""
        with self._lock:
            self._open[rid] = max(self._open.get(rid, 0.0), self._clock() + secs)
            self._hist.pop(rid, None)

    def ok(self, rid: str) -> None:
        with self._lock:
            self._hist.pop(rid, None)

    def recent_fails(self, rid: str) -> int:
        now = self._clock()
        with self._lock:
            return sum(1 for t in self._hist.get(rid, []) if now - t < self.window_s)


# ---------------------------------------------------------------- HTTP (keep-alive)

class Http:
    """POST JSON over http.client with one keep-alive connection per (scheme, host, port). A connection is taken out of the
    pool while in use, so concurrent callers never share one; a stale keep-alive connection is retried once, fresh."""

    def __init__(self):
        self._pool: dict[tuple, list] = {}
        self._lock = threading.Lock()
        self._ctx = ssl.create_default_context()

    def _take(self, k: tuple, timeout: float):
        with self._lock:
            lst = self._pool.get(k) or []
            conn = lst.pop() if lst else None
        if conn is not None:
            conn.timeout = timeout
            if conn.sock is not None:
                conn.sock.settimeout(timeout)
            return conn, True
        scheme, host, port = k
        if scheme == "https":
            return http.client.HTTPSConnection(host, port, timeout=timeout, context=self._ctx), False
        return http.client.HTTPConnection(host, port, timeout=timeout), False

    def _give(self, k: tuple, conn) -> None:
        with self._lock:
            lst = self._pool.setdefault(k, [])
            if len(lst) < 4:
                lst.append(conn)
                return
        conn.close()

    def post_json(self, url: str, body: dict, headers: dict, timeout: float,
                  resp_headers: dict | None = None) -> tuple[int | None, bytes, str | None]:
        """(status, raw body, error). error is 'timeout' | 'connect: ...' | None. `resp_headers`, when given, is filled
        with the response's headers (lower-case names)."""
        return self.request("POST", url, body, headers, timeout, resp_headers)

    def get_json(self, url: str, headers: dict, timeout: float) -> tuple[int | None, bytes, str | None]:
        return self.request("GET", url, None, headers, timeout)

    def request(self, method: str, url: str, body: dict | None, headers: dict, timeout: float,
                resp_headers: dict | None = None) -> tuple[int | None, bytes, str | None]:
        u = urllib.parse.urlsplit(url)
        k = (u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80))
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        payload = json.dumps(body).encode() if body is not None else None
        # No User-Agent: Cloudflare in front of api.automaticai.io refuses Python-urllib's; http.client sends none (works).
        hdrs = {"Accept": "application/json", "Connection": "keep-alive", **headers}
        if payload is not None:
            hdrs.update({"Content-Type": "application/json", "Content-Length": str(len(payload))})
        deadline = time.monotonic() + timeout
        for attempt in (1, 2):
            left = deadline - time.monotonic()
            if left <= 0.05:
                return None, b"", "timeout"
            conn, reused = self._take(k, left)
            try:
                conn.request(method, path, body=payload, headers=hdrs)
                resp = conn.getresponse()
                data = resp.read()
            except (socket.timeout, TimeoutError):
                conn.close()
                return None, b"", "timeout"
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError) as e:
                conn.close()
                if reused and attempt == 1:
                    continue  # the server closed an idle keep-alive connection: once more on a fresh one
                return None, b"", f"connect: {type(e).__name__}"
            except (OSError, http.client.HTTPException) as e:
                conn.close()
                return None, b"", f"connect: {type(e).__name__}: {e}"[:160]
            if resp_headers is not None:
                resp_headers.update({str(a).lower(): str(b) for a, b in resp.getheaders()})
            if resp.will_close:
                conn.close()
            else:
                self._give(k, conn)
            return resp.status, data, None
        return None, b"", "connect: retry exhausted"


# ---------------------------------------------------------------- the decision

class BadDecision(ValueError):
    """The model's content looks like JSON but does not parse as one decision object."""


_PERM_ALIASES = {"read_only": "read_only", "readonly": "read_only", "read-only": "read_only", "read": "read_only",
                 "changes_ok": "changes_ok", "changes": "changes_ok", "code_changes": "changes_ok", "write": "changes_ok",
                 "deploy_ok": "deploy_ok", "deploy": "deploy_ok"}
_ACTION_ALIASES = {"delegate": "propose", "draft": "propose", "send": "confirm", "ask_agent": "direct", "handoff": "direct",
                   "close": "end", "bye": "end", "answer": "reply", "clarify": "reply"}


def _strs(v, n: int = 8, chars: int = 300) -> list[str]:
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        return []
    return [str(x).strip()[:chars] for x in v if str(x).strip()][:n]


def normalize_decision(obj: dict) -> dict:
    action = str(obj.get("action") or "reply").strip().lower()
    action = _ACTION_ALIASES.get(action, action)
    if action not in ACTIONS:
        action = "reply"
    brief = obj.get("brief")
    if isinstance(brief, str):
        brief = {"goal": brief}
    if not isinstance(brief, dict):
        brief = {}
    goal = str(brief.get("goal") or "").strip()[:1500]
    title = re.sub(r"\s+", " ", str(obj.get("title") or "")).strip().rstrip(".")[:90]
    if not title and goal:
        title = " ".join(goal.split()[:8]).rstrip(".,;:")
    perm = _PERM_ALIASES.get(str(obj.get("perm") or "read_only").strip().lower().replace(" ", "_"), "read_only")
    target = obj.get("target")
    out = {
        "say": re.sub(r"\s+", " ", str(obj.get("say") or "")).strip()[:600],
        "action": action,
        "target": str(target).strip() if isinstance(target, str) and target.strip() else None,
        "title": title,
        "brief": {"goal": goal, "context": _strs(brief.get("context")), "done_when": _strs(brief.get("done_when"))},
        "perm": perm,
    }
    if action == "tool":
        # a tool call: its name and arguments, checked against the loaded tool.json contracts before anything runs
        name = obj.get("tool_name") or obj.get("tool") or obj.get("name")
        args = obj.get("args") if obj.get("args") is not None else obj.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = None
        out["tool_name"] = str(name).strip()[:80] if isinstance(name, str) else None
        out["args"] = args if isinstance(args, dict) else {}
    return out


_TITLE_LEAD_RE = re.compile(r"^(?:(?:ok|okay|so|hey|please|can you|could you|i want you to|i need you to|go|and)\s+)*"
                            r"(?:(?:have|ask|tell|get|let|make)\s+(?:the\s+)?(?:[a-z0-9']+\s+){0,2}?(?:pm|agent|assistant|desk)\s+(?:to\s+)?)?", re.I)
_TITLE_TAIL_RE = re.compile(r"\s+(?:the|a|an|to|of|in|on|and|or|for|with|that|which|is|are|my)$", re.I)


def title_from_words(said: str, n: int = 8) -> str:
    """A short title from the driver's own words (a model that sent no title): the request without 'have the PM ...', at most n
    words, never ending on a stop word."""
    t = _TITLE_LEAD_RE.sub("", (said or "").strip()).strip()
    t = " ".join(t.split()[:n]).rstrip(".,;:!?")
    while _TITLE_TAIL_RE.search(t):
        t = _TITLE_TAIL_RE.sub("", t)
    return (t[:1].upper() + t[1:]) if t else ""


def incomplete_propose(d: dict) -> bool:
    """A propose with neither a title nor a brief goal: nothing to read back or send (small models answer with say+action only)."""
    return d.get("action") == "propose" and not (d.get("brief") or {}).get("goal") and not d.get("title")


def parse_decision(text: str) -> dict:
    """One decision from the model's content. Tolerates code fences and text around the object. Content with no object
    at all (the model answered in prose) is a reply whose say is that prose; content that starts like JSON but does not
    parse raises BadDecision (the ladder tries the next rung)."""
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```\s*$", "", t).strip()
    start = t.find("{")
    if start < 0:
        if not t:
            raise BadDecision("empty content")
        d = normalize_decision({"say": t, "action": "reply"})
        d["prose"] = True
        return d
    try:
        obj, _ = json.JSONDecoder().raw_decode(t[start:])
    except ValueError as e:
        if start == 0:
            raise BadDecision(f"unparseable JSON: {e}") from None
        d = normalize_decision({"say": t, "action": "reply"})
        d["prose"] = True
        return d
    if not isinstance(obj, dict):
        raise BadDecision("the JSON is not an object")
    return normalize_decision(obj)


# ---------------------------------------------------------------- the ladder

# The one re-ask of the last rung: what came back was unusable (a length cut: the max_tokens went on reasoning; or empty /
# broken JSON). The gateway's auto/fast router sets the effort itself (glm-5.3 at max for this token, whatever the request
# says), so a long-answer request can spend the whole max_tokens thinking. The re-ask asks for the short version.
REASK_OUTCOMES = ("truncated", "empty", "bad_json")
REASK_MIN_S = 2.5
REASK_TEXT = ("[DESK] Your last answer ran out of room before the JSON object was complete. Answer again now, briefly and "
              "without deliberating: the JSON object only, with a \"say\" of at most 30 words. If the driver asked for a "
              "long or detailed explanation, say the short version in one or two sentences.")


def _domain(r: dict) -> str:
    """Where a timeout is blamed: the host for a bare model name (Hyper), the upstream channel behind a gateway
    (`automaticai/<channel>/<model>`): ministral timing out says nothing about gemini on the same gateway."""
    m = r.get("model") or ""
    return f"{r['host']}|{m.rsplit('/', 1)[0]}" if "/" in m else r["host"]


class Ladder:
    """Try the rungs in order inside one total budget. Every rung's outcome is recorded; the first usable decision wins.

    A rung is skipped while its breaker is open, while its key is unreadable, after an earlier rung on the same host
    could not connect in this call, and after an earlier rung of the same upstream channel timed out (see _domain). A 401 re-reads the key once. A forbidden
    `model` in the answer throws it away (never-Anthropic). Never raises for an LLM reason."""

    def __init__(self, routes: list[dict], keys: KeyCache, breaker: Breaker, http_: Http | None = None,
                 budget_s: float = 8.0, clock=time.monotonic, log=None, gate=None, served_ok=None,
                 reask_min_s: float = REASK_MIN_S):
        self.routes, self.keys, self.breaker = routes, keys, breaker
        self.http = http_ or Http()
        self.budget_s, self.clock, self.log = budget_s, clock, log or _log_default
        # the one re-ask of the last rung (truncated / empty / bad JSON) is made only with at least this much budget left
        self.reask_min_s = reask_min_s
        # gate(route) -> None (use it) or the outcome it is skipped with (a scoped auto rung without a fresh scope proof)
        self.gate = gate
        # served_ok(route, served) -> bool: the route a router rung's answer names is inside its token's proven scope
        self.served_ok = served_ok

    def call(self, messages: list[dict]) -> dict:
        t0 = self.clock()
        attempts: list[dict] = []
        dead_hosts: set[str] = set()
        if not self.routes:
            return {"ok": False, "attempts": attempts, "fallback_reason": "no_routes", "latency_ms": 0}
        reason = "all_routes_failed"
        weak = None
        reasked = False
        for r in self.routes:
            left = self.budget_s - (self.clock() - t0)
            if left < 0.3:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "budget_exhausted", "ms": 0})
                reason = "budget_exhausted"
                break
            if self.breaker.is_open(r["id"]):
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "breaker_open", "ms": 0})
                continue
            if r["host"] in dead_hosts or _domain(r) in dead_hosts:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "host_down", "ms": 0})
                continue
            skip = self.gate(r) if self.gate is not None else None
            if skip:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": skip, "ms": 0})
                continue
            key = self.keys.get(r["key_ref"], timeout=max(0.3, left - 0.3))
            if key is None:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "key_unreadable", "ms": 0})
                continue
            res = self._one(r, key, messages, min(r["timeout_s"], left))
            attempts.append(res["attempt"])
            if (res.get("decision") is None and res["attempt"]["outcome"] in REASK_OUTCOMES and not reasked
                    and r is self.routes[-1] and self.reask_min_s > 0):
                # the last rung answered but nothing usable came back (a length cut: max_tokens spent on reasoning, or
                # empty / broken JSON): ask the same route once more for the short version, inside what is left of the
                # budget, before the turn falls through to the full agent (60-80 s later)
                left = self.budget_s - (self.clock() - t0)
                if left >= self.reask_min_s:
                    reasked = True
                    self._failed(r, res, dead_hosts, breaker=res["attempt"]["outcome"] != "truncated")
                    self.log("converse_reask", route=r["id"], model=r["model"], after=res["attempt"]["outcome"],
                             left_ms=int(left * 1000))
                    res = self._one(r, key, messages + [{"role": "user", "content": REASK_TEXT}], min(r["timeout_s"], left))
                    res["attempt"]["reask"] = True
                    attempts.append(res["attempt"])
            if res.get("decision") is not None and incomplete_propose(res["decision"]) and r is not self.routes[-1]:
                # a small model that proposes with no title and no brief: ask the next rung, keep this one as the last resort
                res["attempt"]["outcome"] = "incomplete_propose"
                weak = weak or (r, res)
                self.breaker.ok(r["id"])
                continue
            if res.get("decision") is not None:
                self.breaker.ok(r["id"])
                return {"ok": True, "decision": res["decision"], "model": res["model"], "route": r["id"],
                        "requested_model": r["model"], "served_route": res.get("served_route"), "attempts": attempts,
                        "usage": res.get("usage"), "cached_tokens": res.get("cached_tokens"),
                        "latency_ms": int((self.clock() - t0) * 1000), "fallback_reason": None}
            self._failed(r, res, dead_hosts, breaker=res["attempt"]["outcome"] != "truncated")
        if weak is not None:  # no rung did better than the incomplete proposal: the guard builds the brief from the driver's words
            r, res = weak
            return {"ok": True, "decision": res["decision"], "model": res["model"], "route": r["id"], "requested_model": r["model"],
                    "served_route": res.get("served_route"),
                    "attempts": attempts, "usage": res.get("usage"), "cached_tokens": res.get("cached_tokens"),
                    "latency_ms": int((self.clock() - t0) * 1000), "fallback_reason": None}
        if attempts and all(a["outcome"] == "key_unreadable" for a in attempts):
            reason = "key_unreadable"
        return {"ok": False, "attempts": attempts, "fallback_reason": reason, "latency_ms": int((self.clock() - t0) * 1000)}

    def _failed(self, r: dict, res: dict, dead_hosts: set, breaker: bool = True) -> None:
        """One failed attempt: the breaker (a length cut is the request's size, not the route's health: not counted),
        the log line, and the hosts / channels the rest of this call skips."""
        a = res["attempt"]
        opened = self.breaker.fail(r["id"]) if breaker else False
        if a.get("http_status") == 402:
            self.breaker.trip(r["id"], BILLING_OPEN_S)
            opened = True
        self.log("converse_attempt_failed", "warn", route=r["id"], model=r["model"], outcome=a["outcome"],
                 ms=a["ms"], http_status=a.get("http_status"), finish_reason=a.get("finish_reason"),
                 completion_tokens=a.get("completion_tokens"), reasoning_tokens=a.get("reasoning_tokens"),
                 reask=a.get("reask"), breaker_opened=opened or None)
        if a["outcome"].startswith("connect"):
            dead_hosts.add(r["host"])  # nothing answers there
        elif a["outcome"] == "timeout":
            dead_hosts.add(_domain(r))  # that upstream is slow; another channel behind the same gateway may not be

    def _one(self, r: dict, key: str, messages: list[dict], timeout: float) -> dict:
        body = {"model": r["model"], "messages": messages, "response_format": {"type": "json_object"},
                "temperature": r["temperature"], "max_tokens": r["max_tokens"], "stream": False}
        if r.get("reasoning_effort"):
            body["reasoning_effort"] = r["reasoning_effort"]
        t0 = self.clock()
        hdr_box: dict = {}

        def post(k: str):
            hdrs = {"Authorization": f"Bearer {k}"} if k else {}
            hdr_box.clear()
            return self.http.post_json(f"{r['base_url']}/chat/completions", body, hdrs, max(0.1, timeout - (self.clock() - t0)),
                                       resp_headers=hdr_box)

        status, raw, err = post(key)
        if status == 401 and r["key_ref"]:
            self.keys.invalidate(r["key_ref"])  # rotated: read it once more
            key2 = self.keys.get(r["key_ref"], timeout=max(0.3, timeout - (self.clock() - t0) - 0.2))
            if key2 is not None and self.clock() - t0 < timeout - 0.2:
                status, raw, err = post(key2)
        ms = int((self.clock() - t0) * 1000)
        att = {"route": r["id"], "model": r["model"], "ms": ms}
        if err:
            return {"attempt": {**att, "outcome": err.split(":")[0] if err.startswith("connect") else err}}
        if status != 200:
            return {"attempt": {**att, "outcome": f"http_{status}", "http_status": status}}
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return {"attempt": {**att, "outcome": "bad_json", "http_status": status}}
        model = data.get("model") if isinstance(data, dict) else None
        model = None if model == "" else model
        # what the facts carry: a `model` that is not a string is shown as JSON (and is forbidden below)
        shown = model if model is None or isinstance(model, str) else json.dumps(model, default=str)[:120]
        # the gateway names the route that served an auto / free request (and may for an explicit one)
        served = (hdr_box.get("x-automaticai-route") or "").strip() or None
        if served:
            att["served_route"] = served
        if ((forbidden(model) and not scoped_auto(model)) or (served and ANTHROPIC_RE.search(served))
                or (served and forbidden(served) and not scoped_auto(served))):
            # the never-Anthropic rule: an answer from a forbidden model is never used, whatever it says
            return {"attempt": {**att, "outcome": "forbidden_model", "answered_model": shown, "http_status": status}}
        if r.get("scoped_auto") and not served:
            # a router rung must say which route answered: an answer it cannot attribute is never used
            return {"attempt": {**att, "outcome": "route_unproven", "answered_model": shown, "http_status": status}}
        if r.get("scoped_auto") and self.served_ok is not None and not self.served_ok(r, served):
            # ... and that route must be one the token's proven scope lists. auto/fast only picks inside the scope, but
            # automaticai/free picks from the gateway's whole free policy: this bounds what the desk ever USES to the scope
            return {"attempt": {**att, "outcome": "route_out_of_scope", "answered_model": shown, "http_status": status}}
        try:
            content = data["choices"][0]["message"].get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError):
            content = ""
        try:
            finish = data["choices"][0].get("finish_reason")
        except (KeyError, IndexError, TypeError, AttributeError):
            finish = None
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else None
        if isinstance(finish, str) and finish:
            att["finish_reason"] = finish[:40]
        if usage and isinstance(usage.get("completion_tokens"), (int, float)):
            att["completion_tokens"] = int(usage["completion_tokens"])
            det = usage.get("completion_tokens_details")
            if isinstance(det, dict) and isinstance(det.get("reasoning_tokens"), (int, float)):
                att["reasoning_tokens"] = int(det["reasoning_tokens"])
        # a length cut (max_tokens spent, mostly on reasoning) is "truncated", not a bad model answer: the ladder re-asks
        cut = finish == "length"
        if not content.strip():
            return {"attempt": {**att, "outcome": "truncated" if cut else "empty", "answered_model": model, "http_status": status}}
        try:
            decision = parse_decision(content)
        except BadDecision:
            return {"attempt": {**att, "outcome": "truncated" if cut else "bad_json", "answered_model": model, "http_status": status}}
        cached = None
        if usage:
            det = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
            cached = det.get("cached_tokens") if det.get("cached_tokens") is not None else usage.get("prompt_cache_hit_tokens")
        return {"attempt": {**att, "outcome": "ok", "answered_model": model, "http_status": status},
                "decision": decision, "model": model, "usage": usage, "served_route": served,
                "cached_tokens": int(cached) if isinstance(cached, (int, float)) else None}


# ---------------------------------------------------------------- lexicons (no LLM call)

def norm(text: str) -> str:
    t = (text or "").lower().replace("’", "'").replace("‘", "'")
    t = re.sub(r"\b([a-z])[-\u2013\u2014]\s*(?=\1[a-z])", "", t)  # whisper's stutter: "S-Send it!" is "send it"
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


_YES = r"(?:yes|yeah|yep|yup|ok|okay|sure|alright|all right|correct|perfect|great|sounds good|looks good|that's right)"
_SEND = (r"(?:send it|send that|send this|send it off|send it over|send that over|go ahead|go for it|do it|ship it|"
         r"confirm|confirmed|kick it off|start it|make it so|please do|yes please)")
# "send it" and its kin, said alone. A bare "yes" / "okay" is NOT here: it only confirms right after the read-back (see bare_yes).
CONFIRM_ONLY_RE = re.compile(rf"(?:{_YES} ?)*(?:please )?{_SEND}(?: (?:please|now|then|thanks|thank you))*")
BARE_YES_RE = re.compile(rf"(?:{_YES}|please|thanks|thank you|right|yes please)(?: (?:{_YES}|please|thanks|thank you|right|do it))*")
SEND_RE = re.compile(rf"\b{_SEND}\b")
QUESTION_RE = re.compile(r"\b(?:how|what|what's|whats|when|who|whom|whose|why|where|which|is|are|was|were|does|did|do you|have you|"
                         r"can you tell|could you tell)\b")
CANCEL_ONLY_RE = re.compile(
    r"(?:(?:no|nope|nah|ok|okay|actually) ?)*(?:cancel(?: it| that| the draft)?|scrap (?:it|that)|forget (?:it|that|about it)"
    r"|never ?mind|drop (?:it|that)|don't send (?:it|that)|do not send (?:it|that)|no|nope)(?: (?:please|thanks|thank you))*")
END_ONLY_RE = re.compile(
    r"(?:(?:ok|okay|alright|great|cool|perfect|thanks|thank you) ?)*(?:that's all|that is all|that's it|that is it|i'm done|"
    r"im done|we're done|we are done|end (?:the )?conversation|talk (?:to you )?later|goodbye|good bye|bye|bye bye|see you|"
    r"that'll be all)(?: (?:thanks|thank you|bye|for now))*")
FORCE_DIRECT_RE = re.compile(r"\b(?:ask|tell|have|let)\s+(?:the\s+)?([a-z0-9][a-z0-9' -]{0,40}?)\s+directly\b|\bfull agent\b")
AFFIRM_RE = SEND_RE
NEGATION_RE = re.compile(r"\b(?:don't|dont|do not|not|never|no|nope|stop|wait|hold on|hold off|cancel|but|instead|change|"
                         r"except|without|later)\b")
_NEG_CUE_RE = re.compile(r"\b(?:don't|dont|do not|doesn't|never|no|not|without|nothing|avoid|n't|skip|except)\b|n't\b")
_QUESTION_START_RE = re.compile(r"^\s*(?:why|what|when|how|did|does|is|was|were|has|had|who|where|which)\b")
# "change" alone is how a driver edits a draft ("change the title"), so it only counts next to code
CHANGE_WORDS_RE = re.compile(r"\b(?:fix|fixes|edit|modify|implement|commit|patch|refactor|code changes?|changes? (?:the )?code|"
                             r"make (?:the|a|those) changes?|update (?:the )?code|write (?:the |a |some )?(?:code|fix|patch|tests?|"
                             r"feature|script|function))\b")
DEPLOY_WORDS_RE = re.compile(r"\b(?:deploy|deployed|deploying|redeploy|restart|release|roll ?out|push (?:it|to (?:prod|"
                             r"production|main)))\b")
# A reply that claims work was sent or started when nothing was (only a confirmed draft is ever sent).
SENT_CLAIM_RE = re.compile(r"\b(?:i(?:'ve| have)? (?:sent|started|kicked off|delegated|dispatched|handed (?:it|that) (?:off|over))|"
                           r"(?:sending|starting) (?:it|that|this) now|(?:it|that)(?:'s| is| has been) (?:been )?(?:sent|started)|"
                           r"on it now)\b", re.IGNORECASE)


# A turn that opens by taking back the draft on the table ("actually forget that, instead ..."): what it replaces is not
# this draft's words, so the delegated prompt's driver words start over from this turn (F4, 2026-10-22 review).
WITHDRAW_LEAD_RE = re.compile(
    r"(?:(?:no|nope|nah|ok|okay|actually|wait|hold on) ?)*(?:forget (?:it|that|about (?:it|that)|what i (?:said|asked))|"
    r"scrap (?:it|that)|scratch that|never ?mind|disregard (?:it|that)|ignore (?:it|that)|drop (?:it|that)|"
    r"do not (?:do|send) (?:it|that)|don't (?:do|send) (?:it|that)|instead of that|new (?:request|topic|question))\b")


def withdraws_draft(text: str) -> bool:
    n = norm(text)
    return bool(n) and WITHDRAW_LEAD_RE.match(n) is not None


def confirm_only(text: str) -> bool:
    n = norm(text)
    return bool(n) and CONFIRM_ONLY_RE.fullmatch(n) is not None


def cancel_only(text: str) -> bool:
    n = norm(text)
    return bool(n) and CANCEL_ONLY_RE.fullmatch(n) is not None


def end_only(text: str) -> bool:
    n = norm(text)
    return bool(n) and END_ONLY_RE.fullmatch(n) is not None


def force_direct(text: str) -> str | None:
    """'ask <agent> directly' / 'full agent': the words that forced the direct path, else None."""
    m = FORCE_DIRECT_RE.search(norm(text))
    return m.group(0) if m else None


def affirm(text: str) -> bool:
    """An explicit send phrase ("send it", "go ahead", "do it") anywhere in the transcript."""
    return AFFIRM_RE.search(norm(text)) is not None


def bare_yes(text: str) -> bool:
    """Only an acknowledgement ("yes", "okay", "sure"): it answers the read-back, nothing else."""
    n = norm(text)
    return bool(n) and BARE_YES_RE.fullmatch(n) is not None and not confirm_only(text)


def is_question(text: str) -> bool:
    return "?" in (text or "") or QUESTION_RE.search(norm(text)) is not None


def readback_just_heard(sess: dict | None, pend: dict | None) -> bool:
    """True when the desk's last utterance was this pending draft's read-back: the newest driver turn proposed it."""
    if not isinstance(pend, dict):
        return False
    turns = driver_turns(sess or {})
    return bool(turns) and turns[-1].get("action") == "propose" and turns[-1].get("readback") == pend.get("brief_id")


def send_affirmed(text: str, sess: dict | None, pend: dict | None) -> bool:
    """Is this transcript a confirmation of the pending draft? Never on a negation, never on a question, never on a bare
    acknowledgement unless the read-back was the last thing the driver heard. (The model proposes; this decides.)"""
    if not (text or "").strip() or negated(text):
        return False
    if confirm_only(text):
        return True
    if bare_yes(text):
        return readback_just_heard(sess, pend)
    return affirm(text) and not is_question(text)


def negated(text: str) -> bool:
    return NEGATION_RE.search(norm(text)) is not None


def _perm_text(words: list[str]) -> str:
    """What the driver's own words ask for, minus what they forbid: clauses with a negation ("don't change any code", "do not
    deploy") and clauses that are questions ("why did it restart?") grant nothing."""
    kept: list[str] = []
    for w in words:
        for clause in re.split(r"[.!?;,\n]+|\b(?:but|and then|then|and)\b", (w or "").lower().replace("\u2019", "'")):
            if not clause.strip() or _NEG_CUE_RE.search(clause) or _QUESTION_START_RE.match(clause):
                continue
            kept.append(clause)
    return norm(" ".join(kept))


def perm_allowed(words: list[str]) -> str:
    """The highest permission the driver's own words allow."""
    text = _perm_text(words)
    if DEPLOY_WORDS_RE.search(text):
        return "deploy_ok"
    if CHANGE_WORDS_RE.search(text):
        return "changes_ok"
    return "read_only"


def clamp_perm(requested: str, words: list[str]) -> str:
    req = requested if requested in PERMS else "read_only"
    return PERMS[min(PERMS.index(req), PERMS.index(perm_allowed(words)))]


# ---------------------------------------------------------------- per-tile voice and model: names and phrases (no LLM)

TOOL_VOICE, TOOL_MODEL = "car_set_voice", "car_set_model"
# The two setting tools' argument contracts, for the in-process fallback when the skill scope is missing (the skills'
# tool.json files say the same).
BUILTIN_SCHEMAS = {
    TOOL_VOICE: {"type": "object", "properties": {"voice": {"type": "string", "maxLength": 64}}, "required": ["voice"],
                 "additionalProperties": False},
    TOOL_MODEL: {"type": "object", "properties": {"model": {"type": "string", "maxLength": 64}}, "required": ["model"],
                 "additionalProperties": False},
}
DEFAULT_WORDS = ("default", "the default", "normal", "the normal", "usual", "the usual", "standard", "the standard")
_NUM_WORDS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven",
              "8": "eight", "9": "nine"}


def _key(text: str) -> str:
    """A phrase as a lookup key: lower case, no spaces, apostrophes or hyphens ('Deep Seek Pro' == 'deepseek-pro')."""
    return re.sub(r"[^a-z0-9]+", "", norm(text))


def voice_spoken(name: str) -> str:
    """How a voice is named aloud: 'walken2' -> 'Walken two', 'rick' -> 'Rick'."""
    m = re.fullmatch(r"([a-z_-]*?)(\d+)", name or "")
    if m and m.group(1):
        return f"{m.group(1).replace('_', ' ').title()} {' '.join(_NUM_WORDS.get(d, d) for d in m.group(2))}"
    return (name or "").replace("_", " ").replace("-", " ").title()


def voice_index(catalog: list[dict]) -> dict[str, str]:
    """Phrase key -> voice name, from vox's catalog ([{name, display_name}]): the name, the name with its digits spoken
    ('walken two'), the display name ('Christopher Walken', the shortest name on a tie), and a display name's first or last
    word when no other voice shares it ('freeman' -> morgan). Earlier entries win."""
    names = sorted({str(v.get("name")) for v in catalog if isinstance(v, dict) and v.get("name")}, key=lambda n: (len(n), n))
    disp = {str(v["name"]): norm(str(v.get("display_name") or "")) for v in catalog if isinstance(v, dict) and v.get("name")}
    idx: dict[str, str] = {}

    def put(phrase: str, name: str) -> None:
        k = _key(phrase)
        if k and k not in idx:
            idx[k] = name
    for n in names:
        put(n, n)
        put(re.sub(r"\d", lambda d: f" {_NUM_WORDS[d.group(0)]}", n), n)
    for n in names:
        if disp.get(n):
            put(disp[n], n)
    for pick in (lambda w: w[-1], lambda w: w[0]):
        words: dict[str, set[str]] = {}
        for n in names:
            w = disp.get(n, "").split()
            if len(w) > 1:
                words.setdefault(pick(w), set()).add(n)
        for w, owners in words.items():
            if len(owners) == 1:
                put(w, next(iter(owners)))
    return idx


def _edits(a: str, b: str, cap: int = 2) -> int:
    """The edit distance (insertions, deletions, substitutions) between a and b, or cap + 1 once it is past cap."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return min(prev[-1], cap + 1)


def _within_one_edit(a: str, b: str) -> bool:
    """True when a and b differ by at most one insertion, deletion or substitution."""
    return _edits(a, b, 1) <= 1


def resolve_voice(said: str, catalog: list[dict], fuzzy: bool = False) -> str | None:
    """The voice name a spoken or typed value means, or None. 'default' resolves to the literal 'default'. `fuzzy` (the
    speech path only, always next to the word voice): a speech-to-text spelling close to one voice counts. Close is one
    edit off a name of five letters ("walkin", "morgen"), or two off a name of six or more when at least four letters were
    heard ("walk" for walken: live 2026-10-22, "USE WALK VOICE"). The nearest voice wins only when no other is as near;
    walken2 is one edit further from "walk" than walken, so "walk" is walken."""
    k = _key(said)
    if not k:
        return None
    if k in {_key(w) for w in DEFAULT_WORDS}:
        return "default"
    idx = voice_index(catalog)
    if k in idx or not fuzzy or len(k) < 4:
        return idx.get(k)
    best: dict[int, set[str]] = {}
    for p, v in idx.items():
        if len(p) < 5 or (len(k) == 4 and len(p) < 6):
            continue  # a four-letter spelling is only ever near a name of six or more ("nick" is never brule or rick)
        cap = 1 if len(p) == 5 else 2
        d = _edits(k, p, cap)
        if d <= cap:
            best.setdefault(d, set()).add(v)
    if not best:
        return None
    near = best[min(best)]
    return next(iter(near)) if len(near) == 1 else None


def _alias_key(text: str) -> str:
    return _key(re.sub(r"^(?:the|a)\s+", "", re.sub(r"\b(?:model|models|brain|llm)\b", " ", norm(text)).strip()))


def alias_index(table: dict | None) -> dict[str, str]:
    """Phrase key -> model alias, from car_desk_aliases.json: the alias itself, its label and every phrase (the words
    model / brain do not count: 'the free model' is 'free')."""
    idx: dict[str, str] = {}
    for alias, e in ((table or {}).get("models") or {}).items():
        if not isinstance(e, dict):
            continue
        for p in [alias, e.get("label") or "", e.get("spoken") or "", *(e.get("phrases") or [])]:
            k = _alias_key(str(p))
            if k and k not in idx:
                idx[k] = alias
    return idx


def resolve_alias(said: str, table: dict | None) -> str | None:
    """The model alias a spoken or typed value means, or None. 'default' resolves to the literal 'default'."""
    k = _alias_key(said)
    if not k:
        return None
    if k in {_key(w) for w in DEFAULT_WORDS}:
        return "default"
    return alias_index(table).get(k)


_SET_LEAD = (r"(?:(?:hey|ok|okay|alright|all right|so|and|now|please|can you|could you|would you|let's|lets|i want to|"
             r"i'd like to|id like to|go ahead and)\s+)*")
_SET_TAIL = r"(?:\s+(?:please|now|instead|then|thanks|thank you|for me|from now on|for this tile|for this agent))*"
_VOICE_RES = [
    # whisper hears "rick voice" as "Rickface" (live 2026-10-22): "face", glued or not, is the word voice here, and only
    # ever when the words before it resolve to a voice vox has
    re.compile(_SET_LEAD + r"(?:use|switch to|switch over to|switch back to|change to|go with|go back to|try|give me|talk with|"
               r"talk in|speak with|speak in)\s+(?:the\s+|a\s+)?(?P<v>.+?)(?:'s)?(?:\s+voice|\s*face)" + _SET_TAIL),
    re.compile(_SET_LEAD + r"(?:switch|change|set|make)\s+(?:the\s+|your\s+|my\s+|its\s+)?voice\s+(?:to|over to|back to)\s+"
               r"(?:the\s+|a\s+)?(?P<v>.+?)(?:'s)?(?:\s+voice)?" + _SET_TAIL),
    re.compile(_SET_LEAD + r"(?P<reset>reset|clear)\s+(?:the\s+|your\s+|my\s+)?voice" + _SET_TAIL),
]
_MODEL_RES = [
    re.compile(_SET_LEAD + r"(?:switch|change|set|make)\s+(?:the\s+|your\s+|my\s+|its\s+)?(?:model|brain)\s+(?:to|over to|back to)\s+"
               r"(?:the\s+)?(?P<a>.+?)" + _SET_TAIL),
    re.compile(_SET_LEAD + r"(?:use|switch to|switch over to|switch back to|change to|go with|go back to|try|think with)\s+"
               r"(?:the\s+)?(?P<a>.+?)" + _SET_TAIL),
    re.compile(_SET_LEAD + r"(?P<reset>reset|clear)\s+(?:the\s+|your\s+|my\s+)?(?:model|brain)" + _SET_TAIL),
]


def setting_phrase(text: str, catalog: list[dict], table: dict | None) -> dict | None:
    """A whole utterance that only changes the tile's voice or model: {"tool_name", "args"}, else None (the model decides).
    "use walken two voice", "switch the voice to Morgan Freeman", "reset the voice"; "switch to deepseek pro", "use the
    free model", "switch the model to auto", "reset the model". A bare name is a voice only next to the word voice, so
    "switch to marge" (an agent) is never read as a voice."""
    n = norm(text)
    if not n or len(n) > 120:
        return None
    for rx in _VOICE_RES:
        m = rx.fullmatch(n)
        if m is None:
            continue
        v = "default" if m.groupdict().get("reset") else resolve_voice(m.group("v"), catalog, fuzzy=True)
        if v:
            return {"tool_name": TOOL_VOICE, "args": {"voice": v}}
    for rx in _MODEL_RES:
        m = rx.fullmatch(n)
        if m is None:
            continue
        a = "default" if m.groupdict().get("reset") else resolve_alias(m.group("a"), table)
        if a == "default" and not re.search(r"\b(?:model|brain)\b", n):
            continue  # "use the usual" alone names nothing: the default model only when the model is named
        if a:
            return {"tool_name": TOOL_MODEL, "args": {"model": a}}
    return None


# ---------------------------------------------------------------- names (handoff)

_GENERIC = {"pm", "agent", "the", "a", "an", "director", "specialist", "reporter", "company", "project", "manager",
            # ordinary words that are also a stem of an agent id (monitoring-pm, infra-pm): said in passing they name no one
            "monitoring", "infra", "infrastructure", "ops", "docs", "board", "data", "core", "platform", "general", "main"}


def name_tokens(agent_id: str, *names: str) -> list[str]:
    """What the driver may say to name an agent: its id with spaces, the id without -pm, its display and roster names."""
    toks = {agent_id.replace("-", " "), re.sub(r"-pm$", "", agent_id).replace("-", " ")}
    for n in names:
        if n:
            toks.add(norm(n.split("—")[0].split(" - ")[0]))
    return sorted({t for t in (norm(x) for x in toks) if len(t) >= 3 and t not in _GENERIC}, key=len, reverse=True)


def named(text: str, tokens: list[str]) -> bool:
    n = f" {norm(text)} "
    return any(re.search(rf"(?<![a-z0-9']){re.escape(t)}(?![a-z0-9'])", n) for t in tokens)


# ---------------------------------------------------------------- speech templates (deterministic)

def readback(draft: dict) -> str:
    return (f"Draft for {draft['target_name']}: {draft['title']}. {PERM_TEXT.get(draft.get('perm'), 'Read-only')}. "
            "Say send it, or tell me what to change.")


def sending_line(draft: dict) -> str:
    return f"Sending to {draft['target_name']}: {draft['title']}. I'll call you back."


def already_sent_line(d: dict) -> str:
    return f"Already sent to {d.get('target_name') or d.get('target')}: {d.get('title')}. I'll call you back with the result."


NOTHING_PENDING_LINE = "There's nothing waiting to send. Tell me what you want done."
DROPPED_LINE = "Dropped. Nothing was sent."
NOTHING_TO_CANCEL_LINE = "Okay. Nothing was waiting to send."
END_LINE = "Okay. Talk soon."
EXPIRED_LINE = "That draft timed out, so nothing was sent. Tell me again what you want done."
DRAFT_CHANGED_LINE = "That draft changed since I read it back, so nothing was sent. Tell me again what you want done."
DIDNT_CATCH_LINE = "Sorry, I didn't catch that. Say it again?"

# The hold cue (HOLOC-23): while the desk's answer is slow the car hears one of these, in the tile's voice. Each is about a
# second of speech or less, pre-rendered in the PhraseBank; the watcher measures the clip it is about to upload and drops (and
# stops using) a line whose render is longer than MEMO_CONVERSE_HOLD_MAX_CLIP_S (default 1.2 s), because a cue that plays long
# holds the pad's speech queue and delays the echo behind it. HOLD_CUE_LINES at ~3 s, HOLD_CUE2_LINES at ~9 s (and as the
# keep-alive while a memo that fell through to the full agent has said nothing for a while), HOLD_CUE3_LINES at ~16 s: the
# desk route's timeout is 22 s since 2026-10-22 (a propose over a long conversation took 9.6-12+ s at host load ~30), so the
# longest silence before the answer or the fall-through is ~7 s. Never the same line twice in a row.
HOLD_CUE_LINES = ("One sec.", "Thinking.", "Hold on.", "Hang on.")
HOLD_CUE2_LINES = ("Still on it.", "Still thinking.")
HOLD_CUE3_LINES = ("Almost there.", "Any second.")


def pick_hold_line(lines: tuple[str, ...], last: str | None, rnd=None) -> str:
    """One of `lines`, never `last` (the line the car heard before) unless it is the only one."""
    import random
    pool = [x for x in lines if x != last] or list(lines)
    return (rnd or random).choice(pool)


# ---------------------------------------------------------------- briefs + ids

def brief_body(title: str, brief: dict, perm: str) -> str:
    """The stored brief, frozen when it is proposed: its sha256 is what gets confirmed and sent."""
    lines = [f"# {title}", "", (brief.get("goal") or title).strip()]
    if brief.get("context"):
        lines += ["", "## Context", *[f"- {c}" for c in brief["context"]]]
    if brief.get("done_when"):
        lines += ["", "## Done when", *[f"- {c}" for c in brief["done_when"]]]
    lines += ["", "## Permission", PERM_RULE.get(perm, PERM_RULE["read_only"])]
    return "\n".join(lines)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def brief_id_for(conv_id: str, body_sha: str, target: str = "", stamp: float = 0.0) -> str:
    """One id per proposed draft: the same brief for another agent, or proposed again later, is another brief (so a
    redirect never shares an id, and a command id, with the draft it replaces)."""
    return str(uuid.uuid5(NS, f"brief:{conv_id}:{body_sha}:{target}:{int(stamp)}"))


def command_id_for(brief_id: str) -> str:
    """The delegation's command id: uuid5 of the brief id, so a re-run of the same confirmation can never mint a second
    command (the gateway dedupes the same envelope, and refuses a different one under the same id)."""
    return str(uuid.uuid5(NS, f"delegation:{brief_id}"))


def render_prompt(draft: dict, words: list[tuple[str, str]], conv_id: str, memo_id: str, tile: str) -> str:
    """DELEGATE_PREFIX + the stored brief verbatim + the driver's own words (oldest first) + a trace line."""
    said = "\n".join(f'- {at} "{text}"' for at, text in words) or "- (none recorded)"
    return (f"{DELEGATE_PREFIX}{draft['body']}\n\n## The driver's own words (speech-to-text, oldest first)\n{said}\n\n"
            f"## Trace\nconversation {conv_id} · memo {memo_id} · brief {draft['brief_id']} · asked via {tile}")


# ---------------------------------------------------------------- sessions (dicts in state.json, mutated under the lock)

def session_key(device: str | None, agent: str) -> str:
    return f"{device or '-'}|{agent}"


def new_session(agent: str, device: str | None, now: float) -> dict:
    cid = str(uuid.uuid4())
    return {"conv_id": cid, "sid": cid[:8], "agent": agent, "device": device, "opened_at": now, "last_at": now,
            "turns": [], "pending": None, "delegations": []}


def driver_turns(sess: dict) -> list[dict]:
    return [t for t in (sess or {}).get("turns") or [] if t.get("kind", "driver") == "driver"]


# a turn that ends whatever came before it: the draft was dropped, sent, or the conversation ended
DRAFT_BOUNDARY_ACTIONS = ("cancel", "confirm", "end")


def draft_turns(sess: dict, draft: dict, skip_memo: str | None = None, limit: int = 12) -> list[dict]:
    """The driver turns that built THIS draft (oldest first), for the delegated prompt's "driver's own words": the
    proposal and each edit of it, never an earlier cancelled or failed ask, a sent delegation's request, or small talk.
    A draft minted by the guard names its turns (`built_by`: memo ids). An older draft (state.json from before) has
    none: the turns since the last cancel, confirm or end."""
    turns = [t for t in driver_turns(sess) if t.get("memo_id") != skip_memo]
    ids = (draft or {}).get("built_by")
    if isinstance(ids, list):
        return [t for t in turns if t.get("memo_id") in ids][-limit:]
    out: list[dict] = []
    for t in reversed(turns):
        if t.get("action") in DRAFT_BOUNDARY_ACTIONS:
            break
        out.append(t)
    return out[::-1][-limit:]


def pending_draft(sess: dict | None, now: float, ttl_s: float) -> dict | None:
    """The draft waiting for a yes: proposed (or being sent), not older than ttl_s since it was proposed or restored."""
    d = (sess or {}).get("pending")
    if not isinstance(d, dict) or d.get("state") not in ("proposed", "sending"):
        return None
    if d.get("state") == "proposed" and now - max(float(d.get("at") or 0), float(d.get("restored_at") or 0)) > ttl_s:
        return None
    return d


# A delegation that is still on its way (sending, running) stays "recent" past the dedupe window: the gateway's batch lane
# can queue it behind other work for far longer than 30 minutes (2026-10-22: 36 min), and "cancel that" or a second "Send it"
# about it must still get the true answer, never "nothing was waiting".
IN_FLIGHT_MAX_S = 6 * 3600.0


def recent_delegation(sess: dict | None, now: float, within_s: float, sha: str | None = None,
                      target: str | None = None) -> dict | None:
    for d in reversed((sess or {}).get("delegations") or []):
        if d.get("state") in ("not_sent",):
            continue
        limit = max(within_s, IN_FLIGHT_MAX_S) if d.get("state") in ("sending", "running") else within_s
        if now - float(d.get("at") or 0) > limit:
            continue
        if (sha is None or d.get("brief_sha256") == sha) and (target is None or d.get("target") == target):
            return d
    return None


def delegation_in_flight(sess: dict | None, now: float, within_s: float) -> dict | None:
    """The newest confirmed delegation that is on its way (being sent, or running) and recent: "cancel that" about it is
    too late, and says so."""
    d = recent_delegation(sess, now, within_s)
    return d if d is not None and d.get("state") in ("sending", "running") else None


def upsert_turn(sess: dict, turn: dict, keep: int = 60) -> int:
    """Record a turn by its memo id (a restart or retry never duplicates one). Its 1-based number among driver turns."""
    turns = sess.setdefault("turns", [])
    for i, t in enumerate(turns):
        if t.get("memo_id") == turn.get("memo_id") and t.get("kind", "driver") == turn.get("kind", "driver"):
            turns[i] = {**t, **turn}
            break
    else:
        turns.append(turn)
    del turns[:-keep]
    n = 0
    for t in turns:
        if t.get("kind", "driver") == "driver":
            n += 1
            if t.get("memo_id") == turn.get("memo_id"):
                return n
    return n


def context_for_direct(sess: dict | None, chars: int = 1200) -> str:
    """The earlier conversation for a direct turn's prompt: newest turns that fit in `chars`, oldest first."""
    out: list[str] = []
    total = 0
    for t in reversed(driver_turns(sess)[:-1] if sess else []):
        line = f"Driver: {t.get('user', '')} / Desk: {t.get('agent_reply') or t.get('say') or ''}"
        line = re.sub(r"\s+", " ", line).strip()
        if total + len(line) > chars and out:
            break
        out.insert(0, line[:chars])
        total += len(line) + 3
    return " | ".join(out)


# ---------------------------------------------------------------- the guard (deterministic; the model only proposes)

def filter_sent_claims(say: str, about: str = "") -> tuple[str, bool]:
    """Drop sentences that claim work was sent or started. `about` (a confirmed delegation's title and target) keeps a claim
    that is true: only a sentence that shares a word with it survives; with nothing on the board every claim goes."""
    if not SENT_CLAIM_RE.search(say or ""):
        return say, False
    words = {w for w in re.findall(r"[a-z0-9]{4,}", (about or "").lower())}

    def true_claim(sentence: str) -> bool:
        if not words:
            return False
        if re.search(r"\b(?:sent|started|kicked off|delegated|dispatched|handed) (?:it|that|this)\b", sentence.lower()):
            return True  # "I've sent it": the thing on the board
        return bool(words & set(re.findall(r"[a-z0-9]{4,}", sentence.lower())))
    sentences = [x for x in re.split(r"(?<=[.!?])\s+", say) if x]
    kept = [x for x in sentences if not SENT_CLAIM_RE.search(x) or true_claim(x)]
    if len(kept) == len(sentences):
        return say, False
    out = " ".join(kept).strip()
    tail = "Nothing new was sent." if words else "Nothing was sent."
    return (f"{out} {tail}" if out else ("Nothing new has been sent." if words else "Nothing has been sent yet.")), True


SENDING_BUSY_LINE = "That one is already being sent to {target}. Tell me again once I've called back."
SENDING_CANCELLED_LINE = "Okay, cancelled before it left. Nothing was sent."
SENDING_TOO_LATE_LINE = "It's already on its way to {target}, so I can't cancel it. I'll call you back with the result."
NOT_CONFIRMED_SUFFIX = " To send it, say send it on its own."


def guard(dec: dict, sess: dict, transcript: str, *, tile: str, tile_name: str, handoff: str, route_fn, names_fn,
          now: float, draft_ttl_s: float = 600.0, dedupe_s: float = 1800.0, memo_id: str = "") -> tuple[dict, list[str]]:
    """The final decision from the model's (or the lexicon's) decision. Returns (final, reasons).

    final: {action, say, draft (a new pending draft, for propose), send (the pending draft to send, for confirm),
    drop (bool: the pending draft goes), close (bool: the conversation ends), already (the earlier delegation),
    cancel_sending (the draft being sent that the driver cancelled: the watcher stops it if it has not left)}."""
    reasons: list[str] = []
    action = dec.get("action") or "reply"
    pend = pending_draft(sess, now, draft_ttl_s)
    # What the driver's own words grant a permission: this turn, plus the turn before it while a draft is being edited.
    words = ([t.get("user") or "" for t in driver_turns(sess)[-1:]] if pend is not None else []) + [transcript]
    # "I've sent it" is a true thing to say while a confirmed delegation is on the board: only a claim with nothing sent is filtered
    board = recent_delegation(sess, now, dedupe_s) if pend is None else None
    about = f"{board.get('title') or ''} {board.get('target_name') or board.get('target') or ''}" if board else ""
    out = {"action": action, "say": dec.get("say") or "", "draft": None, "send": None, "drop": False, "close": False,
           "already": None, "cancel_sending": None}
    resolve = getattr(names_fn, "resolve", None)

    def propose_from(src: dict, base: dict | None = None) -> None:
        target = (src.get("target") or (base or {}).get("target") or tile).strip()
        if resolve is not None:
            target = resolve(target)
        pend_target = (base or {}).get("target")
        if target != tile and target != pend_target:
            # another agent than the tile (and not the one the pending draft already named and read back): only if the
            # driver said its name in THIS turn
            ok_named = handoff == "named"
            tokens = names_fn(target) if ok_named else []
            route = route_fn(target) if ok_named else {"ok": None}
            if handoff != "named":
                reasons.append("handoff_off")
                target = pend_target or tile
            elif not tokens or not named(transcript, tokens):
                reasons.append("handoff_not_named")
                target = pend_target or tile
            elif route.get("ok") is not True:
                reasons.append("unroutable_target")
                target = pend_target or tile
        said = (transcript or "").strip()
        title = (src.get("title") or (base or {}).get("title") or "").strip() or title_from_words(said) or "Untitled request"
        brief = src.get("brief") if (src.get("brief") or {}).get("goal") else (base or {}).get("brief") or src.get("brief") or {}
        if not brief.get("goal"):
            brief = {**brief, "goal": said[:1500] or title}  # a model that gave no brief: the driver's own words are the goal
        perm = clamp_perm(src.get("perm") or (base or {}).get("perm") or "read_only", words)
        if perm != (src.get("perm") or "read_only"):
            reasons.append(f"perm_clamped:{src.get('perm')}->{perm}")
        body = brief_body(title, brief, perm)
        body_sha = sha256(body)
        bid = brief_id_for(sess["conv_id"], body_sha, target, now)
        name = tile_name if target == tile else (names_fn.display(target) if hasattr(names_fn, "display") else target)
        # the turns that built this draft: an edit of a proposed draft continues its chain, anything else starts one
        # (a turn that opens by withdrawing the draft on the table starts a fresh chain: its words replace, not edit)
        chain = (list(pend.get("built_by") or [])
                 if (pend is not None and pend.get("state") == "proposed" and not withdraws_draft(transcript)) else [])
        if memo_id and memo_id not in chain:
            chain.append(memo_id)
        draft = {"brief_id": bid, "brief_sha256": body_sha, "title": title, "target": target, "target_name": name,
                 "perm": perm, "brief": brief, "body": body, "memo_id": memo_id, "at": now, "state": "proposed",
                 "built_by": chain}
        out.update(action="propose", draft=draft, say=readback(draft))

    def busy() -> None:
        reasons.append("edit_while_sending")
        out.update(action="reply", say=SENDING_BUSY_LINE.format(target=pend.get("target_name") or pend.get("target")))

    if action == "confirm":
        if pend is None or pend.get("state") == "sending":
            prior = (pend if pend is not None and pend.get("state") == "sending" else None) or recent_delegation(sess, now, dedupe_s)
            exp = sess.get("expired")
            if (pend is None and isinstance(exp, dict) and now - float(exp.get("at") or 0) < dedupe_s
                    and float(exp.get("at") or 0) > float((prior or {}).get("at") or 0)):
                # the draft the driver means timed out after the last thing that was sent: say so, never "Already sent"
                reasons.append("draft_expired")
                out.update(action="reply", say=EXPIRED_LINE)
                return out, reasons
            if prior is not None:
                reasons.append("already_sent")
                out.update(say=already_sent_line(prior), already=prior)
                return out, reasons
            reasons.append("no_pending_draft")
            out.update(action="reply", say=NOTHING_PENDING_LINE)
            return out, reasons
        want = resolve(dec["target"]) if (resolve is not None and dec.get("target")) else dec.get("target")
        if want and want != pend.get("target") and want != tile:
            # the model names another agent on a confirm: a retarget only if the driver said that agent's name just now;
            # otherwise the model merely echoed an id and the draft keeps the target that was read back
            tokens = names_fn(want) if handoff == "named" else []
            if tokens and named(transcript, tokens):
                reasons.append("retarget_needs_readback")
                propose_from({"target": want, "title": pend["title"], "brief": pend["brief"], "perm": pend["perm"]})
                return out, reasons
            reasons.append("confirm_target_ignored")
        if not send_affirmed(transcript, sess, pend):
            reasons.append("not_affirmed")
            out.update(action="propose", say=readback(pend) + NOT_CONFIRMED_SUFFIX if bare_yes(transcript) or is_question(transcript)
                       else readback(pend))
            return out, reasons
        if sha256(pend.get("body") or "") != pend.get("brief_sha256"):
            reasons.append("draft_changed")
            out.update(action="reply", say=DRAFT_CHANGED_LINE,
                       drop=True)
            return out, reasons
        dup = recent_delegation(sess, now, dedupe_s, sha=pend["brief_sha256"], target=pend.get("target"))
        if dup is not None:
            reasons.append("duplicate_brief")
            out.update(say=already_sent_line(dup), already=dup, drop=True)
            return out, reasons
        out.update(send=pend, say=sending_line(pend))
        return out, reasons
    if action in ("propose", "direct") and pend is None and confirm_only(transcript) and not force_direct(transcript):
        # "send it" with nothing to send is never a new request (a proposal called "Send it") nor a question for the full agent
        reasons.append("no_pending_draft")
        out.update(action="reply", say=NOTHING_PENDING_LINE)
        return out, reasons
    if action == "propose":
        if pend is not None and pend.get("state") == "sending":
            busy()
            return out, reasons
        propose_from(dec, pend)
        return out, reasons
    if action == "cancel":
        if pend is not None and pend.get("state") == "proposed":
            out.update(say=DROPPED_LINE, drop=True)
        elif pend is not None and pend.get("state") == "sending":
            reasons.append("cancel_while_sending")
            out.update(say=SENDING_CANCELLED_LINE, cancel_sending=pend)
        else:
            run = delegation_in_flight(sess, now, dedupe_s)
            if run is not None:
                # the confirmed brief is already published (it goes right after the read-back, not after the phone's
                # grace window): "cancel that" is too late, and the driver is told so, never "nothing was waiting"
                reasons.append("cancel_too_late")
                out.update(say=SENDING_TOO_LATE_LINE.format(target=run.get("target_name") or run.get("target")))
            else:
                out.update(say=NOTHING_TO_CANCEL_LINE)
        return out, reasons
    if action == "end":
        say, hit = filter_sent_claims(out["say"] or END_LINE, about)
        if hit:
            reasons.append("sent_claim_filtered")
        out.update(say=say or END_LINE, close=True, drop=pend is not None and pend.get("state") == "proposed")
        return out, reasons
    if action == "direct":
        return out, reasons
    if action == "tool":
        # a setting the watcher already applied (or refused) before the guard: what is said comes from that outcome, a
        # template, never model prose; a pending draft is untouched
        if not (out["say"] or "").strip():
            out["say"] = "Okay."
        return out, reasons
    # reply
    say, hit = filter_sent_claims(out["say"], about)
    if hit:
        reasons.append("sent_claim_filtered")
    if not say.strip():
        say = DIDNT_CATCH_LINE
        reasons.append("empty_say")
    out.update(action="reply", say=say)
    return out, reasons


# ---------------------------------------------------------------- the agent card (byte-stable)

HOME = Path.home()


def _head(path: Path, chars: int) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:chars].strip()
    except OSError:
        return ""


def _mtime(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def bank_for(repo: str | None, agent: str) -> str:
    b = (repo or agent or "general").strip()
    return "33GOD" if b.lower() in ("33god", "33god-core", "33god-infra") else b


def hindsight_recall(bank: str, timeout_s: float) -> str:
    """A short digest of the agent's memory bank: the newest relevant facts, one per line. '' on any failure."""
    try:
        r = subprocess.run(["hindsight", "memory", "recall", bank, "current priorities, open work, recent decisions",
                            "-o", "json", "-b", "low", "--max-tokens", "800"],
                           capture_output=True, text=True, timeout=timeout_s)
        if r.returncode != 0:
            return ""
        res = json.loads(r.stdout).get("results") or []
    except Exception:  # noqa: BLE001 - the card goes without it
        return ""
    out, total = [], 0
    for x in res:
        t = re.sub(r"\s+", " ", str((x or {}).get("text") or "")).strip()[:300]
        if not t or total + len(t) > 1500:
            continue
        out.append(f"- {t}")
        total += len(t)
    return "\n".join(out)


class CardCache:
    """The agent card: what the fast model may say about the agent and its project. Rebuilt only when an input file
    changed or the recall digest expired, so its bytes stay identical across turns (Hyper caches the prompt prefix)."""

    def __init__(self, registry_path: Path | None = None, profiles_dir: Path | None = None, roster_path: Path | None = None,
                 recall=hindsight_recall, recall_s: float = 0.6, recall_ttl_s: float = 600.0, clock=time.time):
        self.registry_path = registry_path or Path(os.environ.get("MEMO_AGENT_REGISTRY", HOME / ".hermes/agents-registry.yaml"))
        self.profiles_dir = profiles_dir or Path(os.environ.get("MEMO_HERMES_PROFILES", HOME / ".hermes/profiles"))
        self.roster_path = roster_path or Path(os.environ.get("MEMO_PAD_ROSTER", HOME / ".local/share/holocene-auto/pad-roster/roster.json"))
        self.recall, self.recall_s, self.recall_ttl_s, self.clock = recall, recall_s, recall_ttl_s, clock
        self._reg: tuple[int | None, dict] = (None, {})
        self._roster: tuple[int | None, list] = (None, [])
        self._recall: dict[str, tuple[float, str]] = {}
        self._cards: dict[str, tuple[tuple, dict]] = {}
        self._lock = threading.RLock()

    def registry(self) -> dict:
        mt = _mtime(self.registry_path)
        with self._lock:
            if mt is not None and mt == self._reg[0]:
                return self._reg[1]
        try:
            import yaml  # type: ignore
            agents = (yaml.safe_load(self.registry_path.read_text(encoding="utf-8")) or {}).get("agents") or {}
        except Exception:  # noqa: BLE001
            agents = {}
        with self._lock:
            self._reg = (mt, agents if isinstance(agents, dict) else {})
            return self._reg[1]

    def roster(self) -> list[dict]:
        mt = _mtime(self.roster_path)
        with self._lock:
            if mt is not None and mt == self._roster[0]:
                return self._roster[1]
        try:
            rows = json.loads(self.roster_path.read_text(encoding="utf-8")).get("agents") or []
        except Exception:  # noqa: BLE001
            rows = []
        with self._lock:
            self._roster = (mt, [r for r in rows if isinstance(r, dict) and r.get("id")])
            return self._roster[1]

    def row(self, agent: str) -> dict:
        r = self.registry().get(agent)
        return r if isinstance(r, dict) else {}

    def display(self, agent: str) -> str:
        name = str(self.row(agent).get("display_name") or "").split("—")[0].split(" - ")[0].strip()
        return name or agent.replace("-", " ")

    def tokens(self, agent: str) -> list[str]:
        rname = next((str(r.get("name") or "") for r in self.roster() if r.get("id") == agent), "")
        return name_tokens(agent, self.display(agent), rname)

    def resolve(self, raw: str) -> str:
        """A target the model wrote as a display name ("Flume PM") or an id with spaces becomes the roster id; anything else is
        returned as it was (the guard then refuses it as unroutable)."""
        t = (raw or "").strip()
        ids = {r["id"] for r in self.roster()} | set(self.registry())
        if t in ids:
            return t
        slug = norm(t).replace(" ", "-")
        return slug if slug in ids else t

    def __call__(self, agent: str) -> list[str]:  # names_fn for guard(): the tokens that name an agent
        return self.tokens(agent)

    def recall_digest(self, agent: str, allow_call: bool = True) -> tuple[str, bool]:
        bank = bank_for(self.row(agent).get("repo"), agent)
        now = self.clock()
        with self._lock:
            hit = self._recall.get(bank)
        if hit and now - hit[0] < self.recall_ttl_s:
            return hit[1], True
        if not allow_call or self.recall is None:
            return (hit[1], True) if hit else ("", False)
        text = self.recall(bank, self.recall_s) or ""
        with self._lock:
            if text or not hit:
                self._recall[bank] = (now, text)
            else:
                text = hit[1]
        return text, bool(text)

    def roster_text(self) -> str:
        lines = []
        for r in self.roster():
            row = self.row(r["id"])
            lines.append(f"- {r['id']}: {self.display(r['id'])} ({r.get('name') or ''}; repo {row.get('repo') or '-'})")
        return "\n".join(lines[:40])

    def build(self, agent: str, allow_recall: bool = True) -> dict:
        t0 = time.time()
        row = self.row(agent)
        profile = str(row.get("profile_name") or agent)
        soul = self.profiles_dir / profile / "SOUL.md"
        memory = self.profiles_dir / profile / "memories" / "MEMORY.md"
        proj = Path(str(row.get("project_path") or "")) if row.get("project_path") else None
        doc = next((p for p in ((proj / "CLAUDE.md"), (proj / "README.md")) if p.exists()), None) if proj else None
        recall, has_recall = self.recall_digest(agent, allow_call=allow_recall)
        inputs = (agent, _mtime(self.registry_path), _mtime(soul), _mtime(memory), str(doc), _mtime(doc) if doc else None,
                  _mtime(self.roster_path), sha256(recall))
        with self._lock:
            hit = self._cards.get(agent)
            if hit and hit[0] == inputs:
                return {**hit[1], "ms": int((time.time() - t0) * 1000), "cached": True}
        plane = row.get("plane") if isinstance(row.get("plane"), dict) else {}
        parts = [f"AGENT: {self.display(agent)} (id {agent}); repo {row.get('repo') or '-'}; role {row.get('role') or '-'}; "
                 f"project {row.get('project_path') or '-'}; board {plane.get('identifier') or '-'}"]
        s = _head(soul, 1500)
        if s:
            parts.append("SOUL (head):\n" + s)
        mem = _head(memory, 2000)
        if mem:
            parts.append("MEMORY:\n" + mem)
        if doc:
            parts.append(f"PROJECT NOTES ({doc.name}, head):\n" + _head(doc, 2000))
        if recall:
            parts.append("RECALL (hindsight, recent project memory):\n" + recall)
        text = "\n\n".join(parts)
        card = {"agent": agent, "text": text, "sha256": sha256(text), "chars": len(text), "built_at": time.time(),
                "recall": has_recall, "roster": self.roster_text()}
        with self._lock:
            self._cards[agent] = (inputs, card)
        return {**card, "ms": int((time.time() - t0) * 1000), "cached": False}


# ---------------------------------------------------------------- the prompt

SYSTEM_RULES = """You are the fast conversation desk in the driver's car, answering for the agent tile "{name}" (id {agent}). The driver talks to you by voice while driving; what you write in "say" is spoken aloud.

RULES
- Answer in one to three short spoken sentences (at most about 45 words). No markdown, lists, URLs or code.
- A request for a long or detailed answer ("walk me through", "step by step", "in detail") still gets the short version in at most 45 words: the car cannot read out more. Decide quickly; do not deliberate at length.
- Only state facts that are in the AGENT CARD, the DESK STATE or this conversation. You have no live data, and no tools except the desk's own settings listed under TOOLS (when there is such a section). When the driver asks about live state the card does not cover (the board, a ticket's status, a build, logs, files, anything that needs fresh data), set action "direct" so the full agent answers.
- You never do work yourself. When the driver asks for work (investigate, check, fix, write, run, report back), set action "propose" with a self-contained brief: a title of at most eight words, the goal, the context the agent needs (it never sees this conversation) and when it is done. The desk reads the draft back; it is sent only when the driver confirms aloud.
- Never say you sent, started or did anything.
- With a pending draft: the driver confirms it ("send it") -> action "confirm"; drops it -> "cancel"; changes it -> "propose" with the whole updated draft.
- If the transcript looks misheard, ask a short question (action "reply").
- The driver closes the conversation ("that's all", "thanks, bye") -> action "end".
- target: the agent id the work is for, by default "{agent}". Use another ROSTER id only when the driver said that agent's name.
- perm: "read_only" unless the driver asked for code changes ("changes_ok") or a deploy, restart or push ("deploy_ok").

OUTPUT FORMAT
Return one JSON object and nothing else, with the keys say, action, target, title, brief, perm (a TOOLS call instead carries say, action "tool", tool_name and args). Two examples:
{{"say":"Holocene is finishing the fast conversation desk; the watcher stage is next.","action":"reply","target":"{agent}","title":"","brief":null,"perm":"read_only"}}
{{"say":"I can have the PM look into that.","action":"propose","target":"{agent}","title":"Why the audio spool is disabled","brief":{{"goal":"Find out why the audio spool is disabled and report back.","context":["The driver noticed it while driving."],"done_when":["The cause is named and a fix is proposed."]}},"perm":"read_only"}}"""


def tools_block(tools: list[dict]) -> str:
    """The TOOLS section of the system prompt (byte-stable while the tool.json files are): each tool's name, what it
    does and its arguments, plus the one output example for a tool call."""
    if not tools:
        return ""
    lines = ["TOOLS (the desk's own settings; use one only when the driver asks for that change)"]
    first = None
    for t in tools:
        props = ((t.get("parameters") or {}).get("properties") or {})
        args = []
        for k, p in props.items():
            p = p if isinstance(p, dict) else {}
            choice = f" one of {', '.join(map(str, p['enum']))}" if p.get("enum") else ""
            args.append(f"{k}: {p.get('type', 'string')}{choice}")
        lines.append(f"- {t['name']}({'; '.join(args)}): {str(t.get('description') or '').strip()[:300]}")
        if first is None and props:
            k0 = next(iter(props))
            p0 = props[k0] if isinstance(props[k0], dict) else {}
            first = (t["name"], k0, (p0.get("enum") or [p0.get("example") or "walken"])[0])
    lines.append('For a tool call set action "tool", "tool_name" and "args", for example:')
    if first:
        lines.append(json.dumps({"say": "", "action": "tool", "tool_name": first[0], "args": {first[1]: first[2]}},
                                separators=(",", ":")))
    return "\n".join(lines)


def build_messages(*, agent: str, name: str, card: dict, sess: dict | None, transcript: str, board: str = "",
                   recent: str = "", now: float | None = None, window: int = 12, tools: str = "") -> list[dict]:
    """Stable prefix first (rules, card, roster: byte-identical across turns for the provider's prefix cache), then the
    conversation window as user/assistant pairs (append-only), then the volatile desk state and the new transcript."""
    system = (SYSTEM_RULES.format(name=name, agent=agent) + (f"\n\n{tools}" if tools else "")
              + "\n\nAGENT CARD\n" + (card.get("text") or "-")
              + "\n\nROSTER (agents work can be sent to)\n" + (card.get("roster") or "-"))
    msgs = [{"role": "system", "content": system}]
    for t in driver_turns(sess)[-window:]:
        msgs.append({"role": "user", "content": t.get("user") or ""})
        said = t.get("agent_reply") if t.get("action") == "direct" and t.get("agent_reply") else t.get("say")
        msgs.append({"role": "assistant", "content": json.dumps({"say": said or "", "action": t.get("action") or "reply"},
                                                                separators=(",", ":"))})
    now = time.time() if now is None else now
    pend = (sess or {}).get("pending")
    state = [f"Local time {time.strftime('%H:%M', time.localtime(now))}. Turn {len(driver_turns(sess)) + 1} of this conversation."]
    if isinstance(pend, dict) and pend.get("state") in ("proposed", "sending"):
        state.append(f"PENDING DRAFT ({pend['state']}) for {pend.get('target_name')} (target id {pend.get('target')}): {pend.get('title')} "
                     f"[{PERM_TEXT.get(pend.get('perm'), 'Read-only')}]\n{pend.get('body', '')[:1200]}")
    else:
        state.append("PENDING DRAFT: none.")
    state.append("DELEGATION BOARD (work sent from the car in the last 24 h):\n" + (board or "- none"))
    if recent:
        state.append("RECENT VOICE MEMOS to this agent (outside this conversation):\n" + recent)
    msgs.append({"role": "user", "content": "[DESK STATE]\n" + "\n\n".join(state) + "\n\n[THE DRIVER SAID]\n" + transcript})
    return msgs


# ---------------------------------------------------------------- the flag file + settings

class FlagFile:
    """<state>/converse.json, written by `mise run memo:converse`, read per memo (mtime-cached), no restart."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._key: tuple | None = None
        self._doc: dict | None = None

    def read(self) -> dict | None:
        try:
            st = self.path.stat()
        except FileNotFoundError:
            with self._lock:
                self._key, self._doc = None, None
            return None
        except OSError as e:
            return {"mode": "off", "error": f"flag file unreadable: {e}"[:200]}
        key = (st.st_mtime_ns, st.st_size)
        with self._lock:
            if key == self._key:
                return self._doc
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(doc, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as e:
            doc = {"mode": "off", "error": f"flag file invalid: {e}"[:200]}
        with self._lock:
            self._key, self._doc = key, doc
        return doc


@contextlib.contextmanager
def flag_lock(path: Path):
    """An exclusive fcntl lock around a read-modify-write of the flag file: the CLI (memo:converse, memo:voice, memo:model,
    the car-desk skills through it) and the watcher (the desk's phrase short-circuit) all write the same file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(f".{path.name}.lock"), "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read_flag_doc(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_flag_doc(path: Path, doc: dict) -> None:
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_flag(path: Path, drop: tuple = (), **updates) -> dict:
    """Merge updates into the flag file (and remove the `drop` keys), atomically (tmp + rename), under the flag lock.
    Returns the new document. Keys it is not given (tiles, routes) are kept."""
    with flag_lock(path):
        doc = _read_flag_doc(path)
        doc.update({k: v for k, v in updates.items() if v is not None})
        for k in drop:
            doc.pop(k, None)
        _write_flag_doc(path, doc)
        return doc


_UNSET = object()


def update_tile(path: Path, agent: str, *, voice=_UNSET, model=_UNSET, by: str = "cli") -> dict:
    """Set (a string) or clear (None) one tile's car voice and/or desk model alias in the flag file's `tiles` map, under
    the flag lock. Returns the tile's new settings ({} when nothing is left)."""
    if not agent or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", agent):
        raise ValueError(f"bad agent id {agent!r}")
    with flag_lock(path):
        doc = _read_flag_doc(path)
        tiles = doc.get("tiles") if isinstance(doc.get("tiles"), dict) else {}
        tile = dict(tiles.get(agent) or {}) if isinstance(tiles.get(agent), dict) else {}
        for k, v in (("voice", voice), ("model", model)):
            if v is _UNSET:
                continue
            if v is None:
                tile.pop(k, None)
            else:
                tile[k] = str(v)
            tile[f"{k}_set_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            tile[f"{k}_set_by"] = by
        if any(k in tile for k in ("voice", "model")):
            tiles[agent] = tile
        else:
            tiles.pop(agent, None)
        doc["tiles"] = tiles
        _write_flag_doc(path, doc)
        return tiles.get(agent) or {}


# ---------------------------------------------------------------- the model alias table (car_desk_aliases.json)

ALIASES_PATH = Path(__file__).resolve().parent / "car_desk_aliases.json"


def load_aliases(path: Path | None = None) -> dict:
    """The versioned alias table shared by the watcher, memo_trace.py model and the car-set-model skill: {version,
    models: {<alias>: {label, spoken, phrases[], budget_s?, routes[]}}}. {} when it cannot be read."""
    try:
        doc = json.loads(Path(path or ALIASES_PATH).read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) and isinstance(doc.get("models"), dict) else {}
    except (OSError, ValueError):
        return {}


def alias_label(table: dict | None, alias: str | None, spoken: bool = False) -> str:
    e = ((table or {}).get("models") or {}).get(alias or "") or {}
    return str((e.get("spoken") if spoken else None) or e.get("label") or alias or "")


def _route_target(r: dict) -> tuple[str, str]:
    return (r.get("base_url") or "").rstrip("/"), r.get("model") or ""


def merge_ladder(front: list[dict], base: list[dict]) -> list[dict]:
    """The alias's routes in front of the default ladder, every (base_url, model) once. An alias rung that IS a default
    rung keeps the default rung's id (one breaker per upstream); an id clash with another target gets a suffix."""
    by_target = {_route_target(r): r for r in base}
    base_ids = {r["id"] for r in base}
    out: list[dict] = []
    seen_t: set[tuple] = set()
    seen_id: set[str] = set()
    for r in front:
        t = _route_target(r)
        if t in seen_t:
            continue
        r = dict(r)
        if t in by_target:
            r["id"] = by_target[t]["id"]
        else:
            while r["id"] in base_ids or r["id"] in seen_id:
                r["id"] = f"{r['id']}~"  # never borrow a default rung's id (and so its breaker) for another upstream
        seen_t.add(t)
        seen_id.add(r["id"])
        out.append(r)
    out += [r for r in base if _route_target(r) not in seen_t]
    return out


# ---------------------------------------------------------------- the desk's tools (Skillex skills, scope car-desk)

TOOLS_DIR_DEFAULT = Path.home() / ".local/state/holocene-auto/car-desk-scope"
TOOL_TIMEOUT_S = 3.0


def _frontmatter(text: str) -> dict:
    """SKILL.md's YAML frontmatter as a dict ({} without one). PyYAML when present, else the few keys the desk needs."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", text or "", re.S)
    if not m:
        return {}
    try:
        import yaml  # type: ignore
        doc = yaml.safe_load(m.group(1))
        return doc if isinstance(doc, dict) else {}
    except Exception:  # noqa: BLE001 - no PyYAML: read metadata.tool's scalars by hand
        doc: dict = {"metadata": {"tool": {}}}
        for k in ("name", "description"):
            mm = re.search(rf"^{k}:\s*(.+)$", m.group(1), re.M)
            if mm:
                doc[k] = mm.group(1).strip().strip("'\"")
        tool = doc["metadata"]["tool"]
        for k in ("contract", "entrypoint", "effect"):
            mm = re.search(rf"^\s+{k}:\s*(.+)$", m.group(1), re.M)
            if mm:
                tool[k] = mm.group(1).strip().strip("'\"")
        mm = re.search(r"^\s+consumers:\s*\[(.*?)\]", m.group(1), re.M)
        if mm:
            tool["consumers"] = [x.strip().strip("'\"") for x in mm.group(1).split(",") if x.strip()]
        return doc


def _check_args(schema: dict, args) -> str | None:
    """The tool's JSON Schema (the subset tool.json uses: an object of scalar properties, enum, required,
    additionalProperties false, maxLength) against the model's args. None when valid, else why not."""
    if not isinstance(args, dict):
        return "args must be an object"
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    for k in schema.get("required") or []:
        if k not in args:
            return f"missing argument {k!r}"
    if schema.get("additionalProperties") is False:
        extra = [k for k in args if k not in props]
        if extra:
            return f"unknown argument {extra[0]!r}"
    types = {"string": str, "boolean": bool, "integer": int, "number": (int, float)}
    for k, v in args.items():
        p = props.get(k) if isinstance(props.get(k), dict) else {}
        want = types.get(p.get("type", "string"))
        if want and (not isinstance(v, want) or (p.get("type") in ("integer", "number") and isinstance(v, bool))):
            return f"argument {k!r} must be {p.get('type', 'string')}"
        if p.get("enum") and v not in p["enum"]:
            return f"argument {k!r} must be one of {', '.join(map(str, p['enum']))}"
        if isinstance(v, str) and (len(v) > int(p.get("maxLength") or 120) or not v.strip()):
            return f"argument {k!r} is empty or too long"
    return None


class ToolBox:
    """The car desk's tools: each skill under <scope>/.agents/skills/* (a Skillex scope with the car-desk pack enabled)
    whose SKILL.md `metadata.tool.consumers` names `car-desk`, with its tool.json (an OpenAI function object) and its
    entrypoint script. Read at start-up and again whenever the directory, a SKILL.md or a tool.json changes (mtime)."""

    def __init__(self, scope_dir: Path, consumer: str = "car-desk", log=None):
        self.scope_dir = Path(scope_dir)
        self.consumer = consumer
        self.log = log or _log_default
        self._lock = threading.Lock()
        self._key: tuple | None = None
        self._tools: dict[str, dict] = {}
        self.errors: list[str] = []

    @property
    def skills_dir(self) -> Path:
        return self.scope_dir / ".agents" / "skills"

    def _fingerprint(self) -> tuple:
        d = self.skills_dir
        parts = [_mtime(d)]
        try:
            for sk in sorted(d.iterdir()):
                parts += [sk.name, _mtime(sk / "SKILL.md"), _mtime(sk / "tool.json")]
        except OSError:
            pass
        return tuple(parts)

    def tools(self) -> dict[str, dict]:
        key = self._fingerprint()
        with self._lock:
            if key == self._key:
                return self._tools
        tools: dict[str, dict] = {}
        errors: list[str] = []
        try:
            skills = sorted(p for p in self.skills_dir.iterdir() if p.is_dir())
        except OSError:
            skills = []
        for sk in skills:
            try:
                meta = _frontmatter((sk / "SKILL.md").read_text(encoding="utf-8"))
                tool = ((meta.get("metadata") or {}).get("tool") or {}) if isinstance(meta.get("metadata"), dict) else {}
                if not isinstance(tool, dict) or self.consumer not in (tool.get("consumers") or []):
                    continue
                contract = json.loads((sk / str(tool.get("contract") or "tool.json")).read_text(encoding="utf-8"))
                fn = contract.get("function") if contract.get("type") == "function" else contract
                name = str(fn.get("name") or "").strip()
                entry = (sk / str(tool.get("entrypoint") or "")).resolve()
                if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", name):
                    raise ValueError(f"bad tool name {name!r}")
                if not tool.get("entrypoint") or not entry.is_file() or sk.resolve() not in entry.parents:
                    raise ValueError(f"entrypoint {tool.get('entrypoint')!r} is not a file inside the skill")
                params = fn.get("parameters") if isinstance(fn.get("parameters"), dict) else {"type": "object", "properties": {}}
                tools[name] = {"name": name, "description": str(fn.get("description") or ""), "parameters": params,
                               "entrypoint": str(entry), "skill": sk.name, "effect": tool.get("effect"),
                               "dir": str(sk.resolve())}
            except Exception as e:  # noqa: BLE001 - one broken skill never hides the others
                errors.append(f"{sk.name}: {type(e).__name__}: {e}"[:200])
        with self._lock:
            first = self._key is None
            changed = not first and set(tools) != set(self._tools)
            self._key, self._tools, self.errors = key, tools, errors
        if first or changed or errors:
            self.log("converse_tools_loaded", "warn" if errors else "info", dir=str(self.skills_dir),
                     tools=sorted(tools) or None, errors=errors or None)
        return tools

    def listing(self) -> list[dict]:
        return [self.tools()[k] for k in sorted(self.tools())]

    def validate(self, name: str | None, args) -> tuple[dict | None, str | None]:
        t = self.tools().get(name or "")
        if t is None:
            return None, f"no tool called {name!r}"
        why = _check_args(t["parameters"], args if args is not None else {})
        return (t, None) if why is None else (None, why)

    def run(self, name: str, args: dict, agent: str, by: str = "car", timeout: float = TOOL_TIMEOUT_S,
            env: dict | None = None) -> dict:
        """Run the tool's entrypoint (no shell): `<entrypoint> --json --agent <tile> --by <by> --<arg> <value> ...`, stdin
        closed, at most `timeout` seconds. {ok, exit, out (its JSON), error, ms}. Never raises.

        The entrypoint runs in a session (process group) of its own, and a timeout kills the whole group: the skill's own
        child (memo_trace.py voice|model, which does the write) dies with it, so a change the driver is told failed can
        never land a moment later."""
        t0 = time.time()
        t, why = self.validate(name, args)
        if t is None:
            return {"ok": False, "exit": None, "out": None, "error": why, "ms": 0}
        entry = Path(t["entrypoint"])
        argv = ([sys.executable, str(entry)] if entry.suffix == ".py" else [str(entry)])
        argv += ["--json", "--agent", agent, "--by", by]
        for k, v in args.items():
            if isinstance(v, bool):
                argv += [f"--{k}"] if v else []
            else:
                argv += [f"--{k}", str(v)]
        try:
            p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, text=True,
                                 cwd=t["dir"], env={**os.environ, **(env or {})}, start_new_session=True)
        except OSError as e:
            return {"ok": False, "exit": None, "out": None, "error": f"{type(e).__name__}: {e}"[:200],
                    "ms": int((time.time() - t0) * 1000)}
        try:
            stdout, stderr = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                os.killpg(p.pid, signal.SIGKILL)
            with contextlib.suppress(OSError):
                p.kill()
            with contextlib.suppress(Exception):
                p.communicate(timeout=2.0)
            return {"ok": False, "exit": None, "out": None, "error": f"timed out after {timeout:g} s",
                    "ms": int((time.time() - t0) * 1000)}
        out = None
        for line in reversed((stdout or "").strip().splitlines()):
            try:
                out = json.loads(line)
                break
            except ValueError:
                continue
        ok = p.returncode == 0 and isinstance(out, dict) and out.get("ok") is not False
        err = None if ok else (str((out or {}).get("error") or (stderr or "").strip()[-200:] or f"exit {p.returncode}"))[:200]
        return {"ok": ok, "exit": p.returncode, "out": out if isinstance(out, dict) else None, "error": err,
                "ms": int((time.time() - t0) * 1000)}


# ---------------------------------------------------------------- the voices vox has (for the phrase short-circuit)

class VoiceCatalog:
    """vox's voices ([{name, display_name}], GET <vox>/voices, the same list `voxxy voice list --json` prints), cached for
    ttl_s; a failed refresh keeps the last good list."""

    def __init__(self, url: str | None = None, ttl_s: float = 600.0, fetch=None, clock=time.time):
        self.url = (url or os.environ.get("MEMO_VOX_URL", "https://vox.delo.sh")).rstrip("/")
        self.ttl_s, self.clock = ttl_s, clock
        self._fetch = fetch or self._http
        self._at, self._list = 0.0, []
        self._refreshing = False
        self._lock = threading.Lock()

    def _http(self, timeout: float) -> list[dict]:
        import urllib.request
        with urllib.request.urlopen(f"{self.url}/voices", timeout=timeout) as resp:
            data = json.loads(resp.read())
        return data if isinstance(data, list) else (data.get("voices") or [])

    def get(self, timeout: float = 1.5) -> list[dict]:
        """The list. A stale one is returned at once and refreshed in the background (the car never waits on vox for
        it); only an empty cache is fetched in line."""
        with self._lock:
            fresh = self._list and self.clock() - self._at < self.ttl_s
            if fresh:
                return self._list
            stale = list(self._list)
            refreshing = self._refreshing
            if stale and not refreshing:
                self._refreshing = True
        if stale:
            if not refreshing:
                threading.Thread(target=self._refresh, args=(timeout,), name="vox-voices", daemon=True).start()
            return stale
        return self._refresh(timeout)

    def _refresh(self, timeout: float) -> list[dict]:
        try:
            rows = [{"name": str(v.get("name")), "display_name": str(v.get("display_name") or "")}
                    for v in self._fetch(timeout) if isinstance(v, dict) and v.get("name")]
        except Exception:  # noqa: BLE001
            rows = []
        with self._lock:
            self._refreshing = False
            if rows:
                self._at, self._list = self.clock(), rows
            return self._list

    def names(self) -> list[str]:
        return [v["name"] for v in self.get()]


class Desk:
    """Everything the watcher's converse stage needs, configured from the environment (the unit's defaults) and the flag
    file (runtime switch, wins over the environment)."""

    def __init__(self, state_dir: Path, env=None, keys: KeyCache | None = None, http_: Http | None = None,
                 cards: CardCache | None = None, log=None, clock=time.time, tools: ToolBox | None = None,
                 voices: VoiceCatalog | None = None, aliases_path: Path | None = None):
        env = os.environ if env is None else env
        self.env = env
        self.log = log or _log_default
        self.clock = clock
        self.flag = FlagFile(Path(state_dir) / "converse.json")
        self.keys = keys or KeyCache()
        self.breaker = Breaker()
        self.http = http_ or Http()
        self.cards = cards or CardCache()
        self.budget_s = _env_float(env, "MEMO_CONVERSE_BUDGET_S", 8.0)
        self.reask_min_s = _env_float(env, "MEMO_CONVERSE_REASK_MIN_S", REASK_MIN_S)
        self.idle_s = _env_float(env, "MEMO_CONVERSE_IDLE_S", 900.0)
        self.draft_ttl_s = _env_float(env, "MEMO_CONVERSE_DRAFT_TTL_S", 600.0)
        self.dedupe_s = _env_float(env, "MEMO_CONVERSE_DEDUPE_S", 1800.0)
        self.max_audio_s = _env_float(env, "MEMO_CONVERSE_MAX_AUDIO_S", 90.0)
        self.max_input_chars = _env_int(env, "MEMO_CONVERSE_MAX_INPUT_CHARS", 4000)
        self.window = _env_int(env, "MEMO_CONVERSE_WINDOW", 12)
        self.scoped_refs = scoped_key_refs(env)
        self.tools = tools or ToolBox(Path(env.get("MEMO_CONVERSE_TOOLS_DIR") or TOOLS_DIR_DEFAULT), log=self.log)
        self.voices = voices or VoiceCatalog(env.get("MEMO_VOX_URL"))
        self.aliases_path = Path(aliases_path or env.get("MEMO_CONVERSE_ALIASES") or ALIASES_PATH)
        self._aliases: tuple[int | None, dict] = (None, {})
        self._routes: dict[str, tuple[list[dict], list[dict]]] = {}
        self._warned: set[str] = set()
        # scope proofs of the router rungs' tokens: (key_ref, base_url) -> {ok, at, anthropic, ids, error}
        self._proofs: dict[tuple, dict] = {}
        self._proving: set[tuple] = set()
        self._proof_lock = threading.Lock()

    # -- settings

    def env_mode(self) -> tuple[str, str | None]:
        raw = str(self.env.get("MEMO_CONVERSE", "off") or "off").strip().lower()
        if raw in MODES:
            return raw, None
        return "off", f"MEMO_CONVERSE={raw!r} is not off|shadow|on: converse is off"

    def settings(self) -> dict:
        mode, err = self.env_mode()
        agents = _list(self.env.get("MEMO_CONVERSE_AGENTS", ""))
        devices = _list(self.env.get("MEMO_CONVERSE_DEVICES", ""))
        handoff = str(self.env.get("MEMO_CONVERSE_HANDOFF", "named") or "named").strip().lower()
        routes_raw = self.env.get("MEMO_CONVERSE_ROUTES", "")
        source = "env"
        flag = self.flag.read()
        if flag is not None:
            source = "flag"
            fm = str(flag.get("mode") or "off").strip().lower()
            if flag.get("error") or ("mode" not in flag and not flag.get("tiles") and not flag.get("routes")):
                mode, err = "off", flag.get("error") or "flag file without a mode: converse is off"
            elif "mode" not in flag:
                source = "env+flag"  # a file that only carries tile settings (memo:voice / memo:model): the env's mode
            elif fm in MODES:
                mode, err = fm, None
            else:
                mode, err = "off", f"flag mode {fm!r} is not off|shadow|on: converse is off"
            if "agents" in flag:
                agents = _list(flag["agents"])
            if "devices" in flag:
                devices = _list(flag["devices"])
            if flag.get("handoff"):
                handoff = str(flag["handoff"]).strip().lower()
            if flag.get("routes"):
                routes_raw = flag["routes"] if isinstance(flag["routes"], str) else json.dumps(flag["routes"])
        if handoff not in HANDOFF_MODES:
            handoff = "off"
        routes, refused = self.routes(routes_raw)
        if mode != "off" and not routes:
            err = err or "no usable route: converse is off"
            mode = "off"
        if err and err not in self._warned:
            self._warned.add(err)
            self.log("converse_config", "warn", error=err)
        tiles = flag.get("tiles") if isinstance(flag, dict) and isinstance(flag.get("tiles"), dict) else {}
        return {"mode": mode, "source": source, "agents": agents, "devices": devices, "handoff": handoff,
                "routes": routes, "refused": refused, "error": err,
                "tiles": {a: t for a, t in tiles.items() if isinstance(t, dict)}}

    def routes(self, raw) -> tuple[list[dict], list[dict]]:
        k = raw if isinstance(raw, str) else json.dumps(raw)
        if k not in self._routes:
            try:
                routes, refused = parse_routes(raw, self.scoped_refs)
            except Exception as e:  # noqa: BLE001 - a malformed route list turns the desk off, never the watcher
                routes, refused = [], [{"id": None, "model": None, "reason": f"routes unusable: {type(e).__name__}: {e}"[:200]}]
            for r in refused:
                self.log("converse_route_refused", "warn", route=r.get("id"), model=r.get("model"), reason=r["reason"])
            self._routes[k] = (routes, refused)
        return self._routes[k]

    # -- per tile: the car voice and the desk model (flag file `tiles`, car_desk_aliases.json)

    def aliases(self) -> dict:
        """The alias table, re-read when the file changes."""
        mt = _mtime(self.aliases_path)
        if mt is not None and mt == self._aliases[0]:
            return self._aliases[1]
        table = load_aliases(self.aliases_path)
        self._aliases = (mt, table)
        return table

    def tile(self, agent: str | None, s: dict | None = None) -> dict:
        tiles = (s or {}).get("tiles") if s is not None else (self.flag.read() or {}).get("tiles")
        t = (tiles or {}).get(agent or "") if isinstance(tiles, dict) else None
        return t if isinstance(t, dict) else {}

    def voice_for(self, agent: str | None, default: str) -> str:
        """The car reply voice of this tile: its own (memo:voice, the car-set-voice skill, "use walken voice"), else the
        watcher's default (MEMO_VOX_VOICE)."""
        v = self.tile(agent).get("voice")
        return v if isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", v) else default

    def routes_for(self, s: dict, agent: str | None) -> tuple[list[dict], dict]:
        """The ladder for this tile: its model alias's routes (car_desk_aliases.json) in front of the default ladder,
        deduplicated; the default ladder alone without an alias. (routes, info {model, label, budget_s, error})."""
        alias = self.tile(agent, s).get("model")
        if not alias:
            return s["routes"], {"model": None}
        entry = (self.aliases().get("models") or {}).get(alias)
        if not isinstance(entry, dict):
            return s["routes"], {"model": alias, "error": "unknown alias: the default ladder"}
        front, _ = self.routes(entry.get("routes") or [])
        info = {"model": alias, "label": entry.get("label") or alias}
        try:
            if entry.get("budget_s"):
                info["budget_s"] = max(self.budget_s, float(entry["budget_s"]))
        except (TypeError, ValueError):
            pass
        return merge_ladder(front, s["routes"]), info

    def setting_phrase(self, transcript: str) -> dict | None:
        """The deterministic voice / model switch ("use walken voice", "switch to deepseek pro"), or None."""
        if not re.search(r"\b(?:voice|model|brain|use|switch|change|set|try|go|think|reset|clear)\b", norm(transcript)):
            return None  # no setting verb at all: never fetch the voice list for an ordinary question
        return setting_phrase(transcript, self.voices.get(), self.aliases())

    # -- scope proofs (a router rung is used only while its token is proven Claude-free)

    PROOF_TTL_S = 1800.0
    PROOF_REFRESH_S = 600.0
    PROOF_RETRY_S = 60.0

    def prove_scope(self, r: dict) -> dict:
        """GET <base>/models with the rung's token: the token's scope as the gateway sees it. Proven when it lists models
        and none of them is Anthropic (the auto family itself is expected in an auto-scoped token's listing)."""
        k = (r["key_ref"], r["base_url"])
        now = self.clock()
        res: dict = {"ok": False, "checked_at": now}
        key = self.keys.get(r["key_ref"])
        if key is None:
            res["error"] = "key unreadable"
        else:
            status, raw, err = self.http.get_json(f"{r['base_url']}/models", {"Authorization": f"Bearer {key}"} if key else {}, 8.0)
            try:
                ids = [x.get("id") for x in (json.loads(raw.decode("utf-8", "replace")).get("data") or [])
                       if isinstance(x, dict)] if status == 200 else []
            except (ValueError, AttributeError):
                ids = []
            bad = [i for i in ids if not isinstance(i, str) or ANTHROPIC_RE.search(i) or not i.isascii()]
            res.update(ids=len(ids), anthropic=bad[:5] or None, http_status=status, error=err)
            if status == 200 and ids and not bad:
                # the listed names, canonical: a router answer is used only when the route it names is one of them
                res.update(ok=True, at=now, scope_ids=frozenset(_clean_name(i) for i in ids))
            elif not res.get("error"):
                res["error"] = "an Anthropic route is in the token's scope" if bad else f"/models answered {status}"
        with self._proof_lock:
            prev = self._proofs.get(k) or {}
            if not res["ok"] and not res.get("anthropic") and prev.get("ok"):
                # a failed re-check keeps the proof (and its listing) until it expires
                res.update(ok=True, at=prev["at"], stale_error=res.get("error"), scope_ids=prev.get("scope_ids"))
            self._proofs[k] = res
            self._proving.discard(k)
        if not res["ok"] or res.get("anthropic"):
            self.log("converse_scope_unproven", "warn", key_ref=ref_label(r["key_ref"]), base=r["host"],
                     error=res.get("error"), anthropic=res.get("anthropic"))
        return res

    def _prove_later(self, r: dict) -> None:
        k = (r["key_ref"], r["base_url"])
        with self._proof_lock:
            if k in self._proving:
                return
            self._proving.add(k)

        def run():
            try:
                self.prove_scope(r)
            except Exception as e:  # noqa: BLE001
                with self._proof_lock:
                    self._proving.discard(k)
                self.log("converse_scope_proof_failed", "warn", error=f"{type(e).__name__}: {e}"[:200])
        threading.Thread(target=run, name="converse-scope-proof", daemon=True).start()

    def scope_gate(self, r: dict) -> str | None:
        """The ladder's gate: None for an ordinary rung and for a router rung with a fresh proof; else the outcome the
        rung is skipped with (scope_unsafe: an Anthropic route is in the scope; scope_unproven: no proof yet)."""
        if not r.get("scoped_auto"):
            return None
        k = (r["key_ref"], r["base_url"])
        now = self.clock()
        with self._proof_lock:
            p = dict(self._proofs.get(k) or {})
        if p.get("anthropic"):
            if now - float(p.get("checked_at") or 0) > self.PROOF_RETRY_S:
                self._prove_later(r)
            return "scope_unsafe"
        if p.get("ok") and now - float(p.get("at") or 0) < self.PROOF_TTL_S:
            if now - float(p.get("checked_at") or 0) > self.PROOF_REFRESH_S:
                self._prove_later(r)
            return None
        if not p or now - float(p.get("checked_at") or 0) > self.PROOF_RETRY_S:
            self._prove_later(r)
        return "scope_unproven"

    def served_in_scope(self, r: dict, served: str | None) -> bool:
        """The ladder's served-route check for a router rung: the route the gateway says answered (X-AutomaticAI-Route) is
        one the token's proven scope listing names. auto/fast is intersected with the scope by the gateway itself;
        automaticai/free is not (the gateway checks only that the free family is in scope, then picks from its whole free
        policy), so for free this is what keeps every answer the desk uses inside the Claude-free scope."""
        if not served:
            return False
        with self._proof_lock:
            ids = (self._proofs.get((r["key_ref"], r["base_url"])) or {}).get("scope_ids")
        return bool(ids) and _clean_name(served) in ids

    def all_routes(self, s: dict | None = None) -> list[dict]:
        """Every route the desk may call: the default ladder and every alias's routes."""
        s = s or self.settings()
        out = list(s["routes"])
        for e in (self.aliases().get("models") or {}).values():
            if isinstance(e, dict):
                out += self.routes(e.get("routes") or [])[0]
        return out

    @staticmethod
    def agent_allowed(s: dict, agent: str | None) -> bool:
        return bool(agent) and (s["agents"] == "*" or agent in (s["agents"] or []))

    def wants(self, agent: str | None) -> bool:
        """Cheap: may a memo for this agent take the converse (or shadow) path at all right now?"""
        try:
            s = self.settings()
        except Exception as e:  # noqa: BLE001 - a broken desk config is today's path
            self.log("converse_config_error", "warn", error=f"{type(e).__name__}: {e}"[:200])
            return False
        return s["mode"] != "off" and self.agent_allowed(s, agent)

    def usable_routes(self, s: dict, agent: str | None = None) -> list[dict]:
        routes = self.routes_for(s, agent)[0] if agent else s["routes"]
        return [r for r in routes if self.keys.status(r["key_ref"]) != "unreadable"]

    def ineligible(self, s: dict, agent: str | None, sender: dict | None, audio_s, transcript: str,
                   dispatched: bool) -> str | None:
        """Why this memo takes today's path instead of the desk, or None. Never an LLM call."""
        if s["mode"] == "off":
            return "converse_off"
        if not self.agent_allowed(s, agent):
            return "agent_not_allowed"
        if dispatched:
            return "already_dispatched"
        host = (sender or {}).get("host")
        if host != "car":
            return f"host_{host or 'unknown'}"
        if s["devices"] != "*" and s["devices"] and (sender or {}).get("device") not in s["devices"]:
            return "device_not_allowed"
        if isinstance(audio_s, (int, float)) and audio_s > self.max_audio_s:
            return "audio_too_long"
        if len(transcript or "") > self.max_input_chars:
            return "input_too_long"
        if not self.usable_routes(s, agent):
            return "key_unreadable"
        return None

    # -- deciding

    def ladder(self, s: dict, agent: str | None = None) -> Ladder:
        routes, info = self.routes_for(s, agent) if agent else (s["routes"], {})
        return Ladder(routes, self.keys, self.breaker, self.http, info.get("budget_s") or self.budget_s, log=self.log,
                      gate=self.scope_gate, served_ok=self.served_in_scope, reask_min_s=self.reask_min_s)

    def decide(self, s: dict, *, agent: str, name: str, transcript: str, sess: dict | None, card: dict, board: str = "",
               recent: str = "", now: float | None = None) -> dict:
        """The raw decision for one turn: {decision, path, llm, lexicon}. A lexicon match makes no LLM call. Never raises
        for an LLM reason: a failed ladder is action=direct with fallback_reason."""
        now = self.clock() if now is None else now
        pend = pending_draft(sess, now, self.draft_ttl_s)
        lex = None
        exp = (sess or {}).get("expired")
        tile = self.tile(agent, s)
        if confirm_only(transcript) and (pend is not None or recent_delegation(sess, now, self.dedupe_s)
                                         or (isinstance(exp, dict) and now - float(exp.get("at") or 0) < self.dedupe_s)):
            lex = ("confirm_only", {"action": "confirm"})
        elif bare_yes(transcript) and pend is not None and readback_just_heard(sess, pend):
            lex = ("confirm_only", {"action": "confirm"})  # "yes" right after the read-back
        elif cancel_only(transcript) and (pend is not None or delegation_in_flight(sess, now, self.dedupe_s) is not None):
            lex = ("cancel_only", {"action": "cancel"})  # with a brief already on its way: answered "too late", no LLM
        elif end_only(transcript):
            lex = ("end_only", {"action": "end", "say": END_LINE})
        elif force_direct(transcript):
            lex = ("force_direct", {"action": "direct"})
        else:
            hit = self.setting_phrase(transcript)
            if hit is not None:
                lex = ("setting_phrase", {"action": "tool", **hit})
        if lex is not None:
            return {"decision": normalize_decision(lex[1]), "path": lex[0], "lexicon": True, "llm": None,
                    "forced_by": force_direct(transcript) if lex[0] == "force_direct" else None,
                    "tile_model": tile.get("model"), "tile_voice": tile.get("voice")}
        msgs = build_messages(agent=agent, name=name, card=card, sess=sess, transcript=transcript, board=board,
                              recent=recent, now=now, window=self.window, tools=tools_block(self.tools.listing()))
        res = self.ladder(s, agent).call(msgs)
        if not res.get("ok"):
            return {"decision": normalize_decision({"action": "direct"}), "path": "fallback", "lexicon": False,
                    "llm": res, "fallback_reason": res.get("fallback_reason"),
                    "tile_model": tile.get("model"), "tile_voice": tile.get("voice")}
        return {"decision": res["decision"], "path": "fast", "lexicon": False, "llm": res,
                "prompt_chars": sum(len(m["content"]) for m in msgs),
                "tile_model": tile.get("model"), "tile_voice": tile.get("voice")}

    # -- the tool action (car-desk skills): validated, run, spoken from a template

    def run_tool(self, agent: str, tile_name: str, name: str | None, args, by: str = "car") -> dict:
        """Validate a tool call against the loaded tool.json contracts and run the skill's entrypoint (no shell, at most
        TOOL_TIMEOUT_S). {ok, tool, args, via, exit, ms, error, out, say}: `say` is what the driver hears, from a template
        (the new voice / model by its spoken name), never from the model. A setting tool the scope does not offer (the
        scope dir missing) is applied in process through the same locked writer (via=builtin)."""
        args = args if isinstance(args, dict) else {}
        loaded = self.tools.tools()
        res: dict = {"tool": name, "args": args, "via": "skill"}
        if name in loaded:
            # the skill writes through this watcher's own verb, into this desk's flag file and alias table
            r = self.tools.run(name, args, agent, by=by, env={
                "MEMO_STATE_DIR": str(self.flag.path.parent), "MEMO_CONVERSE_ALIASES": str(self.aliases_path),
                "HOLOCENE_CAR_DESK_ALIASES": str(self.aliases_path),
                "HOLOCENE_MEMO_TRACE": str(Path(__file__).resolve().parent / "memo_trace.py")})
        elif name in (TOOL_VOICE, TOOL_MODEL) and not _check_args(BUILTIN_SCHEMAS[name], args):
            res["via"] = "builtin"
            r = self._builtin_tool(agent, name, args, by)
        else:
            why = self.tools.validate(name, args)[1] if loaded else "no tools are loaded"
            r = {"ok": False, "exit": None, "out": None, "error": why, "ms": 0}
        res.update(ok=r["ok"], exit=r.get("exit"), ms=r.get("ms"), error=r.get("error"), out=r.get("out"))
        res["say"] = self.tool_say(tile_name, name, args, r)
        self.log("converse_tool", "info" if r["ok"] else "warn", agent=agent, tool=name, args=args, via=res["via"],
                 ok=r["ok"], exit=r.get("exit"), ms=r.get("ms"), error=r.get("error"))
        return res

    def _builtin_tool(self, agent: str, name: str, args: dict, by: str) -> dict:
        t0 = time.time()
        path = self.flag.path
        try:
            if name == TOOL_VOICE:
                v = resolve_voice(args["voice"], self.voices.get())
                if v is None:
                    return {"ok": False, "exit": 3, "out": None, "error": f"no voice called {args['voice']!r}", "ms": 0}
                # the watcher's default voice by name ("use rick voice") clears the tile, like "default voice"
                clear = v in ("default", str(self.env.get("MEMO_VOX_VOICE") or "rick"))
                tile = update_tile(path, agent, voice=None if clear else v, by=by)
                out = {"ok": True, "agent": agent, "voice": tile.get("voice"), "cleared": clear}
            else:
                a = resolve_alias(args["model"], self.aliases())
                if a is None:
                    return {"ok": False, "exit": 3, "out": None, "error": f"no model called {args['model']!r}", "ms": 0}
                tile = update_tile(path, agent, model=None if a == "default" else a, by=by)
                out = {"ok": True, "agent": agent, "model": tile.get("model"), "cleared": a == "default"}
        except (OSError, ValueError) as e:
            return {"ok": False, "exit": 1, "out": None, "error": f"{type(e).__name__}: {e}"[:200], "ms": 0}
        return {"ok": True, "exit": 0, "out": out, "error": None, "ms": int((time.time() - t0) * 1000)}

    def tool_say(self, tile_name: str, name: str | None, args: dict, r: dict) -> str:
        """The spoken outcome of a tool call (a template)."""
        out = r.get("out") or {}
        if not r.get("ok"):
            what = {TOOL_VOICE: "the voice", TOOL_MODEL: "the model"}.get(name or "", "that")
            why = re.sub(r"\s+", " ", str(out.get("error") or r.get("error") or "")).strip().rstrip(".")
            why = why if why and len(why) <= 120 and "/" not in why and "Error" not in why else "it didn't go through"
            return f"I couldn't change {what}: {why}."
        if name == TOOL_VOICE:
            if out.get("cleared") or not out.get("voice"):
                return f"{tile_name} is back to the default voice."
            return f"Switched {tile_name} to {voice_spoken(str(out['voice']))}."
        if name == TOOL_MODEL:
            if out.get("cleared") or not out.get("model"):
                return f"{tile_name} is back on the default model."
            return f"{tile_name} now thinks with {alias_label(self.aliases(), out['model'], spoken=True)}."
        say = re.sub(r"\s+", " ", str(out.get("say") or "")).strip()
        return say[:200] if say else "Done."

    # -- operator surfaces

    def warm_keys(self) -> None:
        """Read every configured key once, off the critical path (start-up): the heartbeat then says ok or unreadable.
        Then prove the router rungs' token scopes, load the tools and the voice list."""
        s = self.settings()
        routes = self.all_routes(s)
        for r in routes:
            self.keys.get(r["key_ref"])
        done: set[tuple] = set()
        for r in routes:
            if r.get("scoped_auto") and (r["key_ref"], r["base_url"]) not in done:
                done.add((r["key_ref"], r["base_url"]))
                try:
                    self.prove_scope(r)
                except Exception as e:  # noqa: BLE001
                    self.log("converse_scope_proof_failed", "warn", error=f"{type(e).__name__}: {e}"[:200])
        self.tools.tools()
        self.voices.get(timeout=5.0)

    def _route_row(self, r: dict) -> dict:
        st = self.keys.status(r["key_ref"])
        until = self.breaker.open_until(r["id"])
        row = {"id": r["id"], "model": r["model"], "host": r["host"], "key": st, "timeout_s": r["timeout_s"],
               "fails_2m": self.breaker.recent_fails(r["id"]),
               "breaker_open_until": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until)) if until else None}
        if r.get("scoped_auto"):
            with self._proof_lock:
                p = self._proofs.get((r["key_ref"], r["base_url"])) or {}
            row["scope_proof"] = ("unsafe" if p.get("anthropic") else "ok" if p.get("ok") else "unproven")
            row["scope_checked_at"] = (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(p["checked_at"]))
                                       if p.get("checked_at") else None)
        return row

    def heartbeat(self, open_conversations: int = 0, contract: dict | None = None, default_voice: str | None = None) -> dict:
        s = self.settings()
        keys = {}
        routes = []
        for r in s["routes"]:
            row = self._route_row(r)
            keys[r["id"]] = row["key"]
            routes.append(row)
        for r in self.all_routes(s) if s["mode"] != "off" else []:
            if r.get("scoped_auto"):
                self.scope_gate(r)  # a stale proof is refreshed in the background, off the critical path
        vals = set(keys.values()) - {"none"}
        agg = ("no_routes" if not s["routes"] else "ok" if vals <= {"ok"} else "unreadable" if vals == {"unreadable"}
               else "unread" if vals == {"unread"} else "partial")
        table = self.aliases()
        tiles = {}
        for agent, t in sorted((s.get("tiles") or {}).items()):
            lad, info = self.routes_for(s, agent)
            tiles[agent] = {"voice": t.get("voice") or default_voice, "voice_own": bool(t.get("voice")),
                            "model": t.get("model"), "model_label": info.get("label"), "model_error": info.get("error"),
                            "ladder": [r["id"] for r in lad], "budget_s": info.get("budget_s") or self.budget_s,
                            "extra_routes": [self._route_row(r) for r in lad if r["id"] not in keys]}
        tools = self.tools.listing()
        return {"mode": s["mode"], "source": s["source"], "agents": s["agents"], "devices": s["devices"],
                "handoff": s["handoff"], "error": s["error"], "open_conversations": open_conversations,
                "routes": routes, "refused": s["refused"], "key_status": agg, "keys": keys, "contract": contract,
                "budget_s": self.budget_s, "default_voice": default_voice, "tiles": tiles,
                "aliases": {"version": table.get("version"), "models": sorted((table.get("models") or {}))},
                "tools": {"dir": str(self.tools.skills_dir), "loaded": [t["name"] for t in tools],
                          "skills": [t["skill"] for t in tools], "errors": self.tools.errors or None},
                "voices": len(self.voices._list)}


def snapshot(obj):
    """A deep copy for work outside the watcher lock."""
    return copy.deepcopy(obj)

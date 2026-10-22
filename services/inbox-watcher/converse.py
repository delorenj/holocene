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

THE NEVER-ANTHROPIC RULE: no rung may name Claude, Anthropic, Sonnet, Opus, Haiku, Fable or automaticai/auto. A configured
route that matches FORBIDDEN_MODEL_RE is refused when the routes are parsed, and an answer whose `model` field matches is
thrown away and counted as a failure of that rung.

Keys never live in a file: a route carries an op:// reference, read with `op read` on first use and kept in memory only.
Stdlib only.
"""

from __future__ import annotations

import copy
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse
import uuid
from pathlib import Path

# ---------------------------------------------------------------- the never-Anthropic rule

FORBIDDEN_MODEL_RE = re.compile(r"(claude|anthropic|sonnet|opus|haiku|fable|^automaticai/auto(/|$))", re.IGNORECASE)


def forbidden(name) -> bool:
    """True for any model, route id or host that names an Anthropic model or the automaticai/auto pool."""
    return isinstance(name, str) and bool(FORBIDDEN_MODEL_RE.search(name.strip()))


MODES = ("off", "shadow", "on")
HANDOFF_MODES = ("named", "off")
ACTIONS = ("reply", "propose", "confirm", "cancel", "direct", "end")
FAST_ACTIONS = ("reply", "propose", "confirm", "cancel", "end")
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

def parse_routes(raw) -> tuple[list[dict], list[dict]]:
    """(usable routes, refused [{id, model, reason}]) from MEMO_CONVERSE_ROUTES (a JSON list, or the list itself).

    A route: {id, base_url, key_ref (op://...), model, timeout_s, temperature, reasoning_effort, max_tokens}. Refused:
    a forbidden model, id or host (the never-Anthropic rule), a key_ref that is not an op:// reference (a pasted key is a
    plaintext credential), no model, a base_url that is not http(s). Order is the ladder order."""
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
        model = str(r.get("model") or "").strip()
        base = str(r.get("base_url") or "").strip().rstrip("/")
        ref = str(r.get("key_ref") or "").strip()
        host = urllib.parse.urlsplit(base).hostname or ""
        netloc = urllib.parse.urlsplit(base).netloc
        why = None
        if not model:
            why = "no model"
        elif forbidden(model) or forbidden(rid) or forbidden(host):
            why = "forbidden_model: the never-Anthropic rule (claude|anthropic|sonnet|opus|haiku|fable|automaticai/auto)"
        elif not base.startswith(("https://", "http://")) or not host:
            why = f"base_url {base!r} is not http(s)"
        elif ref and not ref.startswith("op://"):
            why = "key_ref must be an op:// reference (never a key)"
        elif rid in seen:
            why = f"duplicate route id {rid!r}"
        if why:
            refused.append({"id": rid, "model": model or None, "reason": why})
            continue
        seen.add(rid)
        effort = r.get("reasoning_effort")
        out.append({
            "id": rid, "base_url": base, "host": netloc, "key_ref": ref, "model": model,
            "timeout_s": max(0.5, float(r.get("timeout_s") or 4)),
            "temperature": float(r["temperature"]) if r.get("temperature") is not None else 0.3,
            "reasoning_effort": str(effort).strip().lower() if effort else None,
            "max_tokens": int(r.get("max_tokens") or 700),
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

    def get(self, ref: str) -> str | None:
        if not ref:
            return ""  # a route with no key (a local endpoint): no Authorization header
        with self._lock:
            if ref in self._vals:
                return self._vals[ref]
            bad = self._bad.get(ref)
            if bad and bad[0] > self._clock():
                return None
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
            if ref in self._bad:
                return "unreadable"
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

    def post_json(self, url: str, body: dict, headers: dict, timeout: float) -> tuple[int | None, bytes, str | None]:
        """(status, raw body, error). error is 'timeout' | 'connect: ...' | None."""
        u = urllib.parse.urlsplit(url)
        k = (u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80))
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        payload = json.dumps(body).encode()
        hdrs = {"Content-Type": "application/json", "Accept": "application/json", "Connection": "keep-alive",
                "Content-Length": str(len(payload)), **headers}
        deadline = time.monotonic() + timeout
        for attempt in (1, 2):
            left = deadline - time.monotonic()
            if left <= 0.05:
                return None, b"", "timeout"
            conn, reused = self._take(k, left)
            try:
                conn.request("POST", path, body=payload, headers=hdrs)
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
    return {
        "say": re.sub(r"\s+", " ", str(obj.get("say") or "")).strip()[:600],
        "action": action,
        "target": str(target).strip() if isinstance(target, str) and target.strip() else None,
        "title": title,
        "brief": {"goal": goal, "context": _strs(brief.get("context")), "done_when": _strs(brief.get("done_when"))},
        "perm": perm,
    }


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

class Ladder:
    """Try the rungs in order inside one total budget. Every rung's outcome is recorded; the first usable decision wins.

    A rung is skipped while its breaker is open, while its key is unreadable, and after an earlier rung on the same host
    timed out or could not connect in this call (the same host is down). A 401 re-reads the key once. A forbidden
    `model` in the answer throws it away (never-Anthropic). Never raises for an LLM reason."""

    def __init__(self, routes: list[dict], keys: KeyCache, breaker: Breaker, http_: Http | None = None,
                 budget_s: float = 8.0, clock=time.monotonic, log=None):
        self.routes, self.keys, self.breaker = routes, keys, breaker
        self.http = http_ or Http()
        self.budget_s, self.clock, self.log = budget_s, clock, log or _log_default

    def call(self, messages: list[dict]) -> dict:
        t0 = self.clock()
        attempts: list[dict] = []
        dead_hosts: set[str] = set()
        if not self.routes:
            return {"ok": False, "attempts": attempts, "fallback_reason": "no_routes", "latency_ms": 0}
        reason = "all_routes_failed"
        for r in self.routes:
            left = self.budget_s - (self.clock() - t0)
            if left < 0.3:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "budget_exhausted", "ms": 0})
                reason = "budget_exhausted"
                break
            if self.breaker.is_open(r["id"]):
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "breaker_open", "ms": 0})
                continue
            if r["host"] in dead_hosts:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "host_down", "ms": 0})
                continue
            key = self.keys.get(r["key_ref"])
            if key is None:
                attempts.append({"route": r["id"], "model": r["model"], "outcome": "key_unreadable", "ms": 0})
                continue
            res = self._one(r, key, messages, min(r["timeout_s"], left))
            attempts.append(res["attempt"])
            if res.get("decision") is not None:
                self.breaker.ok(r["id"])
                return {"ok": True, "decision": res["decision"], "model": res["model"], "route": r["id"],
                        "requested_model": r["model"], "attempts": attempts, "usage": res.get("usage"),
                        "cached_tokens": res.get("cached_tokens"),
                        "latency_ms": int((self.clock() - t0) * 1000), "fallback_reason": None}
            opened = self.breaker.fail(r["id"])
            if res["attempt"].get("http_status") == 402:
                self.breaker.trip(r["id"], BILLING_OPEN_S)
                opened = True
            self.log("converse_attempt_failed", "warn", route=r["id"], model=r["model"], outcome=res["attempt"]["outcome"],
                     ms=res["attempt"]["ms"], http_status=res["attempt"].get("http_status"),
                     breaker_opened=opened or None)
            if res["attempt"]["outcome"] in ("timeout",) or res["attempt"]["outcome"].startswith("connect"):
                dead_hosts.add(r["host"])
        if attempts and all(a["outcome"] == "key_unreadable" for a in attempts):
            reason = "key_unreadable"
        return {"ok": False, "attempts": attempts, "fallback_reason": reason, "latency_ms": int((self.clock() - t0) * 1000)}

    def _one(self, r: dict, key: str, messages: list[dict], timeout: float) -> dict:
        body = {"model": r["model"], "messages": messages, "response_format": {"type": "json_object"},
                "temperature": r["temperature"], "max_tokens": r["max_tokens"], "stream": False}
        if r.get("reasoning_effort"):
            body["reasoning_effort"] = r["reasoning_effort"]
        t0 = self.clock()

        def post(k: str):
            hdrs = {"Authorization": f"Bearer {k}"} if k else {}
            return self.http.post_json(f"{r['base_url']}/chat/completions", body, hdrs, max(0.1, timeout - (self.clock() - t0)))

        status, raw, err = post(key)
        if status == 401 and r["key_ref"]:
            self.keys.invalidate(r["key_ref"])  # rotated: read it once more
            key2 = self.keys.get(r["key_ref"])
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
        model = (data.get("model") if isinstance(data, dict) else None) or None
        if forbidden(model):
            # the never-Anthropic rule: an answer from a forbidden model is never used, whatever it says
            return {"attempt": {**att, "outcome": "forbidden_model", "answered_model": model, "http_status": status}}
        try:
            content = data["choices"][0]["message"].get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError):
            content = ""
        if not content.strip():
            return {"attempt": {**att, "outcome": "empty", "answered_model": model, "http_status": status}}
        try:
            decision = parse_decision(content)
        except BadDecision:
            return {"attempt": {**att, "outcome": "bad_json", "answered_model": model, "http_status": status}}
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else None
        cached = None
        if usage:
            det = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
            cached = det.get("cached_tokens") if det.get("cached_tokens") is not None else usage.get("prompt_cache_hit_tokens")
        return {"attempt": {**att, "outcome": "ok", "answered_model": model, "http_status": status},
                "decision": decision, "model": model or r["model"], "usage": usage,
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
CONFIRM_ONLY_RE = re.compile(rf"(?:{_YES} ?)*(?:(?:please )?{_SEND}(?: (?:please|now|then|thanks|thank you))*)?")
CANCEL_ONLY_RE = re.compile(
    r"(?:(?:no|nope|nah|ok|okay|actually) ?)*(?:cancel(?: it| that| the draft)?|scrap (?:it|that)|forget (?:it|that|about it)"
    r"|never ?mind|drop (?:it|that)|don't send (?:it|that)|do not send (?:it|that)|no|nope)(?: (?:please|thanks|thank you))*")
END_ONLY_RE = re.compile(
    r"(?:(?:ok|okay|alright|great|cool|perfect|thanks|thank you) ?)*(?:that's all|that is all|that's it|that is it|i'm done|"
    r"im done|we're done|we are done|end (?:the )?conversation|talk (?:to you )?later|goodbye|good bye|bye|bye bye|see you|"
    r"that'll be all)(?: (?:thanks|thank you|bye|for now))*")
FORCE_DIRECT_RE = re.compile(r"\b(?:ask|tell|have|let)\s+(?:the\s+)?([a-z0-9][a-z0-9' -]{0,40}?)\s+directly\b|\bfull agent\b")
AFFIRM_RE = re.compile(r"\b(?:yes|yeah|yep|yup|sure|ok|okay|confirm(?:ed)?|go ahead|do it|send it|send that|send this|ship it|"
                       r"sounds good|kick it off|start it|please do|go for it)\b")
NEGATION_RE = re.compile(r"\b(?:don't|dont|do not|not|never|no|nope|stop|wait|hold on|hold off|cancel|but|instead|change|"
                         r"except|without|later)\b")
CHANGE_WORDS_RE = re.compile(r"\b(?:change|changes|fix|fixes|edit|modify|write|implement|commit|patch|refactor|code changes?|"
                             r"make the change|update the code)\b")
DEPLOY_WORDS_RE = re.compile(r"\b(?:deploy|deployed|deploying|redeploy|restart|release|roll ?out|push (?:it|to (?:prod|"
                             r"production|main)))\b")
# A reply that claims work was sent or started when nothing was (only a confirmed draft is ever sent).
SENT_CLAIM_RE = re.compile(r"\b(?:i(?:'ve| have)? (?:sent|started|kicked off|delegated|dispatched|handed (?:it|that) (?:off|over))|"
                           r"(?:sending|starting) (?:it|that|this) now|(?:it|that)(?:'s| is| has been) (?:been )?(?:sent|started)|"
                           r"on it now)\b", re.IGNORECASE)


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
    return AFFIRM_RE.search(norm(text)) is not None


def negated(text: str) -> bool:
    return NEGATION_RE.search(norm(text)) is not None


def perm_allowed(words: list[str]) -> str:
    """The highest permission the driver's own words allow (their last transcripts)."""
    text = norm(" ".join(words))
    if DEPLOY_WORDS_RE.search(text):
        return "deploy_ok"
    if CHANGE_WORDS_RE.search(text):
        return "changes_ok"
    return "read_only"


def clamp_perm(requested: str, words: list[str]) -> str:
    req = requested if requested in PERMS else "read_only"
    return PERMS[min(PERMS.index(req), PERMS.index(perm_allowed(words)))]


# ---------------------------------------------------------------- names (handoff)

_GENERIC = {"pm", "agent", "the", "a", "an", "director", "specialist", "reporter", "company", "project", "manager"}


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


def brief_id_for(conv_id: str, body_sha: str) -> str:
    return str(uuid.uuid5(NS, f"brief:{conv_id}:{body_sha}"))


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


def pending_draft(sess: dict | None, now: float, ttl_s: float) -> dict | None:
    """The draft waiting for a yes: proposed (or being sent), not older than ttl_s since it was proposed or restored."""
    d = (sess or {}).get("pending")
    if not isinstance(d, dict) or d.get("state") not in ("proposed", "sending"):
        return None
    if d.get("state") == "proposed" and now - max(float(d.get("at") or 0), float(d.get("restored_at") or 0)) > ttl_s:
        return None
    return d


def recent_delegation(sess: dict | None, now: float, within_s: float, sha: str | None = None) -> dict | None:
    for d in reversed((sess or {}).get("delegations") or []):
        if d.get("state") in ("not_sent",):
            continue
        if now - float(d.get("at") or 0) > within_s:
            continue
        if sha is None or d.get("brief_sha256") == sha:
            return d
    return None


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

def filter_sent_claims(say: str) -> tuple[str, bool]:
    if not SENT_CLAIM_RE.search(say or ""):
        return say, False
    kept = [s for s in re.split(r"(?<=[.!?])\s+", say) if s and not SENT_CLAIM_RE.search(s)]
    out = " ".join(kept).strip()
    return (f"{out} Nothing was sent." if out else "Nothing has been sent yet."), True


def guard(dec: dict, sess: dict, transcript: str, *, tile: str, tile_name: str, handoff: str, route_fn, names_fn,
          now: float, draft_ttl_s: float = 600.0, dedupe_s: float = 1800.0, memo_id: str = "") -> tuple[dict, list[str]]:
    """The final decision from the model's (or the lexicon's) decision. Returns (final, reasons).

    final: {action, say, draft (a new pending draft, for propose), send (the pending draft to send, for confirm),
    drop (bool: the pending draft goes), close (bool: the conversation ends), already (the earlier delegation)}."""
    reasons: list[str] = []
    action = dec.get("action") or "reply"
    words = [t.get("user") or "" for t in driver_turns(sess)[-1:]] + [transcript]
    pend = pending_draft(sess, now, draft_ttl_s)
    out = {"action": action, "say": dec.get("say") or "", "draft": None, "send": None, "drop": False, "close": False,
           "already": None}

    def propose_from(src: dict, base: dict | None = None) -> None:
        target = (src.get("target") or (base or {}).get("target") or tile).strip()
        if target != tile:
            ok_named = handoff == "named"
            tokens = names_fn(target) if ok_named else []
            route = route_fn(target) if ok_named else {"ok": None}
            if handoff != "named":
                reasons.append("handoff_off")
                target = tile
            elif not tokens or not any(named(w, tokens) for w in words):
                reasons.append("handoff_not_named")
                target = tile
            elif route.get("ok") is not True:
                reasons.append("unroutable_target")
                target = tile
        title = (src.get("title") or (base or {}).get("title") or "").strip() or "Untitled request"
        brief = src.get("brief") if (src.get("brief") or {}).get("goal") else (base or {}).get("brief") or src.get("brief") or {}
        if not brief.get("goal"):
            brief = {**brief, "goal": title}
        perm = clamp_perm(src.get("perm") or (base or {}).get("perm") or "read_only", words)
        if perm != (src.get("perm") or "read_only"):
            reasons.append(f"perm_clamped:{src.get('perm')}->{perm}")
        body = brief_body(title, brief, perm)
        body_sha = sha256(body)
        bid = brief_id_for(sess["conv_id"], body_sha)
        name = tile_name if target == tile else (names_fn.display(target) if hasattr(names_fn, "display") else target)
        draft = {"brief_id": bid, "brief_sha256": body_sha, "title": title, "target": target, "target_name": name,
                 "perm": perm, "brief": brief, "body": body, "memo_id": memo_id, "at": now, "state": "proposed"}
        out.update(action="propose", draft=draft, say=readback(draft))

    if action == "confirm":
        if pend is not None and dec.get("target") and dec["target"] != pend.get("target"):
            reasons.append("retarget_needs_readback")
            propose_from({"target": dec["target"], "title": pend["title"], "brief": pend["brief"], "perm": pend["perm"]})
            return out, reasons
        if pend is None or pend.get("state") == "sending":
            prior = (pend if pend is not None and pend.get("state") == "sending" else None) or recent_delegation(sess, now, dedupe_s)
            if prior is not None:
                reasons.append("already_sent")
                out.update(say=already_sent_line(prior), already=prior)
                return out, reasons
            reasons.append("no_pending_draft")
            out.update(action="reply", say=NOTHING_PENDING_LINE)
            return out, reasons
        if not affirm(transcript) or negated(transcript):
            reasons.append("not_affirmed")
            out.update(action="propose", say=readback(pend))
            return out, reasons
        if sha256(pend.get("body") or "") != pend.get("brief_sha256"):
            reasons.append("draft_changed")
            out.update(action="reply", say="That draft changed since I read it back, so nothing was sent. Tell me again what you want done.",
                       drop=True)
            return out, reasons
        dup = recent_delegation(sess, now, dedupe_s, sha=pend["brief_sha256"])
        if dup is not None:
            reasons.append("duplicate_brief")
            out.update(say=already_sent_line(dup), already=dup, drop=True)
            return out, reasons
        out.update(send=pend, say=sending_line(pend))
        return out, reasons
    if action == "propose":
        propose_from(dec, pend)
        return out, reasons
    if action == "cancel":
        if pend is not None and pend.get("state") == "proposed":
            out.update(say=DROPPED_LINE, drop=True)
        else:
            out.update(say=NOTHING_TO_CANCEL_LINE)
        return out, reasons
    if action == "end":
        say, hit = filter_sent_claims(out["say"] or END_LINE)
        if hit:
            reasons.append("sent_claim_filtered")
        out.update(say=say or END_LINE, close=True, drop=pend is not None and pend.get("state") == "proposed")
        return out, reasons
    if action == "direct":
        return out, reasons
    # reply
    say, hit = filter_sent_claims(out["say"])
    if hit:
        reasons.append("sent_claim_filtered")
    if not say.strip():
        say = "Sorry, I didn't catch that. Say it again?"
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
- Only state facts that are in the AGENT CARD, the DESK STATE or this conversation. You have no tools and no live data. When the driver asks about live state (the board, a ticket's status, a build, logs, files, anything that needs a tool or fresh data), set action "direct" so the full agent answers.
- You never do work yourself. When the driver asks for work (investigate, check, fix, write, run, report back), set action "propose" with a self-contained brief: a title of at most eight words, the goal, the context the agent needs (it never sees this conversation) and when it is done. The desk reads the draft back; it is sent only when the driver confirms aloud.
- Never say you sent, started or did anything.
- With a pending draft: the driver confirms it ("send it") -> action "confirm"; drops it -> "cancel"; changes it -> "propose" with the whole updated draft.
- If the transcript looks misheard, ask a short question (action "reply").
- The driver closes the conversation ("that's all", "thanks, bye") -> action "end".
- target: the agent id the work is for, by default "{agent}". Use another ROSTER id only when the driver said that agent's name.
- perm: "read_only" unless the driver asked for code changes ("changes_ok") or a deploy, restart or push ("deploy_ok").

OUTPUT FORMAT
Return one JSON object and nothing else, with the keys say, action, target, title, brief, perm. Two examples:
{{"say":"Holocene is finishing the fast conversation desk; the watcher stage is next.","action":"reply","target":"{agent}","title":"","brief":null,"perm":"read_only"}}
{{"say":"I can have the PM look into that.","action":"propose","target":"{agent}","title":"Why the audio spool is disabled","brief":{{"goal":"Find out why the audio spool is disabled and report back.","context":["The driver noticed it while driving."],"done_when":["The cause is named and a fix is proposed."]}},"perm":"read_only"}}"""


def build_messages(*, agent: str, name: str, card: dict, sess: dict | None, transcript: str, board: str = "",
                   recent: str = "", now: float | None = None, window: int = 12) -> list[dict]:
    """Stable prefix first (rules, card, roster: byte-identical across turns for the provider's prefix cache), then the
    conversation window as user/assistant pairs (append-only), then the volatile desk state and the new transcript."""
    system = (SYSTEM_RULES.format(name=name, agent=agent) + "\n\nAGENT CARD\n" + (card.get("text") or "-")
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
        state.append(f"PENDING DRAFT ({pend['state']}) for {pend.get('target_name')}: {pend.get('title')} "
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


def write_flag(path: Path, drop: tuple = (), **updates) -> dict:
    """Merge updates into the flag file (and remove the `drop` keys), atomically (tmp + rename). Returns the new document."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            doc = {}
    except (OSError, ValueError):
        doc = {}
    doc.update({k: v for k, v in updates.items() if v is not None})
    for k in drop:
        doc.pop(k, None)
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return doc


class Desk:
    """Everything the watcher's converse stage needs, configured from the environment (the unit's defaults) and the flag
    file (runtime switch, wins over the environment)."""

    def __init__(self, state_dir: Path, env=None, keys: KeyCache | None = None, http_: Http | None = None,
                 cards: CardCache | None = None, log=None, clock=time.time):
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
        self.idle_s = _env_float(env, "MEMO_CONVERSE_IDLE_S", 900.0)
        self.draft_ttl_s = _env_float(env, "MEMO_CONVERSE_DRAFT_TTL_S", 600.0)
        self.dedupe_s = _env_float(env, "MEMO_CONVERSE_DEDUPE_S", 1800.0)
        self.max_audio_s = _env_float(env, "MEMO_CONVERSE_MAX_AUDIO_S", 90.0)
        self.max_input_chars = _env_int(env, "MEMO_CONVERSE_MAX_INPUT_CHARS", 4000)
        self.window = _env_int(env, "MEMO_CONVERSE_WINDOW", 12)
        self._routes: dict[str, tuple[list[dict], list[dict]]] = {}
        self._warned: set[str] = set()

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
            if fm in MODES and not flag.get("error"):
                mode, err = fm, None
            else:
                mode, err = "off", flag.get("error") or f"flag mode {fm!r} is not off|shadow|on: converse is off"
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
        return {"mode": mode, "source": source, "agents": agents, "devices": devices, "handoff": handoff,
                "routes": routes, "refused": refused, "error": err}

    def routes(self, raw) -> tuple[list[dict], list[dict]]:
        k = raw if isinstance(raw, str) else json.dumps(raw)
        if k not in self._routes:
            routes, refused = parse_routes(raw)
            for r in refused:
                self.log("converse_route_refused", "warn", route=r.get("id"), model=r.get("model"), reason=r["reason"])
            self._routes[k] = (routes, refused)
        return self._routes[k]

    @staticmethod
    def agent_allowed(s: dict, agent: str | None) -> bool:
        return bool(agent) and (s["agents"] == "*" or agent in (s["agents"] or []))

    def wants(self, agent: str | None) -> bool:
        """Cheap: may a memo for this agent take the converse (or shadow) path at all right now?"""
        s = self.settings()
        return s["mode"] != "off" and self.agent_allowed(s, agent)

    def usable_routes(self, s: dict) -> list[dict]:
        return [r for r in s["routes"] if self.keys.status(r["key_ref"]) != "unreadable"]

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
        if not self.usable_routes(s):
            return "key_unreadable"
        return None

    # -- deciding

    def ladder(self, s: dict) -> Ladder:
        return Ladder(s["routes"], self.keys, self.breaker, self.http, self.budget_s, log=self.log)

    def decide(self, s: dict, *, agent: str, name: str, transcript: str, sess: dict | None, card: dict, board: str = "",
               recent: str = "", now: float | None = None) -> dict:
        """The raw decision for one turn: {decision, path, llm, lexicon}. A lexicon match makes no LLM call. Never raises
        for an LLM reason: a failed ladder is action=direct with fallback_reason."""
        now = self.clock() if now is None else now
        pend = pending_draft(sess, now, self.draft_ttl_s)
        lex = None
        if confirm_only(transcript) and (pend is not None or recent_delegation(sess, now, self.dedupe_s)):
            lex = ("confirm_only", {"action": "confirm"})
        elif cancel_only(transcript) and pend is not None:
            lex = ("cancel_only", {"action": "cancel"})
        elif end_only(transcript):
            lex = ("end_only", {"action": "end", "say": END_LINE})
        elif force_direct(transcript):
            lex = ("force_direct", {"action": "direct"})
        if lex is not None:
            return {"decision": normalize_decision(lex[1]), "path": lex[0], "lexicon": True, "llm": None,
                    "forced_by": force_direct(transcript) if lex[0] == "force_direct" else None}
        msgs = build_messages(agent=agent, name=name, card=card, sess=sess, transcript=transcript, board=board,
                              recent=recent, now=now, window=self.window)
        res = self.ladder(s).call(msgs)
        if not res.get("ok"):
            return {"decision": normalize_decision({"action": "direct"}), "path": "fallback", "lexicon": False,
                    "llm": res, "fallback_reason": res.get("fallback_reason")}
        return {"decision": res["decision"], "path": "fast", "lexicon": False, "llm": res,
                "prompt_chars": sum(len(m["content"]) for m in msgs)}

    # -- operator surfaces

    def warm_keys(self) -> None:
        """Read every configured key once, off the critical path (start-up): the heartbeat then says ok or unreadable."""
        s = self.settings()
        for r in s["routes"]:
            self.keys.get(r["key_ref"])

    def heartbeat(self, open_conversations: int = 0, contract: dict | None = None) -> dict:
        s = self.settings()
        keys = {}
        routes = []
        for r in s["routes"]:
            st = self.keys.status(r["key_ref"])
            keys[r["id"]] = st
            until = self.breaker.open_until(r["id"])
            routes.append({"id": r["id"], "model": r["model"], "host": r["host"], "key": st,
                           "fails_2m": self.breaker.recent_fails(r["id"]),
                           "breaker_open_until": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until)) if until else None})
        vals = set(keys.values()) - {"none"}
        agg = ("no_routes" if not s["routes"] else "ok" if vals <= {"ok"} else "unreadable" if vals == {"unreadable"}
               else "unread" if vals == {"unread"} else "partial")
        return {"mode": s["mode"], "source": s["source"], "agents": s["agents"], "devices": s["devices"],
                "handoff": s["handoff"], "error": s["error"], "open_conversations": open_conversations,
                "routes": routes, "refused": s["refused"], "key_status": agg, "keys": keys, "contract": contract,
                "budget_s": self.budget_s}


def snapshot(obj):
    """A deep copy for work outside the watcher lock."""
    return copy.deepcopy(obj)

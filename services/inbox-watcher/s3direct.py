"""In-process S3 for the watcher's hot path (HOLOC-23 phase 2): a signed (SigV4) HTTP client with one kept-alive connection
per thread, stdlib only.

Why: every `mc` call is a process spawn plus a TLS handshake through Cloudflare (s3.delo.sh). Measured on this host under
load: `mc cp` up 7.1 s p50 / down 3.5 s p50 via s3.delo.sh, 0.14 s / 0.07 s via the local MinIO port. A reply chunk, the
inbox download and the inbox listing sit on the record-stop -> first-audible-answer path.

`mc_cli(args)` answers the few `mc` invocations the watcher makes on that path (cp up/down, ls --recursive --json,
stat [--json], cat) with the same CompletedProcess shape `mc` would have produced, so callers do not change. Anything else
(rm, pipe, an unknown flag) and ANY error of the direct path returns None, and the caller runs the real `mc`: the direct
path can only make a call faster, never make it fail. Off unless MEMO_S3_DIRECT=1 (tests run a fake `mc` binary).

The endpoint and keys come from the mc alias (~/.mc/config.json), never from a file of ours.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import time
import re
import subprocess
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

ENABLED = os.environ.get("MEMO_S3_DIRECT", "0") == "1"
REGION = os.environ.get("MEMO_S3_REGION", "us-east-1")
CONNECT_TIMEOUT_S = float(os.environ.get("MEMO_S3_DIRECT_TIMEOUT_S", "20"))
_EMPTY_SHA = hashlib.sha256(b"").hexdigest()
# mc guesses a Content-Type from the file extension when no --attr is given; the direct path must store the same type,
# or a one-file reply / an Earshot drop lands as binary/octet-stream instead of audio/ogg.
_EXT_TYPES = {".ogg": "audio/ogg", ".opus": "audio/ogg", ".oga": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/x-wav",
              ".m4a": "audio/mp4", ".webm": "audio/webm", ".json": "application/json", ".txt": "text/plain"}


def guess_type(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return _EXT_TYPES.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


class DirectUnavailable(Exception):
    """The direct path cannot serve this call: the caller runs mc."""


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sigv4_headers(method: str, host: str, path: str, query: str, headers: dict[str, str], payload_sha: str,
                  access: str, secret: str, region: str = REGION, when: datetime | None = None) -> dict[str, str]:
    """The request headers with Authorization added (AWS SigV4, service s3). `path` is already URI-encoded."""
    t = when or datetime.now(timezone.utc)
    amz, day = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    h = {k.lower(): str(v).strip() for k, v in headers.items()}
    h["host"], h["x-amz-date"], h["x-amz-content-sha256"] = host, amz, payload_sha
    names = sorted(h)
    canon = "\n".join([method, path, query, "".join(f"{n}:{h[n]}\n" for n in names), ";".join(names), payload_sha])
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = _sign(_sign(_sign(_sign(("AWS4" + secret).encode(), day), region), "s3"), "aws4_request")
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    h["authorization"] = (f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={';'.join(names)}, Signature={sig}")
    return h


def _quote(s: str) -> str:
    return urllib.parse.quote(s, safe="/-_.~")


class Client:
    def __init__(self, endpoint: str, access: str, secret: str):
        u = urllib.parse.urlparse(endpoint)
        self.https = u.scheme == "https"
        self.host = u.netloc
        self.access, self.secret = access, secret
        self._tl = threading.local()

    def _conn(self, timeout: float, fresh: bool = False) -> http.client.HTTPConnection:
        c = getattr(self._tl, "conn", None)
        if c is None or fresh:
            if c is not None:
                try:
                    c.close()
                except Exception:  # noqa: BLE001
                    pass
            cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
            c = self._tl.conn = cls(self.host, timeout=timeout)
        c.timeout = timeout
        if c.sock is not None:
            c.sock.settimeout(timeout)
        return c

    def budget(self, seconds: float | None) -> None:
        """The wall-clock budget of this thread's next calls (the caller's mc timeout). Both attempts of a request share
        it, so a hung MinIO costs at most the budget before the mc fallback runs, not 2 x CONNECT_TIMEOUT_S."""
        self._tl.deadline = None if seconds is None else time.monotonic() + max(0.5, min(seconds, CONNECT_TIMEOUT_S))

    def request(self, method: str, bucket: str, key: str = "", query: dict | None = None, body: bytes = b"",
                headers: dict | None = None, into=None) -> tuple[int, dict, bytes]:
        """(status, response headers lower-cased, body). `into` (a binary file object) receives the body instead.
        Retried once on a dead kept-alive connection (every call here is idempotent)."""
        path = "/" + _quote(f"{bucket}/{key}" if key else bucket)
        q = "&".join(f"{_quote(k)}={_quote(str(v))}" for k, v in sorted((query or {}).items()))
        sha = hashlib.sha256(body).hexdigest() if body else _EMPTY_SHA
        deadline = getattr(self._tl, "deadline", None)
        start = into.tell() if into is not None else 0
        for attempt in (0, 1):
            left = CONNECT_TIMEOUT_S if deadline is None else deadline - time.monotonic()
            if left <= 0.05:
                raise DirectUnavailable("budget spent")
            h = sigv4_headers(method, self.host, path, q, headers or {}, sha, self.access, self.secret)
            h["content-length"] = str(len(body))
            c = self._conn(min(left, CONNECT_TIMEOUT_S), fresh=attempt == 1)
            if into is not None and attempt == 1:  # a body cut mid-way must not stay in front of the retried copy
                into.seek(start)
                into.truncate()
            try:
                c.request(method, path + (f"?{q}" if q else ""), body=body or None, headers=h)
                r = c.getresponse()
                rh = {k.lower(): v for k, v in r.getheaders()}
                if into is not None and r.status == 200:
                    got = 0
                    while True:
                        buf = r.read(1 << 20)
                        if not buf:
                            break
                        into.write(buf)
                        got += len(buf)
                    want = rh.get("content-length")
                    if want is not None and got != int(want):  # read(amt) returns short, not an error, on a cut body
                        raise http.client.IncompleteRead(b"", int(want) - got)
                    return r.status, rh, b""
                return r.status, rh, r.read()
            except (http.client.HTTPException, ConnectionError, OSError):
                if attempt == 1:
                    raise
                continue
        raise DirectUnavailable("unreachable")

    # ---- the operations the watcher needs

    def put(self, bucket: str, key: str, data: bytes, content_type: str | None = None, tags: str | None = None,
            cache_control: str | None = None) -> None:
        h = {}
        if content_type:
            h["content-type"] = content_type
        if cache_control:
            h["cache-control"] = cache_control
        if tags:
            h["x-amz-tagging"] = tags
        st, _, body = self.request("PUT", bucket, key, body=data, headers=h)
        if st not in (200, 201):
            raise DirectUnavailable(f"PUT {st} {body[:120]!r}")

    def get_to(self, bucket: str, key: str, out: Path) -> bool:
        """True when the object was written to `out`, False when it does not exist."""
        tmp = out.with_name(out.name + ".part")
        try:
            with tmp.open("wb") as f:
                st, _, body = self.request("GET", bucket, key, into=f)
            if st == 404:
                return False
            if st != 200:
                raise DirectUnavailable(f"GET {st} {body[:120]!r}")
            os.replace(tmp, out)
            return True
        finally:
            tmp.unlink(missing_ok=True)

    def get_bytes(self, bucket: str, key: str) -> bytes | None:
        st, _, body = self.request("GET", bucket, key)
        if st == 404:
            return None
        if st != 200:
            raise DirectUnavailable(f"GET {st} {body[:120]!r}")
        return body

    def head(self, bucket: str, key: str) -> dict | None:
        st, h, body = self.request("HEAD", bucket, key)
        if st == 404:
            return None
        if st != 200:
            raise DirectUnavailable(f"HEAD {st}")
        return h

    def list(self, bucket: str, prefix: str) -> list[dict]:
        """Every object under prefix: {key (full), size, etag, last_modified (iso string)}."""
        out, token = [], None
        while True:
            q = {"list-type": "2", "prefix": prefix}
            if token:
                q["continuation-token"] = token
            st, _, body = self.request("GET", bucket, "", query=q)
            if st != 200:
                raise DirectUnavailable(f"LIST {st} {body[:120]!r}")
            root = ElementTree.fromstring(body)
            ns = root.tag.partition("}")[0] + "}" if root.tag.startswith("{") else ""
            for c in root.findall(f"{ns}Contents"):
                out.append({"key": c.findtext(f"{ns}Key") or "", "size": int(c.findtext(f"{ns}Size") or 0),
                            "etag": (c.findtext(f"{ns}ETag") or "").strip('"'),
                            "last_modified": c.findtext(f"{ns}LastModified") or ""})
            if (root.findtext(f"{ns}IsTruncated") or "").lower() == "true":
                token = root.findtext(f"{ns}NextContinuationToken")
                if not token:
                    break
            else:
                break
        return out


# ---------------------------------------------------------------- the mc-shaped front door

_client_lock = threading.Lock()
_clients: dict[str, Client | None] = {}


def _alias_client(alias: str) -> Client | None:
    with _client_lock:
        if alias in _clients:
            return _clients[alias]
        c = None
        try:
            cfg = json.loads((Path.home() / ".mc/config.json").read_text())["aliases"][alias]
            ep = os.environ.get("MEMO_S3_DIRECT_ENDPOINT") or cfg["url"]
            c = Client(ep, cfg["accessKey"], cfg["secretKey"])
        except Exception:  # noqa: BLE001 - no alias, no direct path
            c = None
        _clients[alias] = c
        return c


def reset() -> None:
    with _client_lock:
        _clients.clear()


def _remote(arg: str, alias: str) -> tuple[str, str] | None:
    """('bucket', 'key') for `alias/bucket/key`, else None (a local path)."""
    if not arg.startswith(alias + "/"):
        return None
    bucket, _, key = arg[len(alias) + 1:].partition("/")
    return (bucket, key) if bucket else None


def _attr(raw: str | None) -> tuple[str | None, str | None]:
    """(content-type, cache-control) of an `mc --attr` value: k=v pairs split on ';', a value may be quoted."""
    ctype = cache = None
    if not raw:
        return None, None
    m = re.match(r'\s*Content-Type=("([^"]*)"|[^;]*)(;(.*))?$', raw)
    if raw.startswith("Content-Type="):
        if m:
            ctype = (m.group(2) if m.group(2) is not None else m.group(1)).strip()
            rest = m.group(4) or ""
        else:
            rest = ""
        for part in rest.split(";"):
            if part.strip().startswith("Cache-Control="):
                cache = part.split("=", 1)[1].strip().strip('"')
        return ctype, cache
    raise DirectUnavailable("unsupported --attr")


def _done(rc: int, out: str = "", err: str = "", args=()) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(["s3direct", *args], rc, out, err)


def _iso(s: str) -> str:
    return s


def pipe_cli(alias: str, bucket: str, key: str, body: bytes, attr: str | None, timeout: float | None = None) -> bool:
    """`mc pipe --attr ...`: True when the direct path stored the object, False when the caller must run mc."""
    if not ENABLED:
        return False
    c = _alias_client(alias)
    if c is None:
        return False
    try:
        c.budget(timeout)
        ctype, cache = _attr(attr)
        c.put(bucket, key, body, ctype, None, cache)
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        c.budget(None)


def mc_cli(alias: str, args: tuple, timeout: float) -> subprocess.CompletedProcess | None:
    """Serve one `mc` call in-process, or None (run mc)."""
    if not ENABLED:
        return None
    c = _alias_client(alias)
    if c is None:
        return None
    try:
        c.budget(timeout)
        return _serve(c, alias, list(args))
    except Exception:  # noqa: BLE001 - the direct path never fails a call: mc runs it
        return None
    finally:
        c.budget(None)


def _serve(c: Client, alias: str, args: list[str]) -> subprocess.CompletedProcess | None:
    attr = tags = None
    pos, as_json, recursive, i = [], False, False, 0
    while i < len(args):
        a = args[i]
        if a == "--attr" and i + 1 < len(args):
            attr, i = args[i + 1], i + 2
        elif a == "--tags" and i + 1 < len(args):
            tags, i = args[i + 1], i + 2
        elif a == "--quiet":
            i += 1
        elif a == "--json":
            as_json, i = True, i + 1
        elif a == "--recursive":
            recursive, i = True, i + 1
        elif a.startswith("-") and len(a) > 1 and a != "-":
            return None  # a flag this front door does not know: mc decides
        else:
            pos.append(a)
            i += 1
    if not pos:
        return None
    verb, rest = pos[0], pos[1:]
    if verb == "cp" and len(rest) == 2:
        src, dst = _remote(rest[0], alias), _remote(rest[1], alias)
        if src is None and dst is not None:  # upload
            ctype, cache = _attr(attr)
            ctype = ctype or guess_type(rest[0])  # what mc itself would store without --attr
            data = Path(rest[0]).read_bytes()
            c.put(dst[0], dst[1], data, ctype, tags, cache)
            return _done(0, args=args)
        if src is not None and dst is None:  # download
            if not c.get_to(src[0], src[1], Path(rest[1])):
                return None  # mc words the error
            return _done(0, args=args)
        return None
    if verb == "ls" and recursive and as_json and len(rest) == 1:
        loc = _remote(rest[0], alias)
        if loc is None or not loc[1].endswith("/"):
            return None
        lines = []
        for o in c.list(loc[0], loc[1]):
            rel = o["key"][len(loc[1]):]
            if not rel or rel.endswith("/"):
                continue
            lines.append(json.dumps({"status": "success", "type": "file", "lastModified": o["last_modified"],
                                     "size": o["size"], "key": rel, "etag": o["etag"]}))
        return _done(0, "\n".join(lines) + ("\n" if lines else ""), args=args)
    if verb == "stat" and len(rest) == 1:
        loc = _remote(rest[0], alias)
        if loc is None or not loc[1] or loc[1].endswith("/"):
            return None
        h = c.head(loc[0], loc[1])
        if h is None:
            return None  # mc words "object does not exist"
        if not as_json:
            return _done(0, f"Name      : {loc[1].rsplit('/', 1)[-1]}\nSize      : {h.get('content-length')}\n", args=args)
        meta = {"Content-Type": h.get("content-type", "")}
        for k, v in h.items():
            if k.startswith("x-amz-meta-"):
                meta["X-Amz-Meta-" + "-".join(p.capitalize() for p in k[len("x-amz-meta-"):].split("-"))] = v
        lm = h.get("last-modified") or ""
        try:
            lm = datetime.strptime(lm, "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
        return _done(0, json.dumps({"status": "success", "name": loc[1].rsplit("/", 1)[-1], "lastModified": lm,
                                    "size": int(h.get("content-length") or 0), "etag": (h.get("etag") or "").strip('"'),
                                    "type": "file", "metadata": meta}) + "\n", args=args)
    if verb == "cat" and len(rest) == 1:
        loc = _remote(rest[0], alias)
        if loc is None:
            return None
        body = c.get_bytes(loc[0], loc[1])
        if body is None:
            return None
        return _done(0, body.decode("utf-8", "replace"), args=args)
    return None

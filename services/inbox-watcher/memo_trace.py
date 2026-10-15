#!/usr/bin/env python3
"""memo_trace: one timeline for one voice memo, hop by hop.

  memo_trace.py trace [<memo_id>|<s3 key>|<file name>|latest] [--logs]
  memo_trace.py list  [-n 15]

Every hop reports OK / MISSING / FAILED / UNKNOWN with a timestamp and the
latency since the previous hop, and the run ends with ONE verdict line:
  STOPPED AT <hop>: <why>     or     COMPLETE in <N>s

Evidence sources (all read-only): S3 (mc), `docker logs agent-pad-upload`,
Candystore /events?correlationid=<memo_id>, the gateway journal by command id,
the watcher's state/heartbeat files, and NATS monitoring for the gateway
consumer. See README.md for the exact commands behind each hop.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memo_common as c  # noqa: E402

OK, MISSING, FAILED, UNKNOWN = "OK", "MISSING", "FAILED", "UNKNOWN"
COLOR = sys.stdout.isatty()
_C = {OK: "32", MISSING: "33", FAILED: "31", UNKNOWN: "90"}


def paint(status: str, text: str) -> str:
    return f"\033[{_C[status]}m{text}\033[0m" if COLOR else text


class Hop:
    def __init__(self, name, status, ts=None, detail="", optional=False):
        self.name, self.status, self.ts, self.detail, self.optional = name, status, ts, detail, optional


# ------------------------------------------------------------------ evidence

def watcher_record(key: str) -> dict | None:
    p = c.STATE_DIR / "state.json"
    try:
        return json.loads(p.read_text())["memos"].get(key)
    except Exception:  # noqa: BLE001
        return None


def watcher_heartbeat() -> dict | None:
    try:
        hb = json.loads((c.STATE_DIR / "heartbeat.json").read_text())
        ts = c.parse_iso(hb.get("ts"))
        hb["age_s"] = (c.now_utc() - ts).total_seconds() if ts else None
        return hb
    except Exception:  # noqa: BLE001
        return None


def watcher_unit_active() -> str:
    r = subprocess.run(["systemctl", "--user", "is-active", c.WATCHER_UNIT], capture_output=True, text=True)
    return r.stdout.strip() or "unknown"


def upload_log_line(key: str, memo_id: str) -> tuple[str | None, str | None]:
    """(timestamp, line) of the upload-proxy log line for this memo, if docker logs still has it."""
    r = subprocess.run(["docker", "logs", "--timestamps", c.UPLOAD_CONTAINER], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return None, f"docker logs failed: {(r.stderr or r.stdout).strip()[:120]}"
    hit = None
    for line in (r.stdout + r.stderr).splitlines():
        if key in line or memo_id in line:
            if '"status":200' in line or "uploaded " in line or hit is None:
                hit = line
    if not hit:
        return None, None
    ts, _, rest = hit.partition(" ")
    return ts, rest.strip()


def watcher_logs(memo_id: str, lines: int = 40) -> list[str]:
    r = subprocess.run(["journalctl", "--user", "-u", c.WATCHER_UNIT, "--no-pager", "-o", "cat", "--since", "-3 days"],
                       capture_output=True, text=True, timeout=30)
    hits = [ln for ln in r.stdout.splitlines() if memo_id in ln]
    return hits[-lines:]


# ------------------------------------------------------------------ build hops

def build(key: str) -> tuple[list[Hop], dict]:
    memo_id = c.memo_id_for(key)
    agent = c.agent_from_key(key)
    ctx: dict = {"memo_id": memo_id, "key": key, "agent": agent}
    hops: list[Hop] = []
    rec = watcher_record(key)
    ctx["watcher_record"] = rec

    # 1. S3 object
    st = None
    try:
        st = c.s3_stat(key)
    except Exception as e:  # noqa: BLE001
        hops.append(Hop("s3_object", UNKNOWN, detail=f"mc stat error: {e}"))
    if st:
        hops.append(Hop("s3_object", OK, st["last_modified"], f"{key}  {st['size']} bytes"))
    elif not hops:
        hops.append(Hop("s3_object", MISSING, detail=f"{c.S3_ALIAS}/{c.BUCKET}/{key} does not exist"))

    # 2. upload proxy log line
    try:
        ts, line = upload_log_line(key, memo_id)
        if ts:
            hops.append(Hop("upload_proxy_log", OK, c.parse_iso(ts), line[:160], optional=True))
        else:
            hops.append(Hop("upload_proxy_log", MISSING, detail=line or f"no line mentioning the key in `docker logs {c.UPLOAD_CONTAINER}` "
                            "(older than the proxy's structured logging, or logs rotated)", optional=True))
    except Exception as e:  # noqa: BLE001
        hops.append(Hop("upload_proxy_log", UNKNOWN, detail=str(e)[:120], optional=True))

    # 3. bloodbank facts
    events: list[dict] = []
    try:
        events = c.candystore_events(memo_id)
        ctx["candystore"] = "ok"
    except Exception as e:  # noqa: BLE001
        ctx["candystore"] = f"unreachable: {e}"
    by_type: dict[str, list[dict]] = {}
    for ev in events:
        by_type.setdefault(ev["type"], []).append(ev)

    def fact(action: str) -> dict | None:
        lst = by_type.get(f"bloodbank.audio.memo.{action}")
        return lst[-1] if lst else None

    def add_fact_hop(name, action, describe, optional=False):
        ev = fact(action)
        if ev:
            hops.append(Hop(name, OK, c.parse_iso(ev["time"]), describe(ev.get("data") or {}), optional))
        elif ctx["candystore"] != "ok":
            hops.append(Hop(name, UNKNOWN, detail=f"Candystore {ctx['candystore']}", optional=optional))
        else:
            hops.append(Hop(name, MISSING, detail=f"no bloodbank.audio.memo.{action} with correlationid={memo_id}", optional=optional))

    add_fact_hop("fact:uploaded", "uploaded", lambda d: f"{d.get('bytes')} bytes ua={str(d.get('client_user_agent'))[:40]}", optional=True)
    add_fact_hop("fact:received", "received", lambda d: f"watcher saw it, lag {d.get('detect_lag_ms')}ms")
    add_fact_hop("fact:transcribed", "transcribed",
                 lambda d: f"{d.get('transcript_chars')} chars in {d.get('processing_seconds')}s ({d.get('model')}): "
                           f"{str(d.get('transcript_text'))[:80]!r}")
    add_fact_hop("fact:dispatched", "dispatched",
                 lambda d: f"command {d.get('command_id')} -> {d.get('command_subject')}")

    disp = fact("dispatched")
    command_id = (disp or {}).get("data", {}).get("command_id") or (rec or {}).get("command_id")
    ctx["command_id"] = command_id

    # 4. gateway journal (by command id, never 'latest')
    row = None
    if command_id:
        try:
            row = c.journal_row(command_id)
        except Exception as e:  # noqa: BLE001
            hops.append(Hop("gateway_journal", UNKNOWN, detail=str(e)[:140]))
        else:
            if row:
                ok = row["state"] in ("completed",) and row.get("outcome") in ("success", None)
                bad = row["state"].startswith("rejected") or (row["state"] == "completed" and row.get("outcome") not in ("success", None))
                detail = f"profile={row['profile']} state={row['state']} outcome={row.get('outcome')} created={row['created_at']} updated={row['updated_at']}"
                if bad:
                    detail += f" reason={c.terminal_error(row)}"
                hops.append(Hop("gateway_journal", FAILED if bad else OK, c.parse_iso(row["created_at"]), detail))
            else:
                live = c.gateway_liveness()
                hops.append(Hop("gateway_journal", MISSING,
                                detail=f"gateway never created an execution row for {command_id}; {c.gateway_liveness_text(live)}"))
    else:
        hops.append(Hop("gateway_journal", MISSING, detail="no command id yet (not dispatched)"))

    # 5. agent turn
    inv = [e for t in ("bloodbank.agent.invocation.started", "bloodbank.agent.invocation.completed", "bloodbank.agent.invocation.failed")
           for e in by_type.get(t, []) if (e.get("data") or {}).get("command_id") == command_id]
    inv.sort(key=lambda e: e["time"])
    started = next((e for e in inv if e["type"].endswith(".started")), None)
    done = next((e for e in inv if e["type"].endswith(".completed")), None)
    failed = next((e for e in inv if e["type"].endswith(".failed")), None)
    if started:
        hops.append(Hop("agent:invocation.started", OK, c.parse_iso(started["time"]), f"producer={started.get('producer')}"))
    else:
        hops.append(Hop("agent:invocation.started", MISSING if ctx["candystore"] == "ok" else UNKNOWN,
                        detail="no bloodbank.agent.invocation.started for this command in Candystore"))
    if failed:
        d = failed.get("data") or {}
        hops.append(Hop("agent:invocation.done", FAILED, c.parse_iso(failed["time"]),
                        f"invocation.failed {d.get('error_code')}: {d.get('error_message')}"))
    elif done:
        hops.append(Hop("agent:invocation.done", OK, c.parse_iso(done["time"]), "invocation.completed"))
    elif row and row["state"] == "completed" and row.get("outcome") == "success":
        hops.append(Hop("agent:invocation.done", OK, c.parse_iso(row["updated_at"]), "journal completed/success (fact not in Candystore)"))
    else:
        hops.append(Hop("agent:invocation.done", MISSING if ctx["candystore"] == "ok" else UNKNOWN,
                        detail="no invocation.completed/failed for this command"))

    # 6. reply
    add_fact_hop("fact:replied", "replied",
                 lambda d: f"{d.get('reply_chars')} chars, tts {d.get('tts_seconds')}s ({d.get('tts_engine')}) -> {d.get('reply_s3_key')}")
    rep = fact("replied")
    reply_key = ((rep or {}).get("data") or {}).get("reply_s3_key") or (rec or {}).get("reply_key")
    ctx["reply_key"] = reply_key
    if reply_key:
        rs = c.s3_stat(reply_key)
        hops.append(Hop("reply_object", OK if rs else MISSING, rs["last_modified"] if rs else None,
                        f"{reply_key}  {rs['size']} bytes" if rs else f"{reply_key} not in bucket"))
    else:
        hops.append(Hop("reply_object", MISSING, detail="no reply key recorded"))
    hops.append(Hop("played_on_pad", UNKNOWN, detail="the pad does not report playback; it polls replies/<date>/ every 15s", optional=True))

    # failed facts, positioned by time
    for ev in by_type.get("bloodbank.audio.memo.failed", []):
        d = ev.get("data") or {}
        hops.append(Hop(f"fact:failed[{d.get('stage')}]", FAILED, c.parse_iso(ev["time"]),
                        f"{d.get('error_code')}: {str(d.get('error_message'))[:200]} (retryable={d.get('retryable')}, attempt={d.get('attempt')})",
                        optional=bool(d.get("retryable"))))
    ctx["events"] = events
    return hops, ctx


def verdict(hops: list[Hop], ctx: dict) -> tuple[str, bool]:
    rec = ctx.get("watcher_record") or {}
    # a terminal failed fact (retryable=false) always wins
    terminal = [h for h in hops if h.name.startswith("fact:failed") and not h.optional]
    if terminal:
        h = terminal[-1]
        return f"STOPPED AT {h.name[len('fact:failed['):-1]}: {h.detail}", False
    for h in hops:
        if h.optional and h.status != FAILED:
            continue
        if h.status == OK:
            continue
        stage_hint = ""
        if h.name in ("fact:received", "fact:transcribed", "fact:dispatched", "reply_object", "fact:replied"):
            stage_hint = watcher_hint(rec)
        if h.name == "s3_object":
            return f"STOPPED AT s3_object: {h.detail}", False
        return f"STOPPED AT {h.name}: {h.detail}{stage_hint}", False
    s3 = next((h for h in hops if h.name == "s3_object"), None)
    end = next((h for h in hops if h.name == "reply_object" and h.ts), None)
    if s3 and s3.ts and end and end.ts:
        return f"COMPLETE in {(end.ts - s3.ts).total_seconds():.1f}s", True
    return "COMPLETE", True


def watcher_hint(rec: dict) -> str:
    hb = watcher_heartbeat()
    unit = watcher_unit_active()
    parts = []
    if rec:
        if rec.get("status") == "baseline":
            return " [watcher baselined this object at first start: it predates the watcher and was never processed]"
        parts.append(f"watcher record: status={rec.get('status')} stage={rec.get('stage')} attempts={rec.get('attempts')}")
    else:
        parts.append("watcher has no record of this key")
    if unit != "active":
        parts.append(f"{c.WATCHER_UNIT} is {unit}")
    elif hb and hb.get("age_s") is not None and hb["age_s"] > 60:
        parts.append(f"watcher heartbeat is {int(hb['age_s'])}s old")
    return " [" + "; ".join(parts) + "]"


# ------------------------------------------------------------------ rendering

def render(hops: list[Hop], ctx: dict) -> None:
    print(f"memo_id  {ctx['memo_id']}")
    print(f"key      {ctx['key']}")
    print(f"agent    {ctx['agent']}")
    print(f"command  {ctx.get('command_id') or '-'}")
    print(f"query    curl -s '{c.CANDYSTORE_URL}/events?correlationid={ctx['memo_id']}&limit=100'")
    print()
    prev = None
    for h in hops:
        ts = c.iso(h.ts) if h.ts else "-"
        lat = ""
        if h.ts and prev and h.status == OK:
            lat = f"{max(0.0, (h.ts - prev).total_seconds()):+.1f}s"
        if h.ts and h.status == OK:
            prev = h.ts
        tag = paint(h.status, f"{h.status:<7}")
        opt = " (optional)" if h.optional and h.status != OK else ""
        print(f"  {tag} {h.name:<26} {ts:<25} {lat:<8} {h.detail}{opt}")


def resolve_key(arg: str) -> str:
    if arg == "latest":
        objs = c.s3_list_inbox()
        if not objs:
            raise SystemExit("inbox is empty")
        return max(objs, key=lambda o: o["last_modified"])["key"]
    if arg.startswith(f"{c.INBOX_PREFIX}/"):
        return arg
    key = c.s3_find_inbox_key(arg)
    if not key:
        raise SystemExit(f"no inbox object matches {arg!r}")
    return key


def cmd_trace(args) -> int:
    key = resolve_key(args.target)
    hops, ctx = build(key)
    render(hops, ctx)
    text, complete = verdict(hops, ctx)
    print()
    print(paint(OK if complete else FAILED, f"VERDICT  {text}"))
    if args.logs or not complete:
        lines = watcher_logs(ctx["memo_id"])
        if lines:
            print(f"\nwatcher log ({len(lines)} lines, journalctl --user -u {c.WATCHER_UNIT}):")
            for ln in lines[-15 if not args.logs else -40:]:
                print("  " + ln[:260])
    return 0 if complete else 2


def furthest(events: list[dict], rec: dict | None) -> str:
    types = {e["type"].replace("bloodbank.", "") for e in events}
    failed = [e for e in events if e["type"].endswith("memo.failed") and not (e.get("data") or {}).get("retryable")]
    if failed:
        return f"FAILED@{(failed[-1].get('data') or {}).get('stage')}"
    for t, label in (("audio.memo.replied", "replied"), ("agent.invocation.completed", "agent done"),
                     ("agent.invocation.started", "agent running"), ("audio.memo.dispatched", "dispatched"),
                     ("audio.memo.transcribed", "transcribed"), ("audio.memo.received", "received"),
                     ("audio.memo.uploaded", "uploaded")):
        if t in types:
            return label
    if rec and rec.get("status") == "baseline":
        return "baseline (predates watcher)"
    return "in S3 only"


def cmd_list(args) -> int:
    objs = sorted(c.s3_list_inbox(), key=lambda o: o["last_modified"], reverse=True)[: args.n]
    print(f"{'time (UTC)':<21} {'agent':<16} {'memo_id':<10} {'furthest stage':<26} key")
    for o in objs:
        mid = c.memo_id_for(o["key"])
        try:
            events = c.candystore_events(mid)
        except Exception:  # noqa: BLE001
            events = []
        print(f"{c.iso(o['last_modified'])[:19]:<21} {str(c.agent_from_key(o['key'])):<16} {mid[:8]:<10} "
              f"{furthest(events, watcher_record(o['key'])):<26} {o['key']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    t = sub.add_parser("trace")
    t.add_argument("target", nargs="?", default="latest")
    t.add_argument("--logs", action="store_true", help="always print the watcher's log lines for this memo")
    l = sub.add_parser("list")
    l.add_argument("-n", type=int, default=15)
    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd is None:
        args = ap.parse_args(["trace"])
    return cmd_trace(args)


if __name__ == "__main__":
    sys.exit(main())

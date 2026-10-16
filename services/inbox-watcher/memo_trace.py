#!/usr/bin/env python3
"""memo_trace: one timeline for one voice memo, hop by hop.

  memo_trace.py trace [<memo_id>|<s3 key>|<file name>|latest] [--logs]
  memo_trace.py list  [-n 15]
  memo_trace.py retry <memo_id|key>   revive a failed memo at the stage it died in

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
import re
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

def evt_ts(ev: dict):
    """Millisecond time of a fact: data.occurred_at when the producer set it (the envelope `time` of
    watcher facts is truncated to whole seconds), else the envelope time."""
    return c.parse_iso(((ev.get("data") or {}).get("occurred_at")) or ev.get("time"))


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


def level_of(d: dict) -> str:
    """'max -8 dBFS, mean -30 dBFS over 6.4 s' from a transcribed/failed fact, '' when the watcher measured nothing."""
    if d.get("audio_max_dbfs") is None:
        return ""
    return c.level_text(d.get("audio_max_dbfs"), d.get("audio_mean_dbfs"), d.get("audio_duration_seconds"))


def capture_of(d: dict) -> str:
    """The device-reported capture level (data.capture of the uploaded fact), '' when the pad sent none."""
    cap = d.get("capture") or {}
    bits = [f"{k} {c.fmt_dbfs(cap[k])}" for k in ("peak_dbfs", "rms_dbfs") if isinstance(cap.get(k), (int, float))]
    return "device heard " + ", ".join(b.replace("_dbfs", "") for b in bits) if bits else ""


def lane_of(dispatched: dict | None, rec: dict | None = None, row: dict | None = None) -> str:
    """The gateway lane a memo's command rode: the dispatched fact's `lane`, else its command_subject,
    else the watcher record, else the journal row. A memo with none of those predates lanes: batch."""
    d = (dispatched or {}).get("data") or {}
    for cand in (d.get("lane"), c.lane_from_subject(d.get("command_subject")), (rec or {}).get("lane"), (row or {}).get("lane")):
        if cand in c.GATEWAY_CONSUMERS:
            return cand
    return "batch"


def watcher_unit_active() -> str:
    r = subprocess.run(["systemctl", "--user", "is-active", c.WATCHER_UNIT], capture_output=True, text=True)
    return r.stdout.strip() or "unknown"


def upload_log_line(key: str, memo_id: str, event: str = "upload", needle: str | None = None) -> tuple[str | None, str | None]:
    """(timestamp, line) of the upload-proxy log line of this `event` for this memo, if docker logs still has it.

    event="upload" is the PUT of the memo; event="playback" is the pad's playback beacon for the reply
    (those lines carry the reply key, which contains the memo id)."""
    r = subprocess.run(["docker", "logs", "--timestamps", c.UPLOAD_CONTAINER], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return None, f"docker logs failed: {(r.stderr or r.stdout).strip()[:120]}"
    hit = None
    for line in (r.stdout + r.stderr).splitlines():
        if f'"event":"{event}"' not in line:
            continue
        # a beacon line only counts when its own memo_id field matches (a legacy reply key has no memo id)
        if not (memo_id in line if event == "playback" else (key in line or memo_id in line)):
            continue
        if needle and needle not in line:
            continue
        if hit is None or '"status":200' in line:
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
            hops.append(Hop(name, OK, evt_ts(ev), describe(ev.get("data") or {}), optional))
        elif ctx["candystore"] != "ok":
            hops.append(Hop(name, UNKNOWN, detail=f"Candystore {ctx['candystore']}", optional=optional))
        else:
            hops.append(Hop(name, MISSING, detail=f"no bloodbank.audio.memo.{action} with correlationid={memo_id}", optional=optional))

    add_fact_hop("fact:uploaded", "uploaded",
                 lambda d: f"{d.get('bytes')} bytes ua={str(d.get('client_user_agent'))[:40]}"
                           + (f" | {capture_of(d)}" if capture_of(d) else ""), optional=True)
    add_fact_hop("fact:received", "received", lambda d: f"watcher saw it, lag {d.get('detect_lag_ms')}ms")
    add_fact_hop("fact:transcribed", "transcribed",
                 lambda d: f"{d.get('transcript_chars')} chars in {d.get('processing_seconds')}s ({d.get('model')})"
                           + (f", audio {level_of(d)}" if level_of(d) else "") + f": {str(d.get('transcript_text'))[:80]!r}")
    # The recording's level, from whichever transcribe-stage fact carries it (a silent or unrecognised memo never
    # gets a transcribed fact, only the failed one). It is the evidence behind a "silent microphone" verdict.
    lvl_src = next((x for x in [fact("transcribed")] + list(reversed(by_type.get("bloodbank.audio.memo.failed", [])))
                    if x and (x.get("data") or {}).get("audio_max_dbfs") is not None), None)
    if lvl_src:
        ld = lvl_src.get("data") or {}
        silent = ld["audio_max_dbfs"] < c.SILENT_MAX_DBFS
        dev = capture_of((fact("uploaded") or {}).get("data") or {})
        hops.append(Hop("audio_level", FAILED if silent else OK, evt_ts(lvl_src),
                        f"{level_of(ld)}  -> {'SILENT: no sound reached the recording' if silent else 'audible'}"
                        + (f" | {dev}" if dev else ""), optional=True))
    add_fact_hop("fact:dispatched", "dispatched",
                 lambda d: f"command {d.get('command_id')} -> {d.get('command_subject')} "
                           f"lane={d.get('lane') or c.lane_from_subject(d.get('command_subject')) or 'batch (pre-lane)'}"
                           + (f" (fallback: {d.get('lane_reason')})" if d.get("lane_reason") else ""))

    disp = fact("dispatched")
    command_id = (disp or {}).get("data", {}).get("command_id") or (rec or {}).get("command_id")
    ctx["command_id"] = command_id
    lane = lane_of(disp, rec)
    ctx["lane"] = lane

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
                lane = lane_of(disp, rec, row)
                ctx["lane"] = lane
                detail = (f"lane={row.get('lane') or lane} profile={row['profile']} state={row['state']} "
                          f"outcome={row.get('outcome')} created={row['created_at']} updated={row['updated_at']}"
                          + (f" failure_code={row['failure_code']}" if row.get("failure_code") else ""))
                if bad:
                    detail += f" reason={c.terminal_error(row)}"
                hops.append(Hop("gateway_journal", FAILED if bad else OK, c.parse_iso(row["created_at"]), detail))
            else:
                live = c.gateway_liveness(lane)
                detail = (f"gateway never created an execution row for {command_id} (lane={lane}); "
                          f"{c.gateway_liveness_text(live, lane)}")
                if live.get("ok") and not live.get("num_pending") and not live.get("num_ack_pending"):
                    detail += (f"  <- {lane} consumer is EMPTY: the gateway consumed this command and dropped it without a row "
                               "(unroutable target or bad envelope); see gateway_log below")
                hops.append(Hop("gateway_journal", MISSING, detail=detail))
                glines = c.gateway_log_lines([command_id, agent])
                if glines:
                    hops.append(Hop("gateway_log", FAILED, detail=glines[-1][:300]))
                route = c.registry_route(agent) if agent else None
                if route and route["ok"] is False:
                    hops.append(Hop("agent_route", FAILED, detail=route["reason"]))
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
        hops.append(Hop("agent:invocation.started", OK, evt_ts(started), f"producer={started.get('producer')}"))
    else:
        hops.append(Hop("agent:invocation.started", MISSING if ctx["candystore"] == "ok" else UNKNOWN,
                        detail="no bloodbank.agent.invocation.started for this command in Candystore"))
    if failed:
        d = failed.get("data") or {}
        hops.append(Hop("agent:invocation.done", FAILED, evt_ts(failed),
                        f"invocation.failed {d.get('error_code')}: {d.get('error_message')}"))
    elif done:
        hops.append(Hop("agent:invocation.done", OK, evt_ts(done), "invocation.completed"))
    elif row and row["state"] == "completed" and row.get("outcome") == "success":
        hops.append(Hop("agent:invocation.done", OK, c.parse_iso(row["updated_at"]), "journal completed/success (fact not in Candystore)"))
    else:
        hops.append(Hop("agent:invocation.done", MISSING if ctx["candystore"] == "ok" else UNKNOWN,
                        detail="no invocation.completed/failed for this command"))

    # 5b. what the agent actually received (Hermes session, keyed by chat_id = memo_id)
    if row and row["state"] == "completed":
        sent_chars = ((disp or {}).get("data") or {}).get("prompt_chars")
        sent_hash = ((disp or {}).get("data") or {}).get("prompt_sha256")
        try:
            found = c.find_reply(row["profile"], ctx["memo_id"])
        except Exception as e:  # noqa: BLE001
            hops.append(Hop("hermes_session", UNKNOWN, detail=str(e)[:140], optional=True))
        else:
            got = (found or {}).get("prompt")
            if got is None:
                hops.append(Hop("hermes_session", MISSING if found is None else UNKNOWN,
                                detail=f"no session with source=bloodbank chat_id={ctx['memo_id']} in profile {row['profile']}", optional=True))
            else:
                import hashlib
                same_len = sent_chars is None or len(got.strip()) == int(sent_chars)
                same_hash = sent_hash is None or hashlib.sha256(got.strip().encode()).hexdigest() == sent_hash or hashlib.sha256(got.encode()).hexdigest() == sent_hash
                ok = same_len and same_hash
                hops.append(Hop("hermes_session", OK if ok else FAILED, c.parse_iso(row["created_at"]),
                                (f"agent was given exactly what the watcher sent ({len(got)} chars): {got[:90]!r}" if ok else
                                 f"PROMPT MISMATCH: watcher sent {sent_chars} chars, the agent saw {len(got)}: {got[:120]!r}"), optional=ok))

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
    if reply_key:
        try:
            pts, pline = upload_log_line(reply_key, memo_id, event="playback", needle='"phase":"started"')
            if pts:
                hops.append(Hop("pad_playback_log", OK, c.parse_iso(pts), pline[:160], optional=True))
            else:
                hops.append(Hop("pad_playback_log", UNKNOWN, detail=pline or f"no playback beacon line in `docker logs {c.UPLOAD_CONTAINER}`", optional=True))
        except Exception as e:  # noqa: BLE001
            hops.append(Hop("pad_playback_log", UNKNOWN, detail=str(e)[:120], optional=True))
    played = sorted(by_type.get("bloodbank.audio.memo.played", []), key=lambda e: e["time"])
    p_start = next((e for e in played if (e.get("data") or {}).get("phase") == "started"), None)
    p_end = next((e for e in played if (e.get("data") or {}).get("phase") == "ended"), None)
    if p_start:
        d0 = p_start.get("data") or {}
        ctx["pad_age_s"] = (d0.get("reply_age_ms") or 0) / 1000.0
        extra = f", ended after {(p_end.get('data') or {}).get('played_seconds')}s" if p_end else ", end not reported"
        hops.append(Hop("played_on_pad", OK, evt_ts(p_start),
                        f"reply started {d0.get('reply_age_ms')} ms after it was rendered{extra} ({str(d0.get('client_user_agent'))[:40]})", optional=True))
    else:
        hops.append(Hop("played_on_pad", UNKNOWN,
                        detail="no playback report from the pad yet (it polls replies/ every 15s; a parked car reports nothing)", optional=True))

    # failed facts, positioned by time
    for ev in by_type.get("bloodbank.audio.memo.failed", []):
        d = ev.get("data") or {}
        hops.append(Hop(f"fact:failed[{d.get('stage')}]", FAILED, evt_ts(ev),
                        f"{d.get('error_code')}: {str(d.get('error_message'))[:200]} (retryable={d.get('retryable')}, attempt={d.get('attempt')})",
                        optional=bool(d.get("retryable"))))
    ctx["events"] = events
    return hops, ctx


def in_progress(rec: dict) -> str | None:
    """'at <stage> (Ns so far)' when the watcher is actively working this memo and is alive, else None."""
    if not rec or rec.get("status") != "active":
        return None
    hb = watcher_heartbeat()
    if not hb or hb.get("age_s") is None or hb["age_s"] > 60 or watcher_unit_active() != "active":
        return None
    since = rec.get("step_started_ts") or rec.get("dispatched_ts") or rec.get("received_ts") or rec.get("detected_ts")
    so_far = f" ({int(time.time() - since)}s so far)" if since else ""
    return f"at {rec.get('stage')}{so_far}; watcher heartbeat {int(hb['age_s'])}s old"


def timeout_verdict(h: Hop) -> str | None:
    """The gateway stopped the agent's turn at its per-turn wall clock: say so, not just "failed"."""
    if c.TURN_TIMEOUT not in h.detail:
        return None
    msg = re.sub(r"\s*\(retryable=.*\)$", "", h.detail.split(f"{c.TURN_TIMEOUT}:", 1)[-1].strip())
    return f"STOPPED AT agent finished: turn timeout - {msg}"


def silent_verdict(h: Hop, hops: list[Hop]) -> str | None:
    """The watcher measured the recording and found no sound in it: name the microphone, not the transcript."""
    if "silent_audio" not in h.detail:
        return None
    msg = re.sub(r"\s*\(retryable=.*\)$", "", h.detail.split("silent_audio:", 1)[-1].strip())
    dev = next((x.detail.split("| ", 1)[1] for x in hops if x.name == "audio_level" and "| " in x.detail), "")
    return f"STOPPED AT transcribe: SILENT MICROPHONE - {msg}" + (f" [{dev}]" if dev else "")


def verdict(hops: list[Hop], ctx: dict) -> tuple[str, bool]:
    rec = ctx.get("watcher_record") or {}
    # a terminal failed fact (retryable=false) always wins
    up = next((h for h in hops if h.name == "fact:uploaded" and h.status == OK and h.ts), None)
    # The pad's own silent_capture ("held back, nothing to send") is superseded when the recording was uploaded after
    # all ("send anyway"): from there the watcher's facts decide. Any other terminal failure still always wins.
    superseded = lambda h: "silent_capture" in h.detail and up is not None and h.ts is not None and up.ts >= h.ts  # noqa: E731
    terminal = [h for h in hops if h.name.startswith("fact:failed") and not h.optional and not superseded(h)]
    if not terminal:
        # the gateway's own invocation.failed can land before the watcher's memo.failed fact does
        timed = next((h for h in hops if h.name == "agent:invocation.done" and h.status == FAILED and timeout_verdict(h)), None)
        if timed:
            return timeout_verdict(timed), False
    if terminal:
        h = terminal[-1]
        if timeout_verdict(h):
            return timeout_verdict(h), False
        if silent_verdict(h, hops):
            return silent_verdict(h, hops), False
        if "silent_capture" in h.detail:
            msg = re.sub(r"\s*\(retryable=.*\)$", "", h.detail.split("silent_capture:", 1)[-1].strip())
            return f"STOPPED AT record: SILENT MICROPHONE - {msg} (the pad held the recording back; nothing was uploaded)", False
        return f"STOPPED AT {h.name[len('fact:failed['):-1]}: {h.detail}", False
    for h in hops:
        if h.name.startswith("fact:failed"):
            continue  # a retryable failure is annotation; the stage hop it belongs to decides the verdict
        if h.optional and h.status != FAILED:
            continue
        if h.status == OK:
            continue
        stage_hint = ""
        if h.name in ("fact:received", "fact:transcribed", "fact:dispatched", "reply_object", "fact:replied"):
            stage_hint = watcher_hint(rec)
        if h.name == "s3_object":
            client = [x for x in hops if x.name.startswith("fact:failed") and any(f"[{st}]" in x.name for st in ("record", "upload"))]
            extra = f" | device reported {client[-1].name[len('fact:'):]}: {client[-1].detail}" if client else ""
            return f"STOPPED AT s3_object: {h.detail}{extra}", False
        busy = in_progress(rec)
        if busy:
            ctx["in_progress"] = True
            return f"IN PROGRESS {busy} (not stopped: waiting on {h.name})", False
        return f"STOPPED AT {h.name}: {h.detail}{stage_hint}", False
    s3 = next((h for h in hops if h.name == "s3_object"), None)
    end = next((h for h in hops if h.name == "reply_object" and h.ts), None)
    if s3 and s3.ts and end and end.ts:
        pad = next((h for h in hops if h.name == "played_on_pad" and h.status == OK and h.ts), None)
        tail = (f"; played on the pad {ctx.get('pad_age_s', (pad.ts - end.ts).total_seconds()):.1f}s after the reply was rendered"
                if pad else "; playback on the pad not reported")
        return f"COMPLETE in {(end.ts - s3.ts).total_seconds():.1f}s{tail}", True
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
    print(f"lane     {ctx.get('lane') or '-'}   queues: {c.gateway_lanes_text()}")
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
    if not key and re.fullmatch(r"[0-9a-fA-F-]{8,36}", arg):
        # The object may be gone (deleted, or never existed: a phantom key). The bus still remembers it.
        try:
            if len(arg) == 36:
                evs = c.candystore_events(arg.lower())
            else:  # 8+ char prefix of a memo that never reached S3 (the pad shows the first 8): scan recent memo facts
                evs = c.http_json(f"{c.CANDYSTORE_URL}/events?type=bloodbank.audio.memo.failed&limit=200", timeout=8).get("events", [])
                evs = [e for e in evs if str((e.get("data") or {}).get("memo_id", "")).startswith(arg.lower())]
            for ev in evs:
                k = (ev.get("data") or {}).get("s3_key")
                if isinstance(k, str) and k.startswith(f"{c.INBOX_PREFIX}/"):
                    return k
        except Exception:  # noqa: BLE001
            pass
    if not key:
        raise SystemExit(f"no inbox object matches {arg!r}")
    return key


def cmd_trace(args) -> int:
    key = resolve_key(args.target)
    hops, ctx = build(key)
    render(hops, ctx)
    text, complete = verdict(hops, ctx)
    print()
    print(paint(OK if complete else (MISSING if ctx.get("in_progress") else FAILED), f"VERDICT  {text}"))
    if args.logs or not complete:
        lines = watcher_logs(ctx["memo_id"])
        if lines:
            print(f"\nwatcher log ({len(lines)} lines, journalctl --user -u {c.WATCHER_UNIT}):")
            for ln in lines[-15 if not args.logs else -40:]:
                print("  " + ln[:260])
    return 0 if complete else (3 if ctx.get("in_progress") else 2)


def cmd_retry(args) -> int:
    """Ask the running watcher to revive a failed/skipped memo at the stage it died in."""
    key = resolve_key(args.target)
    mid = c.memo_id_for(key)
    rec = watcher_record(key)
    if rec is None:
        print(f"watcher has no record of {key}; nothing to retry (re-record it, or restart the watcher after fixing S3)")
        return 1
    if rec.get("status") not in ("failed", "skipped"):
        print(f"memo is {rec.get('status')} at {rec.get('stage')}: only failed or skipped memos can be retried")
        return 1
    ctl = c.STATE_DIR / "control"
    ctl.mkdir(parents=True, exist_ok=True)
    (ctl / f"retry-{mid}").write_text("")
    print(f"retry requested for {mid} (resumes at {rec.get('resume_stage') or 'receive'}); watch it with: mise run memo:trace {mid}")
    return 0


def furthest(events: list[dict], rec: dict | None) -> str:
    types = {e["type"].replace("bloodbank.", "") for e in events}
    failed = [e for e in events if e["type"].endswith("memo.failed") and not (e.get("data") or {}).get("retryable")]
    if failed:
        return f"FAILED@{(failed[-1].get('data') or {}).get('stage')}"
    for t, label in (("audio.memo.played", "played on pad"), ("audio.memo.replied", "replied"), ("agent.invocation.completed", "agent done"),
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
    print(f"{'time (UTC)':<21} {'agent':<16} {'memo_id':<10} {'lane':<12} {'furthest stage':<26} key")
    for o in objs:
        mid = c.memo_id_for(o["key"])
        try:
            events = c.candystore_events(mid)
        except Exception:  # noqa: BLE001
            events = []
        rec = watcher_record(o["key"])
        disp = next((e for e in reversed(events) if e["type"].endswith("audio.memo.dispatched")), None)
        lane = lane_of(disp, rec) if (disp or (rec or {}).get("lane")) else "-"
        print(f"{c.iso(o['last_modified'])[:19]:<21} {str(c.agent_from_key(o['key'])):<16} {mid[:8]:<10} {lane:<12} "
              f"{furthest(events, rec):<26} {o['key']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    t = sub.add_parser("trace")
    t.add_argument("target", nargs="?", default="latest")
    t.add_argument("--logs", action="store_true", help="always print the watcher's log lines for this memo")
    r = sub.add_parser("retry")
    r.add_argument("target")
    l = sub.add_parser("list")
    l.add_argument("-n", type=int, default=15)
    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "retry":
        return cmd_retry(args)
    if args.cmd is None:
        args = ap.parse_args(["trace"])
    return cmd_trace(args)


if __name__ == "__main__":
    sys.exit(main())

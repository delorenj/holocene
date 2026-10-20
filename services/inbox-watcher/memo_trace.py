#!/usr/bin/env python3
"""memo_trace: one timeline for one voice memo, hop by hop.

  memo_trace.py trace [<memo_id>|<s3 key>|<file name>|latest] [--logs]
  memo_trace.py list  [-n 15]
  memo_trace.py retry <memo_id|key>   revive a failed, skipped or cancelled memo at the stage it stopped in
  memo_trace.py cancel <memo_id|key|latest>   stop a memo: before dispatch nothing is sent; after it the agent may still
                                              run, but its reply is not spoken

Every hop reports OK / MISSING / FAILED / UNKNOWN with a timestamp and the
latency since the previous hop, and the run ends with ONE verdict line:
  STOPPED AT <hop>: <why>     or     COMPLETE in <N>s     or     CANCELLED before|after dispatch
A memo whose interactive turn timed out and was re-dispatched on the batch lane shows both dispatches and both turns
(the first turn's hops are marked superseded and never decide the verdict).

Evidence sources (all read-only): S3 (mc), `docker logs agent-pad-upload`,
Candystore /events?correlationid=<memo_id>, the gateway journal by command id,
the watcher's state/heartbeat files, and NATS monitoring for the gateway
consumer. See README.md for the exact commands behind each hop.
"""

from __future__ import annotations

import argparse
import json
import os
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
    def __init__(self, name, status, ts=None, detail="", optional=False, superseded=False):
        self.name, self.status, self.ts, self.detail, self.optional = name, status, ts, detail, optional
        self.superseded = superseded  # a hop of an earlier turn that the memo moved past (escalated to the batch lane)


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
    # rms_dbfs is the RMS of the recorder's 100 ms WINDOW PEAKS, not of the samples, so it reads louder than the
    # watcher's true mean. Labelled "window avg" so the two numbers on one trace never look like one measurement.
    names = {"peak_dbfs": "peak", "rms_dbfs": "window avg"}
    bits = [f"{names[k]} {c.fmt_dbfs(cap[k])}" for k in ("peak_dbfs", "rms_dbfs") if isinstance(cap.get(k), (int, float))]
    return "device heard " + ", ".join(bits) if bits else ""


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


EARSHOT_BUCKET = os.environ.get("MEMO_EARSHOT_BUCKET", "earshot")
EARSHOT_JSONL = Path(os.environ.get("EARSHOT_BEACON_JSONL",
                                    Path.home() / ".local/share/earshot/beacons/beacons.jsonl"))
PHONE_PHASES = ("detected", "started", "finished", "failed", "missed")


def earshot_stat(ekey: str) -> dict | None:
    r = c.mc("stat", "--json", f"{c.S3_ALIAS}/{EARSHOT_BUCKET}/{ekey}", timeout=20)
    if r.returncode != 0:
        return None
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return None
    return {"size": d.get("size"), "last_modified": c.parse_iso(d.get("lastModified"))}


def earshot_beacons(ekey: str) -> list[dict]:
    """The phone's beacons for one Earshot object, from the upload proxy's durable JSONL (rotated copy included)."""
    out = []
    for path in (EARSHOT_JSONL.with_name(EARSHOT_JSONL.name + ".old"), EARSHOT_JSONL):
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            if ekey not in line:
                continue
            try:
                b = json.loads(line)
            except ValueError:
                continue
            if b.get("key") == ekey and b.get("phase") in PHONE_PHASES and b.get("status", 200) == 200:
                out.append(b)
    return out


def phone_time(b: dict):
    """Server time of a beacon: the phone's `at` corrected by its reported clock skew, else the proxy receive time."""
    at, skew = c.parse_iso(b.get("at")), b.get("clock_skew_ms")
    if at is not None and isinstance(skew, (int, float)):
        from datetime import timedelta
        return at - timedelta(milliseconds=skew)
    return c.parse_iso(b.get("ts")) or at


def earshot_hops(ekey: str | None, tkey: str | None = None, skipped: str | None = None) -> list[Hop]:
    if not ekey and skipped:
        why = {"car_spoke": "the car that sent the memo was already speaking the reply",
               "car_live": "the car that sent the memo was connected and spoke the reply itself"}.get(skipped, skipped)
        return [Hop("phone_object", OK, detail=f"not mirrored to the phone: {why} (a paired phone plays through the car's "
                                               "speakers: the same reply twice, or into a recording)", optional=True)]
    if not ekey:
        return [Hop("phone_object", UNKNOWN, detail="no Earshot mirror recorded for this reply (MEMO_EARSHOT_CHANNEL off, "
                                                  "or the reply predates the mirror)", optional=True)]
    hops = []
    # The full reply text goes up before the audio, so its hop comes first. Optional: the upload is fail-open.
    if tkey:
        ts_ = earshot_stat(tkey)
        hops.append(Hop("phone_text", OK if ts_ else MISSING, ts_["last_modified"] if ts_ else None,
                        f"s3://{EARSHOT_BUCKET}/{tkey}  {ts_['size']} bytes (the full reply text)" if ts_
                        else f"s3://{EARSHOT_BUCKET}/{tkey} not in bucket", optional=not ts_))
    else:
        hops.append(Hop("phone_text", UNKNOWN, detail="no full-text sidecar recorded for this reply (it predates the sidecar, "
                                                      "or its upload failed open)", optional=True))
    st = earshot_stat(ekey)
    hops.append(Hop("phone_object", OK if st else MISSING, st["last_modified"] if st else None,
                    f"s3://{EARSHOT_BUCKET}/{ekey}  {st['size']} bytes" if st else f"s3://{EARSHOT_BUCKET}/{ekey} not in bucket",
                    optional=not st))
    lm = st["last_modified"] if st else None
    first: dict[str, dict] = {}
    for b in sorted(earshot_beacons(ekey), key=lambda b: str(b.get("ts"))):
        t = phone_time(b)
        if lm is not None and t is not None and (lm - t).total_seconds() > 2:
            continue  # a beacon for an earlier generation of this key
        first.setdefault(b["phase"], b)
    for phase in PHONE_PHASES:
        b = first.get(phase)
        if b is None:
            if phase in ("detected", "started", "finished") and "failed" not in first and "missed" not in first:
                hops.append(Hop(f"phone_{phase}", UNKNOWN, detail="no beacon from the phone yet (earshot status: is it listening?)",
                                optional=True))
            continue
        bad = phase in ("failed", "missed")
        hops.append(Hop(f"phone_{phase}", FAILED if bad else OK, phone_time(b),
                        f"{b.get('device')} app {b.get('app_version')}" + (f": {b.get('error')}" if b.get("error") else ""),
                        optional=not bad))
    return hops


PROGRESS_SHOWN = 8  # a turn with more progress lines than this shows the first and last few and counts the rest


def progress_hops(by_type: dict[str, list[dict]], command_id: str | None) -> list[Hop]:
    """One optional hop per progress line of this command (agent:progress#<seq>) and per narration the watcher spoke for
    it (car:narrated#<n>), interleaved by time. A long turn shows its first and last lines with a count between."""
    if not command_id:
        return []
    lines = [(evt_ts(e), "p", e) for e in by_type.get(c.PROGRESS_TYPE, [])
             if (e.get("data") or {}).get("command_id") == command_id]
    spoken = [(evt_ts(e), "n", e) for e in by_type.get("bloodbank.audio.memo.narrated", [])
              if (e.get("data") or {}).get("command_id") == command_id]
    lines.sort(key=lambda x: ((x[2].get("data") or {}).get("seq") or 0))
    if len(lines) > PROGRESS_SHOWN:
        head, tail = lines[:3], lines[-3:]
        hidden = len(lines) - 6
        mid = (head[-1][0], "gap", {"data": {"hidden": hidden}})
        lines = head + [mid] + tail
    hops = []
    for ts, kind, e in sorted(lines + spoken, key=lambda x: (x[0] is None, x[0] or 0)):
        d = e.get("data") or {}
        if kind == "gap":
            hops.append(Hop("agent:progress...", OK, None, f"{d['hidden']} more progress lines", optional=True))
        elif kind == "p":
            hops.append(Hop(f"agent:progress#{d.get('seq')}", OK, ts,
                            f"{d.get('elapsed_seconds')}s into the turn: {str(d.get('text') or '')[:110]!r}", optional=True))
        else:
            hops.append(Hop(f"car:narrated#{d.get('narration')}", OK, ts,
                            f"spoke progress #{d.get('seq')} -> {d.get('progress_s3_key')} (tts {d.get('tts_seconds')}s "
                            f"{d.get('tts_engine')}, {d.get('elapsed_seconds')}s after dispatch)", optional=True))
    return hops


def speech_events(by_type: dict[str, list[dict]]) -> list[dict]:
    """The car's speech-arbiter decisions for this memo (audio.memo.notified), oldest first."""
    return sorted(by_type.get("bloodbank.audio.memo.notified", []), key=lambda e: evt_ts(e) or c.now_utc())


def speech_lines(events: list[dict], t0) -> list[str]:
    """'+0.8s  ack      started   since stop 412 ms' ... for render(): every decision, relative to the upload."""
    out = []
    for e in events:
        d = e.get("data") or {}
        ts = evt_ts(e)
        rel = f"{(ts - t0).total_seconds():+.1f}s" if ts and t0 else "-"
        bits = [f"since stop {d['since_stop_ms']} ms" if isinstance(d.get("since_stop_ms"), int) else "",
                f"reason {d.get('reason')}" if d.get("reason") else "",
                "while recording" if d.get("recording") is True else "",
                f"mic {d.get('mic')}" if d.get("mic") not in (None, "idle") else ""]
        out.append(f"  {rel:<9} {str(d.get('utterance')):<9} {str(d.get('decision')):<12} "
                   + "  ".join(b for b in bits if b))
    return out


# The car's words (SpeechArbiter wire: kinds ack|echo|progress|cue|reply, actions start|end|halt|drop|deferred) and the
# schema's examples (heard, started) both count.
UTTERANCE_WORDS = {"ack": ("ack",), "heard": ("echo", "heard"), "progress": ("progress",), "reply": ("reply",)}
STARTED_WORDS = ("start", "started")


def first_at(events: list[dict], utterance: str):
    """When the car first STARTED saying this kind of thing for the memo, on the SERVER's clock (when the proxy got the
    decision, the fact's time), else None. Never the device's own clock (data.device_at): it is compared with server
    facts here, and the sim's ran 1.3 s behind (the real car's skew is unknown); the pad posts each decision at once."""
    words = UTTERANCE_WORDS.get(utterance, (utterance,))
    e = next((x for x in events if (x.get("data") or {}).get("utterance") in words
              and (x.get("data") or {}).get("decision") in STARTED_WORDS), None)
    if not e:
        return None
    return evt_ts(e) or c.parse_iso((e.get("data") or {}).get("device_at"))


def upload_ts(hops: list[Hop]):
    """When the memo was uploaded: the proxy's uploaded fact (milliseconds), else the S3 object's LastModified (whole
    seconds only: an ack said 0.2 s before the upload finished would read +0.8 s)."""
    for name in ("fact:uploaded", "s3_object"):
        ts = next((h.ts for h in hops if h.name == name and h.status == OK and h.ts), None)
        if ts is not None:
            return ts
    return None


def timing_line(ctx: dict, hops: list[Hop]) -> str | None:
    """Time to the first thing the driver heard, hop by hop: ack, heard echo, first progress, first narration, reply."""
    t0 = upload_ts(hops)
    if t0 is None:
        return None
    sp = ctx.get("speech") or []
    bits = []

    def rel(label, ts):
        if ts is not None:
            bits.append(f"{label} {(ts - t0).total_seconds():+.1f}s")
    rel("ack", first_at(sp, "ack"))
    rel("heard-echo", first_at(sp, "heard"))
    # any turn: an escalated memo's first turn spoke to the driver too
    rel("first progress", min((h.ts for h in hops if "agent:progress#" in h.name and h.ts), default=None))
    rel("first narration", min((h.ts for h in hops if "car:narrated#" in h.name and h.ts), default=None))
    rel("progress played", first_at(sp, "progress"))
    first_chunk = ctx.get("first_chunk_ts")
    replied = next((h.ts for h in hops if h.name == "fact:replied" and h.status == OK and h.ts), None)
    rel("first chunk up", first_chunk)
    rel("reply up", replied)
    played = first_at(sp, "reply") or next((h.ts for h in hops if h.name == "played_on_pad" and h.status == OK), None)
    rel("reply played", played)
    line = "since upload (server clock): " + " | ".join(bits) if bits else None
    # Time to first response once the agent is done: what chunked speech and the push channel are for.
    done = next((h.ts for h in hops if h.name == "agent:invocation.done" and h.status == OK and h.ts), None)
    if line and done:
        after = []
        # the car on the server's clock (its played beacon) like the agent's finish; the device clock only without one
        car = next((h.ts for h in hops if h.name == "played_on_pad" and h.status == OK and h.ts), None) or played
        for label, ts in (("first chunk up", first_chunk), ("reply up", replied), ("car speaking", car)):
            if ts is not None:
                after.append(f"{label} {(ts - done).total_seconds():+.1f}s")
        if after:
            line += "\n         after the agent finished: " + " | ".join(after)
    return line


def status_hop(key: str, memo_id: str) -> Hop:
    """The car's status object as it is in the bucket now (optional: the watcher writes it fail-open)."""
    skey = c.status_key_for(key, memo_id)
    doc = c.s3_read_json(skey)
    if doc is None:
        return Hop("car_status_object", UNKNOWN, detail=f"no {skey} (written by watchers since 2026-10-20)", optional=True)
    narr = doc.get("narration") or {}
    detail = (f"{skey}: stage={doc.get('stage')} progress_seq={doc.get('progress_seq')} "
              f"narrations={narr.get('n', 0)} elapsed={doc.get('elapsed_s')}s"
              + (f" error={doc.get('error_code')}" if doc.get("error_code") else ""))
    return Hop("car_status_object", OK, c.parse_iso(doc.get("updated_at")), detail, optional=True)


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

    # The watcher's "this memo is moving again" marker is a `received` fact with revived=true: it places the memo in
    # time (see history()) but is not the detection, so the received hop never shows it.
    ctx["stage_times"] = [(evt_ts(e), e["type"].rsplit(".", 1)[-1]) for e in events
                          if e["type"].rsplit(".", 1)[-1] in ("received", "transcribed", "dispatched") and e["type"].startswith("bloodbank.audio.memo.")]

    def fact(action: str) -> dict | None:
        lst = by_type.get(f"bloodbank.audio.memo.{action}")
        if lst and action == "received":
            lst = [e for e in lst if not (e.get("data") or {}).get("revived")] or lst
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
    def describe_dispatch(d: dict) -> str:
        base = (f"command {d.get('command_id')} -> {d.get('command_subject')} "
                f"lane={d.get('lane') or c.lane_from_subject(d.get('command_subject')) or 'batch (pre-lane)'}")
        if d.get("lane_reason") == c.ESCALATED_REASON:
            return (base + f" ESCALATED: the interactive turn (command {d.get('escalated_from_command_id')}) hit the "
                    "gateway's wall clock, so the same prompt was re-dispatched on the batch lane")
        return base + (f" (fallback: {d.get('lane_reason')})" if d.get("lane_reason") else "")

    # 4/5/5b. one command's journal row, agent turn and (for the current one) what the agent was given
    def turn_hops(command_id, disp, prior: int = 0):
        """gateway_journal + agent:invocation.* (+ hermes_session) for ONE command. prior=N numbers an EARLIER turn of a
        memo that was re-dispatched (escalated): its hops are history, named turnN:..., and never decide the verdict."""
        start = len(hops)
        row = None
        lane = lane_of(disp, rec)
        if not prior:
            ctx["lane"] = lane
        # 4. gateway journal (by command id, never 'latest')
        if command_id:
            try:
                row = c.journal_row(command_id)
            except Exception as e:  # noqa: BLE001
                hops.append(Hop("gateway_journal", UNKNOWN, detail=str(e)[:140]))
            else:
                if row:
                    bad = row["state"].startswith("rejected") or (row["state"] == "completed" and row.get("outcome") not in ("success", None))
                    lane = lane_of(disp, rec, row)
                    if not prior:
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
        # 5a. what the agent said it was doing (gateway: agent.invocation.progressed) and which of it the car heard
        # (watcher: audio.memo.narrated), in time order. Annotations: a quick or silent turn has none.
        hops.extend(progress_hops(by_type, command_id))
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
        if row and row["state"] == "completed" and not prior:
            sent_chars = ((disp or {}).get("data") or {}).get("prompt_chars")
            sent_hash = ((disp or {}).get("data") or {}).get("prompt_sha256")
            try:
                # the user message of THIS command: a retried or escalated command shares the memo's session
                found = c.find_reply(row["profile"], ctx["memo_id"], prompt_sha256=sent_hash,
                                     since=evt_ts(disp).timestamp() if disp and evt_ts(disp) else None)
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
        if prior:
            for h in hops[start:]:
                h.name, h.superseded = f"turn{prior}:{h.name}", True

    # 3b. dispatches. A memo whose interactive turn timed out is re-dispatched on the batch lane (or retried by hand):
    # every dispatch gets its own hops, and the earlier ones are marked superseded.
    disps = by_type.get("bloodbank.audio.memo.dispatched", [])
    last_cmd = ((disps[-1].get("data") or {}).get("command_id") if disps else None)
    rec_cmd = (rec or {}).get("command_id")
    # the escalation is minted (new command id saved) but its dispatched fact has not landed yet
    pending_esc = bool(rec and c.memo_escalated(rec) and rec_cmd and rec_cmd != last_cmd)
    for i, ev in enumerate(disps if pending_esc else disps[:-1], 1):
        d = ev.get("data") or {}
        hops.append(Hop(f"fact:dispatched({i})", OK, evt_ts(ev), describe_dispatch(d), optional=True))
        turn_hops(d.get("command_id"), ev, prior=i)
    if pending_esc:
        disp, command_id = None, rec_cmd
        hops.append(Hop("fact:dispatched", MISSING,
                        detail=f"escalating: the interactive turn timed out; batch command {rec_cmd} is not published yet"))
    else:
        add_fact_hop("fact:dispatched", "dispatched", describe_dispatch)
        disp = fact("dispatched")
        command_id = (disp or {}).get("data", {}).get("command_id") or rec_cmd
    ctx["command_id"] = command_id
    ctx["escalated_from"] = ((disp or {}).get("data") or {}).get("escalated_from_command_id") or (
        (rec or {}).get("escalated_from_command_id") if c.memo_escalated(rec or {}) else None)
    turn_hops(command_id, disp)

    # 6. reply: chunk by chunk (audio.memo.voiced: the car can start on chunk 1), then the full file (replied)
    voiced = sorted(by_type.get("bloodbank.audio.memo.voiced", []), key=lambda e: e.get("time") or "")
    firsts: dict = {}
    for e in voiced:  # a stage retry re-uploads a chunk under the same key; its first announcement counts
        firsts.setdefault((e.get("data") or {}).get("chunk"), e)
    chunks = [firsts[k] for k in sorted(k for k in firsts if isinstance(k, int))]
    ctx["first_chunk_ts"] = evt_ts(chunks[0]) if chunks else None
    for e in (chunks[:1] + chunks[-1:] if len(chunks) > 1 else chunks):
        d = e.get("data") or {}
        since = d.get("since_agent_done_seconds")
        hops.append(Hop(f"car:chunk#{d.get('chunk')}of{d.get('chunks')}", OK, evt_ts(e),
                        f"{d.get('spoken_chars')} chars, tts {d.get('tts_seconds')}s"
                        + (f", {since}s after the agent finished" if since is not None else "")
                        + f" -> {d.get('chunk_s3_key')}"
                        + (f" ({len(chunks) - 2} chunks between)" if len(chunks) > 2 and d.get("chunk") == 1 else ""),
                        optional=True))
    add_fact_hop("fact:replied", "replied",
                 lambda d: f"{d.get('reply_chars')} chars, tts {d.get('tts_seconds')}s ({d.get('tts_engine')}) -> {d.get('reply_s3_key')}"
                           + (f", {d.get('reply_chunks')} chunks (first up {d.get('first_chunk_seconds')}s, last "
                              f"{d.get('last_chunk_seconds')}s after the reply text)" if d.get("reply_chunks") else "")
                           + (", spoken as a late reply" if d.get("late") else "")
                           + (" (after escalating to the batch lane)" if d.get("escalated") else ""))
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
        # The honest car lag: from the moment there was audio to play (the first chunk, else the full reply's replied
        # fact) to the pad's "started". reply_age_ms counts from the reply key's stamp, which is taken BEFORE the voice
        # is rendered, so it also contains the whole TTS time (the 10-22 s "car lag" of 2026-10-19/20 was mostly that).
        avail = ctx.get("first_chunk_ts") or (evt_ts(rep) if rep else None)
        lag = (evt_ts(p_start) - avail).total_seconds() if avail and evt_ts(p_start) else None
        ctx["pad_lag_s"] = lag
        ctx["pad_from"] = "the first chunk" if ctx.get("first_chunk_ts") else "the reply"
        extra = f", ended after {(p_end.get('data') or {}).get('played_seconds')}s" if p_end else ", end not reported"
        hops.append(Hop("played_on_pad", OK, evt_ts(p_start),
                        (f"reply started {lag:.1f}s after {ctx['pad_from']} was up" if lag is not None else "reply started")
                        + f" ({d0.get('reply_age_ms')} ms after the key stamp, TTS included){extra} "
                        f"({str(d0.get('client_user_agent'))[:40]})", optional=True))
    else:
        hops.append(Hop("played_on_pad", UNKNOWN,
                        detail="no playback report from the pad yet (replies reach it over the push channel /upload/events, with a "
                               "6 s poll behind it while that is live, else 2 s for 10 min after a send and 15 s after that; only "
                               "the pad that sent the memo plays it; a parked car reports nothing)", optional=True))

    # 7. the phone: the same reply mirrored into the Earshot channel (its full text first), and the device's own beacons for it
    ekey = ((rep or {}).get("data") or {}).get("earshot_key") or (rec or {}).get("earshot_key")
    tkey = ((rep or {}).get("data") or {}).get("earshot_text_key") or (rec or {}).get("earshot_text_key")
    skipped = ((rep or {}).get("data") or {}).get("earshot_skipped") or (rec or {}).get("earshot_skipped")
    ctx["earshot_key"], ctx["earshot_text_key"] = ekey, tkey
    if reply_key:
        try:
            hops.extend(earshot_hops(ekey, tkey, skipped))
        except Exception as e:  # noqa: BLE001
            hops.append(Hop("phone_object", UNKNOWN, detail=str(e)[:140], optional=True))

    # 8. the car's status object (what the tile shows) and its speech arbiter's decisions (rendered as their own block)
    try:
        hops.append(status_hop(key, memo_id))
    except Exception as e:  # noqa: BLE001
        hops.append(Hop("car_status_object", UNKNOWN, detail=str(e)[:140], optional=True))
    ctx["speech"] = speech_events(by_type)

    # failed facts, positioned by time
    for ev in by_type.get("bloodbank.audio.memo.failed", []):
        d = ev.get("data") or {}
        hops.append(Hop(f"fact:failed[{d.get('stage')}]", FAILED, evt_ts(ev),
                        f"{d.get('error_code')}: {str(d.get('error_message'))[:200]} (retryable={d.get('retryable')}, attempt={d.get('attempt')}"
                        + (f", after_dispatch={d.get('after_dispatch')}" if "after_dispatch" in d else "") + ")",
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


def cancel_verdict(h: Hop) -> str | None:
    """`memo:cancel` ended this memo. Say whether anything had been sent: before dispatch nothing was; after it the agent
    may still have run, and only its reply was held back."""
    if h.name != f"fact:failed[{c.CANCELLED}]":
        return None
    if "after_dispatch=True" in h.detail:
        return "CANCELLED after dispatch; reply not spoken"
    return "CANCELLED before dispatch"


def history(ts, after_dispatch_cancel: bool, stage_times: list, rec: dict | None) -> bool:
    """Has the memo moved past the failed (or cancelled) fact published at `ts`? True when a later stage fact exists
    (received incl. the watcher's revive marker, transcribed, dispatched), or when the watcher's record is active and was
    revived or dispatched after it. Only while the memo is unfinished in the watcher's eyes: a failed or cancelled record
    is exactly what its facts say, and the dispatched fact the watcher still publishes for a command that was already
    in flight when it was cancelled is bookkeeping, not a revival."""
    if ts is None or (rec and rec.get("status") != "active"):
        return False
    for t, kind in stage_times:
        if t and t > ts and not (after_dispatch_cancel and kind == "dispatched"):
            return True
    if rec:
        return max(rec.get("revived_ts") or 0, rec.get("dispatched_ts") or 0) > ts.timestamp()
    return False


def verdict(hops: list[Hop], ctx: dict) -> tuple[str, bool]:
    rec = ctx.get("watcher_record") or {}
    # a terminal failed fact (retryable=false) always wins
    up = next((h for h in hops if h.name == "fact:uploaded" and h.status == OK and h.ts), None)
    # The pad's own silent_capture ("held back, nothing to send") is superseded when the recording was uploaded after
    # all ("send anyway"): from there the watcher's facts decide. Any other terminal failure still always wins.
    superseded = lambda h: "silent_capture" in h.detail and up is not None and h.ts is not None and up.ts >= h.ts  # noqa: E731
    terminal = [h for h in hops if h.name.startswith("fact:failed") and not h.optional and not superseded(h)]
    # A failure (a cancel, a held memo) that `memo:retry` later got past is history: the reply that went out after it decides.
    spoken = next((h for h in hops if h.name == "fact:replied" and h.status == OK and h.ts), None)
    if spoken:
        terminal = [h for h in terminal if not (h.ts and h.ts < spoken.ts)]
    # Likewise a failure the memo moved past: a later stage fact (a retry, a late-timeout escalation), or, while the
    # watcher still has the memo active, a revive or dispatch after it. Only the newest word decides.
    terminal = [h for h in terminal if not history(h.ts, h.name == f"fact:failed[{c.CANCELLED}]" and "after_dispatch=True" in h.detail,
                                                   ctx.get("stage_times", []), rec)]
    if not terminal:
        # the gateway's own invocation.failed can land before the watcher's memo.failed fact does
        timed = next((h for h in hops if h.name == "agent:invocation.done" and h.status == FAILED and timeout_verdict(h)), None)
        if timed:
            return timeout_verdict(timed), False
    if terminal:
        h = terminal[-1]
        if cancel_verdict(h):
            return cancel_verdict(h), False
        if timeout_verdict(h):
            return timeout_verdict(h), False
        if silent_verdict(h, hops):
            return silent_verdict(h, hops), False
        if "silent_capture" in h.detail:
            msg = re.sub(r"\s*\(retryable=.*\)$", "", h.detail.split("silent_capture:", 1)[-1].strip())
            return f"STOPPED AT record: SILENT MICROPHONE - {msg} (the pad held the recording back; nothing was uploaded)", False
        return f"STOPPED AT {h.name[len('fact:failed['):-1]}: {h.detail}", False
    for h in hops:
        if h.superseded:
            continue  # an earlier turn the memo moved past (escalated to the batch lane): history, not a stop
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
        lag = ctx.get("pad_lag_s")
        tail = ((f"; played on the pad {lag:.1f}s after {ctx.get('pad_from')} was up" if lag is not None
                 else "; played on the pad") if pad else "; playback on the pad not reported")
        if ctx.get("escalated_from"):
            tail = "; escalated to the batch lane after the interactive turn timed out (spoken as a late reply)" + tail
        phone = next((h for h in hops if h.name == "phone_started" and h.status == OK and h.ts), None)
        if phone:
            tail += (f"; speaking on the phone {(phone.ts - end.ts).total_seconds():.1f}s after the full reply was up "
                     f"({(phone.ts - s3.ts).total_seconds():.1f}s recording-to-voice)")
        elif ctx.get("earshot_key"):
            tail += "; phone playback not reported"
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
    if ctx.get("escalated_from"):
        print(f"escalated from {ctx['escalated_from']}: the interactive turn hit the gateway's wall clock; "
              "the same prompt was re-dispatched on the batch lane")
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
        sup = " (superseded: the memo was re-dispatched)" if h.superseded and h.status != OK else ""
        print(f"  {tag} {h.name:<26} {ts:<25} {lat:<8} {h.detail}{opt}{sup}")
    speech = ctx.get("speech") or []
    t0 = upload_ts(hops)
    if speech:
        print(f"\ncar speech ({len(speech)} arbiter decisions reported by the device, audio.memo.notified; time since upload):")
        for line in speech_lines(speech, t0):
            print(line)
    timing = timing_line(ctx, hops)
    if timing:
        print(f"\ntiming   {timing}")


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
    """Ask the running watcher to revive a failed/skipped/cancelled memo at the stage it stopped in."""
    key = resolve_key(args.target)
    mid = c.memo_id_for(key)
    rec = watcher_record(key)
    if rec is None:
        print(f"watcher has no record of {key}; nothing to retry (re-record it, or restart the watcher after fixing S3)")
        return 1
    if rec.get("status") not in ("failed", "skipped", "cancelled"):
        print(f"memo is {rec.get('status')} at {rec.get('stage')}: only failed, skipped or cancelled memos can be retried")
        return 1
    # The watcher's own resume rules (memo_common): a memo an old watcher cut to a 300-char prompt is revived at
    # transcribe (the audio is still in the inbox and is re-transcribed), everything else at resume_for. Print the
    # stage the watcher will really use, so the operator is not told "dispatch" for a re-transcribe.
    if c.truncated_by_old_watcher(rec):
        stage, note = "transcribe", "re-transcribe: an old watcher cut the prompt to 300 characters"
    else:
        stage, note = c.resume_for(rec), None
    ctl = c.STATE_DIR / "control"
    ctl.mkdir(parents=True, exist_ok=True)
    (ctl / f"retry-{mid}").write_text("")
    print(f"retry requested for {mid} (resumes at {stage}{'; ' + note if note else ''}); watch it with: mise run memo:trace {mid}")
    return 0


def cmd_cancel(args) -> int:
    """Ask the running watcher to cancel a memo that is still in flight (or failed but still watched for a late reply).

    Before the command is published nothing is ever sent. After it the agent may still run: the watcher cannot recall a
    published command, it only refuses to speak or mirror the reply. The same file mechanism as `retry`."""
    key = resolve_key(args.target)
    mid = c.memo_id_for(key)
    rec = watcher_record(key)
    if rec is None:
        print(f"watcher has no record of {key}; nothing to cancel")
        return 1
    if rec.get("status") == c.CANCELLED:
        print(f"memo {mid} is already cancelled (`mise run memo:retry {mid}` revives it)")
        return 1
    if rec.get("status") != "active" and not c.rescue_open(rec):
        print(f"memo is {rec.get('status')} at {rec.get('stage')}: only a memo still in flight can be cancelled")
        return 1
    after = c.cancel_after_dispatch(rec)
    ctl = c.STATE_DIR / "control"
    ctl.mkdir(parents=True, exist_ok=True)
    (ctl / f"cancel-{mid}").write_text("")
    what = ("after dispatch: the command is already out, so the agent may still run, but its reply will not be spoken"
            if after else "before dispatch: nothing will be sent to the agent")
    print(f"cancel requested for {mid} ({what}); watch it with: mise run memo:trace {mid}")
    return 0


def terminal_failure(events: list[dict], rec: dict | None = None) -> dict | None:
    """The last non-retryable failed fact, unless the memo moved past it: a reply went out after it (a retry got past
    it), or it is history (see history(): a later stage fact, a revive or dispatch while the watcher has it active)."""
    last = None
    for e in events:  # oldest first
        if e["type"].endswith("memo.failed") and not (e.get("data") or {}).get("retryable"):
            last = e
        elif e["type"].endswith("audio.memo.replied"):
            last = None
    if last is not None:
        stage_times = [(evt_ts(e), e["type"].rsplit(".", 1)[-1]) for e in events
                       if e["type"].rsplit(".", 1)[-1] in ("received", "transcribed", "dispatched")]
        d = last.get("data") or {}
        if history(evt_ts(last), d.get("stage") == c.CANCELLED and d.get("after_dispatch") is True, stage_times, rec):
            last = None
    return last


def furthest(events: list[dict], rec: dict | None) -> str:
    types = {e["type"].replace("bloodbank.", "") for e in events}
    failed = terminal_failure(events, rec)
    if failed:
        stage = (failed.get("data") or {}).get("stage")
        return "CANCELLED" if stage == c.CANCELLED else f"FAILED@{stage}"
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
        if ((disp or {}).get("data") or {}).get("lane_reason") == c.ESCALATED_REASON:
            lane = f"{lane} (esc.)"  # the interactive turn timed out; this is the batch re-dispatch
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
    x = sub.add_parser("cancel")
    x.add_argument("target")
    l = sub.add_parser("list")
    l.add_argument("-n", type=int, default=15)
    args = ap.parse_args()
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "retry":
        return cmd_retry(args)
    if args.cmd == "cancel":
        return cmd_cancel(args)
    if args.cmd is None:
        args = ap.parse_args(["trace"])
    return cmd_trace(args)


if __name__ == "__main__":
    sys.exit(main())

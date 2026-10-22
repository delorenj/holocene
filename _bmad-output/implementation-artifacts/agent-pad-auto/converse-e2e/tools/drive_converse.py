#!/usr/bin/env python3
"""Drive the fast in-car conversation desk on the Honda sim (emulator-5554 only, never the phone, never /usr/bin/adb).

One 'turn' = tap Record, wait for the mic, paplay a vox-synthesised utterance into the holo_testmic null sink (never gRPC
injection), tap Stop & Send, find the memo the watcher discovered, wait for the car's first audio and for the speech
to go quiet, then read the memo's Bloodbank facts (routed / dispatched / delegated / replied) from Candystore.

  drive_converse.py turn  <name> "<text>" [--quiet S] [--first-audio-timeout S] [--hold S]
  drive_converse.py rec-start | rec-say <name> "<text>" | rec-stop      (pieces, for the barge-in / overlap scenarios)
  drive_converse.py facts <memo_id|prefix> [--json]
  drive_converse.py wait-speech [--quiet S] [--timeout S]                (block until the car has been quiet for S seconds)
  drive_converse.py table                                                (latency table of every turn so far)

State in $W (default /tmp/conv-e2e): logcat.txt (logcat_loop.sh), tap.jsonl (sim_audio_tap.py), wav/, turns.jsonl.
Latency = Stop press (host clock) -> the car's first `start` of that memo's reply (device clock - offset); the audible
time is the first speaker-tap packet with rms >= 30 after that start.
"""
import argparse
import bisect
import datetime as dt
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

W = Path(os.environ.get("W", "/tmp/conv-e2e"))
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
LOG = W / "logcat.txt"
TAP = W / "tap.jsonl"
TURNS = W / "turns.jsonl"
HERE = Path(__file__).resolve()
REPO = next(p for p in HERE.parents if (p / "services/inbox-watcher/memo_common.py").exists())
sys.path.insert(0, str(REPO / "services/inbox-watcher"))
import memo_common as c  # noqa: E402

SPEECH = re.compile(r"^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+HoloceneSpeech:\s+(\w+) (\w*) id=(\S*) memo=(\S+) seq=(-?\d+) "
                    r"mic=(\w+) reason=(.*?) at=(\d+)\s*$")
REC_TAP = ("452", "655")


def adb(*a, tries=5):
    r = None
    for _ in range(tries):
        r = subprocess.run([ADB, "-s", "emulator-5554", *a], capture_output=True, text=True)
        if r.returncode == 0 and "error" not in (r.stderr or "").lower():
            return r.stdout
        time.sleep(0.5)
    return r.stdout if r else ""


def clock_offset():
    """device - host, seconds (median of 3)."""
    offs = []
    for _ in range(3):
        t0 = time.time()
        d = adb("shell", "date +%s.%N").strip()
        t1 = time.time()
        try:
            offs.append(float(d) - (t0 + t1) / 2)
        except ValueError:
            pass
        time.sleep(0.15)
    return statistics.median(offs) if offs else 0.0


def wait_log(pattern, since, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        with open(LOG, "rb") as f:
            f.seek(since)
            for line in f.read().decode("utf-8", "replace").splitlines():
                if pattern in line:
                    return time.time(), line
        time.sleep(0.05)
    return None, None


def synth(name, text, voice="rick"):
    out = W / "wav" / f"{name}.wav"
    if out.exists():
        return out
    (W / "wav").mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request("https://vox.delo.sh/synthesize-url", method="POST",
                                 data=json.dumps({"text": text, "voice": voice}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        meta = json.loads(r.read())
    with urllib.request.urlopen(meta["audio_url"], timeout=60) as r:
        blob = r.read()
    src = W / "wav" / f"{name}.src"
    src.write_bytes(blob)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(out)], check=True)
    (W / "wav" / f"{name}.txt").write_text(text)
    return out


def rec_start(out):
    s0 = os.path.getsize(LOG)
    out["start_pressed"] = time.time()
    adb("shell", "input", "tap", *REC_TAP)
    t, _ = wait_log("mic=recording reason=recording", s0)
    out["mic_recording_seen"] = t
    return t is not None


def rec_say(out, wav, hold=0.0):
    time.sleep(0.4)
    b = time.time()
    r = subprocess.run(["paplay", "--device=holo_testmic", str(wav)], capture_output=True, text=True)
    out["paplay"] = [b, time.time(), r.returncode, r.stderr.strip()[:200]]
    time.sleep(1.0 + hold)


def rec_stop(out):
    s1 = os.path.getsize(LOG)
    out["stop_pressed"] = time.time()
    adb("shell", "input", "tap", *REC_TAP)
    t, _ = wait_log("mic=idle reason=idle", s1, 6)
    if t is None:
        out["stop_retapped"] = time.time()
        adb("shell", "input", "tap", *REC_TAP)
        t, _ = wait_log("mic=idle reason=idle", s1, 15)
    out["mic_idle_seen"] = t
    return t is not None


def discover(after, agent="holocene-pm", timeout=25):
    """The watcher's `discovered` event after `after` (host epoch): returns (memo_id, key, discovered_ts)."""
    since = dt.datetime.fromtimestamp(after - 6).strftime("%Y-%m-%d %H:%M:%S")
    end = time.time() + timeout
    while time.time() < end:
        txt = subprocess.run(["journalctl", "--user", "-u", "holocene-inbox-watcher", "--since", since, "-o", "cat", "--no-pager"],
                             capture_output=True, text=True).stdout
        for line in txt.splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("event") == "discovered" and d.get("agent") == agent:
                ts = c.parse_iso(d["ts"])
                if ts and ts.timestamp() >= after - 3:
                    return d["memo_id"], d.get("key"), ts.timestamp()
        time.sleep(0.5)
    return None, None, None


def speech_events(since_dev, off):
    ev = []
    try:
        lines = open(LOG, errors="replace").read().splitlines()
    except OSError:
        return ev
    for l in lines:
        m = SPEECH.match(l)
        if m and float(m.group(1)) - off >= since_dev:
            ev.append({"t": float(m.group(1)) - off, "ev": m.group(2), "kind": m.group(3), "id": m.group(4), "memo": m.group(5),
                       "mic": m.group(7), "reason": m.group(8)})
    return ev


def tap_audible(t, within=4.0):
    pts = []
    for f in sorted(W.glob("tap*.jsonl")):  # tap.jsonl, tap2.jsonl ...: the tap was restarted when its 90 min ran out
        try:
            pts += [json.loads(l) for l in open(f)]
        except OSError:
            pass
    pts.sort(key=lambda p: p["t"])
    ts = [p["t"] for p in pts]
    i = bisect.bisect_left(ts, t)
    while i < len(pts) and pts[i]["t"] < t + within:
        if pts[i]["rms"] >= 30:
            return pts[i]["t"]
        i += 1
    return None


def wait_quiet(since, quiet=5.0, timeout=60.0, off=0.0):
    """Block until no utterance is playing and none started or ended for `quiet` s (after at least one started, or timeout)."""
    end = time.time() + timeout
    while time.time() < end:
        ev = [e for e in speech_events(since, off) if e["ev"] in ("start", "end", "halt")]
        if ev:
            last = max(e["t"] for e in ev)
            open_ = {e["id"] for e in ev if e["ev"] == "start"} - {e["id"] for e in ev if e["ev"] in ("end", "halt")}
            if not open_ and time.time() - last >= quiet:
                return True
        time.sleep(0.4)
    return False


def facts_of(memo_id):
    evs = c.candystore_events(memo_id)
    out = {}
    for e in evs:
        t = e["type"].replace("bloodbank.", "")
        out.setdefault(t, []).append(e)
    return out


def summarize(memo_id):
    by = facts_of(memo_id)
    g = lambda t: by.get("audio.memo." + t, [])  # noqa: E731
    routed = g("routed")
    rd = (routed[-1].get("data") if routed else None) or {}
    disp = [e["data"] for e in g("dispatched")]
    return {
        "routed": {k: rd.get(k) for k in ("action", "decided_action", "path", "model_answered", "route", "attempts", "latency_ms",
                                         "cached_tokens", "conv_turn", "conv_id", "guard", "fallback_reason", "title", "target",
                                         "perm", "delegate_to", "say", "say_chars", "lexicon", "card_age_s", "decide_ms")} if rd else None,
        "attempt_log": rd.get("attempt_log"),
        "n_routed": len(routed),
        "dispatched": [{k: d.get(k) for k in ("followup", "lane", "lane_reason", "command_id", "target_agent_id", "tile_agent_id",
                                              "model", "brief_id", "brief_title", "perm", "conv_id", "delegated_to")} for d in disp],
        "delegated": [{k: e["data"].get(k) for k in ("target_agent_id", "tile_agent_id", "brief_id", "command_id", "lane", "perm", "title")}
                      for e in g("delegated")],
        "replied": [{k: e["data"].get(k) for k in ("followup", "command_id", "conv", "chars")} for e in g("replied")],
        "voiced": len(g("voiced")),
        "types": sorted({k for k in by}),
    }


def do_turn(a):
    off = clock_offset()
    out = {"name": a.name, "text": a.text, "offset_s": off}
    wav = synth(a.name, a.text)
    ok = rec_start(out)
    if not ok:
        print(json.dumps(out)); sys.exit(1)
    rec_say(out, wav, a.hold)
    rec_stop(out)
    finish_turn(out, off, a)


def finish_turn(out, off, a):
    stop = out["stop_pressed"]
    mid, key, disc = discover(stop)
    out.update({"memo_id": mid, "key": key, "discovered": disc})
    if not mid:
        out["error"] = "no memo discovered"
        record(out)
        print(json.dumps(out, indent=1)); sys.exit(1)
    # first audio of this memo's reply (or any utterance for it)
    t_first = None
    end = time.time() + a.first_audio_timeout
    while time.time() < end and t_first is None:
        for e in speech_events(stop - 2 - off + off, off):
            if e["ev"] == "start" and e["memo"].startswith(mid[:8]) and e["kind"] in ("reply", "echo", "followup", "result", "ack"):
                t_first = e["t"]
                out["first_kind"] = e["kind"]
                break
        time.sleep(0.3)
    out["first_start"] = t_first
    out["first_audible"] = tap_audible(t_first) if t_first else None
    if t_first:
        out["stop_to_first_start_s"] = round(t_first - stop, 2)
        if out["first_audible"]:
            out["stop_to_first_audible_s"] = round(out["first_audible"] - stop, 2)
    wait_quiet(stop - 1, a.quiet, 70, off)
    time.sleep(1.5)  # let the replied/voiced facts reach Candystore
    out["stop_to_upload_discover_s"] = round(disc - stop, 2) if disc else None
    out["facts"] = summarize(mid)
    ev = [e for e in speech_events(stop - 1, off) if e["memo"].startswith(mid[:8])]
    out["speech"] = [(round(e["t"] - stop, 2), e["ev"], e["kind"], e["reason"][:40]) for e in ev]
    record(out)
    print(json.dumps(out, indent=1, default=str))


def record(out):
    with open(TURNS, "a") as f:
        f.write(json.dumps(out, default=str) + "\n")


def cmd_table(_):
    rows = [json.loads(l) for l in open(TURNS)]
    for r in rows:  # the tap file is flushed lazily, so audible onsets are recomputed here, after the fact
        if r.get("first_start"):
            r["first_audible"] = tap_audible(r["first_start"])
            r["stop_to_first_audible_s"] = round(r["first_audible"] - r["stop_pressed"], 2) if r["first_audible"] else None
    print(f"{'name':10s} {'memo':8s} {'action':9s} {'path':12s} {'model@route':36s} {'ms':>6s} {'stop->start':>11s} {'->audible':>9s}")
    vals = []
    for r in rows:
        f = (r.get("facts") or {}).get("routed") or {}
        print(f"{r['name']:10s} {str(r.get('memo_id'))[:8]:8s} {str(f.get('action')):9s} {str(f.get('path')):12s} "
              f"{str(f.get('model_answered'))+'@'+str(f.get('route')):36s} {str(f.get('latency_ms')):>6s} "
              f"{str(r.get('stop_to_first_start_s')):>11s} {str(r.get('stop_to_first_audible_s')):>9s}")
        if re.fullmatch(r"s1-\d\d", r["name"]) and r.get("stop_to_first_audible_s") is not None:
            vals.append(r["stop_to_first_audible_s"])
    if vals:
        vals.sort()
        p = lambda q: vals[min(len(vals) - 1, int(round(q * (len(vals) - 1))))]  # noqa: E731
        print(f"\nS1 audible n={len(vals)} p50={statistics.median(vals):.2f} p90={p(0.9):.2f} max={vals[-1]:.2f}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("turn")
    t.add_argument("name")
    t.add_argument("text")
    t.add_argument("--quiet", type=float, default=5.0)
    t.add_argument("--first-audio-timeout", type=float, default=45.0)
    t.add_argument("--hold", type=float, default=0.0)
    sub.add_parser("rec-start")
    rs = sub.add_parser("rec-say")
    rs.add_argument("name")
    rs.add_argument("text")
    rs2 = sub.add_parser("rec-stop")
    rs2.add_argument("--name", default="rec")
    rs2.add_argument("--quiet", type=float, default=5.0)
    rs2.add_argument("--first-audio-timeout", type=float, default=45.0)
    f = sub.add_parser("facts")
    f.add_argument("memo")
    w = sub.add_parser("wait-speech")
    w.add_argument("--quiet", type=float, default=5.0)
    w.add_argument("--timeout", type=float, default=90.0)
    sub.add_parser("table")
    a = p.parse_args()
    if a.cmd == "turn":
        do_turn(a)
    elif a.cmd == "rec-start":
        o = {}
        print("mic recording" if rec_start(o) else "MIC NOT RECORDING", json.dumps(o))
    elif a.cmd == "rec-say":
        o = {}
        rec_say(o, synth(a.name, a.text))
        print(json.dumps(o))
    elif a.cmd == "rec-stop":
        o = {"name": a.name, "text": ""}
        off = clock_offset()
        rec_stop(o)
        finish_turn(o, off, a)
    elif a.cmd == "facts":
        print(json.dumps(summarize(a.memo), indent=1, default=str))
    elif a.cmd == "wait-speech":
        print("quiet" if wait_quiet(time.time() - 600, a.quiet, a.timeout, clock_offset()) else "timeout")
    elif a.cmd == "table":
        cmd_table(a)


if __name__ == "__main__":
    main()

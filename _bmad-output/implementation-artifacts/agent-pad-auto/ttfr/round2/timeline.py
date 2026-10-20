#!/usr/bin/env python3
"""Per-memo time-to-first-response timeline from: drive run json (host clock), logcat (device clock), the audio tap
(host clock) and memo:trace output (server clock = host). Usage: timeline.py <label> <memo8> <run.json> <logcat> <trace>"""
import json, re, sys
from datetime import datetime, timezone

OFF = 0.720  # host = device + OFF (round 2 clock samples)
label, memo8, runf, logf, tracef = sys.argv[1:6]
run = json.load(open(runf))
T0 = run["stop_pressed"]
tap = [json.loads(l) for l in open("/tmp/ttfr2/tap.jsonl")]


def onset(after, until=None, thr=30):
    for p in tap:
        if p["t"] >= after and p["rms"] >= thr and (until is None or p["t"] < until):
            return p["t"]
    return None


def last_sound(before, since, thr=30):
    best = None
    for p in tap:
        if since <= p["t"] <= before and p["rms"] >= thr:
            best = p["t"] + p["n"] / 16000
    return best


ev = []
for line in open(logf, errors="replace"):
    m = re.match(r"\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+HoloceneSpeech:\s+(\w+) (\w*) id=(\S*) memo=(\S+) .*?reason=(.*?) at=", line)
    if m:
        ev.append((float(m.group(1)) + OFF, m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)))


def first(pred, after=T0 - 2):
    for e in ev:
        if e[0] >= after and pred(e):
            return e
    return None


trace = {}
for line in open(tracef, errors="replace"):
    m = re.match(r"\s+OK\s+(\S+)\s+(\d{4}-\d\d-\d\dT[\d:.]+Z)", line)
    if m and m.group(1) not in trace:
        trace[m.group(1)] = datetime.strptime(m.group(2), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()

rows = []
def row(name, t, note=""):
    rows.append((name, t, note))

row("Stop & Send pressed (adb input)", T0)
idle = first(lambda e: e[1] == "mic" and e[5] == "idle", T0 - 0.5)
row("mic closed (queue: mic idle)", idle and idle[0])
ack = first(lambda e: e[1] == "start" and e[2] == "ack", T0 - 0.5)
if ack:
    row("ack started (queue)", ack[0], "STOP tone + \"Got it, <agent>'s on it.\"")
    row("ack AUDIBLE (speaker tap)", onset(ack[0]))
row("upload fact", trace.get("fact:uploaded"))
row("transcribed", trace.get("fact:transcribed"))
echo = first(lambda e: e[1] == "start" and e[2] == "echo" and e[4].startswith(memo8))
if echo:
    row("heard echo started (queue)", echo[0])
    row("heard echo AUDIBLE", onset(echo[0]))
row("agent turn started", trace.get("agent:invocation.started"))
for k in sorted(k for k in trace if k.startswith("agent:progress#")):
    row(k.replace("agent:", "agent "), trace[k])
for k in sorted(k for k in trace if k.startswith("car:narrated#")):
    row(k.replace("car:", "progress clip up "), trace[k])
prog = first(lambda e: e[1] == "start" and e[2] == "progress" and e[4].startswith(memo8))
if prog:
    row("first progress started (queue)", prog[0])
    row("first progress AUDIBLE", onset(prog[0]))
else:
    d = first(lambda e: e[2] == "progress" and e[4].startswith(memo8))
    row("progress on the car", None, ("%s %s" % (d[1], d[5])) if d else "none offered (turn too short to narrate)")
row("agent DONE (invocation.completed)", trace.get("agent:invocation.done"))
c1 = [k for k in trace if k.startswith("car:chunk#1")]
row("reply chunk 1 up", trace.get(c1[0]) if c1 else None)
row("full reply up (replied fact)", trace.get("fact:replied"))
rep = first(lambda e: e[1] == "start" and e[2] == "reply" and memo8 in e[3])
if rep:
    row("reply started (queue)", rep[0], rep[5])
    row("reply AUDIBLE", onset(rep[0]))
    end = first(lambda e: e[1] in ("end", "halt") and e[2] == "reply" and memo8 in e[3], rep[0])
    if end:
        row("reply ended (queue)", end[0], "%s %s" % (end[1], end[5]))
        row("reply last sound (tap)", last_sound(end[0] + 0.4, rep[0]))
done = trace.get("agent:invocation.done")
print("### %s (memo %s)" % (label, memo8))
print()
print("| step | clock (UTC) | since Stop & Send | since agent done | note |")
print("|---|---|---|---|---|")
for name, t, note in rows:
    if t is None:
        print("| %s | - | - | - | %s |" % (name, note))
        continue
    utc = datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    sd = "%+.1f s" % (t - done) if done and t >= done - 0.05 else ""
    print("| %s | %s | %+.2f s | %s | %s |" % (name, utc, t - T0, sd, note))
print()

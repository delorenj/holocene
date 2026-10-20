#!/usr/bin/env python3
"""Second, server-side overlap check: the car's speech decisions as the upload proxy logged them (event "speech",
posted by the pad for every HoloceneSpeech decision), on the device's monotonic clock (mono_ms).

  docker logs agent-pad-upload 2>&1 | python3 proxy_overlap.py [--since ISO] [--until ISO]

Utterance = start .. end|halt of one speech_id. Mic busy = mic arming|recording .. idle. Fails on:
  1. two utterances overlapping
  2. any utterance other than the arming prompt overlapping a mic-busy window
  3. the arming prompt still sounding once the mic is recording
"""
import argparse, json, sys

ap = argparse.ArgumentParser()
ap.add_argument("--since", default="")
ap.add_argument("--until", default="9999")
a = ap.parse_args()

ev = []
for line in sys.stdin:
    if '"event":"speech"' not in line:
        continue
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue
    if not (a.since <= d["ts"] <= a.until) or d.get("mono_ms") is None:
        continue
    ev.append(d)
ev.sort(key=lambda d: d["mono_ms"])

utt, open_u, mic, rec, mic_since, rec_since = [], {}, [], [], None, None
for d in ev:
    act, kind, sid, t = d.get("speech_action"), d.get("speech_kind"), d.get("speech_id"), d["mono_ms"]
    if act == "start":
        open_u[sid] = (t, kind, d.get("memo_id") or "-")
    elif act in ("end", "halt") and sid in open_u:
        s, k, m = open_u.pop(sid)
        utt.append((s, t, k, sid, m, act))
    elif act == "mic":
        state = d.get("mic")
        if state in ("arming", "recording") and mic_since is None:
            mic_since = t
        if state == "recording" and rec_since is None:
            rec_since = t
        if state == "idle":
            if mic_since is not None:
                mic.append((mic_since, t))
            if rec_since is not None:
                rec.append((rec_since, t))
            mic_since = rec_since = None

fails = []
u = sorted(utt)
for i in range(len(u)):
    for j in range(i + 1, len(u)):
        if u[j][0] >= u[i][1]:
            break
        fails.append("1 speech x speech: %s %s .. %s overlaps %s %s by %d ms"
                     % (u[i][2], u[i][3][-60:], u[i][5], u[j][2], u[j][3][-60:], u[i][1] - u[j][0]))
for s, e, k, sid, m, act in u:
    wins = rec if k == "arming" else mic
    for ms, me in wins:
        if s < me and e > ms:
            fails.append("%s %s %s inside mic window %d..%d (overlap %d ms)"
                         % ("3" if k == "arming" else "2", k, sid[-60:], ms, me, min(e, me) - max(s, ms)))

print("speech decisions: %d   utterances: %d   mic-busy windows: %d   recordings: %d" % (len(ev), len(u), len(mic), len(rec)))
for s, e, k, sid, m, act in u:
    print("  mono %9.3f s  %6.2f s  %-8s %-6s %s" % (s / 1000, (e - s) / 1000, k, act, (m or "-")[:8]))
for ms, me in mic:
    print("  mono %9.3f s  %6.2f s  MIC BUSY (arming + recording)" % (ms / 1000, (me - ms) / 1000))
print()
print("check 1 speech x speech:", "PASS 0 overlaps" if not [f for f in fails if f.startswith("1")] else "FAIL")
print("check 2 speech x mic busy:", "PASS 0 overlaps" if not [f for f in fails if f.startswith("2")] else "FAIL")
print("check 3 arming prompt x recording:", "PASS 0 overlaps" if not [f for f in fails if f.startswith("3")] else "FAIL")
for f in fails:
    print("  " + f)
print("RESULT", "ZERO OVERLAPS" if not fails else "%d OVERLAPS" % len(fails))
sys.exit(1 if fails else 0)

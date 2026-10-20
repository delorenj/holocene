#!/usr/bin/env python3
"""Sound segments on the sim's speakers (tap, host clock) in a window: segments.py <tap.jsonl> <from_host> <seconds> [thr] [gap_ms]"""
import json, sys
tap, lo, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
thr = float(sys.argv[4]) if len(sys.argv) > 4 else 30
gap = (float(sys.argv[5]) if len(sys.argv) > 5 else 120) / 1000
segs = []
for l in open(tap):
    p = json.loads(l)
    t = p["t"]
    if t < lo or t > lo + dur or p["rms"] < thr:
        continue
    e = t + p["n"] / p.get("r", 16000)
    if segs and t - segs[-1][1] <= gap:
        segs[-1][1] = e
        segs[-1][2] = max(segs[-1][2], p["rms"])
    else:
        segs.append([t, e, p["rms"]])
for a, b, r in segs:
    print("%+.3f .. %+.3f s  (%4.0f ms, peak rms %.0f)" % (a - lo, b - lo, (b - a) * 1000, r))

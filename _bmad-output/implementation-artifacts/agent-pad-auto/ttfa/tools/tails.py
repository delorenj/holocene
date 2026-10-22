#!/usr/bin/env python3
"""How long the speakers kept sounding after each logged utterance end (device clock), from the tap (host clock + offset)."""
import json, re, sys
off = float(sys.argv[1]) / 1000.0
pk = [(json.loads(l)) for l in open("/tmp/ttfa/tap.jsonl")]
pk = [(p["t"] + off, p["t"] + off + p["n"] / p.get("r", 16000), p["rms"]) for p in pk]
ends = []
for l in open("/tmp/ttfa/logcat.txt", errors="replace"):
    m = re.match(r"^\s*(\d+\.\d+).*HoloceneSpeech: (end|halt) (\w+) id=(\S*)", l)
    if m:
        ends.append((float(m.group(1)), m.group(2), m.group(3), m.group(4)[:40]))
import bisect
starts = [p[0] for p in pk]
rows = []
for t, ev, kind, uid in ends:
    i = bisect.bisect_left(starts, t - 0.05)
    last = None
    # walk forward while sound continues with gaps < 120 ms
    j = i
    gap_from = t
    while j < len(pk) and pk[j][0] < t + 2.0:
        if pk[j][2] >= 30:
            if last is None or pk[j][0] - last < 0.12:
                last = pk[j][1]
            else:
                break
        elif last is not None and pk[j][0] - last >= 0.12:
            break
        j += 1
    tail = (last - t) if last else 0.0
    rows.append((tail, t, ev, kind, uid))
rows.sort(reverse=True)
print("utterance ends:", len(rows))
for r in rows[:8]:
    print("tail %4.0f ms after %s %s %s at %.3f" % (r[0] * 1000, r[2], r[3], r[4], r[1]))

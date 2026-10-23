#!/usr/bin/env python3
"""Inject one synthesized speech memo into holocene-auto inbox/ the way the car upload proxy stores it, then wait for the desk.
usage: inject.py <name> "<text>" [--wait-dispatch] [--put-at <epoch>]   (--put-at: synthesize now, hold the upload until that time)
Key layout inbox/<agent>/<yyyy>/<mm>/<dd>/<yyyymmddTHHMMSSZ>.ogg ; object metadata X-Amz-Meta-Holocene-Device / -Host (mc cp --attr),
content-type audio/ogg. Output: out-<name>.json with every Candystore fact for the memo id."""
import datetime as dt, json, subprocess, sys, time, urllib.request, uuid, os
HERE = os.path.dirname(os.path.abspath(__file__))
SYNTH = os.path.join(HERE, "../../../ttfa/round2/tools/synth.py")
DEVICE = "e1c40830-9802-420f-98b9-d06be3f51b74"
AGENT = "holocene-pm"
name, text = sys.argv[1], sys.argv[2]
wait_dispatch = "--wait-dispatch" in sys.argv
t_synth = time.time()
subprocess.run([sys.executable, SYNTH, name, text], check=True, capture_output=True)
wav = f"/tmp/ttfa2/{name}.wav"
ogg = f"/tmp/ttfa2/{name}.ogg"
# 0.4 s lead-in silence like a recorder, 48 kHz mono Opus
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-af", "adelay=400,apad=pad_dur=0.4", "-ar", "48000", "-ac", "1",
                "-c:a", "libopus", "-b:a", "32k", ogg], check=True)
if "--put-at" in sys.argv:
    time.sleep(max(0.0, float(sys.argv[sys.argv.index("--put-at") + 1]) - time.time()))
now = dt.datetime.now(dt.timezone.utc)
key = f"inbox/{AGENT}/{now:%Y}/{now:%m}/{now:%d}/{now:%Y%m%dT%H%M%S}Z.ogg"
memo_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "s3://holocene-auto/" + key))
attrs = f"X-Amz-Meta-Holocene-Device={DEVICE};X-Amz-Meta-Holocene-Host=car;Content-Type=audio/ogg"
t_put = time.time()
subprocess.run(["mc", "cp", "--quiet", "--attr", attrs, ogg, f"delo/holocene-auto/{key}"], check=True)
print(json.dumps({"name": name, "key": key, "memo_id": memo_id, "put_at": dt.datetime.now(dt.timezone.utc).isoformat(), "synth_s": round(t_put - t_synth, 1)}), flush=True)

def facts():
    with urllib.request.urlopen(f"http://127.0.0.1:8683/events?correlationid={memo_id}&limit=500", timeout=20) as r:
        evs = json.load(r)["events"]
    by = {}
    for e in sorted(evs, key=lambda e: e["time"]):
        by.setdefault(e["type"].rsplit(".", 1)[-1], []).append(e)
    return by

deadline = time.time() + 240
by = {}
while time.time() < deadline:
    time.sleep(4)
    try:
        by = facts()
    except Exception as ex:
        continue
    done = "replied" in by or "failed" in by
    if done and wait_dispatch and not ("dispatched" in by and "delegated" in by):
        done = time.time() > deadline - 200 and False  # keep waiting for dispatched+delegated
    if done:
        time.sleep(8)  # settle: late facts (voiced, dispatched)
        by = facts()
        break
res = {"name": name, "text": text, "key": key, "memo_id": memo_id, "put_t": t_put, "elapsed_s": round(time.time() - t_put, 1),
       "facts": {k: [{"time": e["time"], "data": e["data"]} for e in v] for k, v in by.items() if k not in ("notified", "played")},
       "types": {k: len(v) for k, v in by.items()}}
json.dump(res, open(os.path.join(HERE, f"out-{name}.json"), "w"), indent=1, default=str)
def g(t):
    return (by.get(t) or [{}])[0].get("data", {})
tr, ro, rp = g("transcribed"), g("routed"), g("replied")
print(json.dumps({"name": name, "memo": memo_id[:8], "heard": tr.get("transcript_text"), "action": ro.get("action"), "path": ro.get("path"),
                  "model": ro.get("model_answered"), "lat_ms": ro.get("latency_ms"), "say": (ro.get("say") or "")[:400],
                  "dispatched": len(by.get("dispatched", [])), "delegated": len(by.get("delegated", [])), "failed": len(by.get("failed", [])),
                  "types": res["types"], "elapsed_s": res["elapsed_s"]}, indent=1))

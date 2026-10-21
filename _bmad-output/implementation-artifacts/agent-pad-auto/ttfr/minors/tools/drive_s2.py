#!/usr/bin/env python3
"""S2 on the sim: the car is refused (the phone took the reply), the pad page is RELOADED (app force-stopped and started: a cold
start, in-memory state gone) while the phone's Earshot drop still fails, then the watcher releases: the car must reclaim and play.
Memo through the holo_testmic null sink (paplay). Prints host epochs as JSON."""
import json, subprocess, sys, time
sys.path.insert(0, "/tmp/v13")
import drive13 as d
d.LOG = "/tmp/s2/logcat.txt"
out = {"scenario": "s2"}
d.record("/tmp/v13/p3.wav", out, "m")
ev = d.journal_until(d.agent_done)
mid = ev["memo_id"]
out["memo"], out["agent_done_logged"] = mid, ev["ts"]
d.adb("shell", "am", "force-stop", "--user", "10", "io.automaticai.holocene")
out["app_stopped"] = time.time()
e = d.journal_until(lambda e: e.get("memo_id") == mid and e.get("event") in ("earshot_mirror_decided", "earshot_skipped"), timeout=120)
out["decided"] = {k: e.get(k) for k in ("ts", "event", "why", "waited_s")}
out["relaunch1"] = time.time()
d.adb("shell", "am", "start", "--user", "10", "-n", d.APP)
# wait until the proxy refuses this car's hold (left to the phone), then reload the page
c = d.proxy_until(lambda e: e.get("event") == "claim" and e.get("memo_id") == mid and e.get("by") == "car" and e.get("ok") is False, timeout=90)
out["refused"] = {"seen": time.time(), "ts": c and c.get("ts"), "owner": c and c.get("owner")}
time.sleep(5)
out["reload"] = time.time()
d.adb("shell", "am", "force-stop", "--user", "10", "io.automaticai.holocene")
time.sleep(1)
d.adb("shell", "am", "start", "--user", "10", "-n", d.APP)
out["reloaded"] = time.time()
e = d.journal_until(lambda e: e.get("memo_id") == mid and e.get("event") in ("earshot_released", "stage_failed", "memo_failed"), timeout=150)
out["released"] = {"seen": time.time(), "ts": e and e.get("ts"), "event": e and e.get("event")}
print(json.dumps(out), flush=True)

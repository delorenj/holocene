#!/usr/bin/env python3
"""Follow the watcher journal; the moment a memo's agent turn is done, start a recording on the car and keep it open
for HOLD seconds (the reply arrives while it is open, so the car holds it), then Stop."""
import json, subprocess, sys, time
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
HOLD = float(sys.argv[1]); WAV = sys.argv[2]
p = subprocess.Popen(["journalctl", "--user", "-u", "holocene-inbox-watcher.service", "-f", "-n", "0", "-o", "cat"],
                     stdout=subprocess.PIPE, text=True)
for line in p.stdout:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("event") == "stage_done" and d.get("stage") == "agent":
        break
p.kill()
out = {"agent_done_logged": d["ts"], "memo_id": d.get("memo_id"), "record_pressed": time.time()}
subprocess.run([ADB, "-s", "emulator-5554", "shell", "input", "tap", "452", "655"], capture_output=True)
time.sleep(3.0)
b = time.time()
subprocess.run(["paplay", "--device=holo_testmic", WAV], capture_output=True)
out["paplay"] = [b, time.time()]
time.sleep(max(0.0, out["record_pressed"] + HOLD - time.time()))
out["stop_pressed"] = time.time()
subprocess.run([ADB, "-s", "emulator-5554", "shell", "input", "tap", "452", "655"], capture_output=True)
print(json.dumps(out), flush=True)

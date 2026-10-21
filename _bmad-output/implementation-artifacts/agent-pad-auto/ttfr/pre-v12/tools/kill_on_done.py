#!/usr/bin/env python3
"""Follow the watcher journal; the moment a memo's agent turn is done (stage_done agent), force-stop the car app."""
import json, subprocess, sys, time
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
p = subprocess.Popen(["journalctl", "--user", "-u", "holocene-inbox-watcher.service", "-f", "-n", "0", "-o", "cat"],
                     stdout=subprocess.PIPE, text=True)
end = time.time() + float(sys.argv[1] if len(sys.argv) > 1 else 300)
for line in p.stdout:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("event") == "stage_done" and d.get("stage") == "agent":
        t0 = time.time()
        r = subprocess.run([ADB, "-s", "emulator-5554", "shell", "am", "force-stop", "--user", "10", "io.automaticai.holocene"],
                           capture_output=True, text=True)
        print(json.dumps({"agent_done_logged": d["ts"], "memo_id": d.get("memo_id"), "force_stop_at": t0,
                          "force_stop_done": time.time(), "rc": r.returncode}), flush=True)
        break
    if time.time() > end:
        print(json.dumps({"timeout": True}), flush=True)
        break
p.kill()

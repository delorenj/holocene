#!/usr/bin/env python3
"""Memo Y on the sim: record memo 2 while memo 1's agent works; hold the note open until memo 1's progress clip is held
back by it (logcat 'deferred progress'), then Stop. Prints host epochs."""
import json, subprocess, sys, time
sys.path.insert(0, "/tmp/v12")
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
LOG = "/tmp/v12/logcat.txt"


def size():
    import os
    return os.path.getsize(LOG)


def wait(pattern, since, timeout):
    end = time.time() + timeout
    while time.time() < end:
        with open(LOG, "rb") as f:
            f.seek(since)
            for line in f.read().decode("utf-8", "replace").splitlines():
                if pattern in line:
                    return time.time(), line.strip()
        time.sleep(0.05)
    return None, None


def tap():
    subprocess.run([ADB, "-s", "emulator-5554", "shell", "input", "tap", "452", "655"], capture_output=True)


out = {}
s0 = size()
out["start2_pressed"] = time.time()
tap()
out["mic_recording"] = wait("mic=recording reason=recording", s0, 25)
time.sleep(0.3)
b = time.time()
r = subprocess.run(["paplay", "--device=holo_testmic", sys.argv[1]], capture_output=True, text=True)
out["paplay"] = [b, time.time(), r.returncode]
out["held_back"] = wait("deferred progress id=progress:", s0, float(sys.argv[2]) if len(sys.argv) > 2 else 60)
time.sleep(1.0)
s1 = size()
out["stop2_pressed"] = time.time()
tap()
out["mic_idle"] = wait("mic=idle reason=idle", s1, 15)
print(json.dumps(out, indent=1))

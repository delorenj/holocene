#!/usr/bin/env python3
"""Drive one memo on the Honda sim (emulator-5554 only): tap Record, wait for the mic, paplay the WAV into the
holo_testmic null sink (never gRPC injection), tap Stop & Send. Prints host epochs as JSON and appends to runs.jsonl.
usage: drive.py <name> <wav> [--hold S]"""
import argparse, json, os, subprocess, sys, time

ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
LOG = "/tmp/ttfa2/logcat.txt"


def adb(*a):
    # the host's adb server is killed now and then by another client; retry until the command really ran
    for _ in range(5):
        r = subprocess.run([ADB, "-s", "emulator-5554", *a], capture_output=True, text=True)
        if r.returncode == 0 and "error" not in (r.stderr or "").lower():
            return r.stdout
        time.sleep(0.5)
    return r.stdout


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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("name")
    p.add_argument("wav")
    p.add_argument("--hold", type=float, default=0.0)
    p.add_argument("--shot", default="")
    a = p.parse_args()
    out = {"name": a.name, "wav": a.wav}
    s0 = os.path.getsize(LOG)
    out["start_pressed"] = time.time()
    adb("shell", "input", "tap", "452", "655")
    t, line = wait_log("mic=recording reason=recording", s0)
    out["mic_recording_seen"] = t
    if t is None:
        print(json.dumps(out)); sys.exit(1)
    time.sleep(0.4)
    b = time.time()
    r = subprocess.run(["paplay", "--device=holo_testmic", a.wav], capture_output=True, text=True)
    out["paplay"] = [b, time.time(), r.returncode, r.stderr.strip()[:200]]
    time.sleep(1.0 + a.hold)
    if a.shot:
        subprocess.run(f"{ADB} -s emulator-5554 exec-out screencap -p > {a.shot}", shell=True)
    s1 = os.path.getsize(LOG)
    out["stop_pressed"] = time.time()
    adb("shell", "input", "tap", "452", "655")
    t, _ = wait_log("mic=idle reason=idle", s1, 6)
    if t is None:  # the Stop tap was lost (adb server restart): tap again, once
        out["stop_retapped"] = time.time()
        adb("shell", "input", "tap", "452", "655")
        t, _ = wait_log("mic=idle reason=idle", s1, 15)
    out["mic_idle_seen"] = t
    with open("/tmp/ttfa2/runs.jsonl", "a") as f:
        f.write(json.dumps(out) + "\n")
    print(json.dumps(out, indent=1))


main()

#!/usr/bin/env python3
"""(paplay into the holo_testmic null sink the emulator mic is routed to) Drive one memo on the sim: start recording (tap or wheel key), inject WAV parts, stop & send. Prints host epochs."""
import json, subprocess, sys, time, argparse
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
TOOLS = "/home/delorenj/code/33GOD/holocene/apps/auto/tools"
LOG = "/tmp/ttfr2/logcat.txt"


def adb(*a):
    return subprocess.run([ADB, "-s", "emulator-5554", *a], capture_output=True, text=True).stdout


def wheel(key):
    subprocess.run([TOOLS + "/sim_drive.sh", "key", key], capture_output=True, text=True)


def wait_log(pattern, since_bytes, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        with open(LOG, "rb") as f:
            f.seek(since_bytes)
            for line in f.read().decode("utf-8", "replace").splitlines():
                if pattern in line:
                    return time.time(), line
        time.sleep(0.05)
    return None, None


def logsize():
    import os
    return os.path.getsize(LOG)


def inject(wav, lead, tail):
    time.sleep(lead / 1000)
    b = time.time()
    r = subprocess.run(["paplay", "--device=holo_testmic", wav], capture_output=True, text=True)
    time.sleep(tail / 1000)
    return json.dumps({"paplay_rc": r.returncode, "err": r.stderr.strip()[:200], "played_s": round(time.time() - b, 3)})


def inject_grpc(wav, lead, tail):
    r = subprocess.run(["uv", "run", "--no-project", "--with", "protobuf>=7.35", "--with", "grpcio", "python",
                        TOOLS + "/emulator_audio.py", "inject", "--port", "8554", "--wav", wav,
                        "--lead-ms", str(lead), "--tail-ms", str(tail)], capture_output=True, text=True)
    return r.stdout.strip() or r.stderr.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--via", choices=["tap", "wheel"], default="tap")
    p.add_argument("--x", type=int, default=452)
    p.add_argument("--y", type=int, default=655)
    p.add_argument("--shot", default="")
    p.add_argument("--hold", type=float, default=0)
    p.add_argument("--shot2", default="")
    p.add_argument("wavs", nargs="+")
    a = p.parse_args()
    out = {}
    s0 = logsize()
    out["start_pressed"] = time.time()
    if a.via == "tap":
        adb("shell", "input", "tap", str(a.x), str(a.y))
    else:
        wheel("playpause")
    t, line = wait_log("mic=recording reason=recording", s0, 25)
    out["mic_recording_seen"] = t
    out["mic_line"] = line
    if t is None:
        print(json.dumps(out)); sys.exit(1)
    if a.shot:
        subprocess.run(f"{ADB} -s emulator-5554 exec-out screencap -p > {a.shot}", shell=True)
    out["inject"] = []
    for i, w in enumerate(a.wavs):
        tail = 1000 if i == len(a.wavs) - 1 else 250
        b = time.time()
        res = inject(w, 300 if i == 0 else 0, tail)
        out["inject"].append({"wav": w, "began": b, "ended": time.time(), "result": res[:300]})
    if a.hold:
        time.sleep(a.hold)
    if a.shot2:
        subprocess.run(f"{ADB} -s emulator-5554 exec-out screencap -p > {a.shot2}", shell=True)
    s1 = logsize()
    out["stop_pressed"] = time.time()
    if a.via == "tap":
        adb("shell", "input", "tap", str(a.x), str(a.y))
    else:
        wheel("playpause")
    t, line = wait_log("mic=idle reason=idle", s1, 15)
    out["mic_idle_seen"] = t
    print(json.dumps(out, indent=1))


main()

#!/usr/bin/env python3
"""K1/K2 proof on the sim (paplay into the holo_testmic null sink; never gRPC inject). Only emulator-5554 is touched.

n1: a normal memo (tap record, paplay, tap stop). The SENT tone of its note must be queued as a note ack.
k:  a memo M; once the car plays M's reply, a recording R opens over the playing reply (tap), is held HOLD s and stopped.
    The reply stops at the arming, R's STOP ack + SENT tone come first, then the reply is offered again from the start.
    With SLOW > 0 the proxy (agent-pad-upload) is paused for SLOW s right before R's Stop, so R's upload lands that long
    after Stop (past the old 6 s window): the SENT tone must still be its note's.
Prints host epochs as JSON."""
import json, os, subprocess, sys, time

ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
LOG = os.environ.get("DRIVE_LOG", "/tmp/k12/logcat.txt")


def adb(*a):
    return subprocess.run([ADB, "-s", "emulator-5554", *a], capture_output=True, text=True).stdout


def logsize():
    return os.path.getsize(LOG)


def wait_log(pattern, since, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        with open(LOG, "rb") as f:
            f.seek(since)
            for line in f.read().decode("utf-8", "replace").splitlines():
                if pattern in line:
                    return time.time()
        time.sleep(0.05)
    return None


def tap():
    adb("shell", "input", "tap", "452", "655")


def record(wav, out, name, hold=0.0, slow=0.0):
    s0 = logsize()
    out[f"{name}_start_pressed"] = time.time()
    tap()
    out[f"{name}_mic_recording"] = wait_log("mic=recording reason=recording", s0)
    if out[f"{name}_mic_recording"] is None:
        raise SystemExit(f"{name}: never recording")
    time.sleep(0.4)
    b = time.time()
    r = subprocess.run(["paplay", "--device=holo_testmic", wav], capture_output=True, text=True)
    out[f"{name}_paplay"] = [b, time.time(), r.returncode]
    time.sleep(1.0)
    time.sleep(max(0.0, out[f"{name}_start_pressed"] + hold - time.time()))
    if slow:
        subprocess.run(["docker", "pause", "agent-pad-upload"], capture_output=True)
        out[f"{name}_proxy_paused"] = time.time()
    out[f"{name}_stop_pressed"] = time.time()
    tap()
    if slow:
        time.sleep(slow)
        subprocess.run(["docker", "unpause", "agent-pad-upload"], capture_output=True)
        out[f"{name}_proxy_unpaused"] = time.time()


def journal_until(pred, timeout=240):
    p = subprocess.Popen(["journalctl", "--user", "-u", "holocene-inbox-watcher.service", "-f", "-n", "0", "-o", "cat"],
                         stdout=subprocess.PIPE, text=True)
    end = time.time() + timeout
    try:
        for line in p.stdout:
            if time.time() > end:
                return None
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if pred(d):
                return d
    finally:
        p.kill()


def agent_done(d):
    return d.get("event") == "stage_done" and d.get("stage") == "agent"


def n1():
    out = {"scenario": "n1"}
    record("/tmp/v13/p1.wav", out, "m1")
    d = journal_until(agent_done)
    out["m1_memo"], out["m1_agent_done_logged"] = d["memo_id"], d["ts"]
    s0 = logsize()
    out["m1_reply_started"] = wait_log("start reply", s0 - 4000, timeout=90)
    out["m1_reply_ended"] = wait_log("end reply", s0 - 4000, timeout=90)
    print(json.dumps(out), flush=True)


def k(hold=6.0, slow=0.0, mwav="/tmp/v13/p2.wav", name="k"):
    out = {"scenario": name, "slow": slow, "mwav": mwav}
    mark = logsize()
    record(mwav, out, "m")
    out["reply_started"] = wait_log("start reply", mark, timeout=150)  # the log is chatty: scan from before the memo
    if out["reply_started"] is None:
        raise SystemExit("no reply started")
    time.sleep(1.2)  # the reply (4-5 s) is playing
    record("/tmp/v13/r1.wav", out, "r", hold=hold, slow=slow)
    out["r_done"] = time.time()
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    # kwait (final build): M asks for a long reply (/tmp/v13/p5.wav: "count out loud from one to thirty ...", made with vox.delo.sh
    # /synthesize and sox to 16 kHz mono), R opens over the playing reply, and R's upload is held 3 s, so the SENT tone arrives while the
    # re-offered long reply is already playing and has to wait for it (more than the old 6 s deadline).
    {"n1": n1, "k": lambda: k(), "kslow": lambda: k(slow=8.0),
     "kwait": lambda: k(slow=3.0, mwav="/tmp/v13/p5.wav", name="kwait")}[sys.argv[1]]()

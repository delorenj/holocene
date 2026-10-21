#!/usr/bin/env python3
"""Proxy-outage proofs on the sim (paplay into the holo_testmic null sink; never gRPC inject).

p1: memo M1 (car live). At M1's agent done a recording R opens (held HOLD s) so M1's reply is held by the car. Once the
    car's hold on M1's reply is seen at the proxy (and the watcher's offer), the proxy is stopped for DOWN s (longer than
    the old 5-poll fail-open budget), then started; R is stopped at HOLD.
p2: memo M2 (car live, no recording). At M2's agent done the proxy is stopped for DOWN s: the reply is up and the car
    learns of it from S3 while nobody can be asked; then started.
p3: memo M3, the app force-stopped at the agent's done (car off); the proxy restarted right after the reply is offered
    (state from disk, settle window); the phone must still get it. Then the proxy is restarted again and the app
    relaunched: its hold/start must be refused (the take survived).
Prints host epochs as JSON."""
import json, subprocess, sys, time, threading
ADB = "/home/delorenj/Android/Sdk/platform-tools/adb"
LOG = "/tmp/v13/logcat.txt"
COMPOSE = ["docker", "compose", "-f", "/home/delorenj/docker/stacks/websites/agent-pad/compose.yml", "-p", "agent-pad"]


def adb(*a):
    return subprocess.run([ADB, "-s", "emulator-5554", *a], capture_output=True, text=True).stdout


def logsize():
    import os
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


def record(wav, out, name, hold=0.0, stop=True):
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
    if stop:
        time.sleep(max(0.0, out[f"{name}_start_pressed"] + hold - time.time()))
        out[f"{name}_stop_pressed"] = time.time()
        tap()


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


def proxy_until(pred, timeout=120):
    p = subprocess.Popen(["docker", "logs", "-f", "--since", "1s", "agent-pad-upload"], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
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


def outage(out, name, down):
    out[f"{name}_proxy_stop"] = time.time()
    subprocess.run(["docker", "stop", "agent-pad-upload"], capture_output=True)
    out[f"{name}_proxy_stopped"] = time.time()
    time.sleep(down)
    out[f"{name}_proxy_start"] = time.time()
    subprocess.run(["docker", "start", "agent-pad-upload"], capture_output=True)
    out[f"{name}_proxy_started"] = time.time()


def agent_done(d):
    return d.get("event") == "stage_done" and d.get("stage") == "agent"


def p1(hold=45.0, down=20.0):
    out = {"scenario": "p1"}
    record("/tmp/v13/p1.wav", out, "m1")
    d = journal_until(agent_done)
    mid = d["memo_id"]
    out["m1_memo"], out["m1_agent_done_logged"] = mid, d["ts"]
    rec = threading.Thread(target=record, args=("/tmp/v13/r1.wav", out, "r1", hold))
    rec.start()
    seen = {}

    def both(e):
        if e.get("event") == "claim" and e.get("memo_id") == mid:
            if e.get("by") == "car" and e.get("action") == "hold" and e.get("ok") is True:
                seen.setdefault("hold", (time.time(), e))
            if e.get("by") == "watcher" and e.get("action") == "offer":
                seen.setdefault("offer", (time.time(), e))
        return "hold" in seen and "offer" in seen
    proxy_until(both)
    out["m1_car_hold_seen"], out["m1_car_hold"] = seen.get("hold", (None, None))
    out["m1_offer_seen"], out["m1_offer"] = seen.get("offer", (None, None))
    time.sleep(2.0)
    outage(out, "m1", down)
    rec.join()
    print(json.dumps(out), flush=True)


def p2(down=25.0):
    out = {"scenario": "p2"}
    record("/tmp/v13/p2.wav", out, "m2")
    d = journal_until(agent_done)
    out["m2_memo"], out["m2_agent_done_logged"], out["m2_agent_done_seen"] = d["memo_id"], d["ts"], time.time()
    outage(out, "m2", down)
    print(json.dumps(out), flush=True)


def p3():
    out = {"scenario": "p3"}
    record("/tmp/v13/p3.wav", out, "m3")
    d = journal_until(agent_done)
    mid = d["memo_id"]
    adb("shell", "am", "force-stop", "--user", "10", "io.automaticai.holocene")
    out["m3_memo"], out["m3_agent_done_logged"], out["m3_app_stopped"] = mid, d["ts"], time.time()
    proxy_until(lambda e: e.get("event") == "claim" and e.get("memo_id") == mid and e.get("by") == "watcher"
                and e.get("action") == "offer", timeout=120)
    out["m3_offer_seen"] = time.time()
    time.sleep(1.0)
    out["m3_proxy_restart"] = time.time()
    subprocess.run(["docker", "restart", "agent-pad-upload"], capture_output=True)
    out["m3_proxy_restarted"] = time.time()
    e = journal_until(lambda e: e.get("memo_id") == mid and e.get("event") in ("earshot_mirrored", "earshot_skipped"),
                      timeout=120)
    out["m3_decided"] = e
    time.sleep(5)
    out["m3_proxy_restart2"] = time.time()
    subprocess.run(["docker", "restart", "agent-pad-upload"], capture_output=True)
    time.sleep(2)
    adb("shell", "am", "start", "--user", "10", "-n", "io.automaticai.holocene/sh.delo.holocene.auto.MainActivity")
    out["m3_app_relaunched"] = time.time()
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    {"p1": p1, "p2": p2, "p3": p3}[sys.argv[1]]()

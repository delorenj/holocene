"""Final-regression driver: p2_driver_patch.py (survives Candystore timeouts) plus two harness fixes found on 2026-10-22.

1. rec_start matched the pad's `deferred ack ... mic=recording reason=recording` line (a stop cue queued while the mic was still
   recording) as "the mic is recording": only the `HoloceneSpeech: mic ` state line counts.
2. rec_stop: a stop tap can be lost under host load (r1-03: no stop for 51 s, the next tap stopped it and the 56 s capture came back
   `empty_capture`). Wait 8 s for any sign the stop registered (mic=idle, deferred/start ack:stopped); only then retap ONCE. A retap
   after a registered stop would START a new recording, so it is never done on a slow-but-registered stop.
"""
import os, sys, time
os.environ.setdefault("W", "/tmp/conv-final")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runs", "phase2"))
import p2_driver_patch  # noqa: F401  (patches drive_converse in place)
import drive_converse as d


def rec_start(out):
    s0 = os.path.getsize(d.LOG)
    out["start_pressed"] = time.time()
    d.adb("shell", "input", "tap", *d.REC_TAP)
    end = time.time() + 25
    while time.time() < end:
        with open(d.LOG, "rb") as f:
            f.seek(s0)
            for line in f.read().decode("utf-8", "replace").splitlines():
                if "HoloceneSpeech: mic " in line and "mic=recording reason=recording" in line:
                    out["mic_recording_seen"] = time.time()
                    return True
        time.sleep(0.05)
    out["mic_recording_seen"] = None
    return False


def _stop_seen(s1):
    with open(d.LOG, "rb") as f:
        f.seek(s1)
        t = f.read().decode("utf-8", "replace")
    return "mic=idle reason=idle" in t or "ack:stopped" in t


def rec_stop(out):
    s1 = os.path.getsize(d.LOG)
    out["stop_pressed"] = time.time()
    d.adb("shell", "input", "tap", *d.REC_TAP)
    end = time.time() + 8
    while time.time() < end and not _stop_seen(s1):
        time.sleep(0.1)
    if not _stop_seen(s1):
        out["stop_retapped"] = time.time()
        d.adb("shell", "input", "tap", *d.REC_TAP)
    t, _ = d.wait_log("mic=idle reason=idle", s1, 20)
    out["mic_idle_seen"] = t
    return t is not None


d.rec_start, d.rec_stop = rec_start, rec_stop
if __name__ == "__main__":
    p2_driver_patch.d.rec_start, p2_driver_patch.d.rec_stop = rec_start, rec_stop
    if sys.argv[1] == "turn":
        a = p2_driver_patch.A(); a.name, a.text = sys.argv[2], sys.argv[3]
        try:
            d.do_turn(a)
        except SystemExit:
            pass

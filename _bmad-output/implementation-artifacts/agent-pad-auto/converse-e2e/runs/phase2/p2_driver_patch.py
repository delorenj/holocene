import json, sys, time, os
os.environ.setdefault("W", "/tmp/conv-p2")
sys.path.insert(0, '/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools')
import drive_converse as d
_fo = d.facts_of
def facts_of(mid):
    for _ in range(2):
        try: return _fo(mid)
        except Exception as e: err = e; time.sleep(1)
    return {"_err": [str(err)]}
d.facts_of = facts_of
def rec_stop(out):
    s1 = os.path.getsize(d.LOG)
    out["stop_pressed"] = time.time()
    d.adb("shell", "input", "tap", *d.REC_TAP)
    t, _ = d.wait_log("mic=idle reason=idle", s1, 20)   # never retap: a retap starts a new recording
    out["mic_idle_seen"] = t
    return t is not None
d.rec_stop = rec_stop
class A: quiet = 4.0; first_audio_timeout = 45.0; hold = 0.0
if __name__ == "__main__":
    if sys.argv[1] == "turn":
        a = A(); a.name, a.text = sys.argv[2], sys.argv[3]
        try:
            d.do_turn(a)
        except SystemExit:
            pass

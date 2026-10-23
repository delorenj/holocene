"""Fix re-run: barge a recording (B) into a fast reply (A), then let B finish. final_r3.py with the turn names as arguments.
usage: fix_barge.py <A name> "<A text>" <B name> "<B text>" [delay_s]"""
import json, sys, time
import final_driver  # noqa: F401  (patches drive_converse)
import drive_converse as d
a_name, a_text, b_name, b_text = sys.argv[1:5]
delay = float(sys.argv[5]) if len(sys.argv) > 5 else 2.5
off = d.clock_offset()
A = {"name": a_name, "text": a_text, "offset_s": off}
assert d.rec_start(A)
d.rec_say(A, d.synth(a_name, a_text)); d.rec_stop(A)
mid, key, disc = d.discover(A["stop_pressed"]); A.update(memo_id=mid, key=key)
print("A memo", mid, flush=True)
t_first = None; end = time.time() + 60
while time.time() < end and t_first is None:
    for e in d.speech_events(A["stop_pressed"] - 2, off):
        if e["ev"] == "start" and e["memo"].startswith(mid[:8]) and e["kind"] == "reply":
            t_first = e["t"]
    time.sleep(0.2)
print("A first start", t_first, flush=True)
time.sleep(delay)
B = {"name": b_name, "text": b_text, "offset_s": off, "barge_pressed": time.time()}
assert d.rec_start(B)
d.rec_say(B, d.synth(b_name, b_text)); d.rec_stop(B)
class Q: quiet = 8.0; first_audio_timeout = 60.0
d.finish_turn(B, off, Q)
A["first_start"] = t_first; A["facts"] = d.summarize(mid)
A["speech"] = [(round(e["t"] - A["stop_pressed"], 2), e["ev"], e["kind"], e["reason"][:40]) for e in d.speech_events(A["stop_pressed"] - 1, off) if e["memo"].startswith(mid[:8])]
A["types"] = (A["facts"] or {}).get("types")
d.record(A)
print(json.dumps({"A_memo": mid, "A_speech": A["speech"], "A_routed": (A["facts"]["routed"] or {}).get("path"), "A_types": A["types"],
                  "B_barge_at": B["barge_pressed"]}, default=str))

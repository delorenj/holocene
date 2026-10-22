"""R4/R5: ask A (a slow desk question), start recording B `gap` s after A's stop (a hold cue is pending), finish B.
usage: final_r4.py "<A text>" "<B text>" [gap_s]"""
import json, sys, time
import final_driver  # noqa: F401
import drive_converse as d
a_text, b_text = sys.argv[1], sys.argv[2]
gap = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
off = d.clock_offset()
A = {"name": "r4-a", "text": a_text, "offset_s": off}
assert d.rec_start(A)
d.rec_say(A, d.synth("r4-a", a_text)); d.rec_stop(A)
time.sleep(gap)
B = {"name": "r4-b", "text": b_text, "offset_s": off, "barge_pressed": time.time()}
assert d.rec_start(B)
d.rec_say(B, d.synth("r4-b", b_text)); d.rec_stop(B)
mid, key, disc = d.discover(A["stop_pressed"]); A.update(memo_id=mid, key=key)
class Q: quiet = 8.0; first_audio_timeout = 60.0
d.finish_turn(B, off, Q)
A["facts"] = d.summarize(mid)
A["speech"] = [(round(e["t"] - A["stop_pressed"], 2), e["ev"], e["kind"], e["reason"][:40]) for e in d.speech_events(A["stop_pressed"] - 1, off) if e["memo"].startswith(mid[:8])]
d.record(A)
print(json.dumps({"A_memo": mid, "A_speech": A["speech"], "A_routed": (A["facts"]["routed"] or {}).get("path"), "B_start_press": B["barge_pressed"], "A_stop": A["stop_pressed"]}, default=str))

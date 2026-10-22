import json, sys, time
sys.path.insert(0,'/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools')
import drive_converse as d
off=d.clock_offset()
A={"name":"s10-a","text":sys.argv[1],"offset_s":off}
d.rec_start(A); d.rec_say(A,d.synth("s10-a",sys.argv[1])); d.rec_stop(A)
mid,key,disc=d.discover(A["stop_pressed"]); A.update(memo_id=mid,key=key)
print("A memo",mid,flush=True)
t_first=None; end=time.time()+60
while time.time()<end and t_first is None:
    for e in d.speech_events(A["stop_pressed"]-2,off):
        if e["ev"]=="start" and e["memo"].startswith(mid[:8]) and e["kind"]=="reply": t_first=e["t"]
    time.sleep(0.2)
print("A first start",t_first,flush=True)
time.sleep(float(sys.argv[3]) if len(sys.argv)>3 else 2.5)   # barge in mid-reply
B={"name":"s10-b","text":sys.argv[2],"offset_s":off}
assert d.rec_start(B)
d.rec_say(B,d.synth("s10-b",sys.argv[2])); d.rec_stop(B)
class Q: quiet=8.0; first_audio_timeout=60.0
d.finish_turn(B,off,Q)
A["first_start"]=t_first; A["facts"]=d.summarize(mid); A["speech"]=[(round(e["t"]-A["stop_pressed"],2),e["ev"],e["kind"],e["reason"][:40]) for e in d.speech_events(A["stop_pressed"]-1,off) if e["memo"].startswith(mid[:8])]
d.record(A)
print(json.dumps({"A_speech":A["speech"],"A_routed":(A["facts"]["routed"] or {}).get("path")},default=str))

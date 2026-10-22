import json, sys, time, re
sys.path.insert(0,'/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools')
import drive_converse as d
MEMO=sys.argv[1]; TEXT=sys.argv[2]; NAME=sys.argv[3]; WAIT=float(sys.argv[4]); DELAY=float(sys.argv[5])
off=d.clock_offset()
wav=d.synth(NAME,TEXT)
t0=time.time(); start=None
n0=len(d.speech_events(time.time()-5,off))
while time.time()-t0<WAIT and start is None:
    for e in d.speech_events(t0-1-0,off):
        if e["ev"]=="start" and e["kind"]=="reply" and e["memo"].startswith(MEMO[:8]) and e["t"]>t0-1+0 and e["t"]-0>0 and e["t"]>=d.clock_offset()*0+t0-1:
            # the delegation's RESULT unit has a later reply stamp than the read-back: take starts after t0
            start=e["t"]
    time.sleep(0.3)
print("result start seen", start, flush=True)
if start is None: sys.exit(1)
time.sleep(DELAY)
B={"name":NAME,"text":TEXT,"offset_s":off}
assert d.rec_start(B)
d.rec_say(B,wav); d.rec_stop(B)
class Q: quiet=8.0; first_audio_timeout=60.0
d.finish_turn(B,off,Q)

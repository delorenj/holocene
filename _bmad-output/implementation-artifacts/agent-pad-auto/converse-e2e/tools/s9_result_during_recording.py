import json, subprocess, sys, time, datetime as dt
sys.path.insert(0,'/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools')
import drive_converse as d
BRIEF=sys.argv[1]; assert len(BRIEF)>=6, "empty brief id"; BRIEF=sys.argv[1]; NAME=sys.argv[2]; TEXT=sys.argv[3]; MAXHOLD=float(sys.argv[4]) if len(sys.argv)>4 else 270
def result_logged():
    since=(dt.datetime.now()-dt.timedelta(seconds=MAXHOLD+60)).strftime("%Y-%m-%d %H:%M:%S")
    txt=subprocess.run(["journalctl","--user","-u","holocene-inbox-watcher","--since",since,"-o","cat","--no-pager"],capture_output=True,text=True).stdout
    for l in txt.splitlines():
        if '"delegation_result"' in l and BRIEF in l: return l
    return None
off=d.clock_offset(); out={"name":NAME,"text":TEXT,"offset_s":off}
wav=d.synth(NAME,TEXT)
assert d.rec_start(out), "mic not recording"
t0=time.time(); hit=None
while time.time()-t0<MAXHOLD:
    hit=result_logged()
    if hit: break
    time.sleep(2)
out["held_s"]=round(time.time()-t0,1); out["result_logged_while_recording"]=bool(hit)
print("held", out["held_s"], "result_logged", bool(hit), flush=True)
if hit: time.sleep(10)   # let the result's reply object reach the pad while the mic is still open
d.rec_say(out, wav)
d.rec_stop(out)
class A: quiet=6.0; first_audio_timeout=60.0
d.finish_turn(out, off, A)

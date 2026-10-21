import json,sys,time,urllib.request
# S3 proof: a live "car" holds a one-file reply for `secs` seconds (as if behind a recording); /voice must not call it stuck.
mid=sys.argv[1]; dev=sys.argv[2]; secs=float(sys.argv[3])
STATE="/home/delorenj/.local/state/holocene-auto/inbox-watcher/state.json"
def post(b):
    r=urllib.request.Request("https://agent-pad.delo.sh/upload/claim",data=json.dumps(b).encode(),method="POST",headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(r,timeout=5))
def api():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:4000/api/modules/voice/memos/{mid}",timeout=10))
def rkey():
    m=next((v for v in json.load(open(STATE))["memos"].values() if v.get("memo_id")==mid),{})
    return (m.get("reply_up") or {}).get("rkey")
while not rkey(): time.sleep(0.3)
rk=rkey(); t0=time.time(); print(f"reply up, holding {rk}", flush=True)
nxt=0
while time.time()-t0<secs:
    a=post({"by":"car","action":"hold","reply_key":rk,"device":dev})
    if time.time()>=nxt:
        d=api()["memo"]
        h=next((h for h in d.get("hops",[]) if h["id"]=="replied"),{})
        print(f"+{time.time()-t0:5.1f}s hold ok={a.get('ok')} owner={a.get('owner')} | /voice status={d.get('status')} stuckAt={d.get('stuckAt')} replied.hop={h.get('status')} waited={round(h.get('waitedSeconds') or 0)}s chunks={[(c['n'],c['of']) for c in d.get('chunks',[])]}", flush=True)
        nxt=time.time()+15
    time.sleep(5)
print("hold released (stopped renewing)", flush=True)

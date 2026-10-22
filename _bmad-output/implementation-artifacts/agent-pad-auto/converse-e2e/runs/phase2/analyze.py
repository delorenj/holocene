import json, re, subprocess, datetime as dt, glob, bisect, statistics
W='/tmp/conv-p2'
SP=re.compile(r"^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+HoloceneSpeech:\s+(\w+) (\w*) id=(\S*) memo=(\S+) seq=(-?\d+) mic=(\w+) reason=(.*?) at=(\d+)\s*$")
offs=[]
for f in glob.glob(W+'/out-*.json'):
    try: offs.append(json.load(open(f))['offset_s'])
    except Exception: pass
off=statistics.median(offs) if offs else 0
ev=[]
for l in open(W+'/logcat.txt',errors='replace'):
    m=SP.match(l)
    if m: ev.append((float(m.group(1))-off,m.group(2),m.group(3),m.group(4),m.group(5),m.group(8)))
ev.sort()
def P(s):
    return dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
txt=subprocess.run(['journalctl','--user','-u','holocene-inbox-watcher','--since','16:29','-o','cat','--no-pager'],capture_output=True,text=True).stdout
J={}
for l in txt.splitlines():
    try:d=json.loads(l)
    except: continue
    mid=d.get('memo_id')
    if mid: J.setdefault(mid,[]).append(d)
# proxy logs
pt=subprocess.run(['docker','logs','--since','45m','agent-pad-upload'],capture_output=True,text=True)
PL={}
for l in (pt.stdout+pt.stderr).splitlines():
    try:d=json.loads(l)
    except: continue
    PL.setdefault(d.get('memo_id'),[]).append(d)
stops=[e for e in ev if e[1]=='deferred' and e[2]=='ack' and e[3].startswith('ack:stopped')]
rows=[]
for mid,es in sorted(J.items(), key=lambda kv: kv[1][0]['ts']):
    disc=[e for e in es if e['event']=='discovered']
    if not disc: continue
    td=P(disc[0]['ts'])
    # latest stop deferred-ack before discovered (device stop)
    cands=[s[0] for s in stops if s[0]<=td+0.5 and td-s[0]<30]
    # also ack start w/o deferral: handled by fallback below
    stop=max(cands) if cands else None
    r={'memo':mid[:8],'disc_s':None}
    r['stop']=stop
    r['stop_to_disc']=round(td-stop,2) if stop else None
    def ts(ev_, **kw):
        for e in es:
            if e['event']==ev_ and all(e.get(k)==v for k,v in kw.items()): return P(e['ts'])
    tw=ts('whisper_server_done') or ts('whisper_server_fallback')
    tt=None
    for e in es:
        if e['event']=='stage_done' and e.get('stage')=='transcribed': tt=P(e['ts'])
    tc=None
    for e in es:
        if e['event']=='converse_decided': tc=P(e['ts']); r['action']=e.get('action'); r['path']=e.get('path'); r['model']=e.get('model'); r['llm_ms']=e.get('llm_ms')
    v1=[P(e['ts']) for e in es if e['event']=='chunk_voiced' and e.get('chunk')==1]
    fail=[e for e in es if e['event']=='memo_failed']
    r['failed']=fail[0].get('code') if fail else None
    r['disc_to_transcribed']=round(tt-td,2) if tt else None
    r['transcribed_to_decided']=round(tc-tt,2) if tc and tt else None
    r['decided_to_chunk1']=round(v1[0]-tc,2) if v1 and tc else None
    # reply start
    st=[e for e in ev if e[1]=='start' and e[2]=='reply' and e[4]==mid[:8] or (e[1]=='start' and e[2]=='reply' and mid in e[3])]
    q=[e for e in ev if e[1]=='queued' and e[2]=='reply' and mid in e[3]]
    r['stop_to_chunk1_up']=round(v1[0]-stop,2) if v1 and stop else None
    r['chunk1_to_queued']=round(q[0][0]-v1[0],2) if q and v1 else None
    r['queued_to_start_wait']=None
    if st and stop: r['stop_to_first_start']=round(st[0][0]-stop,2)
    if q and st: r['queued_to_start_wait']=round(st[0][0]-q[0][0],2)
    ackend=[e[0] for e in ev if e[1]=='end' and e[2]=='ack' and stop and stop<e[0]<stop+15]
    r['acks_done_s']=round(max(ackend)-stop,2) if ackend else None
    r['focus_denied']=len([e for e in ev if mid in e[3] and 'focus_denied' in e[5]])
    r['text']=None
    rows.append(r)
json.dump(rows,open(W+'/rows.json','w'),indent=1)
for r in rows: print({k:v for k,v in r.items() if v is not None and k not in ('stop','text')})

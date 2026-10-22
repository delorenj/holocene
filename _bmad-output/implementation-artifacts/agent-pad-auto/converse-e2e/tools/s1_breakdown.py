import json, sys, statistics, re
sys.path.insert(0,'/home/delorenj/code/33GOD/holocene/services/inbox-watcher')
import memo_common as c
sys.path.insert(0,'/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools')
import drive_converse as d
rows=[json.loads(l) for l in open('turns.jsonl')]
rows=[r for r in rows if re.fullmatch(r"s1-\d\d", r['name'])]
cols=["upload","received","transcribed","routed","replied","first_start","first_audible"]
tab=[]
for r in rows:
    st=r['stop_pressed']
    ev={}
    for e in c.candystore_events(r['memo_id']):
        t=e['type'].replace('bloodbank.audio.memo.','')
        ts=((e.get('data') or {}).get('occurred_at')) or e.get('time')
        ev.setdefault(t,c.parse_iso(ts).timestamp())
    row={"name":r['name'],"memo":r['memo_id'][:8]}
    for k in ("uploaded","received","transcribed","routed","replied"):
        row[k]=round(ev[k]-st,2) if k in ev else None
    row["first_start"]=r.get('stop_to_first_start_s')
    row["first_audible"]=d.tap_audible(r['first_start']) - st if r.get('first_start') and d.tap_audible(r['first_start']) else None
    if row["first_audible"] is not None: row["first_audible"]=round(row["first_audible"],2)
    f=(r['facts'].get('routed') or {})
    row["llm_ms"]=f.get('latency_ms'); row["cached"]=f.get('cached_tokens'); row["model"]=f.get('model_answered'); row["route"]=f.get('route'); row["turn"]=f.get('conv_turn'); row["action"]=f.get('action')
    tab.append(row)
json.dump(tab,open('s1-table.json','w'),indent=1)
print(f"{'turn':6s} {'memo':8s} {'upl':>5s} {'recv':>5s} {'trans':>6s} {'routd':>6s} {'repl':>6s} {'1stStart':>8s} {'audible':>8s} {'llm':>5s} {'cached':>6s}  model@route (conv turn)")
for r in tab:
    print(f"{r['name']:6s} {r['memo']:8s} {str(r['uploaded']):>5s} {str(r['received']):>5s} {str(r['transcribed']):>6s} {str(r['routed']):>6s} {str(r['replied']):>6s} {str(r['first_start']):>8s} {str(r['first_audible']):>8s} {str(r['llm_ms']):>5s} {str(r['cached']):>6s}  {r['model']}@{r['route']} (turn {r['turn']}, {r['action']})")
v=sorted(r['first_audible'] for r in tab if r['first_audible'] is not None)
s=sorted(r['first_start'] for r in tab if r['first_start'] is not None)
q=lambda a,p:a[min(len(a)-1,int(round(p*(len(a)-1))))]
print(f"audible n={len(v)} p50={statistics.median(v):.2f} p90={q(v,.9):.2f} max={v[-1]:.2f}   first-start n={len(s)} p50={statistics.median(s):.2f} p90={q(s,.9):.2f} max={s[-1]:.2f}")
for k in ("uploaded","received","transcribed","routed","replied"):
    a=[r[k] for r in tab if r[k] is not None]
    print(k, 'p50', round(statistics.median(a),2))

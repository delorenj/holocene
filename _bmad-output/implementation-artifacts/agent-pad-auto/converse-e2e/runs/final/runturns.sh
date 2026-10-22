#!/bin/bash
# usage: runturns.sh file (name|text)
export W=/tmp/conv-final
P=/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools/final_driver.py
while IFS='|' read -r n t <&3; do
  python3 $P turn "$n" "$t" > $W/out-$n.json 2>&1 </dev/null
  python3 - "$n" <<'P'
import json,sys
d=json.load(open('/tmp/conv-final/out-%s.json'%sys.argv[1]))
r=(d.get('facts') or {}).get('routed') or {}
f=d.get('facts') or {}
print(sys.argv[1],str(d.get('memo_id'))[:8],r.get('action'),r.get('path'),r.get('model_answered'),r.get('route'),r.get('latency_ms'),'start',d.get('stop_to_first_start_s'),'|',(r.get('say') or '')[:110],'| disp',len(f.get('dispatched',[])),d.get('error',''),flush=True)
P
done 3< "$1"

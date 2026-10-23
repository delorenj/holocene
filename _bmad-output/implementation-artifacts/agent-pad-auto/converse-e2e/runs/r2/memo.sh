#!/bin/bash
# usage: memo.sh <name> "<text>"   - load gate (shared 600 s wait budget), then one memo via final_driver
export W=/tmp/conv-r2 LEAD_IN_S=${LEAD_IN_S:-2.5}
n="$1"; t="$2"
P=/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools/final_driver.py
used=$(cat $W/wait_used 2>/dev/null || echo 0)
l=$(cut -d' ' -f1 /proc/loadavg)
echo "$n load1=$l at $(date +%T) wait_used=$used" >> $W/load.log
while [ "$(echo "$l > 40" | bc)" = 1 ] && [ "$used" -lt 600 ]; do
  sleep 15; used=$((used+15)); echo $used > $W/wait_used; l=$(cut -d' ' -f1 /proc/loadavg)
done
echo "$n GO load1=$l waited_total=$used at $(date +%T)" >> $W/load.log
python3 $P turn "$n" "$t" > $W/out-$n.json 2>&1 </dev/null
python3 - "$n" <<'P'
import json,sys
d=json.load(open('/tmp/conv-r2/out-%s.json'%sys.argv[1]))
r=(d.get('facts') or {}).get('routed') or {}
f=d.get('facts') or {}
print(sys.argv[1],str(d.get('memo_id'))[:8],r.get('action'),r.get('path'),r.get('model_answered'),r.get('latency_ms'),'start',d.get('stop_to_first_start_s'),'|',(r.get('say') or '')[:300],'| disp',len(f.get('dispatched',[])),'deleg',len(f.get('delegated',[])),d.get('error',''),flush=True)
P

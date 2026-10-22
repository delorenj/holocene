#!/bin/bash
# usage: runlist.sh file   (lines: name|text)
D=/home/delorenj/code/33GOD/holocene/_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/tools
while IFS='|' read -r n t <&3; do
  python3 $D/drive_converse.py turn "$n" "$t" --quiet ${Q:-3} > /tmp/conv-e2e/out-$n.json 2>&1 </dev/null
  python3 - "$n" <<'P'
import json,sys
d=json.load(open('/tmp/conv-e2e/out-%s.json'%sys.argv[1]))
r=(d.get('facts') or {}).get('routed') or {}
print(sys.argv[1], r.get('action'), r.get('path'), r.get('model_answered'), r.get('route'), r.get('latency_ms'), 'start',d.get('stop_to_first_start_s'),'|', (r.get('say') or '')[:120], '| disp', len((d.get('facts') or {}).get('dispatched',[])), d.get('error',''))
P
done 3< "$1"

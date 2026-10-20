#!/usr/bin/env bash
# Poll up to 20 min: done when the gateway is no longer draining, or both consumers have ack_pending 0.
end=$(( $(date +%s) + 1200 ))
while (( $(date +%s) < end )); do
  st=$(python3 -c "import json;d=json.load(open('/home/delorenj/.hermes/gateway_state.json'));print(d['gateway_state'], d.get('active_agents'), [w.get('session','')[:40] for w in d.get('active_work') or []])")
  ap=$(curl -s 'http://127.0.0.1:8222/jsz?consumers=true' | python3 -c "
import json,sys
d=json.load(sys.stdin);o=[]
for a in d.get('account_details',[]):
  for s in a.get('stream_detail',[]):
    for c in s.get('consumer_detail',[]) or []:
      if 'hermes-gateway' in c['name']: o.append(c['num_ack_pending'])
print(sum(o))")
  echo "$(date -u +%T) state=$st ack_pending_total=$ap"
  case "$st" in draining*) ;; *) echo "NOT_DRAINING"; exit 0;; esac
  [ "$ap" = "0" ] && { echo "ACK_ZERO"; exit 0; }
  sleep 30
done
echo TIMEOUT; exit 1

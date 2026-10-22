#!/bin/bash
# one line: UTC time, both consumers' ack_pending/pending, and the latest gateway executions
curl -s 'http://127.0.0.1:8222/jsz?consumers=true' | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
out=[datetime.datetime.now(datetime.UTC).strftime('%H:%M:%S')]
for a in d.get('account_details',[]):
  for s in a.get('stream_detail',[]):
    for c in s.get('consumer_detail',[]) or []:
      if 'hermes' in c['name']: out.append('%s ack_pending=%s pending=%s' % (c['name'].replace('bloodbank-hermes-gateway','gw'), c.get('num_ack_pending'), c.get('num_pending')))
print(' | '.join(out))
"
sqlite3 "file:$HOME/.hermes/bloodbank-hermes-gateway-state.sqlite3?mode=ro" "select substr(command_id,1,8), lane, state, created_at, updated_at, coalesce(detached_at,'') from executions order by created_at desc limit ${1:-6}"

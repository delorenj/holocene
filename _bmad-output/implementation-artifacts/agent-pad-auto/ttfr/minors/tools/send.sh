#!/bin/bash
# synthetic "car" sender: a memo uploaded as host=car by a device that never opens a push stream (the car is off)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
KEY="inbox/holocene-pm/$(date -u +%Y/%m/%d)/${STAMP}.ogg"
curl -sS -X PUT -H "Content-Type: audio/ogg" -H "X-Holocene-Device: offcar-$1" -H "X-Holocene-Host: car" \
  -H "User-Agent: HoloceneAuto/s1-proof (car off)" --data-binary @/tmp/s1proof/memo.ogg "https://agent-pad.delo.sh/upload/$KEY" -w ' http=%{http_code}\n'
echo "$KEY"
python3 -c "import uuid,sys;print(uuid.uuid5(uuid.NAMESPACE_URL,'s3://holocene-auto/'+sys.argv[1]))" "$KEY"

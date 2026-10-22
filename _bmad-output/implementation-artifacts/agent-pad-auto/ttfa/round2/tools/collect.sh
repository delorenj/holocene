#!/bin/bash
# refresh the round's server-side logs into /tmp/ttfa2
S=$(cat /tmp/ttfa2/session-start.txt)
docker logs --since "$S" agent-pad-upload 2>&1 | grep '^{' > /tmp/ttfa2/proxy.log
journalctl --user -u holocene-inbox-watcher --since "$(date -d "$S" '+%Y-%m-%d %H:%M:%S')" -o cat --no-pager | grep '^{' > /tmp/ttfa2/watcher.jsonl
wc -l /tmp/ttfa2/proxy.log /tmp/ttfa2/watcher.jsonl

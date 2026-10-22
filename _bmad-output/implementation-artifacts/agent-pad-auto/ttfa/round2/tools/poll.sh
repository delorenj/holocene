#!/bin/bash
while [ ! -e /tmp/ttfa2/stop-poll ]; do
  bash /tmp/ttfa2/lanes.sh 6 >> /tmp/ttfa2/lanes-poll.txt 2>&1
  sleep 2
done

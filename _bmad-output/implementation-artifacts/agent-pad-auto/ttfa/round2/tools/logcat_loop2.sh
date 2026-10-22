#!/bin/bash
# keep an adb logcat (epoch) running into /tmp/ttfa2/logcat.txt; on restart, backfill from the last logged epoch (dupes removed later)
A=/home/delorenj/Android/Sdk/platform-tools/adb
while [ ! -e /tmp/ttfa2/stop-logcat ]; do
  last=$(tail -n 50 /tmp/ttfa2/logcat.txt 2>/dev/null | grep -oE '^ *[0-9]{10}\.[0-9]{3}' | tail -1 | tr -d ' ')
  echo "### logcat (re)start $(date +%s.%N) from ${last:-now}" >> /tmp/ttfa2/logcat-restarts.txt
  if [ -n "$last" ]; then
    $A -s emulator-5554 logcat -v epoch -T "$last" >> /tmp/ttfa2/logcat.txt 2>>/tmp/ttfa2/logcat-err.txt
  else
    $A -s emulator-5554 logcat -v epoch -T 1 >> /tmp/ttfa2/logcat.txt 2>>/tmp/ttfa2/logcat-err.txt
  fi
  sleep 1
done

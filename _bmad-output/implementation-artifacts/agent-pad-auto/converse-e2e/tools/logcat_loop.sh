#!/bin/bash
# keep an adb logcat (epoch) of emulator-5554 only running into $W/logcat.txt; on a restart, backfill from the last logged epoch
W=${W:-/tmp/conv-e2e}
A=/home/delorenj/Android/Sdk/platform-tools/adb
while [ ! -e $W/stop-logcat ]; do
  last=$(tail -n 50 $W/logcat.txt 2>/dev/null | grep -oE '^ *[0-9]{10}\.[0-9]{3}' | tail -1 | tr -d ' ')
  echo "### logcat (re)start $(date +%s.%N) from ${last:-now}" >> $W/logcat-restarts.txt
  if [ -n "$last" ]; then
    $A -s emulator-5554 logcat -v epoch -T "$last" >> $W/logcat.txt 2>>$W/logcat-err.txt
  else
    $A -s emulator-5554 logcat -v epoch -T 1 >> $W/logcat.txt 2>>$W/logcat-err.txt
  fi
  sleep 1
done

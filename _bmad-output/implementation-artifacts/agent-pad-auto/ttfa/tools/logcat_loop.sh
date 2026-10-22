#!/bin/bash
# keep an adb logcat (epoch) running into /tmp/ttfa/logcat.txt until /tmp/ttfa/stop-logcat exists
A=/home/delorenj/Android/Sdk/platform-tools/adb
while [ ! -e /tmp/ttfa/stop-logcat ]; do
  echo "### logcat (re)start $(date +%s.%N)" >> /tmp/ttfa/logcat-restarts.txt
  $A -s emulator-5554 logcat -v epoch -T 1 >> /tmp/ttfa/logcat.txt 2>>/tmp/ttfa/logcat-err.txt
  sleep 1
done

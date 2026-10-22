#!/usr/bin/env python3
"""Sample device-minus-host clock offset over adb (emulator-5554 only). Appends to /tmp/ttfa2/clock-<tag>.txt."""
import subprocess, sys, time
tag = sys.argv[1] if len(sys.argv) > 1 else "x"
out = []
for _ in range(3):
    t0 = time.time()
    d = subprocess.run(["/home/delorenj/Android/Sdk/platform-tools/adb", "-s", "emulator-5554", "shell", "date +%s.%N"],
                       capture_output=True, text=True).stdout.strip()
    t1 = time.time()
    off = (float(d) - (t0 + t1) / 2) * 1000
    out.append("offset_ms(device-host)=%.0f rtt_ms=%.0f" % (off, (t1 - t0) * 1000))
    time.sleep(0.3)
open(f"/tmp/ttfa2/clock-{tag}.txt", "a").write("\n".join(out) + "\n")
print("\n".join(out))

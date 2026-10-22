#!/usr/bin/env python3
"""Watcher journal events since <since> (journalctl syntax), optional memo prefix filter."""
import json, subprocess, sys
since = sys.argv[1] if len(sys.argv) > 1 else "-120s"
pfx = sys.argv[2] if len(sys.argv) > 2 else ""
out = subprocess.run(["journalctl", "--user", "-u", "holocene-inbox-watcher", "--since", since, "-o", "cat", "--no-pager"],
                     capture_output=True, text=True).stdout
for l in out.splitlines():
    try:
        d = json.loads(l)
    except ValueError:
        continue
    mid = str(d.get("memo_id", ""))
    if pfx and not mid.startswith(pfx):
        continue
    ex = {k: v for k, v in d.items() if k not in ("ts", "svc", "level", "key", "memo_id", "event")}
    print(d["ts"][11:23], d["event"], mid[:8], json.dumps(ex)[:260])

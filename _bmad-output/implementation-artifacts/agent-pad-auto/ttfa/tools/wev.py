#!/usr/bin/env python3
"""Print the watcher's structured events captured in /tmp/ttfa/watcher.jsonl (optionally for one memo prefix)."""
import json, sys

pfx = sys.argv[1] if len(sys.argv) > 1 else ""
for l in open("/tmp/ttfa/watcher.jsonl"):
    try:
        d = json.loads(l)
    except ValueError:
        continue
    mid = str(d.get("memo_id", ""))
    if pfx and not mid.startswith(pfx):
        continue
    extra = {k: v for k, v in d.items() if k not in ("ts", "event", "memo_id", "level", "key", "svc")}
    print(d.get("ts"), d.get("event"), mid[:8], json.dumps(extra)[:220])

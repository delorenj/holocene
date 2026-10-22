#!/usr/bin/env python3
"""Markdown table of every converse-e2e turn: what whisper heard, the decision, who answered, what was said.
usage: scenario_table.py <turns.jsonl> <heard.json> [name-prefix ...]   (heard.json: {memo-id-prefix: transcript})"""
import json
import re
import sys

turns = [json.loads(l) for l in open(sys.argv[1])]
heard = json.load(open(sys.argv[2]))
pfx = tuple(sys.argv[3:])
print("| turn | memo | whisper heard | action / path | answered by (route, ms) | desk said | stop to the car starting it |")
print("|---|---|---|---|---|---|---|")
for r in turns:
    if pfx and not r["name"].startswith(pfx):
        continue
    mid = (r.get("memo_id") or "")[:8]
    ro = (r.get("facts") or {}).get("routed") or {}
    who = f"{ro.get('model_answered')} ({ro.get('route')}, {ro.get('latency_ms')} ms)" if ro.get("model_answered") else "no model call" if ro else "-"
    act = f"{ro.get('action')} / {ro.get('path')}" + (f" [{','.join(ro['guard'])}]" if ro.get("guard") else "") if ro else "no routed fact"
    say = (ro.get("say") or "").replace("|", "/").replace("\n", " ")
    say = say if len(say) < 140 else say[:137] + "..."
    aud = r.get("stop_to_first_start_s")
    print(f"| {r['name']} | `{mid}` | {(heard.get(mid) or '').replace('|', '/')} | {act} | {who} | {say} | {aud if aud is not None else '-'} s |")

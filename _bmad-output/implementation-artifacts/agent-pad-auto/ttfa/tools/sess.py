#!/usr/bin/env python3
"""Dump a Hermes bloodbank session for a memo (by chat_id prefix): each row's offset, role, model gap and tool time.
usage: sess.py <profile> <chat_id prefix>"""
import json, sqlite3, sys

prof, pfx = sys.argv[1], sys.argv[2]
db = sqlite3.connect(f"/home/delorenj/.hermes/profiles/{prof}/state.db")
for sid, chat, started, model, n, tools, api, outtok, reas in db.execute(
        "select id, chat_id, started_at, model, message_count, tool_call_count, api_call_count, output_tokens, reasoning_tokens "
        "from sessions where chat_id like ? order by started_at", (pfx + "%",)):
    print(f"session {sid} chat {chat} model {model} msgs {n} tools {tools} api_calls {api} out_tok {outtok} reasoning_tok {reas}")
    rows = db.execute("select role, timestamp, content, tool_calls, tool_name, active from messages where session_id=? order by id",
                      (sid,)).fetchall()
    t0 = rows[0][1] if rows else started
    prev = t0
    for role, ts, content, tc, tname, active in rows:
        names = ""
        if tc:
            try:
                names = ",".join(c["function"]["name"] + ":" + c["function"]["arguments"][:90] for c in json.loads(tc))
            except Exception:
                names = tc[:120]
        txt = (content or "").replace("\n", " ")[:110]
        print(f"  +{ts - t0:7.1f}s (gap {ts - prev:6.1f}s) {role:9s} {'' if active else '[inactive] '}{names} {txt}")
        prev = ts

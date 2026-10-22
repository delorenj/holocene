#!/usr/bin/env python3
"""Per-memo timeline for the TTFA round: Stop press (host), upload, transcribed, dispatched, turn start (gateway journal),
detach, agent done, and the first spoken answer on the car (logcat 'start reply', device clock -> host) or on the phone
(proxy 'heard' started), with the first speaker-tap packet above silence after the car's start. Writes timelines.json."""
import bisect, datetime as dt, json, re, sqlite3, sys
from pathlib import Path

import os
OFF = float(os.environ.get("OFF_MS", "0")) / 1000.0  # device - host, s
RUNS = {json.loads(l)["name"]: json.loads(l) for l in open("/tmp/ttfa2/runs.jsonl")}
MEMOS = json.load(open("/tmp/ttfa2/memos.json"))


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


proxy = [json.loads(l) for l in open("/tmp/ttfa2/proxy.log") if l.startswith("{")]
watch = []
for l in open("/tmp/ttfa2/watcher.jsonl"):
    try:
        watch.append(json.loads(l))
    except ValueError:
        pass
db = sqlite3.connect(f"file:{Path.home()}/.hermes/bloodbank-hermes-gateway-state.sqlite3?mode=ro", uri=True)
speech = []
for l in open("/tmp/ttfa2/speech-logcat.txt", errors="replace"):
    m = re.match(r"^\s*(\d+\.\d+).*HoloceneSpeech: (start|end|halt|chunk) (\w+) id=(\S*) memo=(\S+)", l)
    if m:
        speech.append((float(m.group(1)) - OFF, m.group(2), m.group(3), m.group(4), m.group(5)))
tap = [json.loads(l) for l in open("/tmp/ttfa2/tap.jsonl")]
tap_t = [p["t"] for p in tap]


def audible_after(t, within=3.0):
    i = bisect.bisect_left(tap_t, t)
    while i < len(tap) and tap[i]["t"] < t + within:
        if tap[i]["rms"] >= 30:
            return tap[i]["t"]
        i += 1
    return None


out = {}
for name, pfx in MEMOS.items():
    r = RUNS[name]
    stop = r["stop_pressed"]
    row = {"memo": pfx, "stop_pressed": stop}
    up = [p for p in proxy if p.get("event") == "upload" and p.get("memo_id", "").startswith(pfx)]
    fail = [p for p in proxy if p.get("client_event") == "record_failed" and p.get("memo_id", "").startswith(pfx)]
    if fail:
        row["record_failed"] = fail[0].get("code")
    if up:
        row["upload"] = ts(up[0]["ts"])
    if not up:
        u = [w for w in watch if str(w.get("memo_id", "")).startswith(pfx) and w.get("event") == "discovered"]
        row["upload_from_watcher"] = True
    ev = [w for w in watch if str(w.get("memo_id", "")).startswith(pfx)]

    def first(pred):
        for w in ev:
            if pred(w):
                return ts(w["ts"])
        return None
    row["transcribed"] = first(lambda w: w.get("event") == "stage_done" and w.get("stage") == "transcribed")
    row["stt_ms"] = next((w.get("ms") for w in ev if w.get("event") == "whisper_server_done"), None)
    row["dispatched"] = first(lambda w: w.get("event") == "stage_done" and w.get("stage") == "dispatched")
    cids = [w["command_id"] for w in ev if w.get("event") == "stage_done" and w.get("stage") == "dispatched"]
    cids += [w["command_id"] for w in ev if w.get("event") == "followup_started"]
    row["followup_started"] = first(lambda w: w.get("event") == "followup_started")
    row["detached_seen"] = first(lambda w: w.get("event") == "memo_detached")
    row["commands"] = []
    for cid in cids:
        x = db.execute("select lane, state, created_at, updated_at, detached_at from executions where command_id=?", (cid,)).fetchone()
        if x:
            row["commands"].append({"cid": cid[:8], "lane": x[0], "state": x[1], "turn_start": ts(x[2]), "updated": ts(x[3]),
                                    "detached_at": ts(x[4]) if x[4] else None})
    row["agent_done"] = [ts(w["ts"]) for w in ev if w.get("event") == "stage_done" and w.get("stage") == "agent"]
    row["escalated"] = [ts(w["ts"]) for w in ev if w.get("event") == "memo_escalated"]
    row["background"] = any(w.get("event") == "background_requested" for w in ev)
    sp = [s for s in speech if s[4].startswith(pfx)]
    replies = [s for s in sp if s[2] == "reply" and s[1] == "start"]
    row["car_reply_starts"] = [s[0] for s in replies]
    row["car_reply_audible"] = [audible_after(s[0]) for s in replies]
    row["car_echo_start"] = next((s[0] for s in sp if s[2] == "echo" and s[1] == "start"), None)
    row["car_progress_starts"] = [s[0] for s in sp if s[2] == "progress" and s[1] == "start"]
    row["car_progress_audible"] = [audible_after(t) for t in row["car_progress_starts"]]
    row["car_reply_ids"] = [s[3] for s in replies]
    ph = [p for p in proxy if p.get("event") == "heard" and p.get("phase") == "started" and pfx in str(p.get("key", ""))]
    row["phone_started"] = [ts(p["ts"]) for p in ph]
    out[name] = row

json.dump(out, open("/tmp/ttfa2/timelines.json", "w"), indent=1)


def rel(t, base):
    return "-" if t is None or base is None else "%+.1f" % (t - base)


for name, row in out.items():
    st, upl = row["stop_pressed"], row.get("upload")
    print(f"{name:3s} {row['memo']} stop->upload {rel(upl, st)}  from upload: transcribed {rel(row['transcribed'], upl)} "
          f"(stt {row['stt_ms']} ms) dispatched {rel(row['dispatched'], upl)}")
    for c in row["commands"]:
        print(f"      cmd {c['cid']} {c['lane']:11s} turn_start {rel(c['turn_start'], upl)} detached {rel(c['detached_at'], upl)} "
              f"done {rel(c['updated'], upl)} ({c['state']})")
    print(f"      followup_started {rel(row['followup_started'], upl)} detached_seen {rel(row['detached_seen'], upl)} escalated {row['escalated']}")
    print(f"      echo {rel(row['car_echo_start'], upl)} progress {[rel(t, upl) for t in row['car_progress_starts']]} prog audible {[rel(t, upl) for t in row['car_progress_audible']]} "
          f"car reply starts {[rel(t, upl) for t in row['car_reply_starts']]} audible {[rel(t, upl) for t in row['car_reply_audible']]} "
          f"phone {[rel(t, upl) for t in row['phone_started']]} {row.get('record_failed', '')}")

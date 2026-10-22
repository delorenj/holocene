"""Per-memo table for the final regression. W=/tmp/conv-final holds turns.jsonl, logcat.txt, tap.jsonl, watcher-events.jsonl, proxy.jsonl."""
import json, re, sys, datetime as dt, bisect, os
W = '/tmp/conv-final'
SP = re.compile(r"^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+HoloceneSpeech:\s+(\w+) (\w*) id=(\S*) memo=(\S+) seq=(-?\d+) mic=(\w+) reason=(.*?) at=(\d+)\s*$")
sys.path.insert(0, '/home/delorenj/code/33GOD/holocene/services/inbox-watcher')
import memo_common as c
P = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
rows = [json.loads(l) for l in open(W + '/turns.jsonl')]
ev = []
for l in open(W + '/logcat.txt', errors='replace'):
    m = SP.match(l)
    if m: ev.append((float(m.group(1)), m.group(2), m.group(3), m.group(4), m.group(5), m.group(8)))
tap = [json.loads(l) for l in open(W + '/tap.jsonl')]
tt = [p['t'] for p in tap]
def audible(t):
    i = bisect.bisect_left(tt, t)
    while i < len(tap) and tap[i]['t'] < t + 4:
        if tap[i]['rms'] >= 30: return tap[i]['t']
        i += 1
J = {}
for l in open(W + '/watcher-events.jsonl'):
    try: d = json.loads(l)
    except Exception: continue
    if d.get('memo_id'): J.setdefault(d['memo_id'], []).append(d)
PL = {}
for l in open(W + '/proxy.jsonl'):
    try: d = json.loads(l)
    except Exception: continue
    PL.setdefault(d.get('memo_id'), []).append(d)
out = []
for r in rows:
    mid = r.get('memo_id')
    if not mid or 'stop_pressed' not in r: continue
    off = r['offset_s']; stop = r['stop_pressed']
    mine = [e for e in ev if e[4].startswith(mid[:8])]
    reply_start = next((e[0] - off for e in mine if e[1] == 'start' and e[2] == 'reply'), None)
    beacon = next((P(d['ts']) for d in PL.get(mid, []) if d.get('event') == 'playback' and d.get('phase') == 'started'), None)
    skipped = [(d.get('phase'), d.get('error')) for d in PL.get(mid, []) if d.get('event') == 'playback' and d.get('phase') not in ('started', 'ended')]
    cues = [(round(P(d['ts']) - stop, 1), d.get('n'), d.get('voice'), d.get('text')) for d in J.get(mid, []) if d.get('event') == 'hold_cue']
    dropped = [(round(P(d['ts']) - stop, 1), d.get('reason')) for d in J.get(mid, []) if d.get('event') == 'hold_cue_dropped']
    cue_played = [(round(e[0] - off - stop, 1), e[1]) for e in mine if e[2] == 'progress' and e[1] in ('start',)]
    hold_played = [x for x in cue_played]
    f = (r.get('facts') or {}).get('routed') or {}
    heard = None
    try:
        for e in c.candystore_events(mid):
            if e['type'].endswith('transcribed'):
                dd = e.get('data') or {}
                heard = dd.get('transcript_text') or dd.get('text'); break
    except Exception as x:
        heard = 'ERR ' + str(x)[:40]
    aud = audible(reply_start) if reply_start else None
    out.append(dict(stop_to_upload=r.get('stop_to_upload_discover_s'), name=r['name'], memo=mid[:8], said=r['text'], heard=heard, action=f.get('action'), path=f.get('path'),
                    model=f.get('model_answered'), served=f.get('served_route'), route=f.get('route'), desk_ms=f.get('latency_ms'),
                    reason=f.get('fallback_reason'), tool=f.get('tool'), tile_voice=f.get('tile_voice'),
                    stop_to_start_reply=round(reply_start - stop, 2) if reply_start else None,
                    stop_to_beacon=round(beacon - stop, 2) if beacon else None,
                    stop_to_audible=round(aud - stop, 2) if aud else None,
                    hold_cues_uploaded=cues, hold_dropped=dropped, progress_started=cue_played,
                    playback_skipped=skipped, dispatched=len((r.get('facts') or {}).get('dispatched', []))))
json.dump(out, open(W + '/final-table.json', 'w'), indent=1, default=str)
for o in out:
    print(o['name'], o['memo'], '|', (o['heard'] or '')[:60], '|', o['action'], o['path'], o['model'], o['desk_ms'], o['reason'] or '', '| start', o['stop_to_start_reply'], 'beacon', o['stop_to_beacon'], 'aud', o['stop_to_audible'], '| cues', o['hold_cues_uploaded'], o['hold_dropped'], 'prog', o['progress_started'][:4], o['playback_skipped'], 'disp', o['dispatched'])

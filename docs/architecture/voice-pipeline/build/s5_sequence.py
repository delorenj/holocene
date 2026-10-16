from lib import Svg, figure
from html import escape as esc

LANES = ["Honda app + Pad", "Upload + MinIO", "inbox-watcher (transcribe, vox)", "NATS JetStream", "Hermes gateway", "Hermes agent", "Read side"]
LX = [80 + i * 134 for i in range(7)]
RX = 1010

# (from, to, arrow label, title, event/command, evidence, kind)
STEPS = [
 (0,1,"PUT .ogg","Pad uploads the clip","PUT /upload/inbox/33god-pm/2026/10/16/20261016T121046Z.ogg  33218 B","docker logs agent-pad-upload | grep '\"event\":\"upload\"'   (12:10:55.835)",""),
 (1,3,"memo.uploaded","MinIO store, then announce","evt  bloodbank.audio.memo.uploaded  (raw NATS, fail-open)","mc stat delo/holocene-auto/<key>   Candystore ?type=...memo.uploaded   (12:10:55.836)",""),
 (2,2,"received","Watcher discovers the object","evt  audio.memo.received  memo_id = uuid5(s3 key) = correlationid  (+2.5 s)","memo:trace hop received   journald stage=received   state.json",""),
 (2,2,"transcribe 43 s","ffprobe + faster-whisper","evt  audio.memo.transcribed  large-v3, 42 chars, CPU fallback","memo:trace hop transcribed   journald stage=transcribe ms",""),
 (2,3,"invoke + dispatched","Dispatch on the interactive lane","cmd  bloodbank.cmd.agent.invocation.invoke   evt  audio.memo.dispatched","jsz consumer num_pending / ack_pending   heartbeat.lanes   (12:11:43.912)",""),
 (3,4,"pull (slot 1 of 2)","Gateway pulls, claims a journal row","executions row lane=interactive pending > started   evt  agent.invocation.started","sqlite3 -readonly ~/.hermes/bloodbank-hermes-gateway-state.sqlite3   (12:11:43.934)",""),
 (4,5,"turn, clock 300 s","Hermes runs the agent turn","MessageEvent(internal) chat_id = memo_id   evt  conversation.turn.*   10.3 s here","profile state.db session source=bloodbank   session_turn_leases   aai-llm-observability",""),
 (4,3,"completed + ack","Turn ends, slot freed","evt  agent.invocation.completed (or failed)   journal state=completed outcome=success","Candystore type=...invocation.completed   jsz ack_pending back to 0   (12:11:54.204)",""),
 (2,5,"read reply","Watcher reads the answer","journal row by command_id; last assistant message by chat_id; prompt_match 115 chars","memo:trace hop hermes_session   (read-only sqlite, never written)","dash"),
 (2,2,"TTS 1.9 s","vox synthesizes the reply","POST https://vox.delo.sh/synthesize-url  voice rick  vibevoice  text cut to 500 chars","vox logs   replied fact carries tts_engine",""),
 (2,1,"put replies/ .ogg","Reply stored","replies/2026/10/16/121157Z-33god-pm-657e81ba-....ogg  14465 B   evt  audio.memo.replied","mc stat delo/holocene-auto/<reply key>   journald stage=reply_upload   (12:12:00.363)",""),
 (0,1,"poll, play, beacon","Pad plays the answer","poll replies/ every 15 s; POST /upload/played started, ended   evt  audio.memo.played","docker logs agent-pad-upload | grep playback   /voice 'played on pad'   (12:12:11.566)","dash"),
 (3,6,"evt.> projections","Read side projects every fact","Candystore + holocene-api (own consumer) feed /voice; only memo.failed pushes","curl -s 'http://127.0.0.1:8683/events?correlationid=<memo_id>'   mise run memo:trace 657e81ba",""),
 (4,3,"failed turn_timeout","VARIANT: turn exceeds the wall clock","/stop, journal failure_code=turn_timeout, evt invocation.failed, ack; watcher: agent_reply/turn_timeout","memo:trace STOPPED AT agent finished: turn timeout (300.1s)   /voice 'timed out after 300s'   memo:retry","accent"),
]

def html():
    H = 80 + len(STEPS) * 72 + 30
    g = Svg(1800, H, "seq", "d")
    # lanes
    for i, name in enumerate(LANES):
        g.raw(f'<line class="lane" x1="{LX[i]}" y1="64" x2="{LX[i]}" y2="{H-24}" stroke-dasharray="3 5"/>')
    g.raw(f'<text class="tt" x="{RX}" y="44">STEP / EVENT OR COMMAND / OBSERVABILITY EVIDENCE</text>')
    for i, (f, t, lab, title, ev, evid, kind) in enumerate(STEPS):
        y0 = 78 + i * 72
        if i % 2 == 0:
            g.raw(f'<rect x="0" y="{y0-8}" width="1800" height="72" fill="var(--sys)" opacity="0.28"/>')
        acc = kind == "accent"
        yl = y0 + 30
        if f == t:
            g.node(LX[f] - 66, yl - 17, 132, 34, lab, "", [], "component", accent=acc)
        else:
            x1, x2 = LX[f], LX[t]
            g.edge([(x1, yl), (x2, yl)], ("accent " if acc else "") + ("dash" if kind == "dash" else ""))
            g.label((x1 + x2) / 2, yl - 8, lab, "middle", "accent" if acc else "")
        g.badge(RX - 40, yl, i + 1 if i < 13 else "7x", acc)
        g.note(RX, y0 + 14, title, "h")
        g.note(RX, y0 + 32, ev, "m")
        g.note(RX, y0 + 49, evid, "ev")
    # lane headers last so they sit above lines
    for i, name in enumerate(LANES):
        parts = name.split(" (")
        g.node(LX[i] - 60, 8, 120, 48, parts[0] if len(parts) == 1 else parts[0], "", ([] if len(parts) == 1 else ["(" + parts[1]]), "system")
    svg = g.render("Dynamic view: one voice memo", "Numbered swimlane of memo 657e81ba from tap to played reply, with the event or command at each step and where to see it, plus the timeout variant.")
    pre = '<h2 id="dyn">Dynamic view: one memo, step by step</h2><p class="lede">Real run, memo_id <code>657e81ba-6c53-5f05-9e12-c4d2e196a996</code> (agent 33god-pm, interactive lane, command <code>d8529d87</code>), complete in 65.0 s: upload +0.8 s, discover +2.5 s, transcribe +44.5 s (the dominant cost), dispatch +1.1 s, agent 10.3 s, TTS and upload about 6 s, pad pickup about 14.6 s (its 15 s poll). Times are UTC on 2026-10-16.</p>'
    return pre + figure(svg, "Step numbers match the badges on the container view. The last row is the variant added today: a turn that outlives its 300 s wall clock is stopped, journaled as turn_timeout, announced as invocation.failed, and the memo can be re-dispatched with memo:retry. Whole journey: <code>curl -s 'http://127.0.0.1:8683/events?correlationid=&lt;memo_id&gt;&amp;limit=100'</code>.")

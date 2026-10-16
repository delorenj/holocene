from lib import Svg, figure

HOPS = [
 "Pad PUTs the Ogg/Opus clip (outbox retry) through Cloudflare and Traefik to agent-pad-upload.",
 "Upload proxy stores inbox/&lt;agent&gt;/&lt;date&gt;/&lt;ts&gt;.ogg in MinIO and publishes <code>audio.memo.uploaded</code> (raw NATS, fail-open).",
 "Watcher polls inbox/ every 5 s, derives memo_id = uuid5(s3 key), emits <code>received</code>.",
 "ffprobe, then transcribe (faster-whisper large-v3, CPU when the GPU is full); emits <code>transcribed</code>.",
 "Watcher emits <code>dispatched</code> and the command <code>agent.invocation.invoke</code> (interactive lane) via bb-emit.",
 "Interactive durable pulls it (2 slots); journal row pending to started; <code>invocation.started</code>.",
 "The Hermes turn runs against the model with tools. The per-turn wall clock (300 s default) is armed here.",
 "<code>invocation.completed</code> or <code>failed</code> (incl. <code>turn_timeout</code>); journal closed; message acked; slot freed.",
 "Watcher sees the journal row and reads the reply text from the profile state.db (chat_id = memo_id).",
 "Text goes to vox, which returns Ogg/Opus (vibevoice, voice rick).",
 "Watcher puts replies/&lt;date&gt;/...ogg in MinIO and emits <code>replied</code>.",
 "Pad polls replies/ every 15 s, auto-plays the newest, beacons <code>played</code> / <code>skipped</code>.",
 "Read side: every fact is projected (Candystore, Holocene API to /voice); only <code>audio.memo.failed</code> pushes to the phone.",
]

def html():
    g = Svg(1720, 900, "containers", "2")
    # boundaries
    g.zone(15, 50, 250, 270, "Car: Holocene Auto")
    g.zone(385, 24, 1215, 856, "big-chungus host")
    g.zone(397, 72, 215, 556, "Voice ingress [docker]", "zone solid")
    g.zone(665, 72, 220, 676, "Inbox watcher [systemd]", "zone solid")
    g.zone(930, 72, 130, 380, "Bloodbank", "zone solid")
    g.zone(1105, 300, 220, 370, "Hermes [systemd]", "zone solid")
    g.zone(1385, 100, 220, 350, "Read side", "zone solid")
    # car
    g.node(30, 90, 190, 84, "Holocene Auto app", "[container: Kotlin APK]", ["WebView host, NativeRecorder,", "CarHost parked-only gate"])
    g.node(30, 230, 190, 70, "Agent Pad", "[container: Vite/React SPA]", ["IndexedDB outbox, auto-play"])
    g.node(270, 230, 90, 70, "Cloudflare", "[edge]", ["tunnel, DNS"], "ext")
    # ingress
    g.node(410, 100, 190, 70, "agent-pad-web", "[container: nginx]", ["serves apps/agent-pad/dist"])
    g.node(410, 230, 190, 70, "Traefik", "[container: v3.6]", ["Host / PathPrefix routing"])
    g.node(410, 360, 190, 84, "agent-pad-upload", "[container: Python]", ["PUT /upload/inbox/...", "POST client-event, played"])
    g.node(410, 520, 190, 84, "MinIO holocene-auto", "[S3: s3.delo.sh]", ["inbox/<agent>/<date>/<ts>.ogg", "replies/<date>/...ogg"])
    # watcher
    g.node(680, 100, 190, 70, "transcribe", "[CLI: faster-whisper]", ["large-v3, CPU int8 fallback"])
    g.node(680, 290, 190, 130, "inbox-watcher", "[service: Python]", ["one state machine per memo", "memo_id = correlationid", "state.json, heartbeat,", "memo:trace|list|retry"], accent=True)
    g.node(680, 650, 190, 70, "vox TTS", "[container: vibevoice]", ["POST /synthesize-url"], "container")
    # bus
    g.node(940, 110, 110, 330, "NATS", "[JetStream]", ["BLOODBANK_", "COMMANDS", "(workqueue)", "", "BLOODBANK_", "EVENTS", "evt.>", "", "monitor :8222"])
    # hermes
    g.node(1120, 330, 190, 130, "Hermes gateway", "[plugin: Python]", ["interactive 2 slots,", "batch 4 slots,", "journal sqlite,", "per-turn wall clock 300 s"], accent=True)
    g.node(1120, 540, 190, 100, "Hermes agent profile", "[Python + SQLite]", ["holocene-pm etc.", "state.db: the reply text"])
    g.node(1120, 700, 190, 60, "AutomaticAI gateway", "[external]", ["api.automaticai.io"], "ext")
    # read side + others
    g.node(1400, 34, 190, 56, "Operator", "[person]", [], "person")
    g.node(1400, 140, 190, 70, "Candystore", "[container: dapr + PG]", ["GET :8683/events?corr..."])
    g.node(1400, 250, 190, 80, "Holocene API", "[service: Node :4000]", ["own JetStream consumer,", "/api/modules/voice/memos"])
    g.node(1400, 370, 190, 60, "Holocene web", "[container: Next.js]", ["/voice, Google OIDC"])
    g.node(1400, 480, 190, 70, "bloodbank-ntfy-router", "[container]", ["mute / loud / digest"])
    g.node(1400, 770, 190, 60, "ntfy + Telegram", "[external]", ["phone push, alerts"], "ext")

    # edges: device
    g.edge([(125,174),(125,230)], start=True); g.label(133,206,"WebView host",anchor="start")
    g.edge([(220,265),(270,265)]); g.label(245,254,"HTTPS",anchor="middle")
    g.edge([(360,265),(410,265)]); g.label(385,255,"tunnel",anchor="middle")
    g.edge([(480,230),(480,170)]); g.label(488,206,"serves pad",anchor="start")
    g.edge([(480,300),(480,360)]); g.label(488,334,"/upload/",anchor="start")
    g.edge([(505,444),(505,520)]); g.label(524,486,"S3 mc cp",anchor="start")
    # upload -> NATS over the top
    g.edge([(600,402),(640,402),(640,56),(1030,56),(1030,110)])
    g.label(880,48,"raw NATS: audio.memo.uploaded / played / failed",anchor="middle")
    # watcher <-> minio
    g.edge([(700,420),(700,562),(600,562)], start=True); g.label(650,548,"S3 mc",anchor="middle")
    # watcher <-> transcribe
    g.edge([(775,290),(775,170)]); g.label(783,236,"ffprobe,|transcribe",anchor="start")
    # watcher -> NATS
    g.edge([(870,350),(940,350)]); g.label(903,326,"facts +|invoke",anchor="middle")
    # NATS <-> gateway
    g.edge([(1050,380),(1120,380)]); g.label(1085,360,"invoke",anchor="middle")
    g.edge([(1120,420),(1050,420)], "accent"); g.label(1085,440,"started|completed|failed",anchor="middle",cls="accent")
    # gateway <-> agent
    g.edge([(1215,460),(1215,540)], start=True); g.label(1223,504,"turn",anchor="start")
    g.edge([(1215,640),(1215,700)]); g.label(1223,674,"HTTPS",anchor="start")
    # journal read (dashed) with hop over scrape vertical
    g.raw_edge("M855 420 L855 488 L1024 488 a6 6 0 0 1 12 0 L1160 488 L1160 460", "dash")
    g.label(922,480,"sqlite ro: journal row",anchor="middle")
    # reply read (dashed)
    g.raw_edge("M815 420 L815 590 L1024 590 a6 6 0 0 1 12 0 L1120 590", "dash")
    g.label(900,582,"sqlite ro: reply text",anchor="middle")
    # vox
    g.edge([(760,420),(760,650)]); g.label(768,620,"HTTPS",anchor="start")
    # read side from NATS
    g.edge([(1050,175),(1400,175)]); g.label(1225,167,"evt.> via dapr pubsub.jetstream",anchor="middle")
    g.edge([(1050,215),(1350,215),(1350,290),(1400,290)]); g.label(1200,207,"evt.> ephemeral consumer",anchor="middle")
    g.edge([(1050,255),(1330,255),(1330,515),(1400,515)]); g.label(1338,380,"evt.>",anchor="start")
    g.edge([(1495,370),(1495,330)]); g.label(1503,355,"HTTP",anchor="start")
    g.edge([(1590,62),(1625,62),(1625,400),(1590,400)]); g.label(1631,240,"reads|/voice",anchor="start")
    g.edge([(1590,515),(1620,515),(1620,800),(1590,800)]); g.label(1614,740,"push|failed",anchor="end")
    # monitoring: below NATS, scrape up
    g.node(900, 700, 200, 80, "Monitoring", "[Prometheus stack]", ["nats-exporter, Prometheus,", "Alertmanager, 2 lane rules"], "container")
    g.edge([(1030,700),(1030,440)]); g.label(1038,670,"scrape jsz",anchor="start")
    g.edge([(1050,780),(1050,800),(1400,800)]); g.label(1225,792,"Telegram",anchor="middle")
    # badges
    for (x,y,n,a) in [(230,286,1,False),(505,482,2,False),(700,500,3,False),(775,200,4,False),(905,350,5,False),
                      (1085,380,6,False),(1215,500,7,True),(1085,420,8,True),(855,455,9,False),(815,560,9,False),(760,560,10,False),
                      (650,562,11,False),(256,286,12,False),(1372,175,13,False)]:
        g.badge(x,y,n,a)
    svg = g.render("Containers of the voice memo pipeline", "All containers across the car, ingress, watcher, bus, Hermes and read side, with the thirteen numbered hops of one memo and the timeout path in the accent colour.")
    ol = '<ol class="hops">' + "".join(f"<li>{h}</li>" for h in HOPS) + "</ol>"
    pre = '<h2 id="l2">Level 2: containers, one memo end to end</h2><p class="lede">Every deployable piece the memo touches, grouped by the system that owns it. Numbered badges are the hops of one memo in order; the accent path is the per-turn wall clock added on 2026-10-16.</p>'
    return pre + figure(svg, "Dashed edges are read-only look-ups (the watcher reads the journal and the profile state.db; it never writes them). Not drawn to keep it legible: the watcher also reads agents-registry.yaml and Candystore (fallback trace), holocene-api reads the watcher heartbeat, and n8n/PMs publish invocation.start into the batch lane of the same bus.", ol)

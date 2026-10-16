"""Level 2 (containers) layout, shared by the HTML page (s2_containers.py) and the Excalidraw scene (excalidraw.py).
Edge order matters for the SVG: horizontal runs hop over the verticals of edges drawn before them."""

W, H = 1760, 900

# id, x, y, w, h, caption, kind
ZONES = [
    ("z-car", 15, 50, 250, 380, "Car: Holocene Auto", "zone"),
    ("z-host", 385, 10, 1335, 876, "big-chungus host", "zone"),
    ("z-ingress", 397, 72, 215, 556, "Voice ingress [docker]", "zone solid"),
    ("z-watch", 665, 72, 220, 676, "Inbox watcher [systemd]", "zone solid"),
    ("z-bb", 1000, 72, 130, 380, "Bloodbank", "zone solid"),
    ("z-hermes", 1175, 280, 220, 400, "Hermes [systemd]", "zone solid"),
    ("z-read", 1455, 100, 220, 350, "Read side", "zone solid"),
]

# id, x, y, w, h, name, tech, lines, kind, accent
NODES = [
    ("app", 30, 90, 190, 84, "Holocene Auto app", "[container: Kotlin APK]", ["WebView host, NativeRecorder,", "CarHost parked-only gate"], "container", False),
    ("pad", 30, 230, 190, 70, "Agent Pad", "[container: Vite/React SPA]", ["IndexedDB outbox, auto-play"], "container", False),
    ("op1", 30, 346, 190, 62, "Operator", "[person]", ["speaks, hears the reply"], "person", False),
    ("play", 30, 560, 190, 62, "Google Play internal", "[external]", ["installs the APK (repo v10)"], "ext", False),
    ("cf", 270, 230, 90, 70, "Cloudflare", "[edge]", ["tunnel, DNS"], "ext", False),
    ("web", 410, 100, 190, 70, "agent-pad-web", "[container: nginx]", ["serves apps/agent-pad/dist"], "container", False),
    ("traefik", 410, 230, 190, 70, "Traefik", "[container: v3.6]", ["Host / PathPrefix routing"], "container", False),
    ("upload", 410, 360, 190, 84, "agent-pad-upload", "[container: Python]", ["PUT /upload/inbox/...", "POST client-event, played"], "container", False),
    ("minio", 410, 520, 190, 84, "MinIO holocene-auto", "[S3: s3.delo.sh]", ["inbox/<agent>/<date>/<ts>.ogg", "replies/<date>/...ogg"], "container", False),
    ("transcribe", 680, 100, 190, 70, "transcribe", "[CLI: faster-whisper]", ["large-v3, CPU int8 fallback"], "container", False),
    ("watcher", 680, 290, 190, 130, "inbox-watcher", "[service: Python]", ["one state machine per memo", "memo_id = correlationid", "state.json, heartbeat,", "memo:trace|list|retry"], "container", True),
    ("vox", 680, 650, 190, 90, "vox TTS", "[container: vibevoice]", ["POST /synthesize-url,", "then GET audio_url", "engines: vibevoice only"], "container", False),
    ("nats", 1010, 110, 110, 330, "NATS", "[JetStream]", ["BLOODBANK_", "COMMANDS", "(workqueue)", "", "BLOODBANK_", "EVENTS", "evt.>", "", "monitor :8222"], "container", False),
    ("plane", 1235, 30, 200, 56, "Plane + n8n", "[external: PM2 on host]", [], "ext", False),
    ("registry", 1190, 312, 190, 58, "agents-registry.yaml", "[YAML file]", ["read by gateway, watcher, API"], "container", False),
    ("gateway", 1190, 392, 190, 110, "Hermes gateway", "[plugin: Python]", ["interactive 2 slots,", "batch 4 slots,", "journal sqlite,", "per-turn wall clock 300 s"], "container", True),
    ("agent", 1190, 570, 190, 90, "Hermes agent profile", "[Python + SQLite]", ["holocene-pm etc.", "state.db: the reply text"], "container", False),
    ("llm", 1190, 720, 190, 70, "AutomaticAI gateway", "[external]", ["api.automaticai.io", "fallbacks: glm-5.3, kimi-2.8"], "ext", False),
    ("monitor", 970, 700, 200, 80, "Monitoring", "[Prometheus stack]", ["nats-exporter, Prometheus,", "Alertmanager, 2 lane rules"], "container", False),
    ("op2", 1470, 34, 190, 56, "Operator", "[person]", ["reads /voice"], "person", False),
    ("candy", 1470, 140, 190, 70, "Candystore", "[container: dapr + PG]", ["GET :8683/events?corr..."], "container", False),
    ("api", 1470, 250, 190, 80, "Holocene API", "[service: Node :4000]", ["own JetStream consumer,", "/api/modules/voice/memos"], "container", False),
    ("holoweb", 1470, 370, 190, 60, "Holocene web", "[container: Next.js]", ["/voice, Google OIDC"], "container", False),
    ("oidc", 1470, 500, 190, 56, "Google OIDC", "[external]", ["login for /voice"], "ext", False),
    ("router", 1470, 600, 190, 70, "bloodbank-ntfy-router", "[container]", ["mute / loud / digest"], "container", False),
    ("alerts", 1470, 785, 190, 60, "ntfy + Telegram", "[external]", ["phone push, alerts"], "ext", False),
]

# a, b, pts, label, (lx, ly, anchor), dash, accent, both
E = []
def edge(a, b, pts, label="", lpos=None, dash=False, accent=False, both=False):
    E.append(dict(a=a, b=b, pts=pts, label=label, lpos=lpos, dash=dash, accent=accent, both=both))

# verticals first, so later horizontals hop over them
edge("monitor", "nats", [(1100, 700), (1100, 440)], "scrape jsz", (1108, 670, "start"))
edge("upload", "nats", [(600, 402), (640, 402), (640, 50), (1060, 50), (1060, 110)], "raw NATS: audio.memo.uploaded / played / failed", (650, 44, "start"))
edge("plane", "nats", [(1235, 58), (1112, 58), (1112, 110)], "invocation.start|(batch lane)", (1120, 76, "start"))
edge("app", "pad", [(125, 174), (125, 230)], "WebView host", (133, 206, "start"), both=True)
edge("op1", "pad", [(125, 346), (125, 300)], "taps record|(parked only)", (133, 322, "start"))
edge("pad", "cf", [(220, 265), (270, 265)], "HTTPS", (245, 250, "middle"))
edge("cf", "traefik", [(360, 265), (410, 265)], "tunnel", (385, 250, "middle"))
edge("cf", "minio", [(315, 300), (315, 562), (410, 562)], "s3.delo.sh via Traefik|(router minio-api):|S3 list + GET replies/|every 15 s, unsigned", (307, 452, "end"), both=True)
edge("traefik", "web", [(480, 230), (480, 170)], "serves pad", (488, 206, "start"))
edge("traefik", "upload", [(480, 300), (480, 360)], "/upload/", (488, 334, "start"))
edge("upload", "minio", [(505, 444), (505, 520)], "S3 mc cp", (524, 486, "start"))
edge("watcher", "minio", [(700, 420), (700, 562), (600, 562)], "S3 mc", (650, 548, "middle"), both=True)
edge("watcher", "transcribe", [(775, 290), (775, 170)], "ffprobe,|transcribe", (783, 236, "start"))
edge("watcher", "vox", [(760, 420), (760, 650)], "HTTPS", (768, 620, "start"))
edge("watcher", "nats", [(870, 340), (1010, 340)], "bb-emit:|facts + invoke", (940, 312, "middle"))
edge("watcher", "nats", [(870, 385), (1010, 385)], "probe :8222|fallback: .start", (940, 402, "middle"), dash=True)
edge("nats", "gateway", [(1120, 412), (1190, 412)], "invoke", (1155, 396, "middle"))
edge("gateway", "nats", [(1190, 452), (1120, 452)], "started|completed|failed", (1155, 472, "middle"), accent=True)
edge("gateway", "registry", [(1285, 392), (1285, 370)], "route check", (1293, 385, "start"), dash=True)
edge("gateway", "agent", [(1285, 502), (1285, 570)], "turn", (1300, 548, "start"), both=True)
edge("agent", "llm", [(1285, 660), (1285, 720)], "HTTPS", (1293, 694, "start"))
edge("watcher", "gateway", [(855, 420), (855, 530), (1240, 530), (1240, 502)], "sqlite ro: journal row", (975, 522, "middle"), dash=True)
edge("watcher", "agent", [(815, 420), (815, 615), (1190, 615)], "sqlite ro: reply text", (950, 607, "middle"), dash=True)
edge("nats", "candy", [(1120, 175), (1470, 175)], "evt.> via dapr pubsub.jetstream", (1290, 167, "middle"))
edge("nats", "api", [(1120, 215), (1430, 215), (1430, 290), (1470, 290)], "evt.> ephemeral consumer", (1270, 207, "middle"))
edge("nats", "router", [(1120, 255), (1410, 255), (1410, 635), (1470, 635)], "evt.> core subscribe, no durable", (1140, 247, "start"), dash=True)
edge("holoweb", "api", [(1565, 370), (1565, 330)], "HTTP", (1573, 355, "start"))
edge("holoweb", "oidc", [(1565, 430), (1565, 500)], "login", (1573, 470, "start"), dash=True)
edge("op2", "holoweb", [(1660, 62), (1700, 62), (1700, 400), (1660, 400)], "reads /voice", (1696, 240, "end"))
edge("router", "alerts", [(1660, 635), (1700, 635), (1700, 815), (1660, 815)], "push|failed", (1694, 730, "end"))
edge("monitor", "alerts", [(1070, 780), (1070, 815), (1470, 815)], "Telegram", (1250, 807, "middle"))
edge("play", "app", [(30, 591), (8, 591), (8, 132), (30, 132)])

# x, y, n, accent
BADGES = [(245, 265, 1, False), (505, 482, 2, False), (700, 500, 3, False), (775, 200, 4, False), (905, 340, 5, False),
          (1155, 412, 6, False), (1285, 525, 7, True), (1155, 452, 8, True), (855, 470, 9, False), (815, 560, 9, False),
          (760, 560, 10, False), (650, 562, 11, False), (315, 520, 12, False), (1440, 175, 13, False)]
# edge-id -> hop number for the Excalidraw labels: (a, b, first point) uniquely picks an edge

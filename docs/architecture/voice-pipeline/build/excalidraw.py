"""Builds ../voice-pipeline.excalidraw (container view) with bound arrows."""
import json, random, pathlib
random.seed(33)
els = []
def base(t, id_, x, y, w, h, **kw):
    d = dict(id=id_, type=t, x=x, y=y, width=w, height=h, angle=0, strokeColor="#1e1e1e", backgroundColor="transparent",
             fillStyle="solid", strokeWidth=1, strokeStyle="solid", roughness=0, opacity=100, groupIds=[], frameId=None,
             roundness=None, seed=random.randint(1, 2**31), version=1, versionNonce=random.randint(1, 2**31),
             isDeleted=False, boundElements=[], updated=1760000000000, link=None, locked=False)
    d.update(kw); return d

NODES = {}  # id -> (x,y,w,h)
FILL = {"person":"#f3e9d2","system":"#dbe7f5","container":"#ffffff","ext":"#ecebe6","accent":"#fbe0d3"}
def zone(i, x, y, w, h, label):
    els.append(base("rectangle", i, x, y, w, h, strokeColor="#8d897b", strokeStyle="dashed", roundness={"type":3}))
    els.append(base("text", i+"-t", x+10, y+8, len(label)*8, 18, text=label, originalText=label, fontSize=14, fontFamily=3,
                    textAlign="left", verticalAlign="top", containerId=None, lineHeight=1.25, strokeColor="#625f57"))
def node(i, x, y, w, h, title, lines, kind="container"):
    NODES[i] = (x, y, w, h)
    acc = kind == "accent"
    els.append(base("rectangle", i, x, y, w, h, backgroundColor=FILL[kind], roundness={"type":3},
                    strokeStyle="dashed" if kind=="ext" else "solid", strokeWidth=3 if acc else 1,
                    strokeColor="#c0471d" if acc else "#1e1e1e"))
    txt = title + ("\n" + "\n".join(lines) if lines else "")
    els.append(base("text", i+"-t", x+6, y+6, w-12, h-12, text=txt, originalText=txt, fontSize=13, fontFamily=2,
                    textAlign="center", verticalAlign="middle", containerId=i, lineHeight=1.25))
    els[-2]["boundElements"].append({"id": i+"-t", "type": "text"})

def arrow(a, b, pts, label="", lpos=None, dash=False, accent=False, both=False):
    aid = f"{a}__{b}"
    x0, y0 = pts[0]
    rel = [[px-x0, py-y0] for px, py in pts]
    w = max(p[0] for p in rel)-min(p[0] for p in rel); h = max(p[1] for p in rel)-min(p[1] for p in rel)
    els.append(base("arrow", aid, x0, y0, w, h, points=rel, strokeStyle="dashed" if dash else "solid",
                    strokeColor="#c0471d" if accent else "#1e1e1e", strokeWidth=3 if accent else 1,
                    startBinding={"elementId": a, "focus": 0, "gap": 1}, endBinding={"elementId": b, "focus": 0, "gap": 1},
                    startArrowhead="arrow" if both else None, endArrowhead="arrow", roundness=None, lastCommittedPoint=None, elbowed=False))
    for e in els:
        if e["id"] in (a, b): e["boundElements"].append({"id": aid, "type": "arrow"})
    if label:
        lines = label.split("|")
        lx, ly = lpos
        for k, ln in enumerate(lines):
            els.append(base("text", f"{aid}-l{k}", lx, ly + k*15, len(ln)*7.2, 15, text=ln, originalText=ln, fontSize=12, fontFamily=3,
                            textAlign="left", verticalAlign="top", containerId=None, lineHeight=1.25,
                            strokeColor="#c0471d" if accent else "#3a3935"))

# zones (same layout as the HTML level-2 view)
zone("z-car", 15, 50, 250, 290, "Car: Holocene Auto")
zone("z-host", 385, 24, 1215, 856, "big-chungus host")
zone("z-ing", 397, 72, 215, 556, "Voice ingress [docker]")
zone("z-wat", 665, 72, 220, 676, "Inbox watcher [systemd]")
zone("z-bb", 930, 72, 130, 380, "Bloodbank")
zone("z-her", 1105, 300, 220, 370, "Hermes [systemd]")
zone("z-read", 1385, 100, 220, 350, "Read side")
node("app", 30, 90, 190, 84, "Holocene Auto app", ["Kotlin APK", "WebView host, NativeRecorder,", "CarHost parked-only gate"])
node("pad", 30, 230, 190, 70, "Agent Pad", ["Vite/React SPA", "IndexedDB outbox, auto-play"])
node("cf", 270, 230, 90, 70, "Cloudflare", ["edge", "tunnel, DNS"], "ext")
node("web", 410, 100, 190, 70, "agent-pad-web", ["nginx", "serves apps/agent-pad/dist"])
node("traefik", 410, 230, 190, 70, "Traefik", ["Host / PathPrefix routing"])
node("upload", 410, 360, 190, 84, "agent-pad-upload", ["Python", "PUT /upload/inbox/...", "POST client-event, played"])
node("minio", 410, 520, 190, 84, "MinIO holocene-auto", ["s3.delo.sh", "inbox/<agent>/<date>/<ts>.ogg", "replies/<date>/...ogg"])
node("transcribe", 680, 100, 190, 70, "transcribe", ["faster-whisper large-v3", "CPU int8 fallback"])
node("watcher", 680, 290, 190, 130, "inbox-watcher", ["systemd service, Python", "one state machine per memo", "memo_id = correlationid", "memo:trace|list|retry"], "accent")
node("vox", 680, 650, 190, 70, "vox TTS", ["vibevoice", "POST /synthesize-url"])
node("nats", 940, 110, 110, 330, "NATS JetStream", ["commands", "(workqueue)", "events", "evt.>", "monitor :8222"])
node("gateway", 1120, 330, 190, 130, "Hermes gateway", ["bloodbank plugin", "interactive 2 slots", "batch 4 slots, journal", "turn wall clock 300 s"], "accent")
node("agent", 1120, 540, 190, 100, "Hermes agent profile", ["holocene-pm etc.", "state.db: the reply text"])
node("llm", 1120, 700, 190, 60, "AutomaticAI gateway", ["api.automaticai.io"], "ext")
node("operator", 1400, 34, 190, 56, "Operator", [], "person")
node("candy", 1400, 140, 190, 70, "Candystore", ["dapr + Postgres", "GET :8683/events"])
node("api", 1400, 250, 190, 80, "Holocene API", ["Node :4000", "own JetStream consumer", "/api/modules/voice/memos"])
node("holoweb", 1400, 370, 190, 60, "Holocene web", ["/voice, Google OIDC"])
node("router", 1400, 480, 190, 70, "bloodbank-ntfy-router", ["mute / loud / digest"])
node("alerts", 1400, 770, 190, 60, "ntfy + Telegram", ["phone push, alerts"], "ext")
node("monitor", 900, 700, 200, 80, "Monitoring", ["nats-exporter, Prometheus,", "Alertmanager, 2 lane rules"])

arrow("app","pad",[(125,174),(125,230)],"WebView host",(133,196),both=True)
arrow("pad","cf",[(220,265),(270,265)],"HTTPS",(224,246))
arrow("cf","traefik",[(360,265),(410,265)],"tunnel",(366,246))
arrow("traefik","web",[(480,230),(480,170)],"serves pad",(488,196))
arrow("traefik","upload",[(480,300),(480,360)],"/upload/",(488,324))
arrow("upload","minio",[(505,444),(505,520)],"2 S3 mc cp",(513,476))
arrow("upload","nats",[(600,402),(640,402),(640,56),(1030,56),(1030,110)],"2 raw NATS: audio.memo.uploaded / played / failed",(700,38))
arrow("watcher","minio",[(700,420),(700,562),(600,562)],"3,11 S3 mc|list inbox/, put replies/",(608,470),both=True)
arrow("watcher","transcribe",[(775,290),(775,170)],"4 ffprobe,|transcribe",(783,226))
arrow("watcher","nats",[(870,350),(940,350)],"5 facts +|invoke",(878,314))
arrow("nats","gateway",[(1050,380),(1120,380)],"6 invoke",(1056,362))
arrow("gateway","nats",[(1120,420),(1050,420)],"8 started|completed|failed",(1056,428),accent=True)
arrow("gateway","agent",[(1215,460),(1215,540)],"7 turn|(clock armed)",(1223,486),both=True)
arrow("agent","llm",[(1215,640),(1215,700)],"HTTPS",(1223,662))
arrow("watcher","gateway",[(855,420),(855,488),(1160,488),(1160,460)],"9 sqlite ro: journal row",(865,470),dash=True)
arrow("watcher","agent",[(815,420),(815,590),(1120,590)],"9 sqlite ro: reply text",(840,572),dash=True)
arrow("watcher","vox",[(760,420),(760,650)],"10 HTTPS",(768,610))
arrow("nats","candy",[(1050,175),(1400,175)],"13 evt.> via dapr pubsub.jetstream",(1090,157))
arrow("nats","api",[(1050,215),(1350,215),(1350,290),(1400,290)],"evt.> ephemeral consumer",(1090,197))
arrow("nats","router",[(1050,255),(1330,255),(1330,515),(1400,515)],"evt.>",(1338,380))
arrow("holoweb","api",[(1495,370),(1495,330)],"HTTP",(1503,342))
arrow("operator","holoweb",[(1590,62),(1625,62),(1625,400),(1590,400)],"reads|/voice",(1631,230))
arrow("router","alerts",[(1590,515),(1620,515),(1620,800),(1590,800)],"push|failed",(1550,720))
arrow("monitor","nats",[(1030,700),(1030,440)],"scrape jsz",(1038,660))
arrow("monitor","alerts",[(1050,780),(1050,800),(1400,800)],"Telegram",(1200,782))
els.append(base("text", "legend", 20, 905, 700, 60, text="Voice memo pipeline, container view. 2026-10-16. Numbers 1-13 are the hops of one memo; dashed = read-only look-up; orange = per-turn wall clock path.\nSource of truth: workspace.dsl (Structurizr). HTML with C4 levels 1-3 and the dynamic view: voice-pipeline-c4.html",
                originalText="", fontSize=14, fontFamily=2, textAlign="left", verticalAlign="top", containerId=None, lineHeight=1.25))
els[-1]["originalText"] = els[-1]["text"]
scene = {"type": "excalidraw", "version": 2, "source": "https://draw.delo.sh", "elements": els,
         "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"}, "files": {}}
out = pathlib.Path(__file__).parent.parent / "voice-pipeline.excalidraw"
out.write_text(json.dumps(scene, indent=1))
print(len(els), "elements ->", out)

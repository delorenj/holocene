from lib import Svg, figure

def html():
    pre = '<h2 id="l1">Level 1: system context</h2><p class="lede">Who and what the operator touches, and what the pipeline depends on.</p>'
    g = Svg(1400, 700, "ctx", "1")
    g.zone(20, 56, 270, 330, "In the car (Honda, parked)")
    g.zone(440, 56, 660, 610, "big-chungus (one Linux host, Traefik + Cloudflare Tunnel in front)")
    # col A
    g.node(40, 90, 230, 80, "Operator", "[person]", ["Jarad: speaks a memo,", "hears the answer"], "person")
    g.node(40, 250, 230, 100, "Holocene Auto", "[software system: Android]", ["Honda AAOS head unit app;", "records only while parked;", "hosts Agent Pad"], "system")
    g.node(40, 420, 230, 70, "Google Play internal", "[external]", ["ships v10 0.2.8-internal"], "ext")
    g.node(40, 560, 230, 84, "Plane + n8n", "[external: PM2]", ["tickets; publish invocation.start", "(batch lane)"], "ext")
    # host col L
    g.node(500, 90, 250, 84, "Voice ingress", "[software system]", ["agent-pad-web, upload proxy,", "MinIO holocene-auto"], "system")
    g.node(500, 230, 250, 84, "Inbox watcher", "[software system]", ["transcribe, dispatch, await,", "speak, upload reply"], "system", accent=True)
    g.node(500, 370, 250, 130, "Bloodbank", "[software system]", ["NATS JetStream: events +", "commands (2 lanes);", "bb-emit, ntfy-router"], "system")
    g.node(500, 550, 250, 96, "Hermes", "[software system]", ["gateway plugin + ~37 agent", "profiles; per-turn wall clock", "on the interactive lane"], "system", accent=True)
    # host col R
    g.node(840, 90, 240, 84, "Monitoring", "[software system]", ["nats-exporter, Prometheus,", "Alertmanager"], "system")
    g.node(840, 370, 240, 84, "Read side", "[software system]", ["Candystore, Holocene API,", "Holocene web /voice"], "system")
    # externals right
    g.node(1160, 90, 200, 100, "ntfy + Telegram", "[external]", ["phone push for", "audio.memo.failed;", "lane alerts"], "ext")
    g.node(1160, 580, 200, 80, "AutomaticAI gateway", "[external]", ["api.automaticai.io", "model automaticai/auto"], "ext")
    g.node(1160, 370, 200, 70, "Google OIDC", "[external]", ["login for /voice"], "ext")

    g.edge([(155,170),(155,250)]); g.label(163,214,"speaks, hears",anchor="start")
    g.edge([(155,420),(155,350)]); g.label(163,408,"installs APK",anchor="start")
    g.edge([(270,300),(350,300),(350,132),(500,132)], start=True)
    g.label(358,212,"HTTPS via|Cloudflare|audio up,|replies down",anchor="start")
    g.edge([(625,174),(625,230)]); g.label(633,206,"inbox objects",anchor="start")
    g.edge([(560,314),(560,370)]); g.label(568,346,"facts, invoke",anchor="start")
    g.edge([(560,500),(560,550)]); g.label(568,530,"invoke / start",anchor="start")
    g.edge([(680,550),(680,500)]); g.label(688,530,"lifecycle facts",anchor="start")
    g.edge([(500,272),(470,272),(470,598),(500,598)], "dash"); g.label(462,505,"journal,|reply text",anchor="end")
    # plane -> bloodbank with hop over dashed edge
    g.raw_edge("M270 602 L380 602 L380 448 Q380 440 388 440 L464 440 a6 6 0 0 1 12 0 L500 440", "dash")
    g.label(325,624,"invoke / start",anchor="middle")
    g.edge([(750,620),(1160,620)])
    g.label(950,606,"agent turns, HTTPS",anchor="middle")
    g.edge([(750,410),(840,410)]); g.label(795,402,"evt.>",anchor="middle")
    g.edge([(840,132),(790,132),(790,385),(750,385)]); g.label(798,250,"scrapes jsz|:8222",anchor="start")
    g.edge([(1080,115),(1160,115)]); g.label(1120,106,"Telegram",anchor="middle")
    g.edge([(750,470),(1120,470),(1120,165),(1160,165)]); g.label(1126,330,"ntfy push|(failed only)",anchor="start")
    g.raw_edge("M1080 405 L1114 405 a6 6 0 0 1 12 0 L1160 405", "dash")
    svg = g.render("System context: voice memo pipeline", "Operator, car app and the systems behind the voice memo pipeline on big-chungus, with Hermes and the model gateway at the end of the bus.")
    return pre + figure(svg, "The car app is the only door in. Everything behind it runs on one host; the accent boxes are where the work happens (Inbox watcher drives it, Hermes does the thinking and now enforces the per-turn wall clock).")

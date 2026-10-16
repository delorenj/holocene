from lib import Svg, figure

def html():
    g = Svg(1340, 710, "auto", "3a")
    g.zone(20, 10, 900, 430, "Holocene Auto app [APK, Kotlin, sh.delo.holocene.auto]")
    # components
    g.node(40, 70, 220, 100, "MainActivity", "[component: Activity]", ["launcher; builds UI, owns lifecycle;", "mic / speech / TTS diagnostic", "probes; StopKeys handling"], "component")
    g.node(340, 50, 240, 90, "DiagnosticSession", "[component: state machine]", ["IDLE > CAPTURING > ACKNOWLEDGING", "> DONE | CANCELLED; AckPolicy,", "PcmStats, Fixtures"], "component")
    g.node(340, 190, 240, 120, "AgentPadHost", "[component: WebView host]", ["URL allow-policy (isPadUrl),", "mic gate padAllowed =", "!isCarHost || unrestricted,", "render-process-gone recovery"], "component", accent=False)
    g.node(40, 250, 220, 100, "CarHost", "[component: android.car shim]", ["isolates all android.car.*;", "HostGate monotonic release;", "fail-closed off-automotive"], "component", accent=True)
    g.node(680, 70, 230, 90, "NativeBridge", "[component: window.HoloceneNative]", ["@JavascriptInterface", "start() / stop() / micClosed()"], "component")
    g.node(680, 230, 230, 100, "NativeRecorder", "[component: MediaRecorder]", ["MIC > OGG container, OPUS", "bounded duration (auto-stop);", "keeps nothing after stop/cancel"], "component", accent=True)
    g.node(40, 480, 220, 70, "Android Car service", "[external: android.car]", ["CarUxRestrictions (parked)"], "ext")
    g.node(680, 500, 230, 80, "Agent Pad", "[container: Vite/React SPA]", ["loaded from agent-pad.delo.sh;", "IndexedDB outbox"], "container")
    g.node(680, 630, 230, 62, "Operator", "[person]", ["taps the pad UI in the WebView"], "person")
    g.node(1050, 500, 250, 80, "agent-pad-upload", "[container: Python]", ["PUT /upload/inbox/..."], "container")
    # edges
    g.edge([(260,95),(340,95)]); g.label(300,87,"fixtures",anchor="middle")
    g.edge([(260,150),(300,150),(300,230),(340,230)]); g.label(292,190,"lifecycle",anchor="end")
    g.edge([(260,300),(300,300),(300,270),(340,270)]); g.label(292,244,"parked gate",anchor="end")
    g.edge([(580,230),(630,230),(630,115),(680,115)]); g.label(638,190,"addJavascript|Interface",anchor="start")
    g.edge([(795,160),(795,230)]); g.label(803,200,"start / stop",anchor="start")
    g.edge([(150,350),(150,480)], start=True); g.label(158,420,"CarUxRestrictions|callbacks",anchor="start")
    g.edge([(795,330),(795,500)]); g.label(787,420,"Ogg/Opus bytes,|evaluateJavascript",anchor="end")
    g.edge([(460,310),(460,540),(680,540)]); g.label(468,526,"loads pad (WebView, HTTPS)",anchor="start")
    g.edge([(910,520),(960,520),(960,130),(910,130)]); g.label(968,300,"start() / stop() /|micClosed()",anchor="start")
    g.edge([(795,630),(795,580)]); g.label(803,612,"taps record|(parked only)",anchor="start")
    g.edge([(910,550),(1050,550)]); g.label(980,542,"PUT .ogg, HTTPS",anchor="middle")
    svg = g.render("Holocene Auto app components", "Inside the Android app: the car UX gate, the WebView host that loads Agent Pad, the JavaScript bridge and the native recorder.")
    pre = '<h2 id="l3a">Level 3a: components, the Holocene Auto app</h2><p class="lede">The app is a thin shell: it decides whether the pad may open (parked only), hosts it in a WebView and records audio natively because WebView getUserMedia is unreliable on the head unit. Recording is parked-only by construction.</p>'
    return pre + figure(svg, "CarHost and NativeRecorder are the two safety-relevant components: the first fails closed when the car reports driving restrictions or the car library is absent, the second bounds every clip and keeps no audio after stop.")

from lib import Svg, figure
import layout2 as L

HOPS = [
 "Pad PUTs the Ogg/Opus clip (outbox retry) to agent-pad.delo.sh/upload: Cloudflare Tunnel, Traefik, agent-pad-upload. Played/skipped beacons (POST /upload/played) use the same path.",
 "Upload proxy stores inbox/&lt;agent&gt;/&lt;date&gt;/&lt;ts&gt;.ogg in MinIO and publishes <code>audio.memo.uploaded</code> (raw NATS, fail-open).",
 "Watcher polls inbox/ every 5 s, derives memo_id = uuid5(s3 key), emits <code>received</code>.",
 "ffprobe, then transcribe (faster-whisper large-v3, CPU when the GPU is full); emits <code>transcribed</code>.",
 "Watcher emits <code>dispatched</code> and the command <code>agent.invocation.invoke</code> (interactive lane) by running bb-emit. It first probes consumer state on NATS :8222 and falls back to <code>.start</code> only if interactive is unpulled and batch is pulled.",
 "Interactive durable pulls it (2 slots); journal row pending to started; <code>invocation.started</code>.",
 "The Hermes turn runs against the model with tools. The per-turn wall clock (300 s default) is armed at dispatch.",
 "<code>invocation.completed</code> or <code>failed</code> (incl. <code>turn_timeout</code>); journal closed; message acked; slot freed.",
 "Watcher sees the journal row and reads the reply text from the profile state.db (chat_id = memo_id).",
 "Text goes to vox (POST /synthesize-url, then GET of the audio_url), which returns Ogg/Opus (vibevoice, voice rick).",
 "Watcher puts replies/&lt;date&gt;/...ogg in MinIO and emits <code>replied</code>.",
 "Pad lists replies/ every 15 s straight from MinIO (unsigned S3 ListObjectsV2 and GET on s3.delo.sh, via Cloudflare and Traefik router <code>minio-api</code>, not through agent-pad-upload), auto-plays the newest, and beacons <code>played</code> / <code>skipped</code> through the proxy (hop 1 path).",
 "Read side: every fact is projected (Candystore, Holocene API to /voice); only <code>audio.memo.failed</code> pushes to the phone, via a core NATS subscription that is not replayed.",
]

def html():
    g = Svg(L.W, L.H, "containers", "2")
    for (i, x, y, w, h, cap, kind) in L.ZONES:
        g.zone(x, y, w, h, cap, kind)
    for (i, x, y, w, h, name, tech, lines, kind, acc) in L.NODES:
        g.node(x, y, w, h, name, tech, lines, kind, accent=acc)
    for e in L.E:
        cls = ("accent " if e["accent"] else "") + ("dash" if e["dash"] else "")
        g.edge(e["pts"], cls.strip(), start=e["both"])
        if e["label"]:
            lx, ly, an = e["lpos"]
            g.label(lx, ly, e["label"], anchor=an, cls="accent" if e["accent"] else "")
    for (x, y, n, a) in L.BADGES:
        g.badge(x, y, n, a)
    svg = g.render("Containers of the voice memo pipeline", "All containers across the car, ingress, watcher, bus, Hermes and read side, with the thirteen numbered hops of one memo and the timeout path in the accent colour.")
    ol = '<ol class="hops">' + "".join(f"<li>{h}</li>" for h in HOPS) + "</ol>"
    pre = '<h2 id="l2">Level 2: containers, one memo end to end</h2><p class="lede">Every deployable piece the memo touches, grouped by the system that owns it. Numbered badges are the hops of one memo in order; the accent path is the per-turn wall clock added on 2026-10-16.</p>'
    return pre + figure(svg, "Dashed edges are read-only look-ups or optional paths (the watcher reads the journal and the profile state.db and never writes them; ntfy-router listens on a core NATS subscription with no durable, so a push is lost if it is down). Reply audio does not come back through the upload proxy: the pad reads MinIO directly (badge 12). Two Operator boxes are the same person: one in the car, one at /voice. Left off this picture to keep crossings down, all of them present in workspace.dsl: the watcher's Candystore fallback read, the watcher's and Holocene API's reads of agents-registry.yaml, and holocene-api's heartbeat read.", ol)

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
    k = 2
    while any(e["id"] == aid for e in els):
        aid = f"{a}__{b}_{k}"; k += 1
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

import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import layout2 as L
KIND = {"zone": None}
for (i, x, y, w, h, cap, kind) in L.ZONES:
    zone(i, x, y, w, h, cap)
for (i, x, y, w, h, name, tech, lines, kind, acc) in L.NODES:
    k = "accent" if acc else kind
    node(i, x, y, w, h, name, [tech.strip("[]")] + [ln for ln in lines if ln], k)
BADGE_FOR = {}
for (bx, by, n, a) in L.BADGES:
    BADGE_FOR[(bx, by)] = n
def badge_num(pts):
    # a badge sits on (or within 14 px of) the edge polyline
    for (bx, by), n in BADGE_FOR.items():
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            if min(xa, xb) - 14 <= bx <= max(xa, xb) + 14 and min(ya, yb) - 14 <= by <= max(ya, yb) + 14:
                return n
    return None
used = set()
for e in L.E:
    label = e["label"]
    n = badge_num(e["pts"])
    if n is not None and (e["a"], e["b"], n) not in used:
        used.add((e["a"], e["b"], n))
        label = (f"{n} " + label) if label else str(n)
    lx, ly, an = e["lpos"] if e["lpos"] else (e["pts"][0][0] + 6, e["pts"][0][1] + 6, "start")
    w = max((len(t) for t in label.split("|")), default=0) * 7.2
    lx = lx - (w / 2 if an == "middle" else w if an == "end" else 0)
    arrow(e["a"], e["b"], e["pts"], label, (lx, ly - 12) if e["lpos"] else (lx, ly), dash=e["dash"], accent=e["accent"], both=e["both"])
els.append(base("text", "legend", 20, 915, 700, 60, text="Voice memo pipeline, container view. 2026-10-16. Numbers 1-13 are the hops of one memo (12 = pad reads replies straight from MinIO via Cloudflare + Traefik); dashed = read-only look-up or optional (ntfy-router is a core NATS subscriber, no durable); orange = per-turn wall clock path.\nSource of truth: workspace.dsl (Structurizr). HTML with C4 levels 1-3 and the dynamic view: voice-pipeline-c4.html",
                originalText="", fontSize=14, fontFamily=2, textAlign="left", verticalAlign="top", containerId=None, lineHeight=1.25))
els[-1]["originalText"] = els[-1]["text"]
scene = {"type": "excalidraw", "version": 2, "source": "https://draw.delo.sh", "elements": els,
         "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"}, "files": {}}
out = pathlib.Path(__file__).parent.parent / "voice-pipeline.excalidraw"
out.write_text(json.dumps(scene, indent=1))
print(len(els), "elements ->", out)

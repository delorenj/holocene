"""Render each diagram of ../voice-pipeline-c4.html to ../png/*.png with headless Chromium.
usage: python3 render.py [light|dark] [outdir]"""
import re, sys, subprocess, pathlib, tempfile
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import page
here = pathlib.Path(__file__).parent
theme = sys.argv[1] if len(sys.argv) > 1 else "light"
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else here.parent / "png"
out.mkdir(exist_ok=True)
html = (here.parent / "voice-pipeline-c4.html").read_text()
svgs = re.findall(r"<svg .*?</svg>", html, re.S)
names = ["01-context", "02-containers", "03a-auto-components", "03b-gateway-components", "03c-timeout-path", "04-dynamic-memo"]
assert len(svgs) == len(names), len(svgs)
chrome = "/home/delorenj/.local/bin/google-chrome"
for name, svg in zip(names, svgs):
    m = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    w, h = int(m.group(1)), int(m.group(2))
    doc = f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>{page.CSS} body{{margin:0}} svg{{width:{w}px;height:{h}px}}</style></head><body>{svg}</body></html>'
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "f.html"; f.write_text(doc)
        dst = out / (name + ("" if theme == "light" else "-dark") + ".png")
        subprocess.run([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5",
                        f"--window-size={w},{h}", "--virtual-time-budget=6000", f"--screenshot={dst}", f"file://{f}"],
                       check=True, capture_output=True)
    print(dst, w, h)

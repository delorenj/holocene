#!/usr/bin/env python3
"""Synthesize memo phrases with vox (/synthesize-url) and convert to 16 kHz mono WAV for paplay into holo_testmic.
usage: synth.py <name> <text> [voice]"""
import json, subprocess, sys, urllib.request

name, text = sys.argv[1], sys.argv[2]
voice = sys.argv[3] if len(sys.argv) > 3 else "rick"
req = urllib.request.Request("https://vox.delo.sh/synthesize-url", method="POST",
                             data=json.dumps({"text": text, "voice": voice}).encode(),
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=180) as r:
    meta = json.loads(r.read())
with urllib.request.urlopen(meta["audio_url"], timeout=60) as r:
    blob = r.read()
src = f"/tmp/ttfa/{name}.src"
open(src, "wb").write(blob)
out = f"/tmp/ttfa/{name}.wav"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", out], check=True)
dur = subprocess.run(["soxi", "-D", out], capture_output=True, text=True).stdout.strip()
print(json.dumps({"name": name, "engine": meta.get("engine"), "seconds": dur, "wav": out}))

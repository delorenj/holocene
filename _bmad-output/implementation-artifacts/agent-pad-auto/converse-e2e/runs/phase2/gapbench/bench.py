"""Offline gap bench: split real fast-reply texts with the old and new chunk caps, render each chunk back to back through
the live vox at the desk's steps, and replay the pad timeline (chunk i starts at max(end of i-1, landed_i + PAD_S))."""
import json, os, sys, tempfile, time, subprocess
from pathlib import Path
sys.path.insert(0, "/home/delorenj/code/33GOD/holocene/services/inbox-watcher")
import inbox_watcher as iw
PAD_S = 0.3
texts = json.load(open("/tmp/claude-1000/say_texts.json"))
configs = {"old 45,80,170,300": (45, 80, 170, 300), "new 55,65,95,180,300": (55, 65, 95, 180, 300)}
steps = iw.CONVERSE_TTS_STEPS
def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())
rows = []
for mid, text in texts.items():
    spoken = iw.clean_for_speech(text, iw.SPEAK_CHARS) if hasattr(iw, "clean_for_speech") else text
    for name, caps in configs.items():
        parts = iw.split_for_speech(spoken, caps, 60)
        t = 0.0; land = []; durs = []
        for p in parts:
            d = Path(tempfile.mkdtemp(prefix="gb-"))
            t0 = time.time()
            audio, eng = iw.synthesize(p, d, **iw.synth_kw(steps, iw.TtsGate.NARRATION, iw.VOICE))
            t += time.time() - t0
            land.append(t); durs.append(dur(audio))
        start = land[0] + PAD_S; end = start + durs[0]; gaps = []
        for i in range(1, len(parts)):
            s = max(end, land[i] + PAD_S); gaps.append(round(s - end, 2)); end = s + durs[i]
        row = {"memo": mid, "cfg": name, "chars": [len(p) for p in parts], "render_s": [round(b - a, 2) for a, b in zip([0] + land, land)],
               "audio_s": [round(x, 2) for x in durs], "first_audio_s": round(land[0] + PAD_S, 2), "gaps_s": gaps, "total_gap_s": round(sum(gaps), 2)}
        rows.append(row); print(json.dumps(row), flush=True)
json.dump(rows, open("/tmp/claude-1000/gapbench/rows.json", "w"), indent=1)

import json
import os
from pathlib import Path
import shutil
import subprocess

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[4]
commands = [
    ("source-probes", ["pnpm", "--filter", "@holocene/api", "exec", "tsx", "../../_bmad-output/implementation-artifacts/holoc-57/reviews/spec/source-probes.mts"]),
    ("independent-browser", ["node", "_bmad-output/implementation-artifacts/holoc-57/reviews/spec/independent-browser.mjs"]),
    ("supplemental-navigation", ["node", "_bmad-output/implementation-artifacts/holoc-57/reviews/spec/supplemental-navigation.mjs"]),
    ("outside-click-probe", ["node", "_bmad-output/implementation-artifacts/holoc-57/reviews/spec/outside-click-probe.mjs"]),
]
results = []
for name, command in commands:
    env = {**os.environ, "NODE_DISABLE_COMPILE_CACHE": "1"}
    proc = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    (OUT / f"{name}.log").write_text(proc.stdout + proc.stderr)
    result = {"name": name, "command": command, "cwd": str(ROOT), "exit_code": proc.returncode, "log": f"{name}.log"}
    results.append(result)
    print(json.dumps(result))
    if proc.returncode:
        print(proc.stdout + proc.stderr)
        break
(OUT / "independent-command-results.json").write_text(json.dumps(results, indent=2))
# Only remove this review's own temporary caches, never source, sibling quality evidence or worker evidence.
for name in ["scratch", "__pycache__"]:
    shutil.rmtree(OUT / name, ignore_errors=True)
if any(r["exit_code"] for r in results):
    raise SystemExit(1)

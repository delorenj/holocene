import json
import os
from pathlib import Path
import subprocess
import time
import shutil

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
TASKS = {
    "api-typecheck": ["pnpm", "--filter", "@holocene/api", "typecheck", "--incremental", "false"],
    "web-typecheck": ["pnpm", "--filter", "@holocene/web", "typecheck", "--incremental", "false"],
    "api-regression": ["pnpm", "--filter", "@holocene/api", "test"],
    "web-regression": ["pnpm", "--filter", "@holocene/web", "test"],
    "reproduced-browser-suite": ["pnpm", "--filter", "@holocene/web", "test:products-browser"],
}

def run(item):
    name, command = item
    env = os.environ.copy()
    scratch = OUT / "scratch" / name
    scratch.mkdir(parents=True, exist_ok=True)
    if name != "reproduced-browser-suite":
        env["TMPDIR"] = str(scratch)
    env.update(PLAYWRIGHT_MODULE="/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc57-browser-deps/node_modules/playwright/index.mjs", PRODUCTS_EVIDENCE_DIR=str(OUT / "reproduced-browser"))
    env["NODE_DISABLE_COMPILE_CACHE"] = "1"
    start = time.monotonic()
    proc = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=250)
    shutil.rmtree(scratch, ignore_errors=True)
    (OUT / f"{name}.log").write_text(proc.stdout)
    return {"name": name, "command": command, "cwd": str(ROOT), "exit_code": proc.returncode, "duration_seconds": round(time.monotonic()-start, 2), "log": f"{name}.log", "last_lines": proc.stdout.splitlines()[-12:]}

if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=5) as pool:
        result = list(pool.map(run, TASKS.items()))
    (OUT / "check-results.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))

"""HOLOC-56: the holocene PM launch pass honours the launch | live | steady contract.

Every case copies THIS checkout's generated driver (`../launch-pass.py`, `../board-lease.py`,
`../launch-pass.prompt.md`) into a throwaway fixture repo and runs the real CLI (`--monitor`, `--brief`,
`--apply`) as a subprocess. The driver finds its repo by walking up to the fixture's `.project.json` and
keeps its runtime (lease, receipts, roadmap) beside the fixture copy, so nothing here reads or writes
the real `.launch.yaml`, the real `runtime/` or the real Plane board.

`px` is a fake on PATH: it serves `task list` / `task get` from a JSON file and appends EVERY
invocation (reads and writes) to `calls.log`. Its board is fixture data, not live evidence.

Run (no system tmp, no pytest cache):
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider -rA \
      --basetemp="$HOME/.hermes/profiles/holocene-pm/cache/scratch/holoc56-pytest" \
      agents/hermes/pm/.scripts/holoc-56/test_launch_mode.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
CHECKOUT = SCRIPTS.parents[3]
COPIED = ("launch-pass.py", "board-lease.py", "launch-pass.prompt.md")

LAUNCH_DECL = """\
mode: launch
declared: 2026-11-17
source: "fixture: HOLOC-56 isolated test"
finish_line: "fixture finish line"
target_date: 2026-12-01
contract: [README.md]
epic: FIX-1
cut_line:
  launch_critical: [FIX-2]
  after_launch: [FIX-3]
"""

LIVE_DECL = """\
mode: live
declared: 2026-11-17
live_since: 2026-11-20
source: "fixture: HOLOC-56 isolated test"
finish_line: "fixture finish line"
contract: [README.md]
epic: FIX-1
live:
  name: Fixture
  checkout:
    provider: stripe
    key_ref: "op://DeLoSecrets/fixture/none"
"""

STEADY_DECL = "mode: steady\ndeclared: 2026-11-17\n"

FAKE_PX = r'''#!__PY__
import json, os, sys
state = os.environ["PX_FIXTURE_STATE"]
args = sys.argv[1:]
with open(os.path.join(state, "calls.log"), "a") as f:
    f.write(json.dumps(args) + "\n")
board = json.load(open(os.path.join(state, "board.json")))
if args[:2] == ["task", "list"]:
    print(json.dumps({"ok": True, "board": board["board"], "issues": [
        {"sequence_id": t["seq"], "state_name": t["state_name"], "state_group": t["state_group"], "name": t["name"]}
        for t in board["tickets"]]}))
elif args[:2] == ["task", "get"]:
    for t in board["tickets"]:
        if f"{board['board']}-{t['seq']}" == args[2]:
            print(json.dumps({"ticket": t}))
            break
    else:
        sys.exit(1)
else:
    with open(os.path.join(state, "writes.log"), "a") as f:
        f.write(json.dumps(args) + "\n")
    print("ok " + " ".join(args[:3]))
'''


def ticket(seq, lane, group, pri="none", labels=()):
    return {"seq": seq, "name": f"fixture ticket {seq}", "state_name": lane, "state_group": group,
            "priority": pri, "label_names": list(labels), "comments": [], "external_id": None,
            "created_at": "2026-11-10T12:00:00+00:00", "updated_at": "2026-11-17T12:00:00+00:00"}


BOARD = {"board": "FIX", "tickets": [
    ticket(2, "Todo", "unstarted", "high"),
    ticket(3, "Backlog", "backlog", "medium"),
    ticket(4, "In Progress", "started", labels=["agent:working"]),
]}


class Fixture:
    def __init__(self, base: Path, declaration):
        self.root = base / "repo"
        self.role = self.root / "agents" / "hermes" / "pm"
        scripts = self.role / ".scripts"
        scripts.mkdir(parents=True)
        for name in COPIED:
            (scripts / name).write_bytes((SCRIPTS / name).read_bytes())
        (self.role / "role.yaml").write_text('agent_id: "fixture-pm"\n')
        (self.role / "SOUL.md").write_text("# fixture soul\n")
        (self.root / "README.md").write_text("fixture contract\n")
        (self.root / ".project.json").write_text(json.dumps({"ticket_provider": {"identifier": "FIX"}}))
        if declaration is not None:
            (self.root / ".launch.yaml").write_text(declaration)
        self.state = base / "px-state"
        self.state.mkdir()
        (self.state / "board.json").write_text(json.dumps(BOARD))
        bin_dir = base / "bin"
        bin_dir.mkdir()
        px = bin_dir / "px"
        px.write_text(FAKE_PX.replace("__PY__", sys.executable))
        px.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                    "PX_FIXTURE_STATE": str(self.state), "LAUNCH_PASS_DATE": "2026-11-20",
                    "LAUNCH_LEASE_WAIT": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        for k in ("LAUNCH_REPO", "LAUNCH_PASS_MAX", "HERMES_BOARD_LEASE_OWNER"):
            self.env.pop(k, None)

    def run(self, *args):
        return subprocess.run([sys.executable, str(self.role / ".scripts" / "launch-pass.py"), *args],
                              capture_output=True, text=True, env=self.env, cwd=str(self.root), timeout=60)

    def log(self, name):
        p = self.state / name
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def plan(self):
        p = self.role / "runtime" / "launch-pass.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"writes": [{"op": "comment", "ref": "FIX-2", "text": "fixture comment"}],
                                 "roadmap": "# fixture roadmap", "note": "fixture"}))
        return p


@pytest.fixture
def make(tmp_path):
    return lambda declaration: Fixture(tmp_path, declaration)


QUIET = [(LIVE_DECL, "live"), (STEADY_DECL, "steady"), (None, "steady")]
QUIET_IDS = ["live", "steady", "absent"]


# ------------------------------------------------------------------------- quiet modes

@pytest.mark.parametrize("declaration,mode", QUIET, ids=QUIET_IDS)
def test_monitor_quiet_modes_print_their_mode_and_never_touch_the_board(make, declaration, mode):
    fx = make(declaration)
    out = fx.run("--monitor")
    print(f"[{mode}] --monitor stdout: {out.stdout!r}")
    assert out.returncode == 0 and out.stdout == f"launch-mode: {mode}\n" and out.stderr == ""
    assert fx.log("calls.log") == []  # no px call at all: no board read, no board write


@pytest.mark.parametrize("declaration,mode", QUIET, ids=QUIET_IDS)
def test_brief_quiet_modes_have_no_launch_planning(make, declaration, mode):
    fx = make(declaration)
    out = fx.run("--brief")
    assert out.returncode == 0 and out.stdout.startswith(f"launch-mode: {mode}\n")
    assert f"quiet: {mode}" in out.stdout
    assert "# Snapshot" not in out.stdout and "launch-pass.json" not in out.stdout  # no plan schema handed out
    assert fx.log("calls.log") == []


@pytest.mark.parametrize("declaration,mode", QUIET, ids=QUIET_IDS)
def test_apply_outside_launch_writes_nothing(make, declaration, mode):
    fx = make(declaration)
    plan = fx.plan()
    out = fx.run("--apply")
    print(f"[{mode}] --apply stdout: {out.stdout!r}")
    assert out.returncode == 0 and out.stdout == f"launch-mode: {mode}: apply refused, nothing written.\n"
    assert fx.log("calls.log") == [] and fx.log("writes.log") == []
    runtime = fx.role / "runtime"
    assert plan.exists() and not plan.with_suffix(".applied.json").exists()  # plan neither consumed nor archived
    assert sorted(p.name for p in runtime.iterdir()) == ["launch-pass.json"]  # no lease, receipt or roadmap


# ------------------------------------------------------------------------- launch preserved

def test_launch_monitor_reads_the_fixture_board_and_never_writes(make):
    fx = make(LAUNCH_DECL)
    out = fx.run("--monitor")
    print("[launch] --monitor stdout (fixture board, not live evidence):\n" + out.stdout)
    lines = out.stdout.splitlines()
    assert out.returncode == 0 and lines[0] == "launch-mode: launch"
    assert lines[1] == "date 2026-11-20" and lines[2].startswith("declaration ")
    assert lines[3:5] == ["epic FIX-1", "target 2026-12-01 (11d)"]
    assert any(l.startswith("FIX-2|Todo|high|") and "cut:lc" in l for l in lines)
    assert any(l.startswith("FIX-4|In Progress|") and "working" in l for l in lines)
    assert fx.run("--monitor").stdout == out.stdout  # deterministic: an unchanged board hashes the same
    assert fx.log("writes.log") == []
    assert {tuple(c[:2]) for c in fx.log("calls.log")} == {("task", "list"), ("task", "get")}


def test_launch_brief_hands_out_the_plan_contract(make):
    out = make(LAUNCH_DECL).run("--brief")
    assert out.returncode == 0 and out.stdout.startswith("# Launch pass")  # the pass contract (launch-pass.prompt.md)
    for needle in ("# Declaration", "# Snapshot", "launch-mode: launch", "FIX-2|Todo|high", "launch-pass.json",
                   '"op": "comment"', "--apply"):
        assert needle in out.stdout, needle


def test_launch_apply_writes_through_fake_px_with_tag_lease_and_receipt(make):
    fx = make(LAUNCH_DECL)
    plan = fx.plan()
    out = fx.run("--apply")
    print("[launch] --apply stdout (fake px, fixture runtime):\n" + out.stdout)
    assert out.returncode == 0
    writes = fx.log("writes.log")
    assert writes == [["comment", "FIX-2", "-m", "[pm] fixture comment"]]  # tagged by the driver
    runtime = fx.role / "runtime"
    assert not plan.exists() and plan.with_suffix(".applied.json").exists()
    receipts = list((runtime / "launch-receipts").glob("*.json"))
    assert len(receipts) == 1 and json.loads(receipts[0].read_text())["results"][0]["status"] == "ok"
    assert (runtime / "launch-roadmap.md").read_text() == "# fixture roadmap\n"


# ------------------------------------------------------------------------- real checkout (read-only)

def test_real_checkout_monitor_matches_its_declaration():
    """Read-only: the actual checkout's driver. No committed .launch.yaml => exactly steady."""
    decl = CHECKOUT / ".launch.yaml"
    out = subprocess.run([sys.executable, str(SCRIPTS / "launch-pass.py"), "--monitor"], capture_output=True, text=True,
                         cwd=str(CHECKOUT), env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=120)
    print(f"[real checkout] .launch.yaml present={decl.exists()} --monitor stdout: {out.stdout!r}")
    assert out.returncode == 0
    if not decl.exists():
        assert out.stdout == "launch-mode: steady\n"

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time

GIB = 1024 ** 3
DEFAULT_LIMIT = int(3.3 * GIB)
DEFAULT_HARD = int(3.65 * GIB)


def parse_stat(text):
    values = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            values[parts[0]] = int(parts[1])
    return values


def pinned_bytes(current, stat):
    return max(0, current - stat.get("file", 0))


def verdict(current, stat, limit=DEFAULT_LIMIT, hard=DEFAULT_HARD):
    if current >= hard:
        return "hard"
    if pinned_bytes(current, stat) >= limit:
        return "pinned"
    return None


def owned(pid, port):
    try:
        command = Path("/proc/%d/cmdline" % pid).read_bytes().split(b"\0")
    except OSError:
        return False
    text = [part.decode(errors="replace") for part in command]
    return any("qemu-system" in part for part in text[:1]) and "-port" in text and str(port) in text[text.index("-port") + 1:text.index("-port") + 2]


def rss_bytes(pid):
    try:
        for line in Path("/proc/%d/status" % pid).read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    return 0


def rollup(pid):
    values = {}
    try:
        for line in Path("/proc/%d/smaps_rollup" % pid).read_text().splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0] in ("Rss:", "Pss_Anon:", "Pss_File:", "Pss_Shmem:"):
                values[parts[0].rstrip(":")] = int(parts[1]) * 1024
    except OSError:
        pass
    return values


def terminate(pid, grace=15.0):
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if not Path("/proc/%d" % pid).exists():
            return "terminated"
        time.sleep(0.2)
    os.kill(pid, signal.SIGKILL)
    return "killed"


def main():
    parser = argparse.ArgumentParser(description="Sample cgroup and owned-emulator memory; stop only that emulator before the worker cap")
    parser.add_argument("--cgroup", type=Path, required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--hard", type=int, default=DEFAULT_HARD)
    args = parser.parse_args()
    if not owned(args.pid, args.port):
        raise SystemExit("pid %d is not the emulator owning console port %d" % (args.pid, args.port))
    peak = {"current": 0, "pinned": 0, "rss": 0}
    outcome = "emulator exited"
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    interrupted = []
    signal.signal(signal.SIGTERM, lambda *_: interrupted.append(True))
    with args.log.open("a") as log:
        while Path("/proc/%d" % args.pid).exists() and not interrupted:
            current = int((args.cgroup / "memory.current").read_text())
            stat = parse_stat((args.cgroup / "memory.stat").read_text())
            rss = rss_bytes(args.pid)
            pinned = pinned_bytes(current, stat)
            peak = {"current": max(peak["current"], current), "pinned": max(peak["pinned"], pinned), "rss": max(peak["rss"], rss)}
            log.write(json.dumps({"t": round(time.time(), 2), "current": current, "pinned": pinned, "anon": stat.get("anon", 0), "file": stat.get("file", 0), "emulator_rss": rss, "rollup": rollup(args.pid)}) + "\n")
            log.flush()
            reason = verdict(current, stat, args.limit, args.hard)
            if reason and owned(args.pid, args.port):
                log.write(json.dumps({"t": round(time.time(), 2), "action": "terminate-owned-emulator", "reason": reason, "pid": args.pid, "port": args.port, "current": current, "pinned": pinned}) + "\n")
                log.flush()
                outcome = "stopped owned emulator (%s): %s" % (reason, terminate(args.pid))
                break
            time.sleep(args.interval)
        if interrupted:
            outcome = "monitor interrupted; emulator left running"
        log.write(json.dumps({"summary": peak, "outcome": outcome, "limit": args.limit, "hard": args.hard}) + "\n")
    print(json.dumps({"summary": peak, "outcome": outcome}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

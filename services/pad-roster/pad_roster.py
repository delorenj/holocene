#!/usr/bin/env python3
"""Agent Pad roster: every agent the pad can send a memo to, most recently talked to first, wearing its avatar.

One pass per run (systemd timer). Writes, under PAD_ROSTER_DIR (default ~/.local/share/holocene-auto/pad-roster):

  roster.json                   what https://agent-pad.delo.sh/roster/roster.json serves to the pad
  avatars/<agent>.<hash>.jpg    each agent's avatar, copied from Holocene's avatar store (content-addressed, so a new
                                avatar is a new URL served immutable)
  state.json                    agent id -> the avatar file the roster last published

Who is on the pad: every registry row the Bloodbank gateway can route a command to (memo_common.registry_route, the
same rule the inbox watcher dispatches with). A tile for anything else would strand every memo recorded for it.

"Most recently interacted with": the newest message the operator sent the agent, read from the agent's Hermes
session store (~/.hermes/profiles/<profile>/state.db). Operator sessions are the ones a person drives (Telegram,
CLI/TUI, desktop, Slack) plus voice memos (Bloodbank sessions opened by the inbox watcher). Cron, subagent, oneshot
and other Bloodbank traffic is the fleet talking to itself and does not count, nor do Hermes' own role='user' notices
or a CLI/TUI/desktop session no bigger than a probe (one question, one answer).

Avatars come from Holocene's avatar store (HOLOCENE_AVATAR_DIR, owned by apps/api/src/avatars.ts): one avatar per
agent, set on holocene.delo.sh/settings or synced from the agent's Telegram bot, and mirrored back to it. This job
only reads that store; it never talks to Telegram or 1Password.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "inbox-watcher"))
import memo_common as mc_  # noqa: E402  routability rule shared with the inbox watcher

HOME = Path.home()
OUT_DIR = Path(os.environ.get("PAD_ROSTER_DIR", HOME / ".local/share/holocene-auto/pad-roster"))
PROFILES_DIR = Path(os.environ.get("PAD_ROSTER_PROFILES", HOME / ".hermes/profiles"))
AVATAR_STORE = Path(os.environ.get("HOLOCENE_AVATAR_DIR", HOME / ".local/share/holocene/avatars"))
STORE_FILE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[0-9a-f]{16}\.jpg$")
AVATAR_URL_PREFIX = "/roster/avatars/"

OPERATOR_SOURCES = ("telegram", "cli", "tui", "desktop", "slack")
# Sources a script can also open: a session there counts only past a probe's size (a "reply PONG" fleet sweep is one
# question and one answer). A person typing in Telegram or Slack, or recording a memo, always counts.
SCRIPTABLE_SOURCES = ("cli", "tui", "desktop")
PROBE_MAX_MESSAGES = 2
VOICE_MEMO_USER = "inbox-watcher"
# Hermes stores its own notices (delegation results, compaction summaries, attachment notes) as role='user' rows.
SYNTHETIC_PREFIXES = ("[ASYNC DELEGATION", "[CONTEXT COMPACTION", "[IMPORTANT", "[SYSTEM", "[Slack attachment notice")

# The five tiles the pad shipped with keep their colours, so the car looks the same for the agents it already had.
LEGACY_COLORS = {
    "33god-pm": "#4f8cff", "holocene-pm": "#9b59b6", "client-portal-pm": "#e67e22",
    "heyma-pm": "#2ecc71", "bloodbank-pm": "#e74c3c",
}
PALETTE = ["#4f8cff", "#9b59b6", "#e67e22", "#2ecc71", "#e74c3c", "#1abc9c", "#f39c12", "#d35400",
           "#16a085", "#c0392b", "#8e44ad", "#2980b9", "#27ae60", "#e84393", "#00a8ff", "#b8860b"]


def log(event: str, **kw) -> None:
    print(json.dumps({"event": event, **kw}, separators=(",", ":")), flush=True)


# ---------------------------------------------------------------- who

def short_name(display: str | None, agent_id: str) -> str:
    """Tile label: 'Holocene PM' -> 'Holocene', "Dumply — Carrie's AI Tutor" -> 'Dumply', none -> id words."""
    name = (display or "").split("—")[0].split(" - ")[0].strip()
    if name.endswith(" PM"):
        name = name[: -len(" PM")].strip()
    return name or id_name(agent_id)


def id_name(agent_id: str) -> str:
    base = agent_id[:-3] if agent_id.endswith("-pm") else agent_id
    return " ".join(w.capitalize() for w in base.split("-")) or agent_id


def color_for(agent_id: str) -> str:
    if agent_id in LEGACY_COLORS:
        return LEGACY_COLORS[agent_id]
    h = int(hashlib.sha1(agent_id.encode()).hexdigest(), 16)
    return PALETTE[h % len(PALETTE)]


def routable_agents(registry: Path) -> tuple[list[dict], list[dict]]:
    """[(id, profile, display_name)] the gateway can route to, in registry order, plus the rows left off and why."""
    import yaml  # type: ignore
    rows = yaml.safe_load(registry.read_text(encoding="utf-8")).get("agents") or {}
    keep, skipped = [], []
    for agent_id in rows:
        route = mc_.registry_route(agent_id)
        if route["ok"] is True:
            keep.append({"id": agent_id, "profile": route["profile"], "display_name": route["display_name"]})
        else:
            skipped.append({"id": agent_id, "reason": route["reason"]})
    return keep, skipped


# ---------------------------------------------------------------- when

def last_interaction(profile_dir: Path) -> tuple[float | None, str | None]:
    """(epoch seconds, source) of the newest operator message to this agent, or (None, None)."""
    db = profile_dir / "state.db"
    if not db.is_file():
        return None, None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None, None
    try:
        marks = ",".join("?" * len(OPERATOR_SOURCES))
        script_marks = ",".join("?" * len(SCRIPTABLE_SOURCES))
        not_synthetic = " AND ".join("coalesce(m.content, '') NOT LIKE ?" for _ in SYNTHETIC_PREFIXES)
        # A session with no real operator message (an empty desktop tab, a compaction stub) is not an interaction.
        row = con.execute(
            f"""SELECT at, source FROM (
                  SELECT (SELECT max(m.timestamp) FROM messages m
                          WHERE m.session_id = s.id AND m.role = 'user' AND {not_synthetic}) AS at, s.source AS source
                  FROM sessions s
                  WHERE (s.source IN ({marks}) OR (s.source = 'bloodbank' AND s.user_id = ?))
                    AND NOT (s.source IN ({script_marks})
                             AND (SELECT count(*) FROM messages m WHERE m.session_id = s.id) <= ?))
                WHERE at IS NOT NULL ORDER BY at DESC LIMIT 1""",
            (*(p + "%" for p in SYNTHETIC_PREFIXES), *OPERATOR_SOURCES, VOICE_MEMO_USER, *SCRIPTABLE_SOURCES,
             PROBE_MAX_MESSAGES),
        ).fetchone()
    except sqlite3.Error as e:
        log("interaction_unreadable", profile=profile_dir.name, error=type(e).__name__)
        return None, None
    finally:
        con.close()
    if not row or row[0] is None:
        return None, None
    return float(row[0]), ("voice" if row[1] == "bloodbank" else row[1])


# ---------------------------------------------------------------- avatar

def store_avatars(store: Path) -> dict[str, str] | None:
    """agent id -> avatar file name in Holocene's avatar store, or None when the store cannot be read."""
    try:
        idx = json.loads((store / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    out = {}
    for agent_id, rec in (idx.get("agents") or {}).items():
        f = rec.get("file") if isinstance(rec, dict) else None
        if isinstance(f, str) and STORE_FILE.match(f) and f.startswith(f"{agent_id}.") and (store / "files" / f).is_file():
            out[agent_id] = f
    return out


def publish_avatar(store: Path, avatars: Path, name: str) -> None:
    """Copy one store file next to the roster (same content-addressed name, so it is copied once)."""
    if (avatars / name).is_file():
        return
    tmp = avatars / f".{name}.tmp"
    shutil.copyfile(store / "files" / name, tmp)
    os.chmod(tmp, 0o644)
    tmp.replace(avatars / name)


# ---------------------------------------------------------------- one pass

def build(out: Path, profiles: Path, registry: Path, now: float, store: Path | None = None) -> dict:
    store = store or AVATAR_STORE
    avatars = out / "avatars"
    avatars.mkdir(parents=True, exist_ok=True)
    state_path = out / "state.json"
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        state = {}
    cache: dict = {k: v for k, v in (state.get("avatars") or {}).items() if isinstance(v, str)}
    files = store_avatars(store)
    if files is None:
        # Holocene's store unreadable for a moment: the pad keeps the pictures it already has.
        log("avatar_store_unreadable", store=str(store))
        files = cache

    keep, skipped = routable_agents(registry)
    rows = []
    for a in keep:
        pdir = profiles / a["profile"]
        at, via = last_interaction(pdir)
        name = files.get(a["id"])
        if name and (name != cache.get(a["id"]) or not (avatars / name).is_file()):
            try:
                publish_avatar(store, avatars, name)
                cache[a["id"]] = name
            except OSError as e:
                log("avatar_copy_failed", agent=a["id"], error=type(e).__name__)
        elif not name:
            cache.pop(a["id"], None)
        file = cache.get(a["id"])
        rows.append({
            "id": a["id"],
            "name": short_name(a["display_name"], a["id"]),
            "color": color_for(a["id"]),
            "avatar": AVATAR_URL_PREFIX + file if file and (avatars / file).is_file() else None,
            "interactedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at)) if at else None,
            "via": via,
            "_at": at or 0,
        })

    # Two agents that would read the same on a tile get their id-derived names instead.
    seen: dict[str, int] = {}
    for r in rows:
        seen[r["name"].lower()] = seen.get(r["name"].lower(), 0) + 1
    for r in rows:
        if seen[r["name"].lower()] > 1:
            r["name"] = id_name(r["id"])

    # Agents that left the roster take their pictures with them.
    current = {a["id"] for a in keep}
    cache = {k: v for k, v in cache.items() if k in current}
    referenced = set(cache.values())
    for f in avatars.glob("*.jpg"):
        if f.name not in referenced:
            f.unlink(missing_ok=True)

    order = {a["id"]: i for i, a in enumerate(keep)}
    rows.sort(key=lambda r: (-r["_at"], order[r["id"]]))
    for r in rows:
        del r["_at"]

    roster = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "order": "most recent operator message first (Telegram, CLI, TUI, desktop, Slack, voice memo); never-contacted agents last in registry order",
        "agents": rows,
        "skipped": skipped,
    }
    write_json(out / "roster.json", roster)
    write_json(state_path, {"avatars": cache})
    return roster


def write_json(path: Path, obj: dict) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o644)
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--print", action="store_true", help="print the roster after writing it")
    args = ap.parse_args(argv)
    roster = build(OUT_DIR, PROFILES_DIR, mc_.REGISTRY_PATH, time.time())
    log("roster_written", path=str(OUT_DIR / "roster.json"), agents=len(roster["agents"]),
        with_avatar=sum(1 for a in roster["agents"] if a["avatar"]), skipped=[s["id"] for s in roster["skipped"]])
    if args.print:
        for a in roster["agents"]:
            print(f"  {a['id']:<26} {a['name']:<24} {a['interactedAt'] or 'never':<22} {a['via'] or '':<9} {a['avatar'] or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

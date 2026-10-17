#!/usr/bin/env python3
"""Agent Pad roster: every agent the pad can send a memo to, most recently talked to first, wearing its Telegram avatar.

One pass per run (systemd timer). Writes, under PAD_ROSTER_DIR (default ~/.local/share/holocene-auto/pad-roster):

  roster.json                   what https://agent-pad.delo.sh/roster/roster.json serves to the pad
  avatars/<agent>.<uid>.jpg     the bot's current Telegram profile photo, named by Telegram's file_unique_id (or a
                                hash of the bytes) so a new avatar is a new URL (served immutable) and an unchanged
                                one is never re-downloaded
  state.json                    per-agent avatar check cache (bot id, file_unique_id, when it was last checked)

Who is on the pad: every registry row the Bloodbank gateway can route a command to (memo_common.registry_route, the
same rule the inbox watcher dispatches with). A tile for anything else would strand every memo recorded for it.

"Most recently interacted with": the newest message the operator sent the agent, read from the agent's Hermes
session store (~/.hermes/profiles/<profile>/state.db). Operator sessions are the ones a person drives (Telegram,
CLI/TUI, desktop, Slack) plus voice memos (Bloodbank sessions opened by the inbox watcher). Cron, subagent, oneshot
and other Bloodbank traffic is the fleet talking to itself and does not count.

Avatars are linked, not copied by hand: the source is the bot's live Telegram profile photo (the one the
hermes-project-avatar skill sets), re-checked every PAD_ROSTER_AVATAR_TTL_S. First choice is the Bot API with the
profile's own token (an op:// reference in its config.yaml, read with `op read` inside this process and never logged),
which also says who the bot really is. A profile without a usable token falls back to the public t.me userpic of the
registry's telegram.bot_username, which needs no secret.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "inbox-watcher"))
import memo_common as mc_  # noqa: E402  routability rule shared with the inbox watcher

HOME = Path.home()
OUT_DIR = Path(os.environ.get("PAD_ROSTER_DIR", HOME / ".local/share/holocene-auto/pad-roster"))
PROFILES_DIR = Path(os.environ.get("PAD_ROSTER_PROFILES", HOME / ".hermes/profiles"))
AVATAR_TTL_S = int(os.environ.get("PAD_ROSTER_AVATAR_TTL_S", "1800"))
AVATAR_URL_PREFIX = "/roster/avatars/"
OP_BIN = os.environ.get("OP_BIN", "op")
TG_API = "https://api.telegram.org"

OPERATOR_SOURCES = ("telegram", "cli", "tui", "desktop", "slack")
VOICE_MEMO_USER = "inbox-watcher"

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
            tg = rows[agent_id].get("telegram") if isinstance(rows[agent_id], dict) else None
            bot = (tg or {}).get("bot_username") if isinstance(tg, dict) else None
            keep.append({"id": agent_id, "profile": route["profile"], "display_name": route["display_name"],
                         "bot_username": bot.lstrip("@") if isinstance(bot, str) and bot.strip() else None})
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
        row = con.execute(
            f"""SELECT coalesce((SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id AND m.role = 'user'),
                                s.started_at) AS at, s.source
                FROM sessions s
                WHERE s.source IN ({marks}) OR (s.source = 'bloodbank' AND s.user_id = ?)
                ORDER BY at DESC LIMIT 1""",
            (*OPERATOR_SOURCES, VOICE_MEMO_USER),
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

def token_ref(profile_dir: Path) -> str | None:
    try:
        import yaml  # type: ignore
        cfg = yaml.safe_load((profile_dir / "config.yaml").read_text(encoding="utf-8")) or {}
        ref = cfg["secrets"]["onepassword"]["env"]["TELEGRAM_BOT_TOKEN"]
    except Exception:  # noqa: BLE001  no config, no secrets block, no Telegram bot
        return None
    return ref if isinstance(ref, str) and ref.startswith("op://") else None


def op_read(ref: str) -> str | None:
    try:
        p = subprocess.run([OP_BIN, "read", "--no-newline", ref], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


def http_get(url: str, timeout: int = 20) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "holocene-pad-roster"}), timeout=timeout) as r:
        return r.read()


class Telegram:
    """The three read-only Bot API calls the avatar needs. Error text never carries the token or the URL."""

    def __init__(self, token: str, get: Callable[[str], bytes] = http_get):
        self._t, self._get = token, get

    def call(self, method: str, **params) -> dict:
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        try:
            body = json.loads(self._get(f"{TG_API}/bot{self._t}/{method}{q}"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method}: HTTP {e.code}") from None
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"{method}: {type(e).__name__}") from None
        if not body.get("ok"):
            raise RuntimeError(f"{method}: {str(body.get('description', 'not ok'))[:120]}")
        return body["result"]

    def download(self, file_path: str) -> bytes:
        try:
            return self._get(f"{TG_API}/file/bot{self._t}/{urllib.parse.quote(file_path)}")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"download: HTTP {e.code}") from None
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"download: {type(e).__name__}") from None


def refresh_avatar(agent_id: str, tg: Telegram, avatars: Path) -> dict:
    """Current profile photo of the agent's bot, downloaded only when Telegram says it changed."""
    me = tg.call("getMe")
    photos = tg.call("getUserProfilePhotos", user_id=me["id"], limit=1)
    entry = {"bot_id": me["id"], "bot_username": "@" + str(me.get("username", "")), "checked_at": time.time()}
    if not photos.get("photos"):
        prune(avatars, agent_id, None)
        return {**entry, "source": "bot_api", "file_unique_id": None, "file": None}
    best = max(photos["photos"][0], key=lambda s: s.get("width", 0))
    uid = best["file_unique_id"]
    name = f"{agent_id}.{uid}.jpg"
    if not (avatars / name).is_file():
        data = tg.download(tg.call("getFile", file_id=best["file_id"])["file_path"])
        if len(data) < 64:
            raise RuntimeError("download: empty image")
        tmp = avatars / f".{name}.tmp"
        tmp.write_bytes(data)
        tmp.replace(avatars / name)
        log("avatar_downloaded", agent=agent_id, bot=entry["bot_username"], file_unique_id=uid, bytes=len(data))
    prune(avatars, agent_id, name)
    return {**entry, "source": "bot_api", "file_unique_id": uid, "file": name}


def public_avatar(agent_id: str, username: str, avatars: Path, get: Callable[[str], bytes] = http_get) -> dict:
    """The bot's public profile picture (t.me userpic), for a bot whose token this host cannot use.

    Telegram answers 404 with a 1x1 gif when the bot has no photo. The file is named by a hash of its bytes, so a
    changed photo is a new URL just like the Bot API path."""
    entry = {"bot_username": "@" + username, "checked_at": time.time(), "source": "public_userpic"}
    try:
        data = get(f"https://t.me/i/userpic/320/{urllib.parse.quote(username)}.jpg")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {**entry, "file": None}
        raise RuntimeError(f"userpic: HTTP {e.code}") from None
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"userpic: {type(e).__name__}") from None
    if not data.startswith(b"\xff\xd8"):
        prune(avatars, agent_id, None)
        return {**entry, "file": None}
    name = f"{agent_id}.{hashlib.sha256(data).hexdigest()[:16]}.jpg"
    if not (avatars / name).is_file():
        tmp = avatars / f".{name}.tmp"
        tmp.write_bytes(data)
        tmp.replace(avatars / name)
        log("avatar_downloaded", agent=agent_id, bot=entry["bot_username"], source="public_userpic", bytes=len(data))
    prune(avatars, agent_id, name)
    return {**entry, "file": name}


def prune(avatars: Path, agent_id: str, keep: str | None) -> None:
    for old in avatars.glob(f"{agent_id}.*.jpg"):  # agent ids never contain a dot
        if old.name != keep:
            old.unlink(missing_ok=True)


# ---------------------------------------------------------------- one pass

def build(out: Path, profiles: Path, registry: Path, now: float, force_avatars: bool = False,
          read_secret: Callable[[str], str | None] = op_read,
          telegram: Callable[[str], Telegram] = Telegram,
          public_get: Callable[[str], bytes] = http_get) -> dict:
    avatars = out / "avatars"
    avatars.mkdir(parents=True, exist_ok=True)
    state_path = out / "state.json"
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        state = {}
    cache: dict = state.get("avatars", {})

    keep, skipped = routable_agents(registry)
    rows = []
    for a in keep:
        pdir = profiles / a["profile"]
        at, via = last_interaction(pdir)

        cached = cache.get(a["id"])
        stale = force_avatars or not cached or now - cached.get("checked_at", 0) > AVATAR_TTL_S or (
            cached.get("file") and not (avatars / cached["file"]).is_file())
        if stale:
            entry, errors = None, []
            ref = token_ref(pdir)
            token = read_secret(ref) if ref else None
            if ref and token is None:
                errors.append("token unreadable")
            if token:
                try:
                    entry = refresh_avatar(a["id"], telegram(token), avatars)
                except RuntimeError as e:
                    errors.append(str(e))
            if entry is None and a["bot_username"]:
                try:
                    entry = public_avatar(a["id"], a["bot_username"], avatars, get=public_get)
                except RuntimeError as e:
                    errors.append(str(e))
            if entry is not None and entry.get("file") is None and errors and cached and cached.get("file") \
                    and (avatars / cached["file"]).is_file():
                # The authoritative path failed and the public fallback found nothing (a stale registry username
                # reads the same as "no photo"): that is not evidence the photo went away.
                entry = None
            if entry is not None:
                entry["checked_at"] = now
                if errors:
                    entry["fallback_reason"] = "; ".join(errors)
                cache[a["id"]] = entry
            elif errors:
                # Keep the last good photo: a Telegram hiccup must not blank the car's tiles.
                log("avatar_failed", agent=a["id"], error="; ".join(errors))
                if cached:
                    cache[a["id"]] = {**cached, "checked_at": now, "last_error": "; ".join(errors)}
            else:
                cache.pop(a["id"], None)
        file = (cache.get(a["id"]) or {}).get("file")
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
    ap.add_argument("--force-avatars", action="store_true", help="re-check every bot's Telegram photo now")
    ap.add_argument("--print", action="store_true", help="print the roster after writing it")
    args = ap.parse_args(argv)
    roster = build(OUT_DIR, PROFILES_DIR, mc_.REGISTRY_PATH, time.time(), force_avatars=args.force_avatars)
    log("roster_written", path=str(OUT_DIR / "roster.json"), agents=len(roster["agents"]),
        with_avatar=sum(1 for a in roster["agents"] if a["avatar"]), skipped=[s["id"] for s in roster["skipped"]])
    if args.print:
        for a in roster["agents"]:
            print(f"  {a['id']:<26} {a['name']:<24} {a['interactedAt'] or 'never':<22} {a['via'] or '':<9} {a['avatar'] or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

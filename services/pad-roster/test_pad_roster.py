"""Agent Pad roster: who is on the pad, in what order, wearing which avatar. Run: /usr/bin/python3 -m unittest -v"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
import urllib.error
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="pad-roster-test-"))
REGISTRY = TMP / "agents-registry.yaml"
os.environ["MEMO_AGENT_REGISTRY"] = str(REGISTRY)  # memo_common reads it at import

import pad_roster as pr  # noqa: E402  (puts inbox-watcher on sys.path)
import memo_common  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200


def fleet(row_id: str, display: str, bot: str | None = None, enabled: bool = True) -> str:
    tg = f"\n    telegram: {{bot_username: {bot}}}" if bot else ""
    return (f"  {row_id}:\n    display_name: {display!r}\n    profile_name: {row_id}{tg}\n"
            f"    bloodbank: {{enabled: {str(enabled).lower()}, gateway_scope: fleet, target_agent_id: {row_id}}}\n")


def session_db(profile: Path, rows: list[tuple[str, str, str | None, float, list[float]]]) -> None:
    """rows: (session id, source, user_id, started_at, [user message timestamps])"""
    profile.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(profile / "state.db")
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT, started_at REAL)")
    con.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL)")
    for sid, source, user, started, msgs in rows:
        con.execute("INSERT INTO sessions VALUES (?,?,?,?)", (sid, source, user, started))
        for t in msgs:
            con.execute("INSERT INTO messages (session_id, role, timestamp) VALUES (?, 'user', ?)", (sid, t))
            con.execute("INSERT INTO messages (session_id, role, timestamp) VALUES (?, 'assistant', ?)", (sid, t + 999999))
    con.commit()
    con.close()


class FakeTelegram:
    def __init__(self, username: str, uid: str | None):
        self.username, self.uid, self.downloads = username, uid, 0

    def __call__(self, token: str):
        if token == "dead":
            outer = self

            class Dead:
                def call(self, method, **kw):
                    raise RuntimeError(f"{method}: HTTP 401")
            return Dead()
        return self

    def call(self, method, **kw):
        if method == "getMe":
            return {"id": 42, "username": self.username}
        if method == "getUserProfilePhotos":
            if not self.uid:
                return {"total_count": 0, "photos": []}
            return {"photos": [[{"file_id": "s", "file_unique_id": self.uid + "s", "width": 160},
                                {"file_id": "b", "file_unique_id": self.uid, "width": 640}]]}
        if method == "getFile":
            assert kw["file_id"] == "b", "the biggest size is the one downloaded"
            return {"file_path": "photos/file_1.jpg"}
        raise AssertionError(method)

    def download(self, path):
        self.downloads += 1
        return JPEG


class RosterTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=TMP))
        self.out, self.profiles = self.root / "out", self.root / "profiles"
        REGISTRY.write_text("agents:\n" + "".join([
            fleet("holocene-pm", "Holocene PM", "holocene_pm_bot"),
            fleet("33god-pm", "Grolf", "Gr0lfBot"),
            fleet("flume-pm", "Flume PM", "flume_pm_bot"),
            fleet("dumply", "Dumply — Carrie's AI Tutor", "dr_dumply_bot", enabled=False),
            fleet("infra-pm", "Infra PM"),
            fleet("monitoring-pm", "Infra"),
            fleet("never-pm", "Never PM"),
        ]))
        session_db(self.profiles / "holocene-pm", [
            ("a", "cron", None, 9000, [9000]),             # the fleet talking to itself: not an interaction
            ("b", "bloodbank", "inbox-watcher", 100, [500]),  # a voice memo
        ])
        session_db(self.profiles / "33god-pm", [("c", "telegram", "7564050286", 200, [700, 650])])
        session_db(self.profiles / "flume-pm", [
            ("d", "cli", None, 50, []),                    # an operator session with no user message rows yet
            ("e", "bloodbank", "bloodbank.integration.n8n", 8000, [8000]),  # n8n traffic does not count
            ("f", "subagent", None, 8500, [8500]),
        ])
        session_db(self.profiles / "infra-pm", [("g", "slack", "U1", 300, [300])])
        (self.profiles / "holocene-pm" / "config.yaml").write_text(
            "secrets:\n  onepassword:\n    env:\n      TELEGRAM_BOT_TOKEN: op://Vault/item/field\n")

    def build(self, tg=None, secret="tok", public=None, now=10_000.0, force=False):
        tg = tg or FakeTelegram("HolocenePMBot", "UID1")
        public = public or (lambda url: (_ for _ in ()).throw(urllib.error.HTTPError(url, 404, "nf", {}, None)))
        return pr.build(self.out, self.profiles, REGISTRY, now, force_avatars=force,
                        read_secret=lambda ref: secret, telegram=tg, public_get=public)

    def test_only_routable_agents_are_tiles(self):
        r = self.build()
        ids = [a["id"] for a in r["agents"]]
        self.assertNotIn("dumply", ids)
        self.assertEqual([s["id"] for s in r["skipped"]], ["dumply"])
        for a in ids:
            self.assertIs(memo_common.registry_route(a)["ok"], True, a)

    def test_most_recent_operator_message_first_then_registry_order(self):
        r = self.build()
        self.assertEqual([a["id"] for a in r["agents"]],
                         ["33god-pm", "holocene-pm", "infra-pm", "flume-pm", "monitoring-pm", "never-pm"])
        by = {a["id"]: a for a in r["agents"]}
        self.assertEqual(by["33god-pm"]["via"], "telegram")
        self.assertEqual(by["holocene-pm"]["via"], "voice")
        self.assertEqual(by["flume-pm"]["via"], "cli")
        self.assertIsNone(by["never-pm"]["interactedAt"])

    def test_names_are_short_and_never_collide(self):
        by = {a["id"]: a["name"] for a in self.build()["agents"]}
        self.assertEqual(by["holocene-pm"], "Holocene")
        self.assertEqual(by["33god-pm"], "Grolf")
        # 'Infra PM' and 'Infra' would both read "Infra" on a tile
        self.assertEqual((by["infra-pm"], by["monitoring-pm"]), ("Infra", "Monitoring"))
        self.assertEqual(pr.short_name("Dumply — Carrie's AI Tutor", "dumply"), "Dumply")

    def test_bot_api_avatar_downloaded_once_and_linked(self):
        tg = FakeTelegram("HolocenePMBot", "UID1")
        r = self.build(tg=tg)
        hol = next(a for a in r["agents"] if a["id"] == "holocene-pm")
        self.assertEqual(hol["avatar"], "/roster/avatars/holocene-pm.UID1.jpg")
        self.assertEqual((self.out / "avatars/holocene-pm.UID1.jpg").read_bytes(), JPEG)
        self.build(tg=tg, force=True)
        self.assertEqual(tg.downloads, 1, "an unchanged photo is not downloaded again")
        # a new photo on Telegram is a new URL, and the old file goes away
        tg.uid = "UID2"
        r = self.build(tg=tg, force=True)
        self.assertEqual(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"], "/roster/avatars/holocene-pm.UID2.jpg")
        self.assertFalse((self.out / "avatars/holocene-pm.UID1.jpg").exists())

    def test_avatar_check_is_cached_for_the_ttl(self):
        tg = FakeTelegram("HolocenePMBot", "UID1")
        self.build(tg=tg, now=10_000)
        tg.uid = "UID2"
        r = self.build(tg=tg, now=10_000 + pr.AVATAR_TTL_S - 1)
        self.assertTrue(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"].endswith("UID1.jpg"))
        r = self.build(tg=tg, now=10_000 + pr.AVATAR_TTL_S + 1)
        self.assertTrue(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"].endswith("UID2.jpg"))

    def test_public_userpic_when_the_token_is_dead_or_missing(self):
        asked = []

        def public(url):
            asked.append(url)
            if "Gr0lfBot" in url or "holocene_pm_bot" in url:
                return JPEG
            raise urllib.error.HTTPError(url, 404, "nf", {}, None)

        r = self.build(secret="dead", public=public)
        by = {a["id"]: a for a in r["agents"]}
        self.assertRegex(by["33god-pm"]["avatar"], r"^/roster/avatars/33god-pm\.[0-9a-f]{16}\.jpg$")
        self.assertRegex(by["holocene-pm"]["avatar"], r"^/roster/avatars/holocene-pm\.[0-9a-f]{16}\.jpg$")
        self.assertIsNone(by["flume-pm"]["avatar"], "404 means the bot has no photo")
        self.assertIsNone(by["infra-pm"]["avatar"], "no bot username, no avatar")
        state = json.loads((self.out / "state.json").read_text())
        self.assertIn("HTTP 401", state["avatars"]["holocene-pm"]["fallback_reason"])

    def test_a_failed_check_keeps_the_last_good_photo(self):
        self.build()
        boom = FakeTelegram("HolocenePMBot", "UID1")
        boom.call = lambda method, **kw: (_ for _ in ()).throw(RuntimeError(f"{method}: URLError"))
        r = self.build(tg=boom, force=True)
        self.assertEqual(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"], "/roster/avatars/holocene-pm.UID1.jpg")

    def test_token_never_reaches_output(self):
        secret = "123456:SECRET-TOKEN"
        self.build(secret=secret, tg=FakeTelegram("HolocenePMBot", "UID1"))
        for f in self.out.rglob("*.json"):
            self.assertNotIn(secret, f.read_text())


if __name__ == "__main__":
    unittest.main()

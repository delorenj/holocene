"""Agent Pad roster: who is on the pad, in what order, wearing which avatar. Run: /usr/bin/python3 -m unittest -v"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
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


def session_db(profile: Path, rows: list[tuple]) -> None:
    """rows: (session id, source, user_id, started_at, [user message timestamp or (timestamp, content)])"""
    profile.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(profile / "state.db")
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT, started_at REAL)")
    con.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)")
    for sid, source, user, started, msgs in rows:
        con.execute("INSERT INTO sessions VALUES (?,?,?,?)", (sid, source, user, started))
        for m in msgs:
            t, text = m if isinstance(m, tuple) else (m, "hey")
            con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", (sid, text, t))
            con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'ok', ?)", (sid, t + 999999))
    con.commit()
    con.close()


def put_store(store: Path, files: dict[str, bytes]) -> dict[str, str]:
    """Holocene's avatar store with one avatar per agent; returns agent -> file name."""
    import hashlib
    (store / "files").mkdir(parents=True, exist_ok=True)
    names = {}
    for agent, data in files.items():
        name = f"{agent}.{hashlib.sha256(data).hexdigest()[:16]}.jpg"
        (store / "files" / name).write_bytes(data)
        names[agent] = name
    (store / "index.json").write_text(json.dumps({"agents": {a: {"file": n, "source": "holocene"} for a, n in names.items()}}))
    return names


class RosterTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=TMP))
        self.out, self.profiles, self.store = self.root / "out", self.root / "profiles", self.root / "store"
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
            ("b", "bloodbank", "inbox-watcher", 100, [800]),  # a voice memo: newer than Grolf's last real message
        ])
        session_db(self.profiles / "33god-pm", [
            ("c", "telegram", "7564050286", 200, [700, 650, (900, "[ASYNC DELEGATION BATCH COMPLETE - deleg_1]")]),
            ("c2", "desktop", None, 950, []),             # an empty desktop tab is not an interaction
        ])
        session_db(self.profiles / "flume-pm", [
            ("d", "cli", None, 50, [60, 70]),              # a real CLI conversation
            ("d2", "cli", None, 7000, [(7000, "Respond with pong")]),  # a fleet probe: one question, one answer
            ("e", "bloodbank", "bloodbank.integration.n8n", 8000, [8000]),  # n8n traffic does not count
            ("f", "subagent", None, 8500, [8500]),
        ])
        session_db(self.profiles / "infra-pm", [("g", "slack", "U1", 300, [300])])

    def build(self, now=10_000.0):
        return pr.build(self.out, self.profiles, REGISTRY, now, store=self.store)

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
                         ["holocene-pm", "33god-pm", "infra-pm", "flume-pm", "monitoring-pm", "never-pm"])
        by = {a["id"]: a for a in r["agents"]}
        self.assertEqual(by["33god-pm"]["via"], "telegram")
        self.assertEqual(by["holocene-pm"]["via"], "voice")
        self.assertEqual(by["flume-pm"]["via"], "cli")
        self.assertEqual(by["flume-pm"]["interactedAt"], "1970-01-01T00:01:10Z", "the pong probe at 7000 is not a conversation")
        self.assertEqual(by["33god-pm"]["interactedAt"], "1970-01-01T00:11:40Z", "notices and empty tabs are not the operator")
        self.assertIsNone(by["never-pm"]["interactedAt"])

    def test_names_are_short_and_never_collide(self):
        by = {a["id"]: a["name"] for a in self.build()["agents"]}
        self.assertEqual(by["holocene-pm"], "Holocene")
        self.assertEqual(by["33god-pm"], "Grolf")
        # 'Infra PM' and 'Infra' would both read "Infra" on a tile
        self.assertEqual((by["infra-pm"], by["monitoring-pm"]), ("Infra", "Monitoring"))
        self.assertEqual(pr.short_name("Dumply — Carrie's AI Tutor", "dumply"), "Dumply")

    def test_avatars_come_from_holocenes_store(self):
        names = put_store(self.store, {"holocene-pm": JPEG, "33god-pm": JPEG + b"g"})
        r = self.build()
        by = {a["id"]: a for a in r["agents"]}
        self.assertEqual(by["holocene-pm"]["avatar"], "/roster/avatars/" + names["holocene-pm"])
        self.assertEqual((self.out / "avatars" / names["holocene-pm"]).read_bytes(), JPEG)
        self.assertIsNone(by["flume-pm"]["avatar"])

    def test_a_new_avatar_replaces_the_old_file(self):
        old = put_store(self.store, {"holocene-pm": JPEG})["holocene-pm"]
        self.build()
        new = put_store(self.store, {"holocene-pm": JPEG + b"new"})["holocene-pm"]
        r = self.build()
        self.assertEqual(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"], "/roster/avatars/" + new)
        self.assertFalse((self.out / "avatars" / old).exists())

    def test_an_unreadable_store_keeps_the_pictures_the_pad_has(self):
        name = put_store(self.store, {"holocene-pm": JPEG})["holocene-pm"]
        self.build()
        (self.store / "index.json").write_text("{not json")
        r = self.build()
        self.assertEqual(next(a for a in r["agents"] if a["id"] == "holocene-pm")["avatar"], "/roster/avatars/" + name)

    def test_agents_that_leave_take_their_pictures(self):
        name = put_store(self.store, {"holocene-pm": JPEG})["holocene-pm"]
        self.build()
        REGISTRY.write_text(REGISTRY.read_text().replace("enabled: true, gateway_scope: fleet, target_agent_id: holocene-pm",
                                                         "enabled: false, gateway_scope: fleet, target_agent_id: holocene-pm"))
        self.build()
        self.assertFalse((self.out / "avatars" / name).exists())


if __name__ == "__main__":
    unittest.main()

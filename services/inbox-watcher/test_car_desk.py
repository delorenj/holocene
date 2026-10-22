"""The car desk's tiles, tools and new ladder (HOLOC-23, operator decisions 2026-10-22): the never-Anthropic router rule
(automaticai/auto/fast and automaticai/free only on the scoped holocene-converse token, scope proof, served-route check),
the alias table, per-tile voice and model, the setting phrases, the locked flag-file writer, the ToolBox (tool.json
contracts, entrypoints), and the watcher end to end: a voice switch spoken in the new voice, a model switch that moves
the alias's routes in front of the ladder, a model's tool call, an unknown voice that falls back at once, the CLI verbs.
Run with the rest:
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

from test_converse import SECRET, decision, fake_server
from test_converse_pipeline import ConverseHarness, DEVICE
from test_inbox_watcher import VOX_CATALOG, VOX_TEXTS, VOX_VOICES, iw, mc_

import converse as cv  # noqa: E402

HERE = Path(__file__).resolve().parent
SCOPED = "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse"
GW = "https://api.automaticai.io/v1"
MEMO_TRACE = HERE / "memo_trace.py"


def route(rid, model, ref=SCOPED, base=GW, **kw):
    return {"id": rid, "base_url": base, "key_ref": ref, "model": model, **kw}


# ---------------------------------------------------------------------------------------------------- the router rule

class RouterRule(unittest.TestCase):
    def test_auto_fast_and_free_only_on_the_scoped_token(self):
        routes, refused = cv.parse_routes([
            route("r3", "automaticai/auto/fast"), route("free", "automaticai/free"),
            route("x1", "automaticai/auto/fast", ref="op://DeLoSecrets/other/credential"),
            route("x2", "automaticai/free", ref="op://DeLoSecrets/hermes/credential"),
        ], scoped_refs=(SCOPED,))
        self.assertEqual([(r["id"], r["scoped_auto"]) for r in routes], [("r3", True), ("free", True)])
        self.assertEqual([r["id"] for r in refused], ["x1", "x2"])
        self.assertTrue(all(r["reason"].startswith("auto_unscoped") for r in refused))

    def test_every_other_router_and_claude_stays_refused_even_on_the_scoped_token(self):
        bad = ["automaticai/auto", "automaticai/auto/orchestrator", "automaticai/auto/subagent", "auto",
               "openrouter/auto", "automaticai/openrouter/openrouter/auto", "automaticai/damien/claude-haiku-4.5",
               "anthropic/claude-sonnet-5.5", "automaticai/personal/claude-opus-5.5", "fable-5", "AutomaticAI/Auto/Fast",
               "automaticai/auto/fast​-claude"]
        routes, refused = cv.parse_routes([route(f"b{i}", m) for i, m in enumerate(bad)], scoped_refs=(SCOPED,))
        self.assertEqual(routes, [])
        self.assertEqual(len(refused), len(bad))

    def test_the_default_scoped_ref_is_the_holocene_converse_token(self):
        self.assertEqual(cv.scoped_key_refs({}), (SCOPED,))
        self.assertEqual(cv.scoped_key_refs({"MEMO_CONVERSE_SCOPED_KEY_REFS": "op://A/b/c, not-a-ref"}), ("op://A/b/c",))
        self.assertEqual(cv.scoped_key_refs({"MEMO_CONVERSE_SCOPED_KEY_REFS": ""}), ())
        # the delegated turn's model override still refuses the router names (never a Hermes turn on auto)
        self.assertTrue(cv.forbidden("automaticai/auto/fast"))

    def test_the_gateways_aai_spelling_is_the_same_name(self):
        # review 2026-10-22: the gateway's CanonicalModel rewrites aai/<x> to automaticai/<x>, so aai/auto/orchestrator IS
        # the orchestrator pool (Claude in its strong and frontier tiers) and aai/auto/fast IS the router
        for name in ("aai/auto", "aai/auto/orchestrator", "aai/auto/subagent", "AAI/auto/orchestrator", " aai/auto ",
                     "aai/personal/claude-sonnet-5.5", "aai/openrouter/openrouter/auto", "aai/auto/fast"):
            self.assertTrue(cv.forbidden(name), name)  # forbidden as a name; only a scoped rung may use auto/fast
        self.assertTrue(cv.scoped_auto("aai/auto/fast"))
        self.assertTrue(cv.scoped_auto("aai/free"))
        self.assertFalse(cv.scoped_auto("aai/auto/orchestrator"))
        self.assertFalse(cv.forbidden("aai/personal/glm-5.3"))
        hermes = "op://DeLoSecrets/someitem/hermes"
        routes, refused = cv.parse_routes([
            route("ok", "aai/auto/fast"), route("okf", "aai/free"), route("glm", "aai/personal/glm-5.3", ref=hermes),
            route("x1", "aai/auto/orchestrator", ref=hermes), route("x2", "aai/auto/fast", ref=hermes),
            route("x3", "aai/free", ref=hermes), route("x4", "aai/auto/orchestrator"), route("x5", "aai/auto"),
            route("x6", "aai/auto/subagent"), route("x7", "Aai/Auto/Fast"),
        ], scoped_refs=(SCOPED,))
        # what is checked is what is sent: the canonical spelling
        self.assertEqual([(r["id"], r["model"], r["scoped_auto"]) for r in routes],
                         [("ok", "automaticai/auto/fast", True), ("okf", "automaticai/free", True),
                          ("glm", "automaticai/personal/glm-5.3", False)])
        self.assertEqual({r["id"]: r["reason"].split(":")[0] for r in refused},
                         {"x1": "forbidden_model", "x2": "auto_unscoped", "x3": "auto_unscoped", "x4": "forbidden_model",
                          "x5": "forbidden_model", "x6": "forbidden_model", "x7": "forbidden_model"})

    def test_a_name_that_is_not_a_string_is_forbidden_none_is_not(self):
        self.assertFalse(cv.forbidden(None))  # a direct provider that omits `model`
        for v in (["claude-opus"], {"id": "claude"}, [], {}, 3, b"glm"):
            self.assertTrue(cv.forbidden(v), v)

    def test_the_retired_hindsight_item_is_refused(self):
        retired = "op://DeLoSecrets/" + "tflaecgcrdgxrh2ovgi5ysjkzq" + "/credential"
        routes, refused = cv.parse_routes([route("r1", "deepseek-v4.1-flash-1017", ref=retired, base="https://hyper.charm.land/v1")])
        self.assertEqual(routes, [])
        self.assertTrue(refused[0]["reason"].startswith("key_retired"), refused)
        # an old routes override from the evidence (memo:converse --routes-file) can no longer bring it back
        old = HERE.parent.parent / "_bmad-output/implementation-artifacts/agent-pad-auto/converse-e2e/runs/s11a-routes-hyper-unroutable.json"
        if old.exists():
            routes, refused = cv.parse_routes(old.read_text())
            self.assertNotIn(retired, json.dumps(routes))
            self.assertEqual([r["id"] for r in refused], ["x1", "x2"])

    def test_the_alias_table_parses_clean_and_matches_the_unit(self):
        table = cv.load_aliases(cv.ALIASES_PATH)
        self.assertEqual(table["version"], 1)
        self.assertEqual(sorted(table["models"]), ["auto", "deepseek-flash", "deepseek-pro", "free"])
        text = cv.ALIASES_PATH.read_text()
        self.assertNotIn("tflaecgcrdgxrh2ovgi5ysjkzq", text)  # never the Hindsight item
        self.assertNotRegex(text, r"\bsk-[A-Za-z0-9_-]{12,}")
        for alias, e in table["models"].items():
            routes, refused = cv.parse_routes(e["routes"])
            self.assertEqual(refused, [], alias)
            self.assertTrue(routes, alias)
            for r in routes:
                self.assertRegex(r["key_ref"], r"^op://DeLoSecrets/[a-z0-9]{26}/", f"{alias}: an item-UUID reference")
                self.assertFalse(cv.ANTHROPIC_RE.search(r["model"]))
                if r["scoped_auto"]:
                    self.assertEqual(r["key_ref"], SCOPED)
        unit = (HERE / "holocene-inbox-watcher.service").read_text()
        raw = next(ln for ln in unit.splitlines() if ln.startswith("Environment='MEMO_CONVERSE_ROUTES=")).split("=", 2)[2].rstrip("'")
        ladder, _ = cv.parse_routes(raw)
        flash, _ = cv.parse_routes(table["models"]["deepseek-flash"]["routes"])
        self.assertEqual([(r["base_url"], r["model"]) for r in flash], [(r["base_url"], r["model"]) for r in ladder[:2]])
        auto, _ = cv.parse_routes(table["models"]["auto"]["routes"])
        self.assertEqual((auto[0]["model"], auto[0]["id"]), (ladder[2]["model"], ladder[2]["id"]))
        pro, _ = cv.parse_routes(table["models"]["deepseek-pro"]["routes"])
        self.assertEqual([r["model"] for r in pro], ["deepseek-v4-pro-0813", "deepseek-v4-pro"])
        self.assertGreater(pro[1]["timeout_s"], ladder[1]["timeout_s"])
        self.assertGreaterEqual(table["models"]["deepseek-pro"]["budget_s"], 12)
        # every rung gets its full timeout even when all the ones before it time out (review 2026-10-22: at 12 s, r1 and
        # r2 timing out left r3 3 s against its measured 2.5-4.4 s)
        budget = float(next(ln for ln in unit.splitlines() if ln.startswith("Environment=MEMO_CONVERSE_BUDGET_S=")).split("=")[-1])
        self.assertGreaterEqual(budget, sum(r["timeout_s"] for r in ladder))
        self.assertGreaterEqual(table["models"]["deepseek-pro"]["budget_s"], sum(r["timeout_s"] for r in pro))
        self.assertGreaterEqual(pro[1]["timeout_s"], 11)  # pro-d answered in 8982 ms once on a loaded host
        free, _ = cv.parse_routes(table["models"]["free"]["routes"])
        self.assertEqual((free[0]["model"], free[0]["key_ref"]), ("automaticai/free", SCOPED))

    def test_merge_puts_the_alias_first_and_keeps_one_rung_per_upstream(self):
        base, _ = cv.parse_routes([route("r1", "m-flash", ref="op://V/h/c", base="https://h/v1"),
                                   route("r2", "deepseek-flash", ref="op://V/d/k", base="https://d"),
                                   route("r3", "automaticai/auto/fast")], scoped_refs=(SCOPED,))
        front, _ = cv.parse_routes([route("pro-h", "m-pro", ref="op://V/h/c", base="https://h/v1"),
                                    route("x", "deepseek-flash", ref="op://V/d/k", base="https://d/"),
                                    route("r1", "other", ref="op://V/o/c", base="https://o")], scoped_refs=(SCOPED,))
        out = cv.merge_ladder(front, base)
        self.assertEqual([(r["id"], r["model"]) for r in out],
                         [("pro-h", "m-pro"), ("r2", "deepseek-flash"), ("r1~", "other"), ("r1", "m-flash"),
                          ("r3", "automaticai/auto/fast")])


class ScopedLadder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gw, cls.other = fake_server(), fake_server()

    @classmethod
    def tearDownClass(cls):
        cls.gw.shutdown()
        cls.other.shutdown()

    def setUp(self):
        for s in (self.gw, self.other):
            s.modes, s.default, s.calls, s.sleep, s.model, s.decision = [], "ok", [], 2.0, None, decision()
            s.route_header, s.gets = None, []
        self.logs = []
        self.base = f"http://127.0.0.1:{self.gw.server_port}/v1"
        self.routes, _ = cv.parse_routes([
            route("r3", "automaticai/auto/fast", base=self.base, timeout_s=2),
            route("r9", "fallback-model", ref="op://V/o/c", base=f"http://127.0.0.1:{self.other.server_port}/v1", timeout_s=2),
        ], scoped_refs=(SCOPED,))
        self.desk = cv.Desk(Path(tempfile.mkdtemp()), env={"MEMO_CONVERSE_SCOPED_KEY_REFS": SCOPED},
                            keys=cv.KeyCache(reader=lambda ref: SECRET), log=lambda *a, **k: self.logs.append((a, k)))

    def ladder(self):
        return cv.Ladder(self.routes, self.desk.keys, cv.Breaker(), self.desk.http, 6, log=lambda *a, **k: None,
                         gate=self.desk.scope_gate, served_ok=self.desk.served_in_scope)

    def test_the_desks_own_ladder_checks_the_served_route(self):
        lad = self.desk.ladder({"routes": self.routes, "tiles": {}})
        self.assertEqual((lad.gate, lad.served_ok), (self.desk.scope_gate, self.desk.served_in_scope))

    def test_a_router_answer_from_a_route_outside_the_proven_scope_is_not_used(self):
        # automaticai/free picks from the gateway's whole free policy, not the token's scope: an answer from a route the
        # proof did not list is never used, whatever it says
        self.assertTrue(self.desk.prove_scope(self.routes[0])["ok"])
        self.gw.route_header, self.gw.model = "automaticai/kilo-anon/not-in-the-scope", "nemotron"
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertEqual(res["attempts"][0]["outcome"], "route_out_of_scope")
        self.assertEqual(res["route"], "r9")
        # the gateway's alias spelling of a listed route is that route
        self.gw.route_header, self.gw.model = "aai/personal/glm-5.3", "glm-5.3"
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertEqual((res["route"], res["served_route"]), ("r3", "aai/personal/glm-5.3"))
        # no proof listing at all (never proven): nothing it serves is in scope
        self.assertFalse(cv.Desk(Path(tempfile.mkdtemp()), env={}).served_in_scope(self.routes[0], "automaticai/personal/glm-5.3"))

    def test_an_answer_whose_model_is_not_a_string_is_thrown_away(self):
        def lad():
            return cv.Ladder(self.routes[1:], self.desk.keys, cv.Breaker(), self.desk.http, 6, log=lambda *a, **k: None)
        for model in (["claude-opus"], {"id": "claude"}, {"id": "glm-5.3"}):
            self.other.model = model
            res = lad().call([{"role": "user", "content": "hi"}])
            self.assertFalse(res["ok"], model)
            self.assertEqual(res["attempts"][0]["outcome"], "forbidden_model", model)
            self.assertEqual(res["attempts"][0]["answered_model"], json.dumps(model))  # shown as JSON, never used
        self.other.model = None  # no model field value of its own: the fake echoes the request's, a string
        self.assertTrue(lad().call([{"role": "user", "content": "hi"}])["ok"])

    def test_an_unproven_scope_skips_the_router_rung_and_proves_it_in_the_background(self):
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["scope_unproven", "ok"])
        self.assertEqual(self.gw.calls, [])  # nothing was sent to the router before its scope was proven
        for _ in range(50):
            if self.gw.gets:
                break
            time.sleep(0.05)
        self.assertEqual(self.gw.gets[0]["path"], "/v1/models")
        self.assertEqual(self.gw.gets[0]["auth"], f"Bearer {SECRET}")

    def test_a_proven_scope_lets_the_router_answer_and_records_the_served_route(self):
        self.assertTrue(self.desk.prove_scope(self.routes[0])["ok"])
        self.gw.route_header, self.gw.model = "automaticai/personal/glm-5.3", "glm-5.3"
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertTrue(res["ok"])
        self.assertEqual((res["route"], res["model"], res["served_route"]), ("r3", "glm-5.3", "automaticai/personal/glm-5.3"))
        self.assertNotIn("reasoning_effort", self.gw.calls[-1]["body"])

    def test_a_claude_route_in_the_scope_makes_the_rung_unsafe(self):
        self.gw.listing = self.gw.listing + ["automaticai/damien/claude-haiku-4.5"]
        p = self.desk.prove_scope(self.routes[0])
        self.assertFalse(p["ok"])
        self.assertEqual(p["anthropic"], ["automaticai/damien/claude-haiku-4.5"])
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertEqual(res["attempts"][0]["outcome"], "scope_unsafe")
        self.assertEqual(self.gw.calls, [])
        self.gw.listing = [x for x in self.gw.listing if "claude" not in x]

    def test_an_anthropic_answer_or_served_route_is_thrown_away(self):
        self.desk.prove_scope(self.routes[0])
        for header, model in (("automaticai/damien/claude-haiku-4.5", "glm-5.3"), ("automaticai/personal/glm-5.3", "claude-haiku-4.5")):
            self.gw.route_header, self.gw.model = header, model
            res = self.ladder().call([{"role": "user", "content": "hi"}])
            self.assertEqual(res["attempts"][0]["outcome"], "forbidden_model", header)
            self.assertEqual(res["route"], "r9")

    def test_a_router_answer_that_names_no_route_is_not_used(self):
        self.desk.prove_scope(self.routes[0])
        self.gw.route_header = None
        res = self.ladder().call([{"role": "user", "content": "hi"}])
        self.assertEqual(res["attempts"][0]["outcome"], "route_unproven")
        self.assertEqual(res["route"], "r9")

    def test_a_failed_recheck_keeps_a_good_proof_until_it_expires(self):
        self.assertTrue(self.desk.prove_scope(self.routes[0])["ok"])
        self.gw.listing, keep = [], self.gw.listing
        try:
            p = self.desk.prove_scope(self.routes[0])
            self.assertTrue(p["ok"])
            self.assertTrue(p["stale_error"])
        finally:
            self.gw.listing = keep


# ---------------------------------------------------------------------------------------------------- names, phrases

CATALOG = [{"name": n, "display_name": d} for n, d in (
    ("brule", "Brule"), ("carlin", "George Carlin"), ("damian", "Damian"), ("david", "David"), ("dumply", "Dumply"),
    ("marge", "Marge Simpson"), ("morgan", "Morgan Freeman"), ("morty", "Morty"), ("peter", "Peter Griffin"),
    ("rick", "Rick Sanchez"), ("walken", "Christopher Walken"), ("walken2", "Christopher Walken"))]


class Phrases(unittest.TestCase):
    table = cv.load_aliases(cv.ALIASES_PATH)

    def test_voices_resolve_by_name_display_name_and_spoken_digits(self):
        for said, want in (("walken", "walken"), ("Walken two", "walken2"), ("walken 2", "walken2"), ("WALKEN2", "walken2"),
                           ("Christopher Walken", "walken"), ("Morgan Freeman", "morgan"), ("freeman", "morgan"),
                           ("George", "carlin"), ("default", "default"), ("christopher", None), ("bob", None)):
            self.assertEqual(cv.resolve_voice(said, CATALOG), want, said)
        self.assertEqual(cv.voice_spoken("walken2"), "Walken two")
        self.assertEqual(cv.voice_spoken("rick"), "Rick")

    def test_aliases_resolve_from_their_phrases(self):
        for said, want in (("deepseek pro", "deepseek-pro"), ("Deep Seek Pro", "deepseek-pro"), ("pro", "deepseek-pro"),
                           ("flash", "deepseek-flash"), ("DeepSeek-Flash", "deepseek-flash"), ("the free model", "free"),
                           ("autorouter", "auto"), ("auto router", "auto"), ("default", "default"), ("claude", None)):
            self.assertEqual(cv.resolve_alias(said, self.table), want, said)

    def test_setting_phrases(self):
        v = lambda x: {"tool_name": cv.TOOL_VOICE, "args": {"voice": x}}  # noqa: E731
        mo = lambda x: {"tool_name": cv.TOOL_MODEL, "args": {"model": x}}  # noqa: E731
        for said, want in (("Use walken voice.", v("walken")), ("Switch to the Walken two voice, please.", v("walken2")),
                           ("switch the voice to Morgan Freeman", v("morgan")), ("Use Morgan Freeman's voice", v("morgan")),
                           ("Reset the voice.", v("default")), ("Switch to DeepSeek Pro.", mo("deepseek-pro")),
                           ("Okay, use the free model", mo("free")), ("switch the model to auto", mo("auto")),
                           ("go with the autorouter", mo("auto")), ("Reset the model.", mo("default")),
                           ("use the default model", mo("default")), ("Can you switch to deep seek flash please?", mo("deepseek-flash"))):
            self.assertEqual(cv.setting_phrase(said, CATALOG, self.table), want, said)
        # whisper's spelling one letter off (live 2026-10-22: "Use the walkin' voice!"); never for short names or two near ones
        self.assertEqual(cv.setting_phrase("Use the walkin' voice!", CATALOG, self.table), v("walken"))
        self.assertEqual(cv.setting_phrase("use the morgen voice", CATALOG, self.table), v("morgan"))
        self.assertIsNone(cv.setting_phrase("use the nick voice", CATALOG, self.table))
        self.assertIsNone(cv.resolve_voice("walkin", CATALOG))  # typed values (CLI, skills) are exact
        # live 2026-10-22, both missed the short-circuit and went to the LLM: "USE WALK VOICE" (two letters short of
        # walken; walken2 is one further) and "Use Rickface!" (whisper's "rick voice")
        self.assertEqual(cv.setting_phrase("USE WALK VOICE", CATALOG, self.table), v("walken"))
        self.assertEqual(cv.setting_phrase("Use Rickface!", CATALOG, self.table), v("rick"))
        self.assertEqual(cv.setting_phrase("use rick's face", CATALOG, self.table), v("rick"))
        self.assertEqual(cv.setting_phrase("use the carla voice", CATALOG, self.table), v("carlin"))
        self.assertEqual(cv.resolve_voice("walk", CATALOG, fuzzy=True), "walken")
        self.assertIsNone(cv.resolve_voice("walk", CATALOG))
        self.assertIsNone(cv.resolve_voice("mort", CATALOG, fuzzy=True))  # four letters are never near a five-letter name
        self.assertIsNone(cv.resolve_voice("dave", CATALOG, fuzzy=True))
        for said in ("use the interface", "use a straight face", "switch to the surface", "use your poker face",
                     "try a different face", "use the walk", "use the nick voice", "use the bob voice"):
            self.assertIsNone(cv.setting_phrase(said, CATALOG, self.table), said)
        self.assertEqual(cv._edits("walk", "walken"), 2)
        self.assertEqual(cv._edits("walk", "walken2", 2), 3)
        self.assertTrue(cv._within_one_edit("walkin", "walken"))
        self.assertFalse(cv._within_one_edit("walk", "walken"))
        for said in ("switch to marge", "switch to flume", "use the default", "what voice is that", "switch to rick",
                     "use the walken voice and then tell me what's on the board", "Send it.", "switch to banana voice",
                     "Have the PM switch to the new database"):
            self.assertIsNone(cv.setting_phrase(said, CATALOG, self.table), said)

    def test_the_voice_list_never_makes_the_car_wait_once_it_has_one(self):
        now = [1000.0]
        calls = []
        gate = threading.Event()

        def fetch(timeout):
            calls.append(timeout)
            if len(calls) > 1:
                gate.wait(2)
            return CATALOG
        vc = cv.VoiceCatalog("http://x", ttl_s=10, fetch=fetch, clock=lambda: now[0])
        self.assertEqual(len(vc.get()), 12)  # empty: fetched in line
        now[0] += 60  # stale
        t0 = time.time()
        self.assertEqual(len(vc.get()), 12)  # the stale list at once, refreshed in the background
        self.assertLess(time.time() - t0, 0.5)
        gate.set()

    def test_a_tool_decision_normalises(self):
        d = cv.normalize_decision({"action": "tool", "tool_name": "car_set_voice", "args": {"voice": "walken"}, "say": ""})
        self.assertEqual((d["action"], d["tool_name"], d["args"]), ("tool", "car_set_voice", {"voice": "walken"}))
        d = cv.normalize_decision({"action": "tool", "name": "car_set_model", "arguments": '{"model": "free"}'})
        self.assertEqual((d["tool_name"], d["args"]), ("car_set_model", {"model": "free"}))
        self.assertNotIn("tool_name", cv.normalize_decision({"action": "reply", "say": "hi"}))


# ---------------------------------------------------------------------------------------------------- flag file

class TileWriter(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "converse.json"

    def test_tiles_are_kept_by_the_mode_writer_and_cleared_cleanly(self):
        cv.write_flag(self.path, mode="on", agents=["holocene-pm"])
        cv.update_tile(self.path, "holocene-pm", voice="walken", by="car")
        cv.update_tile(self.path, "holocene-pm", model="deepseek-pro")
        cv.write_flag(self.path, mode="off")
        doc = json.loads(self.path.read_text())
        self.assertEqual(doc["mode"], "off")
        self.assertEqual((doc["tiles"]["holocene-pm"]["voice"], doc["tiles"]["holocene-pm"]["model"]), ("walken", "deepseek-pro"))
        self.assertEqual(doc["tiles"]["holocene-pm"]["voice_set_by"], "car")
        cv.update_tile(self.path, "holocene-pm", voice=None)
        cv.update_tile(self.path, "holocene-pm", model=None)
        self.assertEqual(json.loads(self.path.read_text())["tiles"], {})
        with self.assertRaises(ValueError):
            cv.update_tile(self.path, "../etc", voice="x")

    def test_concurrent_writers_lose_no_update(self):
        def work(i):
            for j in range(10):
                cv.update_tile(self.path, f"agent-{i}", voice=f"v{j}")
                cv.write_flag(self.path, mode="on")
        ts = [threading.Thread(target=work, args=(i,)) for i in range(6)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        tiles = json.loads(self.path.read_text())["tiles"]
        self.assertEqual({a: t["voice"] for a, t in tiles.items()}, {f"agent-{i}": "v9" for i in range(6)})

    def test_a_file_with_only_tiles_keeps_the_env_mode(self):
        cv.update_tile(self.path, "holocene-pm", voice="walken")
        desk = cv.Desk(self.path.parent, env={"MEMO_CONVERSE": "shadow", "MEMO_CONVERSE_ROUTES": json.dumps(
            [route("r1", "m", ref="op://V/i/f", base="https://h/v1")])}, log=lambda *a, **k: None)
        s = desk.settings()
        self.assertEqual((s["mode"], s["source"]), ("shadow", "env+flag"))
        self.assertEqual(desk.voice_for("holocene-pm", "rick"), "walken")
        self.assertEqual(desk.voice_for("flume-pm", "rick"), "rick")


# ---------------------------------------------------------------------------------------------------- tools

def make_skill(scope: Path, name: str, tool: dict, script: str, consumers="[car-desk]") -> Path:
    sk = scope / ".agents" / "skills" / name
    (sk / "scripts").mkdir(parents=True, exist_ok=True)
    (sk / "SKILL.md").write_text(textwrap.dedent(f"""\
        ---
        name: {name}
        description: "a test skill"
        metadata:
          tool:
            contract: tool.json
            entrypoint: scripts/run.py
            effect: writes-desk-prefs
            consumers: {consumers}
        ---
        # {name}
        """))
    (sk / "tool.json").write_text(json.dumps({"type": "function", "function": tool}))
    (sk / "scripts" / "run.py").write_text(script)
    return sk


# A stand-in for the real car-desk skills: the same contract (argv, one JSON object, exit codes), writing through the
# watcher's own verb exactly as scripts/set_voice.py and scripts/set_model.py do.
SKILL_SCRIPT = textwrap.dedent("""\
    import json, os, subprocess, sys
    a = sys.argv[1:]
    agent, by = a[a.index("--agent") + 1], a[a.index("--by") + 1]
    verb, val = ("voice", a[a.index("--voice") + 1]) if "--voice" in a else ("model", a[a.index("--model") + 1])
    cmd = [sys.executable, "-B", os.environ["HOLOCENE_MEMO_TRACE"], verb, agent,
           *(["--clear"] if val == "default" else [val]), "--json", "--by", by]
    r = subprocess.run(cmd, capture_output=True, text=True)
    res = json.loads(r.stdout.strip().splitlines()[-1])
    print(json.dumps({**res, "cleared": val == "default"}))
    sys.exit(0 if res.get("ok") else (3 if r.returncode == 3 else 1))
    """)
VOICE_TOOL = {"name": "car_set_voice", "description": "Change the car voice.",
              "parameters": {"type": "object", "properties": {"voice": {"type": "string", "maxLength": 64}},
                             "required": ["voice"], "additionalProperties": False}}
MODEL_TOOL = {"name": "car_set_model", "description": "Change the desk model.",
              "parameters": {"type": "object", "properties": {"model": {"type": "string", "enum": [
                  "deepseek-flash", "deepseek-pro", "free", "auto", "default"]}},
                             "required": ["model"], "additionalProperties": False}}


class Tools(unittest.TestCase):
    def setUp(self):
        self.scope = Path(tempfile.mkdtemp(prefix="scope-"))
        self.box = cv.ToolBox(self.scope, log=lambda *a, **k: None)

    def test_loads_only_car_desk_tools_and_reloads_on_change(self):
        self.assertEqual(self.box.tools(), {})
        make_skill(self.scope, "car-set-voice", VOICE_TOOL, "print('{}')")
        make_skill(self.scope, "other", {**VOICE_TOOL, "name": "other_tool"}, "print('{}')", consumers="[hermes]")
        self.assertEqual(sorted(self.box.tools()), ["car_set_voice"])
        make_skill(self.scope, "car-set-model", MODEL_TOOL, "print('{}')")
        self.assertEqual(sorted(self.box.tools()), ["car_set_model", "car_set_voice"])
        self.assertIn("car_set_model(model: string one of deepseek-flash", cv.tools_block(self.box.listing()))

    def test_validation_against_the_contract(self):
        make_skill(self.scope, "car-set-model", MODEL_TOOL, "print('{}')")
        for name, args, why in (("car_set_model", {"model": "claude"}, "one of"), ("car_set_model", {}, "missing"),
                                ("car_set_model", {"model": "free", "x": 1}, "unknown argument"),
                                ("car_set_model", {"model": 3}, "must be string"), ("rm_rf", {}, "no tool")):
            t, err = self.box.validate(name, args)
            self.assertIsNone(t)
            self.assertIn(why, err)
        self.assertIsNotNone(self.box.validate("car_set_model", {"model": "free"})[0])

    def test_run_passes_argv_without_a_shell_and_reads_one_json_object(self):
        make_skill(self.scope, "car-set-voice", VOICE_TOOL,
                   "import json, sys; print('noise'); print(json.dumps({'ok': True, 'argv': sys.argv[1:]}))")
        r = self.box.run("car_set_voice", {"voice": "walken; rm -rf /"}, "holocene-pm", by="car")
        self.assertTrue(r["ok"])
        self.assertEqual(r["out"]["argv"], ["--json", "--agent", "holocene-pm", "--by", "car", "--voice", "walken; rm -rf /"])

    def test_a_failing_or_slow_tool_is_reported_never_raised(self):
        make_skill(self.scope, "car-set-voice", VOICE_TOOL,
                   "import json, sys; print(json.dumps({'ok': False, 'error': 'there is no voice called bob'})); sys.exit(3)")
        r = self.box.run("car_set_voice", {"voice": "bob"}, "holocene-pm")
        self.assertEqual((r["ok"], r["exit"], r["error"]), (False, 3, "there is no voice called bob"))
        make_skill(self.scope, "car-set-voice", VOICE_TOOL, "import time; time.sleep(5)")
        r = self.box.run("car_set_voice", {"voice": "x"}, "holocene-pm", timeout=0.5)
        self.assertFalse(r["ok"])
        self.assertIn("timed out", r["error"])

    def test_a_timeout_kills_the_skills_own_child_so_the_change_never_lands_late(self):
        # review 2026-10-22: the skill's child (memo_trace.py voice|model, the writer) outlived the 3 s kill and wrote
        # converse.json after the driver heard "I couldn't change the voice"
        marker = Path(tempfile.mkdtemp()) / "landed"
        make_skill(self.scope, "car-set-voice", VOICE_TOOL, textwrap.dedent(f"""\
            import subprocess, sys, time
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.0); open({str(marker)!r}, 'w').write('x')"])
            time.sleep(5)
            """))
        t0 = time.time()
        r = self.box.run("car_set_voice", {"voice": "walken"}, "holocene-pm", timeout=0.5)
        self.assertLess(time.time() - t0, 2.5)
        self.assertEqual((r["ok"], r["error"]), (False, "timed out after 0.5 s"))
        time.sleep(1.5)
        self.assertFalse(marker.exists(), "the skill's child wrote after the timeout")

    def test_an_entrypoint_outside_the_skill_is_refused(self):
        sk = make_skill(self.scope, "car-set-voice", VOICE_TOOL, "print('{}')")
        (sk / "SKILL.md").write_text((sk / "SKILL.md").read_text().replace("scripts/run.py", "../../../../etc/passwd"))
        self.assertEqual(self.box.tools(), {})
        self.assertTrue(self.box.errors)


# ---------------------------------------------------------------------------------------------------- the watcher

class TileTurns(ConverseHarness, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.scope = Path(tempfile.mkdtemp(prefix="car-desk-scope-"))
        make_skill(self.scope, "car-set-voice", VOICE_TOOL, SKILL_SCRIPT)
        make_skill(self.scope, "car-set-model", MODEL_TOOL, SKILL_SCRIPT)
        self.pro = fake_server()
        self.addCleanup(self.pro.shutdown)
        self.aliases = self.state.dir / "aliases.json"
        self.aliases.write_text(json.dumps({"version": 1, "models": {
            "deepseek-pro": {"label": "DeepSeek Pro", "spoken": "Deep Seek Pro", "phrases": ["deepseek pro", "pro"],
                             "budget_s": 9, "routes": [route("pro-d", "deepseek-v4-pro", ref="op://DeLoSecrets/ds/key",
                                                             base=f"http://127.0.0.1:{self.pro.server_port}", timeout_s=3)]},
            "deepseek-flash": {"label": "DeepSeek Flash", "phrases": ["flash"], "routes": [self.routes[0]]},
            "free": {"label": "the free router", "phrases": ["free"], "routes": [route(
                "free", "automaticai/free", base=f"http://127.0.0.1:{self.gateway.server_port}/v1", timeout_s=3)]}}}))
        d = self.w.desk
        d.tools = cv.ToolBox(self.scope, log=d.log)
        d.aliases_path = self.aliases
        d.voices = cv.VoiceCatalog(mc_.VOX_URL)
        self.flagpath = self.state.dir / "converse.json"

    def tile(self):
        return (json.loads(self.flagpath.read_text()).get("tiles") or {}).get("holocene-pm") or {}

    def test_use_walken_voice_switches_with_no_llm_call_and_says_so_in_the_new_voice(self):
        key, m = self.say("Use Walken voice.")
        self.assertEqual(m["status"], "done")
        self.assertEqual(self.llm_calls(), 0)
        self.assertEqual(self.cmds(key), [])
        self.assertEqual(self.tile()["voice"], "walken")
        self.assertEqual(self.tile()["voice_set_by"], "car")
        self.assertEqual(VOX_TEXTS, ["Switched Holocene PM to Walken."])
        self.assertEqual(VOX_VOICES, ["walken"])  # spoken in the NEW voice
        r, = self.of_type("routed", key)
        self.assertEqual((r["action"], r["path"], r["lexicon"]), ("tool", "setting_phrase", True))
        self.assertEqual((r["tool"]["tool"], r["tool"]["args"], r["tool"]["ok"], r["tool"]["via"]),
                         ("car_set_voice", {"voice": "walken"}, True, "skill"))
        self.assertEqual(r["tile_voice"], "walken")
        rep, = self.of_type("replied", key)
        self.assertEqual(rep["voice"], "walken")
        self.assertNotIn("voice_requested", rep)
        # the next turn is spoken in walken too; another tile is not
        self.hyper.decision = decision(say="The watcher stage is next.")
        self.say("What's next?")
        self.assertEqual(VOX_VOICES[-1], "walken")
        hb = self.w.desk.heartbeat(default_voice=iw.VOICE)
        self.assertEqual(hb["tiles"]["holocene-pm"]["voice"], "walken")
        self.assertEqual(hb["tools"]["loaded"], ["car_set_model", "car_set_voice"])

    def test_walken_two_and_reset(self):
        self.say("Switch to the Walken two voice.")
        self.assertEqual(self.tile()["voice"], "walken2")
        self.assertEqual(self.last_said, "Switched Holocene PM to Walken two.")
        self.say("Reset the voice.")
        self.assertNotIn("voice", self.tile())
        self.assertEqual(self.last_said, "Holocene PM is back to the default voice.")
        self.assertIn(VOX_VOICES[-1], (None, iw.VOICE))

    def test_switch_to_deepseek_pro_puts_its_routes_in_front_of_the_ladder(self):
        key, m = self.say("Switch to DeepSeek Pro.")
        self.assertEqual(self.tile()["model"], "deepseek-pro")
        self.assertEqual(self.last_said, "Holocene PM now thinks with Deep Seek Pro.")
        self.assertEqual(self.llm_calls(), 0)
        self.pro.decision = decision(say="Pro here.")
        key, m = self.say("What's next?")
        self.assertEqual(self.last_said, "Pro here.")
        self.assertEqual(len(self.pro.calls), 1)
        self.assertEqual(self.pro.calls[0]["body"]["model"], "deepseek-v4-pro")
        r, = self.of_type("routed", key)
        self.assertEqual((r["route"], r["tile_model"]), ("pro-d", "deepseek-pro"))
        # pro down: the default ladder still backs it up
        self.pro.default = "500"
        self.hyper.decision = decision(say="Flash here.")
        key, m = self.say("And after that?")
        self.assertEqual(self.last_said, "Flash here.")
        r, = self.of_type("routed", key)
        self.assertEqual([a["route"] for a in r["attempt_log"]], ["pro-d", "r1"])
        lad, info = self.w.desk.routes_for(self.w.desk.settings(), "holocene-pm")
        self.assertEqual([x["id"] for x in lad], ["pro-d", "r1", "r3a"])
        self.assertEqual(info["budget_s"], max(9, self.w.desk.budget_s))

    def test_the_models_tool_call_is_validated_then_run(self):
        self.hyper.decision = {"say": "", "action": "tool", "tool_name": "car_set_model", "args": {"model": "claude"}}
        key, m = self.say("Think with the best Anthropic model you have.")
        self.assertEqual(m["status"], "done")
        self.assertNotIn("model", self.tile() if self.flagpath.exists() else {})
        self.assertTrue(self.last_said.startswith("I couldn't change the model:"), self.last_said)
        r, = self.of_type("routed", key)
        self.assertFalse(r["tool"]["ok"])
        self.hyper.decision = {"say": "", "action": "tool", "tool_name": "car_set_model", "args": {"model": "free"}}
        key, m = self.say("Could you put this desk on the free models for a while?")
        self.assertEqual(self.tile()["model"], "free")
        self.assertEqual(self.last_said, "Holocene PM now thinks with the free router.")
        # the prompt offered both tools
        system = self.hyper.calls[-1]["body"]["messages"][0]["content"]
        self.assertIn("TOOLS", system)
        self.assertIn("car_set_voice(voice: string)", system)
        self.hyper.decision = {"say": "", "action": "tool", "tool_name": "rm_everything", "args": {}}
        self.say("Delete everything.")
        self.assertTrue(self.last_said.startswith("I couldn't change that:"), self.last_said)

    def test_without_the_skill_scope_the_phrase_still_switches_in_process(self):
        self.w.desk.tools = cv.ToolBox(Path(tempfile.mkdtemp()), log=lambda *a, **k: None)
        key, m = self.say("Use Morgan Freeman's voice.")
        self.assertEqual(self.tile()["voice"], "morgan")
        r, = self.of_type("routed", key)
        self.assertEqual((r["tool"]["via"], r["tool"]["ok"]), ("builtin", True))
        self.assertEqual(VOX_VOICES[-1], "morgan")

    def test_an_unknown_tile_voice_falls_back_at_once_and_says_which_voice_was_used(self):
        cv.update_tile(self.flagpath, "holocene-pm", voice="ghost")
        self.hyper.decision = decision(say="Still here.")
        t0 = time.time()
        key, m = self.say("Are you there?")
        self.assertLess(time.time() - t0, 10)
        self.assertEqual(m["status"], "done")
        self.assertEqual(VOX_VOICES, [iw.VOICE])  # rendered once, in the default voice: no retry stall
        rep, = self.of_type("replied", key)
        self.assertEqual((rep["voice"], rep["voice_requested"], rep["voice_fallback"]), (iw.VOICE, "ghost", "voice_not_found"))
        self.assertEqual(m["voice_lock"]["voice"], iw.VOICE)

    def test_the_voice_is_locked_per_reply(self):
        m = {"agent": "holocene-pm", "reply_stamp": "2026-10-22T10:00:00Z", "memo_id": "x", "key": "k"}
        cv.update_tile(self.flagpath, "holocene-pm", voice="walken")
        self.assertEqual(self.w._reply_voice(m), "walken")
        cv.update_tile(self.flagpath, "holocene-pm", voice="carlin")
        self.assertEqual(self.w._reply_voice(m), "walken")  # the same reply keeps its voice
        m["reply_stamp"] = "2026-10-22T10:05:00Z"
        self.assertEqual(self.w._reply_voice(m), "carlin")  # the next reply round locks again

    def test_the_tile_voice_is_a_car_setting_a_browser_memo_keeps_the_default(self):
        # review 2026-10-22: the tile's voice applied to every reply for the agent, browser memos included
        cv.update_tile(self.flagpath, "holocene-pm", voice="walken")
        browser = {"agent": "holocene-pm", "reply_stamp": "s1", "memo_id": "b", "key": "kb",
                   "sender": {"ok": True, "host": "browser", "device": None}}
        self.assertEqual(self.w._reply_voice(browser), iw.VOICE)
        # a memo whose sender is not known yet: read once (S3 metadata), kept on the memo
        self.sender = {"ok": True, "host": "browser", "device": None}
        m = {"agent": "holocene-pm", "reply_stamp": "s1", "memo_id": "u", "key": "ku"}
        self.assertEqual(self.w._reply_voice(m), iw.VOICE)
        self.assertEqual(m["sender"]["host"], "browser")
        self.sender = {"ok": False, "host": None, "device": None}  # unreadable: not known to be the car
        self.assertEqual(self.w._reply_voice({"agent": "holocene-pm", "reply_stamp": "s1", "key": "kx"}), iw.VOICE)
        self.sender = {"ok": True, "host": "car", "device": DEVICE}
        self.assertEqual(self.w._reply_voice({"agent": "holocene-pm", "reply_stamp": "s1", "key": "kc"}), "walken")
        self.assertEqual(self.w._tile_voice("holocene-pm", "kc", "rick"), "walken")
        # no voice of its own: no S3 read at all
        with unittest.mock.patch.object(mc_, "s3_sender", side_effect=AssertionError("read")):
            self.assertEqual(self.w._tile_voice("flume-pm", "kz", iw.VOICE), iw.VOICE)


class CliVerbs(unittest.TestCase):
    def run_cli(self, *args, state):
        env = {**os.environ, "MEMO_STATE_DIR": str(state), "MEMO_CONVERSE_ALIASES": str(cv.ALIASES_PATH)}
        r = subprocess.run([sys.executable, "-B", str(MEMO_TRACE), *args], capture_output=True, text=True, env=env, timeout=30)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1]) if "--json" in args else r.stdout

    def test_voice_and_model_verbs(self):
        state = Path(tempfile.mkdtemp())
        rc, out = self.run_cli("voice", "holocene-pm", "walken two", "--json", state=state)
        self.assertEqual((rc, out["ok"], out["voice"], out["spoken"]), (0, True, "walken2", "Walken two"))
        rc, out = self.run_cli("voice", "holocene-pm", "bob", "--json", state=state)
        self.assertEqual((rc, out["ok"]), (3, False))
        self.assertIn("walken", out["valid"])
        rc, out = self.run_cli("model", "holocene-pm", "deepseek pro", "--json", state=state)
        self.assertEqual((rc, out["model"]), (0, "deepseek-pro"))
        self.assertEqual(out["ladder"][:2], ["pro-h=deepseek-v4-pro-0813", "pro-d=deepseek-v4-pro"])
        rc, out = self.run_cli("model", "holocene-pm", "claude opus", "--json", state=state)
        self.assertEqual(rc, 3)
        tiles = json.loads((state / "converse.json").read_text())["tiles"]
        self.assertEqual((tiles["holocene-pm"]["voice"], tiles["holocene-pm"]["model"]), ("walken2", "deepseek-pro"))
        rc, out = self.run_cli("converse", "status", state=state)
        self.assertIn("tile     holocene-pm: voice walken2, model deepseek-pro", out)
        rc, out = self.run_cli("model", "holocene-pm", "--clear", "--json", state=state)
        self.assertEqual((rc, out["model"], out["cleared"]), (0, None, True))
        rc, out = self.run_cli("voice", "holocene-pm", "--clear", "--json", state=state)
        self.assertEqual(json.loads((state / "converse.json").read_text())["tiles"], {})


REAL = Path.home() / "code/skillex/all-skills"


@unittest.skipUnless((REAL / "car-set-voice/scripts/set_voice.py").exists(), "the car-desk skills are not checked out")
class RealSkills(unittest.TestCase):
    """The real car-desk skill scripts (skillex all-skills) against this watcher's verb, vox faked."""

    def test_the_real_scripts_write_through_the_verb(self):
        state = Path(tempfile.mkdtemp())
        env = {**os.environ, "MEMO_STATE_DIR": str(state), "HOLOCENE_MEMO_TRACE": str(MEMO_TRACE),
               "HOLOCENE_CAR_DESK_ALIASES": str(cv.ALIASES_PATH), "MEMO_CONVERSE_ALIASES": str(cv.ALIASES_PATH)}
        box = cv.ToolBox(Path(tempfile.mkdtemp()), log=lambda *a, **k: None)
        skills = box.skills_dir
        skills.mkdir(parents=True)
        for n in ("car-set-voice", "car-set-model"):
            (skills / n).symlink_to(REAL / n)
        self.assertEqual(sorted(box.tools()), ["car_set_model", "car_set_voice"])
        r = box.run("car_set_voice", {"voice": "Christopher Walken"}, "holocene-pm", env=env, timeout=10)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["out"]["voice"], "walken")
        r = box.run("car_set_voice", {"voice": "nobody"}, "holocene-pm", env=env, timeout=10)
        self.assertEqual((r["ok"], r["exit"]), (False, 3))
        r = box.run("car_set_model", {"model": "free"}, "holocene-pm", env=env, timeout=10)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["out"]["model"], "free")
        tiles = json.loads((state / "converse.json").read_text())["tiles"]["holocene-pm"]
        self.assertEqual((tiles["voice"], tiles["model"], tiles["voice_set_by"]), ("walken", "free", "car"))
        self.assertTrue(VOX_CATALOG)


if __name__ == "__main__":
    unittest.main()

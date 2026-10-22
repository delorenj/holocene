"""converse.py, the fast in-car conversation desk (HOLOC-23): routes, the never-Anthropic rule, the ladder against a fake
OpenAI-compatible server, lexicons, the deterministic guard, briefs, ids and the agent card. No network, no op, no
hindsight. Run with the rest:
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# never a real vox, alias table or skill scope from these tests
os.environ.setdefault("MEMO_VOX_URL", "http://127.0.0.1:9")
os.environ.setdefault("MEMO_CONVERSE_TOOLS_DIR", tempfile.mkdtemp(prefix="no-car-desk-scope-"))
os.environ.setdefault("MEMO_CONVERSE_ALIASES", str(Path(tempfile.mkdtemp(prefix="no-aliases-")) / "none.json"))
import converse as cv  # noqa: E402

SECRET = "fake-hyper-key-0123456789abcdef"  # a fake: the tests prove it never leaks
ROTATED = "fake-rotated-key-fedcba9876543210"


def decision(**kw):
    d = {"say": "Holocene is finishing the desk.", "action": "reply", "target": "holocene-pm", "title": "", "brief": None,
         "perm": "read_only"}
    d.update(kw)
    return d


class FakeLLM(BaseHTTPRequestHandler):
    """POST <prefix>/chat/completions like Hyper or the gateway. server.modes is a queue of behaviours (then
    server.default): ok | timeout | 500 | 402 | 429 | 401 | badjson | prose | truncated | forbidden | empty."""

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        srv = self.server
        auth = self.headers.get("Authorization")
        srv.calls.append({"path": self.path, "auth": auth, "body": body})
        mode = srv.modes.pop(0) if srv.modes else srv.default
        if mode == "401" and auth == f"Bearer {ROTATED}":
            mode = "ok"
        if mode == "timeout":
            time.sleep(srv.sleep)
        content = json.dumps(srv.decision)
        status = 200
        out = {"id": "c1", "object": "chat.completion", "model": srv.model or body["model"],
               "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
               "usage": {"prompt_tokens": 900, "completion_tokens": 40, "prompt_tokens_details": {"cached_tokens": 640}}}
        raw = None
        if mode in ("500", "402", "429", "401"):
            status, out = int(mode), {"error": {"message": "nope"}}
        elif mode == "badjson":
            raw = b"<html>bad gateway</html>"
        elif mode == "prose":
            out["choices"][0]["message"]["content"] = "Holocene is fine, nothing is blocked."
        elif mode == "truncated":
            out["choices"][0]["message"]["content"] = '{"say": "Hel'
        elif mode == "forbidden":
            out["model"] = "claude-haiku-4.5"
        elif mode == "empty":
            out["choices"][0]["message"]["content"] = ""
        blob = raw if raw is not None else json.dumps(out).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(blob)))
            if srv.route_header and status == 200:
                self.send_header("X-AutomaticAI-Route", srv.route_header)  # the gateway names the route that served
            self.end_headers()
            self.wfile.write(blob)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        """GET <prefix>/models: the token's scope as the gateway lists it (server.listing)."""
        srv = self.server
        srv.gets.append({"path": self.path, "auth": self.headers.get("Authorization")})
        blob = json.dumps({"object": "list", "data": [{"id": m, "object": "model"} for m in srv.listing]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)


def fake_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeLLM)
    srv.daemon_threads = True
    srv.modes, srv.default, srv.calls, srv.sleep, srv.model, srv.decision = [], "ok", [], 2.0, None, decision()
    srv.route_header, srv.gets = None, []
    srv.listing = ["automaticai/auto", "automaticai/auto/fast", "automaticai/free", "automaticai/personal/glm-5.3-flash",
                   "automaticai/personal/kimi-k3s", "automaticai/personal/glm-5.3", "automaticai/deepseek/deepseek-flash"]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PROPOSE_FULL = {"say": "I'll have the PM check.", "action": "propose", "target": "holocene-pm", "title": "Check the converse tests",
                "brief": {"goal": "Find which tests cover the converse stage.", "context": [], "done_when": ["Listed."]}, "perm": "read_only"}


class Routes(unittest.TestCase):
    def test_the_never_anthropic_rule_refuses_claude_and_auto_routes_at_parse(self):
        raw = json.dumps([
            {"id": "r0", "base_url": "https://api.automaticai.io/v1", "key_ref": "op://V/i/f", "model": "automaticai/personal/claude-sonnet-5.5"},
            {"id": "ra", "base_url": "https://api.automaticai.io/v1", "key_ref": "op://V/i/f", "model": "automaticai/auto"},
            {"id": "rs", "base_url": "https://api.automaticai.io/v1", "key_ref": "op://V/i/f", "model": "automaticai/auto/subagent"},
            {"id": "rh", "base_url": "https://api.automaticai.io/v1", "key_ref": "op://V/i/f", "model": "automaticai/damien/claude-haiku-4.5"},
            {"id": "ro", "base_url": "https://api.anthropic.com/v1", "key_ref": "op://V/i/f", "model": "some-model"},
            {"id": "rf", "base_url": "https://x.example/v1", "key_ref": "op://V/i/f", "model": "fable-1"},
            {"id": "r1", "base_url": "https://hyper.charm.land/v1", "key_ref": "op://V/i/f", "model": "deepseek-v4.1-flash-1017"},
            {"id": "r3a", "base_url": "https://api.automaticai.io/v1", "key_ref": "op://V/i/f", "model": "automaticai/personal/kimi-k3s"},
        ])
        routes, refused = cv.parse_routes(raw)
        self.assertEqual([r["id"] for r in routes], ["r1", "r3a"])
        self.assertEqual([r["id"] for r in refused], ["r0", "ra", "rs", "rh", "ro", "rf"])
        self.assertTrue(all("forbidden_model" in r["reason"] for r in refused))

    def test_a_pasted_key_is_refused_only_op_refs_are_allowed(self):
        routes, refused = cv.parse_routes([{"id": "r1", "base_url": "https://h/v1", "key_ref": SECRET, "model": "m"}])
        self.assertEqual(routes, [])
        self.assertIn("op://", refused[0]["reason"])
        self.assertNotIn(SECRET, json.dumps(refused))

    def test_the_unit_routes_parse(self):
        unit = (Path(__file__).resolve().parent / "holocene-inbox-watcher.service").read_text()
        line = next(ln for ln in unit.splitlines() if ln.startswith("Environment='MEMO_CONVERSE_ROUTES="))
        raw = line.split("=", 2)[2].rstrip("'")
        routes, refused = cv.parse_routes(raw)
        self.assertEqual(refused, [])
        # operator decision 2026-10-22: the default is ONE route, automaticai/auto/fast on the holocene-converse token; the
        # gateway's auto chain is the fallback. No pinned model (Hyper / DeepSeek) in the default; those are tile aliases.
        self.assertEqual([(r["id"], r["model"]) for r in routes], [("r1", "automaticai/auto/fast")])
        self.assertTrue(all(r["key_ref"].startswith("op://DeLoSecrets/") for r in routes))
        r1 = routes[0]
        self.assertTrue(r1["scoped_auto"])
        self.assertEqual(r1["base_url"], "https://api.automaticai.io/v1")
        self.assertEqual(r1["key_ref"], "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/holocene-converse")
        self.assertEqual(r1["timeout_s"], 12.0)
        self.assertEqual((r1["temperature"], r1["reasoning_effort"]), (1.0, None))  # kimi 400s any other temperature
        self.assertFalse(any(cv.forbidden(r["model"]) for r in routes if not r["scoped_auto"]))
        self.assertNotIn("tflaecgcrdgxrh2ovgi5ysjkzq", unit)  # the Hindsight item is no longer the car desk's key
        budget = float(next(ln for ln in unit.splitlines() if ln.startswith("Environment=MEMO_CONVERSE_BUDGET_S=")).split("=")[-1])
        self.assertGreaterEqual(budget, sum(r["timeout_s"] for r in routes))  # the budget covers the route's whole timeout
        self.assertNotRegex(line, r"hyper\.charm\.land|api\.deepseek\.com")  # no pinned model in the default
        self.assertNotRegex(unit, r"\bsk-[A-Za-z0-9_-]{12,}")  # no pasted key ("car-desk-scope" is a path)


class Ladder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srvs = [fake_server() for _ in range(3)]

    @classmethod
    def tearDownClass(cls):
        for s in cls.srvs:
            s.shutdown()

    def setUp(self):
        for s in self.srvs:
            s.modes, s.default, s.calls, s.sleep, s.model, s.decision = [], "ok", [], 2.0, None, decision()
            s.route_header, s.gets = None, []
        self.logs = []
        self.reads = []

        def reader(ref):
            self.reads.append(ref)
            return SECRET
        self.keys = cv.KeyCache(reader=reader)
        self.breaker = cv.Breaker()

    def routes(self, timeouts=(1.0, 1.0, 1.0)):
        return cv.parse_routes([
            {"id": f"r{i + 1}", "base_url": f"http://127.0.0.1:{s.server_port}/v1", "key_ref": f"op://DeLoSecrets/item{i}/credential",
             "model": ["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash", "automaticai/personal/kimi-k3s"][i],
             "timeout_s": timeouts[i]} for i, s in enumerate(self.srvs)])[0]

    def ladder(self, budget=8.0, **kw):
        return cv.Ladder(self.routes(**kw), self.keys, self.breaker, budget_s=budget,
                         log=lambda event, level="info", **f: self.logs.append({"event": event, **f}))

    def call(self, **kw):
        return self.ladder(**kw).call([{"role": "user", "content": "what's Holocene working on?"}])

    def test_rung_one_answers_with_json_object_and_its_usage(self):
        res = self.call()
        self.assertTrue(res["ok"])
        self.assertEqual((res["route"], res["model"], res["decision"]["action"]), ("r1", "deepseek-v4.1-flash-1017", "reply"))
        self.assertEqual(res["cached_tokens"], 640)
        self.assertEqual(res["usage"]["prompt_tokens"], 900)
        call, = self.srvs[0].calls
        self.assertEqual(call["path"], "/v1/chat/completions")
        self.assertEqual(call["body"]["response_format"], {"type": "json_object"})
        self.assertFalse(call["body"]["stream"])
        self.assertEqual(call["auth"], f"Bearer {SECRET}")
        self.assertEqual(self.srvs[1].calls, [])

    def test_each_failure_falls_to_the_next_rung(self):
        for mode in ("500", "402", "429", "badjson", "truncated", "empty"):
            with self.subTest(mode=mode):
                self.setUp()
                self.srvs[0].default = mode
                res = self.call()
                self.assertTrue(res["ok"], res)
                self.assertEqual(res["route"], "r2")
                self.assertEqual(res["attempts"][0]["outcome"], {"500": "http_500", "402": "http_402", "429": "http_429",
                                                                 "badjson": "bad_json", "truncated": "bad_json",
                                                                 "empty": "empty"}[mode])

    def test_a_timeout_falls_through_and_r3_answers_when_r1_and_r2_fail(self):
        self.srvs[0].default = "timeout"
        self.srvs[1].default = "500"
        t0 = time.time()
        res = self.call(timeouts=(0.4, 1.0, 1.0))
        self.assertLess(time.time() - t0, 2.5)
        self.assertTrue(res["ok"])
        self.assertEqual(res["route"], "r3")
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["timeout", "http_500", "ok"])

    def test_prose_is_a_reply_not_a_failure(self):
        self.srvs[0].default = "prose"
        res = self.call()
        self.assertEqual((res["route"], res["decision"]["action"]), ("r1", "reply"))
        self.assertEqual(res["decision"]["say"], "Holocene is fine, nothing is blocked.")

    def test_a_forbidden_answering_model_is_discarded(self):
        self.srvs[0].default = "forbidden"
        res = self.call()
        self.assertEqual(res["route"], "r2")
        self.assertEqual(res["attempts"][0]["outcome"], "forbidden_model")
        self.assertEqual(res["attempts"][0]["answered_model"], "claude-haiku-4.5")
        for s in self.srvs:
            s.default = "forbidden"
        res = self.call()
        self.assertFalse(res["ok"])
        self.assertEqual(res["fallback_reason"], "all_routes_failed")
        self.assertNotIn("decision", res)

    def test_the_gateway_model_name_is_not_required_to_equal_the_route(self):
        self.srvs[0].model = "k3-256k"  # the gateway answers kimi-k3s as "k3-256k"
        res = self.call()
        self.assertEqual((res["ok"], res["model"], res["requested_model"]), (True, "k3-256k", "deepseek-v4.1-flash-1017"))

    def test_a_propose_with_no_title_and_no_brief_goes_to_the_next_rung(self):
        self.srvs[0].decision = {"say": "Draft.", "action": "propose"}  # what a small model sends
        self.srvs[1].decision = {**PROPOSE_FULL}
        res = self.call()
        self.assertEqual((res["route"], res["decision"]["title"]), ("r2", "Check the converse tests"))
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["incomplete_propose", "ok"])
        self.assertTrue(self.breaker.is_open("r1") is False)  # not a failure of the rung
        # nobody does better: the weak proposal is the answer and the guard builds the brief from the driver's words
        self.srvs[1].decision = {"say": "Draft.", "action": "propose"}
        self.srvs[2].decision = {"say": "Draft.", "action": "propose"}
        res = self.call()
        self.assertTrue(res["ok"])
        self.assertEqual(res["route"], "r3")
        final, _ = g(res["decision"], session(), "Have the PM check which tests cover the converse stage and report back")
        self.assertEqual(final["draft"]["title"], "Check which tests cover the converse stage")
        self.assertIn("Have the PM check which tests cover the converse stage and report back", final["draft"]["body"])

    def test_a_title_made_from_the_drivers_words(self):
        f = cv.title_from_words
        self.assertEqual(f("Have the PM check which git branch the holocene repo is on and report back."), "Check which git branch the holocene repo")
        self.assertEqual(f("Have the PM count the lines in the converse file and report back"), "Count the lines in the converse file")
        self.assertEqual(f("Please ask Holocene PM to look into the audio spool"), "Look into the audio spool")
        self.assertEqual(f(""), "")

    def test_the_breaker_opens_after_three_failures_in_two_minutes(self):
        self.srvs[0].default = "500"
        for _ in range(3):
            self.assertEqual(self.call()["route"], "r2")
        self.assertTrue(self.breaker.is_open("r1"))
        before = len(self.srvs[0].calls)
        res = self.call()
        self.assertEqual(res["attempts"][0]["outcome"], "breaker_open")
        self.assertEqual(len(self.srvs[0].calls), before)  # r1 not even asked

    def test_a_402_out_of_credit_opens_the_rung_for_ten_minutes_at_once(self):
        self.srvs[0].default = "402"
        self.assertEqual(self.call()["route"], "r2")  # one failure is enough
        self.assertTrue(self.breaker.is_open("r1"))
        before = len(self.srvs[0].calls)
        self.assertEqual(self.call()["attempts"][0]["outcome"], "breaker_open")
        self.assertEqual(len(self.srvs[0].calls), before)
        now = [1000.0]
        b = cv.Breaker(clock=lambda: now[0])
        b.trip("r1", cv.BILLING_OPEN_S)
        now[0] += 599
        self.assertTrue(b.is_open("r1"))
        now[0] += 2
        self.assertFalse(b.is_open("r1"))

    def test_whispers_stutter_still_matches_the_lexicons(self):
        for said in ("S-Send it!", "s-send it", "Y-yes, send it.", "N-no", "C-cancel that"):
            self.assertTrue(cv.confirm_only(said) or cv.cancel_only(said), said)
        self.assertFalse(cv.confirm_only("S-Send it but change the title"))
        self.assertEqual(cv.norm("A-and so"), "and so")

    def test_breaker_clock(self):
        now = [1000.0]
        b = cv.Breaker(clock=lambda: now[0])
        self.assertFalse(b.fail("r1"))
        now[0] += 130  # outside the 120 s window: forgotten
        self.assertFalse(b.fail("r1"))
        self.assertFalse(b.fail("r1"))
        self.assertTrue(b.fail("r1"))
        self.assertTrue(b.is_open("r1"))
        now[0] += 61
        self.assertFalse(b.is_open("r1"))

    def test_a_401_rereads_the_key_once(self):
        seq = [SECRET, ROTATED]
        self.keys = cv.KeyCache(reader=lambda ref: seq.pop(0))
        self.srvs[0].modes = ["401"]
        res = self.call()
        self.assertEqual(res["route"], "r1")
        self.assertEqual([c["auth"] for c in self.srvs[0].calls], [f"Bearer {SECRET}", f"Bearer {ROTATED}"])

    def test_an_unreadable_key_skips_its_rungs_and_is_retried_later(self):
        now = [0.0]

        def bad(ref):
            raise RuntimeError("op read rc=1: [ERROR] could not read secret")
        self.keys = cv.KeyCache(reader=bad, retry_s=300, clock=lambda: now[0])
        res = self.call()
        self.assertFalse(res["ok"])
        self.assertEqual(res["fallback_reason"], "key_unreadable")
        self.assertEqual(self.keys.status("op://DeLoSecrets/item0/credential"), "unreadable")

    def test_the_whole_ladder_keeps_its_budget(self):
        for s in self.srvs:
            s.default, s.sleep = "timeout", 1.0
        t0 = time.time()
        res = self.call(budget=1.2, timeouts=(0.8, 0.8, 0.8))
        self.assertLess(time.time() - t0, 2.2)
        self.assertFalse(res["ok"])

    def test_a_host_that_timed_out_is_not_asked_again_in_the_same_call(self):
        routes, _ = cv.parse_routes([
            {"id": "r1", "base_url": f"http://127.0.0.1:{self.srvs[0].server_port}/v1", "key_ref": "op://V/a/b", "model": "m1", "timeout_s": 0.4},
            {"id": "r2", "base_url": f"http://127.0.0.1:{self.srvs[0].server_port}/v1", "key_ref": "op://V/a/b", "model": "m2", "timeout_s": 0.4},
            {"id": "r3", "base_url": f"http://127.0.0.1:{self.srvs[2].server_port}/v1", "key_ref": "op://V/a/b", "model": "m3"}])
        self.srvs[0].default = "timeout"
        res = cv.Ladder(routes, self.keys, self.breaker, budget_s=8).call([{"role": "user", "content": "x"}])
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["timeout", "host_down", "ok"])

    def test_a_timeout_on_one_gateway_channel_does_not_blame_the_others(self):
        port = self.srvs[0].server_port
        routes, _ = cv.parse_routes([
            {"id": "g1", "base_url": f"http://127.0.0.1:{port}/v1", "key_ref": "op://V/a/b", "model": "automaticai/mistral-allowance/m1", "timeout_s": 0.4},
            {"id": "g2", "base_url": f"http://127.0.0.1:{port}/v1", "key_ref": "op://V/a/b", "model": "automaticai/personal/m2", "timeout_s": 0.4}])
        self.srvs[0].modes = ["timeout"]  # only the first call is slow
        res = cv.Ladder(routes, self.keys, self.breaker, budget_s=8).call([{"role": "user", "content": "x"}])
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["timeout", "ok"])
        # ...but the same channel is skipped
        routes, _ = cv.parse_routes([
            {"id": "g1", "base_url": f"http://127.0.0.1:{port}/v1", "key_ref": "op://V/a/b", "model": "automaticai/personal/m1", "timeout_s": 0.4},
            {"id": "g2", "base_url": f"http://127.0.0.1:{port}/v1", "key_ref": "op://V/a/b", "model": "automaticai/personal/m2", "timeout_s": 0.4}])
        self.srvs[0].modes = ["timeout"]
        res = cv.Ladder(routes, self.keys, self.breaker, budget_s=8).call([{"role": "user", "content": "x"}])
        self.assertEqual([a["outcome"] for a in res["attempts"]], ["timeout", "host_down"])

    def test_the_key_never_appears_in_a_log_line_a_result_or_an_error(self):
        for mode in ("500", "timeout", "badjson", "forbidden"):
            self.srvs[0].modes = [mode]
            self.srvs[1].modes = ["402"]
            res = self.call(timeouts=(0.3, 1.0, 1.0))
            blob = json.dumps({"res": res, "logs": self.logs}, default=str)
            self.assertNotIn(SECRET, blob)
        self.assertNotIn(SECRET, json.dumps(cv.Desk(Path(tempfile.mkdtemp()), env={}, keys=self.keys).heartbeat()))
        refs = cv.KeyCache(reader=lambda ref: (_ for _ in ()).throw(RuntimeError("op read rc=1: denied")))
        self.assertIsNone(refs.get("op://V/x/y"))
        self.assertNotIn(SECRET, refs.error("op://V/x/y") or "")


class Decisions(unittest.TestCase):
    def test_fences_and_trailing_text_are_tolerated(self):
        d = cv.parse_decision('```json\n{"say":"Hi.","action":"propose","title":"Spool check","brief":{"goal":"Check it."},"perm":"deploy"}\n```')
        self.assertEqual((d["action"], d["title"], d["brief"]["goal"], d["perm"]), ("propose", "Spool check", "Check it.", "deploy_ok"))
        d = cv.parse_decision('Here you go: {"say":"Sure.","action":"reply"} hope that helps')
        self.assertEqual((d["say"], d["action"]), ("Sure.", "reply"))

    def test_unknown_actions_are_replies_and_delegate_is_only_a_proposal(self):
        self.assertEqual(cv.parse_decision('{"say":"x","action":"launch_missiles"}')["action"], "reply")
        self.assertEqual(cv.parse_decision('{"say":"x","action":"delegate","title":"T"}')["action"], "propose")

    def test_broken_json_raises(self):
        with self.assertRaises(cv.BadDecision):
            cv.parse_decision('{"say": "Hel')


class Lexicons(unittest.TestCase):
    def test_confirm_only(self):
        for t in ("send it", "Send it.", "yes send it", "Yes, send it.", "go ahead.", "Yeah go ahead", "Do it.", "yes please"):
            self.assertTrue(cv.confirm_only(t), t)
        for t in ("don't send it", "Don't send it.", "yes but change the title", "send it to flume instead", "what is it",
                  "no", "send it later"):
            self.assertFalse(cv.confirm_only(t), t)

    def test_cancel_end_and_force_direct(self):
        self.assertTrue(cv.cancel_only("Cancel that."))
        self.assertTrue(cv.cancel_only("Don't send it."))
        self.assertTrue(cv.cancel_only("never mind"))
        self.assertFalse(cv.cancel_only("cancel the meeting with Bob tomorrow"))
        self.assertTrue(cv.end_only("Okay, that's all."))
        self.assertTrue(cv.end_only("thanks bye"))
        self.assertFalse(cv.end_only("that's all I wanted to ask about the spool?"))
        self.assertEqual(cv.force_direct("Ask Holocene PM directly what's on the board"), "ask holocene pm directly")
        self.assertTrue(cv.force_direct("put me through to the full agent"))
        self.assertIsNone(cv.force_direct("what is on the board"))

    def test_affirm_and_negation(self):
        self.assertTrue(cv.affirm("Yes, go ahead and send that over."))
        self.assertFalse(cv.negated("Yes, go ahead and send that over."))
        for t in ("yes but change the title", "don't send it", "send it instead to flume", "wait"):
            self.assertTrue(cv.negated(t), t)

    def test_the_permission_clamp_follows_the_drivers_own_words(self):
        self.assertEqual(cv.clamp_perm("deploy_ok", ["look into why the spool is disabled"]), "read_only")
        self.assertEqual(cv.clamp_perm("deploy_ok", ["yes but let it change the code"]), "changes_ok")
        self.assertEqual(cv.clamp_perm("deploy_ok", ["fix it", "and deploy it when green"]), "deploy_ok")
        self.assertEqual(cv.clamp_perm("read_only", ["fix it and deploy"]), "read_only")  # a ceiling, never a raise
        self.assertEqual(cv.clamp_perm("bogus", ["fix it"]), "read_only")


REG = {"holocene-pm": "Holocene PM", "flume-pm": "Flume PM", "ghost-pm": "Ghost PM"}


class Names:
    """names_fn for guard(): tokens per agent id, and a display name."""

    def __call__(self, agent):
        return cv.name_tokens(agent, REG.get(agent, ""))

    def display(self, agent):
        return REG.get(agent, agent)


def route_fn(agent):
    return {"ok": agent in ("holocene-pm", "flume-pm")}


def session(**kw):
    s = cv.new_session("holocene-pm", "dev-0001", 1000.0)
    s.update(kw)
    return s


def g(dec, sess, transcript, handoff="named", now=1010.0):
    return cv.guard(cv.normalize_decision(dec), sess, transcript, tile="holocene-pm", tile_name="Holocene PM",
                    handoff=handoff, route_fn=route_fn, names_fn=Names(), now=now, memo_id="m-1")


PROPOSE = {"action": "propose", "say": "I'll have the PM check.", "title": "Why the audio spool is disabled",
           "brief": {"goal": "Find out why the audio spool is disabled and report back.", "context": ["Seen in the car."],
                     "done_when": ["The cause is named."]}, "perm": "read_only"}


class Guard(unittest.TestCase):
    def test_a_proposal_is_read_back_from_the_template_naming_target_title_and_permission(self):
        final, reasons = g(PROPOSE, session(), "Have the PM look into why the audio spool is disabled and report back")
        self.assertEqual(final["action"], "propose")
        self.assertEqual(final["say"], "Draft for Holocene PM: Why the audio spool is disabled. Read-only. "
                                       "Say send it, or tell me what to change.")
        d = final["draft"]
        self.assertEqual((d["target"], d["perm"], d["state"]), ("holocene-pm", "read_only", "proposed"))
        self.assertEqual(d["brief_sha256"], cv.sha256(d["body"]))
        self.assertIsNone(final["send"])

    def test_confirm_sends_the_stored_draft_verbatim_and_a_duplicate_is_refused(self):
        sess = session()
        draft = g(PROPOSE, sess, "have the PM look into the spool")[0]["draft"]
        sess["pending"] = draft
        final, reasons = g({"action": "confirm"}, sess, "send it")
        self.assertIs(final["send"], draft)
        self.assertEqual(final["say"], "Sending to Holocene PM: Why the audio spool is disabled. I'll call you back.")
        # once it is being sent, another "send it" says so and sends nothing
        draft["state"] = "sending"
        final, reasons = g({"action": "confirm"}, sess, "send it")
        self.assertIsNone(final["send"])
        self.assertIn("already_sent", reasons)
        self.assertTrue(final["say"].startswith("Already sent to Holocene PM"))
        # a brief with the same sha sent in the last 30 min is refused even if proposed again
        sess["pending"] = dict(draft, state="proposed")
        sess["delegations"] = [{"brief_id": draft["brief_id"], "brief_sha256": draft["brief_sha256"], "title": draft["title"],
                                "target": "holocene-pm", "target_name": "Holocene PM", "state": "running", "at": 1005.0}]
        final, reasons = g({"action": "confirm"}, sess, "send it")
        self.assertIsNone(final["send"])
        self.assertIn("duplicate_brief", reasons)

    def test_confirm_needs_a_pending_draft_an_affirmation_and_no_negation(self):
        final, reasons = g({"action": "confirm"}, session(), "send it")
        self.assertEqual((final["action"], final["send"]), ("reply", None))
        self.assertIn("no_pending_draft", reasons)
        sess = session()
        sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        final, reasons = g({"action": "confirm"}, sess, "yes but change the title")
        self.assertIsNone(final["send"])
        self.assertEqual(final["action"], "propose")
        self.assertIn("not_affirmed", reasons)
        # an expired draft is not waiting any more
        final, reasons = g({"action": "confirm"}, sess, "send it", now=1000.0 + 601 + 10)
        self.assertIsNone(final["send"])

    def test_a_changed_draft_is_never_sent(self):
        sess = session()
        d = sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        d["body"] += "\nrm -rf /"
        final, reasons = g({"action": "confirm"}, sess, "send it")
        self.assertIsNone(final["send"])
        self.assertIn("draft_changed", reasons)

    def test_handoff_needs_the_agent_named_and_routable(self):
        sess = session()
        final, reasons = g({**PROPOSE, "target": "flume-pm"}, sess, "send that to the other agent instead")
        self.assertEqual(final["draft"]["target"], "holocene-pm")
        self.assertIn("handoff_not_named", reasons)
        final, reasons = g({**PROPOSE, "target": "ghost-pm"}, sess, "send that to Ghost instead")
        self.assertEqual(final["draft"]["target"], "holocene-pm")
        self.assertIn("unroutable_target", reasons)
        final, reasons = g({**PROPOSE, "target": "flume-pm"}, sess, "Send that to Flume PM instead", handoff="off")
        self.assertIn("handoff_off", reasons)
        final, reasons = g({**PROPOSE, "target": "flume-pm"}, sess, "Send that to Flume PM instead")
        self.assertEqual(reasons, [])
        self.assertEqual(final["draft"]["target"], "flume-pm")
        self.assertTrue(final["say"].startswith("Draft for Flume PM: "))

    def test_a_retarget_on_confirm_is_read_back_not_sent(self):
        sess = session()
        sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        final, reasons = g({"action": "confirm", "target": "flume-pm"}, sess, "send it to Flume PM")
        self.assertIsNone(final["send"])
        self.assertEqual((final["action"], final["draft"]["target"]), ("propose", "flume-pm"))

    def test_the_permission_is_clamped_by_the_drivers_last_two_transcripts(self):
        sess = session()
        final, reasons = g({**PROPOSE, "perm": "deploy_ok"}, sess, "look into why the spool is off")
        self.assertEqual(final["draft"]["perm"], "read_only")
        self.assertIn("perm_clamped:deploy_ok->read_only", reasons)
        cv.upsert_turn(sess, {"memo_id": "m-0", "user": "look into why the spool is off", "at": 1001.0})
        final, _ = g({**PROPOSE, "perm": "changes_ok"}, sess, "Yes but let it change the code")
        self.assertEqual(final["draft"]["perm"], "changes_ok")
        self.assertIn("Code changes OK, no deploy", final["say"])

    def test_a_reply_that_claims_it_sent_something_is_corrected(self):
        final, reasons = g({"action": "reply", "say": "Done. I've sent it to the PM."}, session(), "what's up")
        self.assertNotIn("sent it", final["say"])
        self.assertIn("Nothing was sent.", final["say"])
        self.assertIn("sent_claim_filtered", reasons)

    def test_a_sent_claim_is_true_while_a_confirmed_delegation_is_on_the_board(self):
        sess = session()
        sess["delegations"] = [{"brief_id": "b-1", "brief_sha256": "x" * 64, "title": "Spool", "target": "holocene-pm",
                                "state": "running", "at": 1005.0}]
        final, reasons = g({"action": "reply", "say": "I've sent it to the PM. They're looking into it."}, sess, "how's that going")
        self.assertEqual(final["say"], "I've sent it to the PM. They're looking into it.")
        self.assertNotIn("sent_claim_filtered", reasons)
        # ...but not about a NEW draft that is still unsent
        sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        final, reasons = g({"action": "reply", "say": "I've sent it."}, sess, "what about the new one")
        self.assertIn("sent_claim_filtered", reasons)

    def test_send_it_after_a_draft_timed_out_says_so_instead_of_already_sent(self):
        sess = session()
        sess["delegations"] = [{"brief_id": "b-1", "brief_sha256": "x" * 64, "title": "Old", "target": "holocene-pm",
                                "state": "done", "at": 1005.0}]
        sess["expired"] = {"brief_id": "b-2", "title": "New", "at": 1500.0}
        final, reasons = g({"action": "confirm"}, sess, "send it", now=1700.0)
        self.assertEqual((final["action"], final["say"]), ("reply", cv.EXPIRED_LINE))
        self.assertIsNone(final["send"])
        self.assertIn("draft_expired", reasons)
        # a delegation sent AFTER the expiry is a real 'already sent'
        sess["delegations"][0]["at"] = 1600.0
        final, reasons = g({"action": "confirm"}, sess, "send it", now=1700.0)
        self.assertIn("already_sent", reasons)

    def test_a_model_that_proposes_send_it_with_no_draft_is_not_believed(self):
        final, reasons = g({"action": "propose", "say": "Draft.", "title": "Send it"}, session(), "Send it!")
        self.assertEqual((final["action"], final["say"]), ("reply", cv.NOTHING_PENDING_LINE))
        self.assertIn("no_pending_draft", reasons)
        self.assertIsNone(final["draft"])

    def test_send_it_is_never_a_direct_turn_either(self):
        final, reasons = g({"action": "direct"}, session(), "Send it.")
        self.assertEqual((final["action"], final["say"]), ("reply", cv.NOTHING_PENDING_LINE))
        final, _ = g({"action": "direct"}, session(), "Ask Holocene PM directly what is on the board.")
        self.assertEqual(final["action"], "direct")

    def test_cancel_drops_the_pending_draft_and_end_closes(self):
        sess = session()
        sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        final, _ = g({"action": "cancel"}, sess, "cancel that")
        self.assertTrue(final["drop"])
        self.assertEqual(final["say"], "Dropped. Nothing was sent.")
        final, _ = g({"action": "end", "say": ""}, sess, "that's all")
        self.assertTrue(final["close"])


class Briefs(unittest.TestCase):
    def test_the_brief_carries_the_verbatim_transcripts_and_the_no_live_change_rule(self):
        sess = session()
        draft = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        words = [("10:00:01", "Have the PM look into why the audio spool is disabled and report back"), ("10:00:20", "Send it.")]
        prompt = cv.render_prompt(draft, words, sess["conv_id"], "memo-1", "holocene-pm")
        self.assertTrue(prompt.startswith(cv.DELEGATE_PREFIX))
        self.assertIn("Run no deploy, restart, push or other change to a live system unless", prompt)
        self.assertIn(draft["body"], prompt)  # verbatim
        self.assertIn('- 10:00:01 "Have the PM look into why the audio spool is disabled and report back"', prompt)
        self.assertIn('- 10:00:20 "Send it."', prompt)
        self.assertIn(f"brief {draft['brief_id']}", prompt)
        self.assertIn("Read-only: inspect, read and report", prompt)

    def test_uuid5_ids_are_stable(self):
        a = cv.brief_id_for("conv-1", "ab" * 32)
        self.assertEqual(a, cv.brief_id_for("conv-1", "ab" * 32))
        self.assertNotEqual(a, cv.brief_id_for("conv-1", "cd" * 32))
        self.assertEqual(cv.command_id_for(a), cv.command_id_for(a))
        self.assertNotEqual(cv.command_id_for(a), a)
        import uuid
        self.assertEqual(uuid.UUID(cv.command_id_for(a)).version, 5)


class Card(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="card-"))
        (self.d / "profiles/holocene-pm/memories").mkdir(parents=True)
        (self.d / "profiles/holocene-pm/SOUL.md").write_text("You are the Holocene PM.")
        (self.d / "profiles/holocene-pm/memories/MEMORY.md").write_text("HOLOC-23 is in progress.")
        proj = self.d / "holocene"
        proj.mkdir()
        (proj / "CLAUDE.md").write_text("# Holocene agent guide")
        (self.d / "reg.yaml").write_text(
            "agents:\n  holocene-pm:\n    display_name: Holocene PM\n    repo: holocene\n    role: pm\n"
            f"    profile_name: holocene-pm\n    project_path: {proj}\n    plane: {{identifier: HOLOC}}\n"
            "  flume-pm:\n    display_name: Flume PM\n    repo: flume\n    profile_name: flume-pm\n")
        (self.d / "roster.json").write_text(json.dumps({"agents": [{"id": "holocene-pm", "name": "Holocene"},
                                                                   {"id": "flume-pm", "name": "Flume"}]}))
        self.recalls = []

        def recall(bank, timeout):
            self.recalls.append(bank)
            return "- the desk ships today"
        self.cards = cv.CardCache(self.d / "reg.yaml", self.d / "profiles", self.d / "roster.json", recall=recall)

    def test_the_card_is_byte_identical_for_unchanged_inputs(self):
        a = self.cards.build("holocene-pm")
        b = self.cards.build("holocene-pm")
        self.assertEqual(a["text"], b["text"])
        self.assertEqual(a["sha256"], b["sha256"])
        self.assertEqual(self.recalls, ["holocene"])  # the recall digest is cached too
        for part in ("Holocene PM (id holocene-pm)", "SOUL (head):\nYou are the Holocene PM.", "HOLOC-23 is in progress.",
                     "# Holocene agent guide", "the desk ships today", "board HOLOC"):
            self.assertIn(part, a["text"])
        self.assertIn("flume-pm: Flume PM", a["roster"])
        m1 = cv.build_messages(agent="holocene-pm", name="Holocene PM", card=a, sess=None, transcript="first")
        m2 = cv.build_messages(agent="holocene-pm", name="Holocene PM", card=b, sess=session(), transcript="second")
        self.assertEqual(m1[0], m2[0])  # the stable prefix
        self.assertIn("OUTPUT FORMAT", m1[0]["content"])
        self.assertIn('"action":"propose"', m1[0]["content"])  # a literal example (deepseek -1017 needs one)
        os.utime(self.d / "profiles/holocene-pm/SOUL.md", ns=(time.time_ns() + 10 ** 9, time.time_ns() + 10 ** 9))
        (self.d / "profiles/holocene-pm/SOUL.md").write_text("You are the new Holocene PM.")
        self.assertNotEqual(self.cards.build("holocene-pm")["sha256"], a["sha256"])

    def test_names_for_handoff(self):
        self.assertIn("flume", self.cards.tokens("flume-pm"))
        self.assertIn("flume pm", self.cards.tokens("flume-pm"))
        self.assertTrue(cv.named("Send that to Flume instead", self.cards.tokens("flume-pm")))
        self.assertFalse(cv.named("send that to the other one", self.cards.tokens("flume-pm")))
        self.assertNotIn("pm", self.cards.tokens("flume-pm"))

    def test_the_conversation_window_and_desk_state_come_last(self):
        sess = session()
        cv.upsert_turn(sess, {"memo_id": "a", "user": "what's Holocene working on?", "say": "The desk.", "action": "reply", "at": 1.0})
        sess["pending"] = g(PROPOSE, sess, "look into the spool")[0]["draft"]
        msgs = cv.build_messages(agent="holocene-pm", name="Holocene PM", card=self.cards.build("holocene-pm"), sess=sess,
                                 transcript="send it", board="- spool check -> Holocene PM: running")
        self.assertEqual([m["role"] for m in msgs], ["system", "user", "assistant", "user"])
        self.assertEqual(msgs[1]["content"], "what's Holocene working on?")
        self.assertEqual(json.loads(msgs[2]["content"]), {"say": "The desk.", "action": "reply"})
        self.assertIn("PENDING DRAFT (proposed) for Holocene PM (target id holocene-pm): Why the audio spool is disabled", msgs[3]["content"])
        self.assertIn("spool check -> Holocene PM: running", msgs[3]["content"])
        self.assertTrue(msgs[3]["content"].endswith("[THE DRIVER SAID]\nsend it"))


class Settings(unittest.TestCase):
    ROUTES = json.dumps([{"id": "r1", "base_url": "https://hyper.charm.land/v1", "key_ref": "op://V/i/f",
                          "model": "deepseek-v4.1-flash-1017"}])

    def test_the_flag_file_wins_over_the_environment_and_a_bad_one_turns_it_off(self):
        d = Path(tempfile.mkdtemp())
        desk = cv.Desk(d, env={"MEMO_CONVERSE": "off", "MEMO_CONVERSE_AGENTS": "holocene-pm", "MEMO_CONVERSE_ROUTES": self.ROUTES},
                       log=lambda *a, **k: None)
        self.assertEqual((desk.settings()["mode"], desk.settings()["source"]), ("off", "env"))
        cv.write_flag(d / "converse.json", mode="on", agents="*")
        s = desk.settings()
        self.assertEqual((s["mode"], s["source"], s["agents"]), ("on", "flag", "*"))
        cv.write_flag(d / "converse.json", mode="shadow")
        self.assertEqual(desk.settings()["mode"], "shadow")
        (d / "converse.json").write_text("{not json")
        self.assertEqual(desk.settings()["mode"], "off")
        (d / "converse.json").unlink()
        self.assertEqual(desk.settings()["source"], "env")

    def test_an_invalid_env_mode_or_no_usable_route_is_off_never_a_crash(self):
        d = Path(tempfile.mkdtemp())
        self.assertEqual(cv.Desk(d, env={"MEMO_CONVERSE": "onn", "MEMO_CONVERSE_ROUTES": self.ROUTES},
                                 log=lambda *a, **k: None).settings()["mode"], "off")
        claude = json.dumps([{"id": "r1", "base_url": "https://x/v1", "key_ref": "op://V/i/f", "model": "claude-sonnet-5.5"}])
        s = cv.Desk(d, env={"MEMO_CONVERSE": "on", "MEMO_CONVERSE_ROUTES": claude}, log=lambda *a, **k: None).settings()
        self.assertEqual(s["mode"], "off")
        self.assertEqual(s["refused"][0]["id"], "r1")

    def test_eligibility(self):
        d = Path(tempfile.mkdtemp())
        desk = cv.Desk(d, env={"MEMO_CONVERSE": "on", "MEMO_CONVERSE_AGENTS": "holocene-pm", "MEMO_CONVERSE_ROUTES": self.ROUTES},
                       keys=cv.KeyCache(reader=lambda ref: SECRET), log=lambda *a, **k: None)
        s = desk.settings()
        car = {"ok": True, "host": "car", "device": "dev-00001"}
        self.assertIsNone(desk.ineligible(s, "holocene-pm", car, 5.0, "hello", False))
        self.assertEqual(desk.ineligible(s, "flume-pm", car, 5.0, "hello", False), "agent_not_allowed")
        self.assertEqual(desk.ineligible(s, "holocene-pm", {"ok": True, "host": "browser"}, 5.0, "hi", False), "host_browser")
        self.assertEqual(desk.ineligible(s, "holocene-pm", car, 91.0, "hi", False), "audio_too_long")
        self.assertEqual(desk.ineligible(s, "holocene-pm", car, 5.0, "hi", True), "already_dispatched")
        self.assertEqual(desk.ineligible({**s, "devices": ["other-device"]}, "holocene-pm", car, 5.0, "hi", False),
                         "device_not_allowed")


if __name__ == "__main__":
    unittest.main()

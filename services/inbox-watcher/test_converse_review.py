"""Regression tests for the 2026-10-22 independent review of the fast conversation desk (HOLOC-23): each test is one
finding that was reproduced, now fixed."""

from __future__ import annotations

import unittest
import unittest.mock

from test_converse import SECRET  # noqa: F401
from test_converse_pipeline import DEVICE, PROPOSE, ConverseHarness, decision  # noqa: F401
from test_inbox_watcher import VOX_TEXTS, facts, iw, mc_  # noqa: F401

import converse as cv  # noqa: E402


class Names:
    def __call__(self, a):
        return cv.name_tokens(a, {"flume-pm": "Flume PM", "holocene-pm": "Holocene PM", "monitoring-pm": "Monitoring PM"}.get(a, a))

    def display(self, a):
        return {"flume-pm": "Flume PM", "holocene-pm": "Holocene PM"}.get(a, a)

    def resolve(self, raw):
        t = (raw or "").strip()
        ids = {"flume-pm", "holocene-pm", "monitoring-pm"}
        slug = cv.norm(t).replace(" ", "-")
        return t if t in ids else slug if slug in ids else t


def route(a):
    return {"ok": a in ("holocene-pm", "flume-pm", "monitoring-pm")}


class GuardReview(unittest.TestCase):
    def setUp(self):
        self.now = 1_000_000.0
        self.s = cv.new_session("holocene-pm", "dev", self.now)

    def turn(self, text, dec, mid, **kw):
        self.now += 20
        f, r = cv.guard(cv.normalize_decision(dec), self.s, text, tile="holocene-pm", tile_name="Holocene PM", handoff="named",
                        route_fn=route, names_fn=Names(), now=self.now, memo_id=mid, **kw)
        if f["draft"] is not None:
            self.s["pending"] = f["draft"]
        if f["send"] is not None:
            f["send"]["state"] = "sending"
        turn = {"memo_id": mid, "user": text, "say": f["say"], "action": f["action"], "at": self.now}
        p = self.s["pending"]
        if f["action"] == "propose" and p and p["state"] == "proposed":
            turn["readback"] = p["brief_id"]
        cv.upsert_turn(self.s, turn)
        return f, r

    BASE = {"action": "propose", "title": "Check the spool", "brief": {"goal": "Find out why the spool is off"}, "perm": "read_only",
            "target": "holocene-pm"}

    def pending(self):
        self.turn("Have the PM check why the spool is off", self.BASE, "m1")

    # -- confirmation must be explicit
    def test_a_question_that_starts_with_okay_never_confirms(self):
        self.pending()
        for text in ("Okay, how long will that take?", "Sure, and what's on the board today?", "Yeah. Also, who owns the voice pipeline?"):
            f, r = self.turn(text, {"action": "confirm"}, f"q-{text[:6]}")
            self.assertIsNone(f["send"], text)
            self.assertIn("not_affirmed", r)

    def test_a_bare_yes_confirms_only_right_after_the_read_back(self):
        self.pending()
        f, _ = self.turn("What's on the board today?", {"action": "reply", "say": "Do you mean the Holocene board?"}, "m2")
        f, r = self.turn("Yes.", {"action": "confirm"}, "m3")
        self.assertIsNone(f["send"], "the desk's last words were a question, not the read-back")
        self.assertFalse(cv.send_affirmed("Okay.", self.s, self.s["pending"]) and self.s["turns"][-1]["action"] != "propose")

    def test_a_bare_yes_right_after_the_read_back_does_confirm(self):
        self.pending()
        self.assertTrue(cv.send_affirmed("Yes.", self.s, self.s["pending"]))
        f, _ = self.turn("Yes.", {"action": "confirm"}, "m2")
        self.assertIsNotNone(f["send"])

    def test_great_perfect_correct_are_not_confirm_lexicon(self):
        for t in ("Great", "Perfect", "Correct", "Okay", "Yes", "Sure"):
            self.assertFalse(cv.confirm_only(t), t)
        for t in ("Send it", "Yes, send it.", "Go ahead", "ok do it please", "Make it so"):
            self.assertTrue(cv.confirm_only(t), t)

    def test_okay_after_a_done_delegation_is_not_already_sent(self):
        self.pending()
        f, _ = self.turn("Send it.", {"action": "confirm"}, "m2")
        self.assertIsNotNone(f["send"])
        self.s["pending"] = None
        self.s["delegations"].append({"brief_id": "b", "brief_sha256": "x", "target": "holocene-pm", "state": "done", "at": self.now})
        self.assertFalse(cv.confirm_only("Okay."))

    # -- permission clamp
    def test_the_clamp_honours_negation_and_questions(self):
        self.assertEqual(cv.perm_allowed(["Look into the spool but don't change any code"]), "read_only")
        self.assertEqual(cv.perm_allowed(["Check why it failed, do not deploy or restart anything"]), "read_only")
        self.assertEqual(cv.perm_allowed(["Why did the watcher restart this morning?"]), "read_only")
        self.assertEqual(cv.perm_allowed(["Change the title to spool check"]), "read_only")
        self.assertEqual(cv.perm_allowed(["write me a short summary of the board"]), "read_only")
        self.assertEqual(cv.perm_allowed(["Fix the spool bug and commit it"]), "changes_ok")
        self.assertEqual(cv.perm_allowed(["Fix it and then deploy it"]), "deploy_ok")

    def test_a_deploy_in_an_unrelated_earlier_question_does_not_unlock_it(self):
        self.now += 1
        f, _ = self.turn("Did the deploy finish?", {"action": "reply", "say": "I don't know."}, "m0")
        f, r = self.turn("Have the PM check the spool", {**self.BASE, "perm": "deploy_ok"}, "m1")
        self.assertEqual(f["draft"]["perm"], "read_only")

    # -- named handoff
    def test_a_named_handoff_survives_edits_and_a_model_confirm(self):
        self.turn("Have Flume PM check why the spool is off", {**self.BASE, "target": "flume-pm"}, "m1")
        self.assertEqual(self.s["pending"]["target"], "flume-pm")
        f, r = self.turn("Also have it look at the logs", {**self.BASE, "target": "flume-pm"}, "m2")
        self.assertEqual(self.s["pending"]["target"], "flume-pm")
        f, r = self.turn("And make the title shorter", {**self.BASE, "target": "flume-pm", "title": "Spool check"}, "m3")
        self.assertEqual(self.s["pending"]["target"], "flume-pm", r)
        for echo in ("holocene-pm", "Flume PM"):
            self.s["pending"]["state"] = "proposed"
            f, r = self.turn("Send it.", {"action": "confirm", "target": echo}, f"c-{echo}")
            self.assertIsNotNone(f["send"], (echo, r))
            self.assertEqual(f["send"]["target"], "flume-pm")

    def test_a_common_word_stem_does_not_name_an_agent(self):
        f, r = self.turn("Check the monitoring for the spool", {**self.BASE, "target": "monitoring-pm"}, "m1")
        self.assertEqual(f["draft"]["target"], "holocene-pm")
        self.assertIn("handoff_not_named", r)

    # -- cancel / redirect while the read-back is being spoken
    def test_cancel_while_sending_asks_the_watcher_to_stop_it(self):
        self.pending()
        self.turn("Send it.", {"action": "confirm"}, "m2")
        f, r = self.turn("Cancel that.", {"action": "cancel"}, "m3")
        self.assertEqual(f["action"], "cancel")
        self.assertIsNotNone(f["cancel_sending"])
        self.assertNotEqual(f["say"], cv.NOTHING_TO_CANCEL_LINE)

    def test_a_redirect_while_sending_is_refused_not_read_back(self):
        self.pending()
        self.turn("Send it.", {"action": "confirm"}, "m2")
        f, r = self.turn("No wait, send it to Flume PM instead", {"action": "confirm", "target": "flume-pm"}, "m3")
        self.assertIsNone(f["draft"])
        f, r = self.turn("Make it for Flume PM", {**self.BASE, "target": "flume-pm"}, "m4")
        self.assertIsNone(f["draft"])
        self.assertIn("edit_while_sending", r)

    def test_a_retarget_and_a_later_proposal_get_their_own_brief_ids(self):
        a = cv.brief_id_for("c", "sha", "holocene-pm", 100.0)
        self.assertNotEqual(a, cv.brief_id_for("c", "sha", "flume-pm", 100.0))
        self.assertNotEqual(a, cv.brief_id_for("c", "sha", "holocene-pm", 5000.0))

    def test_the_same_brief_for_another_agent_is_not_a_duplicate(self):
        self.pending()
        f, _ = self.turn("Send it.", {"action": "confirm"}, "m2")
        self.s["delegations"].append({"brief_id": f["send"]["brief_id"], "brief_sha256": f["send"]["brief_sha256"],
                                      "target": "holocene-pm", "state": "running", "at": self.now})
        self.s["pending"] = None
        self.s["pending"] = {**f["send"], "state": "proposed", "target": "flume-pm", "target_name": "Flume PM",
                             "brief_id": "other"}
        f2, r = self.turn("Send it.", {"action": "confirm"}, "m3")
        self.assertIsNotNone(f2["send"], r)

    # -- never Anthropic
    def test_forbidden_survives_zero_width_lookalike_and_router_aliases(self):
        for bad in ("automaticai/​auto", "​automaticai/auto", "x\nautomaticai/auto", "сlaude", "openrouter/auto",
                    "automaticai/auto-fast", "ＡＵＴＯ".lower(), "automaticai/damien/claude-haiku-4.5", "Fable-9"):
            self.assertTrue(cv.forbidden(bad), bad)
        for good in ("deepseek-v4.1-flash-1017", "automaticai/personal/kimi-k3s", "ministral-14b-latest",
                     "automaticai/ministral/ministral-14b", "api.automaticai.io", "hyper.charm.land", "k3-256k"):
            self.assertFalse(cv.forbidden(good), good)

    # -- config robustness
    def test_a_malformed_numeric_route_field_turns_the_route_off(self):
        for bad in ({"timeout_s": "4s"}, {"temperature": "hot"}, {"max_tokens": "lots"}, {"temperature": [1]}, {"timeout_s": 1e9}):
            routes, refused = cv.parse_routes([{"id": "r1", "base_url": "https://h.example/v1", "model": "m", "key_ref": "op://v/i/f", **bad}])
            self.assertEqual(routes, [], bad)
            self.assertEqual(len(refused), 1, bad)

    def test_desk_settings_never_raise_on_a_hand_edited_flag_file(self):
        import tempfile
        from pathlib import Path
        d = Path(tempfile.mkdtemp())
        desk = cv.Desk(d, env={"MEMO_CONVERSE": "on", "MEMO_CONVERSE_AGENTS": "*"}, log=lambda *a, **k: None)
        cv.write_flag(d / "converse.json", mode="on", routes=[{"id": "r1", "base_url": "https://h.example/v1", "model": "m",
                                                               "key_ref": "op://v/i/f", "timeout_s": "4s"}])
        s = desk.settings()
        self.assertEqual(s["mode"], "off")
        self.assertFalse(desk.wants("holocene-pm"))

    # -- keys
    def test_an_unreadable_key_is_retried_after_its_retry_time(self):
        now = [1000.0]
        calls = []

        def reader(ref):
            calls.append(ref)
            if len(calls) < 3:
                raise RuntimeError("op down")
            return "k"
        kc = cv.KeyCache(reader=reader, retry_s=300, clock=lambda: now[0])
        self.assertIsNone(kc.get("op://v/i/f"))
        self.assertEqual(kc.status("op://v/i/f"), "unreadable")
        now[0] += 301
        self.assertEqual(kc.status("op://v/i/f"), "unread", "past its retry time the desk may try it again")
        self.assertIsNone(kc.get("op://v/i/f"))
        now[0] += 301
        self.assertEqual(kc.get("op://v/i/f"), "k")
        self.assertEqual(kc.status("op://v/i/f"), "ok")

    def test_a_slow_op_read_never_holds_a_turn_past_its_wait(self):
        import threading
        import time
        gate = threading.Event()
        kc = cv.KeyCache(reader=lambda ref: (gate.wait(5), "k")[1])
        t0 = time.time()
        self.assertIsNone(kc.get("op://v/i/f", timeout=0.3))
        self.assertLess(time.time() - t0, 1.5)
        gate.set()
        time.sleep(0.2)
        self.assertEqual(kc.get("op://v/i/f"), "k", "the read finished in the background")

    # -- sent-claim filter
    def test_a_false_sent_claim_about_new_work_is_filtered_even_with_a_delegation_on_the_board(self):
        self.s["delegations"].append({"brief_id": "b", "brief_sha256": "x", "target": "holocene-pm", "target_name": "Holocene PM",
                                      "title": "Why the audio spool is disabled", "state": "running", "at": self.now})
        f, r = self.turn("Also deploy the web app", {"action": "reply", "say": "I've kicked off the deploy of the web app."}, "m1")
        self.assertIn("sent_claim_filtered", r)
        self.assertNotIn("kicked off", f["say"])
        f, r = self.turn("How is that going?", {"action": "reply", "say": "I've sent it to the PM. It is running."}, "m2")
        self.assertNotIn("sent_claim_filtered", r)


class PipelineReview(ConverseHarness, unittest.TestCase):
    def propose(self, text="Have the PM look into why the audio spool is disabled and report back", dec=PROPOSE):
        self.hyper.decision = dec
        return self.say(text)

    def test_a_retry_of_a_failed_read_back_asks_the_desk_again_and_sends_once(self):
        self.propose()
        real = iw.synthesize

        def no_sending(text, tmp, **kw):
            if text.startswith("Sending to"):
                raise iw.StageError("tts", "vox_failed", "vox down")
            return real(text, tmp, **kw)
        with unittest.mock.patch.object(iw, "synthesize", side_effect=no_sending):
            key, m = self.say("Send it.")
        self.assertEqual(m["status"], "failed")
        self.assertEqual(m["resume_stage"], "converse")
        self.control("retry", m)
        self.tick_until(lambda: m["stage"] == "await_agent" or m["status"] in ("done", "failed"))
        self.assertEqual(len(self.cmds(key)), 1, "the retried confirm sends the draft")
        self.assertEqual(self.sess()["delegations"][-1]["state"], "running")

    def test_a_delegation_that_cannot_be_dispatched_is_restored_and_the_driver_is_told(self):
        self.propose("Have Flume PM look into why the audio spool is disabled", dec={**PROPOSE, "target": "flume-pm"})
        real = mc_.registry_route

        def gone(a, *aa, **kw):
            if a == "flume-pm":
                return {"ok": False, "reason": "flume-pm is not routable"}
            return real(a, *aa, **kw)
        with unittest.mock.patch.object(mc_, "registry_route", side_effect=gone):
            before = len(VOX_TEXTS)
            key, m = self.start("Send it.")
            self.tick_until(lambda: m["status"] in ("done", "failed") and m["key"] not in self.w.running)
            said = " ".join(VOX_TEXTS[before:])
            self.assertEqual(m["status"], "done")
        self.assertEqual(self.cmds(key), [])
        self.assertIn("nothing was sent", said)
        sess = self.sess()
        self.assertEqual(sess["pending"]["state"], "proposed")
        self.assertEqual(sess["delegations"][-1]["state"], "not_sent")
        key2, m2 = self.say("Send it.")
        self.assertNotIn("Already sent", self.last_said)

    def test_cancel_during_the_read_back_stops_the_delegation(self):
        self.propose()
        key, m = self.start("Send it.")
        self.tick_until(lambda: m["stage"] in ("speak", "mirror"), n=400)
        self.assertEqual(self.sess()["pending"]["state"], "sending")
        key2, m2 = self.say("Cancel that.")
        self.assertIn("cancelled before it left", self.last_said)
        self.tick_until(lambda: m["status"] in ("done", "failed"))
        self.assertEqual(self.cmds(key), [], "nothing was published")
        self.assertIsNone(self.sess()["pending"])
        self.assertEqual(self.sess()["delegations"][-1]["state"], "not_sent")

    def test_a_failure_half_way_through_the_apply_rolls_the_conversation_back(self):
        self.propose()
        real = self.w.fact_gated
        n = {"c": 0}

        def flaky(action, m, payload):
            if action == "routed" and payload.get("action") == "confirm" and n["c"] == 0:
                n["c"] += 1
                raise RuntimeError("boom after mutation")
            return real(action, m, payload)
        with unittest.mock.patch.object(self.w, "fact_gated", side_effect=flaky):
            key, m = self.say("Send it.")
        self.assertIn("Sending to Holocene PM", self.last_said)
        self.assertNotIn("Already sent", self.last_said)
        self.assertEqual(len(self.cmds(key)), 1)

    def test_a_cancelled_delegation_retried_after_a_new_confirm_never_publishes_twice(self):
        self.propose()
        real = self.w.step_dispatch
        done = {"x": False}

        def cancel_first(mm):
            if not done["x"] and mm.get("followups"):
                done["x"] = True
                with self.w.mu:
                    self.w.cancel_memo(mm)
            return real(mm)
        with unittest.mock.patch.object(self.w, "step_dispatch", side_effect=cancel_first):
            key, m = self.start("Send it.")
            self.tick_until(lambda: m["status"] == "cancelled" and m["key"] not in self.w.running)
        self.assertEqual(m["resume_stage"], "converse")
        key2, m2 = self.say("Send it.")
        self.control("retry", m)
        self.tick_until(lambda: m["status"] in ("done", "failed") and m["key"] not in self.w.running)
        ids = [r["argv"][r["argv"].index("--command-id") + 1] for t, r in facts() if t.startswith("bloodbank.cmd.")]
        self.assertEqual(len(ids), len(set(ids)), "one command id is never published twice")
        self.assertEqual(len(self.of_type("delegated", key)) + len(self.of_type("delegated", key2)), 1)

    def test_a_delegation_runs_on_the_voice_model_never_the_profiles_default(self):
        self.assertFalse(cv.forbidden(iw.CONVERSE_DELEGATE_MODEL))
        self.assertTrue(iw.CONVERSE_DELEGATE_MODEL)

    def test_a_stuck_sending_draft_is_cleared_by_the_sweep(self):
        self.propose()
        self.say("Send it.")
        with self.w.mu:
            sess = self.sess()
            sess["pending"] = {**(sess.get("pending") or {"brief_id": sess["delegations"][-1]["brief_id"], "title": "t"}),
                               "state": "sending", "at": time_ago(2000)}
            sess["delegations"][-1]["state"] = "sending"
            self.w.last_conv_sweep = 0.0
            self.w.converse_sweep()
        self.assertIsNone(self.sess()["pending"])
        self.assertEqual(self.sess()["delegations"][-1]["state"], "not_sent")


def time_ago(s):
    import time
    return time.time() - s


def m_done(h, key):
    m = h.state.memos[key]
    return m["status"] in ("done", "failed") or m["stage"] == "await_agent"


if __name__ == "__main__":
    unittest.main()

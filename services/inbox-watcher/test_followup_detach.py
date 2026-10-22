"""Answer-then-background, the detached interactive turn, and the voice turn's model, end to end with every hop faked.

Reuses the fakes of test_inbox_watcher (fake mc, bb-emit, gateway journal, Hermes state.db, vox): importing it sets the
environment before the watcher is imported. Run with the rest:
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'
"""
import json
import sqlite3
import time
import unittest
import unittest.mock
import uuid

from test_inbox_watcher import (  # noqa: F401 - the module sets up the fakes and the environment
    GATEWAY_DB, HERMES, VOX_TEXTS, MemoHarness, RecordingWriter, facts, hermes_session, iw, journal, journal_turn_timeout,
    mc_, progress_fact,
)


def say(profile, chat_id, role, content, ts=None):
    """Append one message to the memo's existing Hermes session (a follow-up turn writes into the same session)."""
    db = sqlite3.connect(HERMES / profile / "state.db")
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
               (f"s-{chat_id}", role, content, ts if ts is not None else time.time()))
    db.commit(); db.close()


def journal_detached(command_id, at="2026-10-21T21:05:00Z"):
    """The gateway detached this command's interactive turn at its wall clock: the row stays running, detached_at set."""
    journal(command_id, "holocene-pm", state="started", outcome=None)
    db = sqlite3.connect(GATEWAY_DB)
    try:
        db.execute("ALTER TABLE executions ADD COLUMN detached_at TEXT")
    except sqlite3.OperationalError:
        pass
    db.execute("UPDATE executions SET detached_at=? WHERE command_id=?", (at, command_id))
    db.commit(); db.close()


def journal_ceiling(command_id):
    """A detached turn the gateway cut off at its detached ceiling: failed turn_timeout, timeout_source detached_ceiling."""
    journal_turn_timeout(command_id, message="agent turn timed out after 1800s on interactive lane (detached ceiling)")
    db = sqlite3.connect(GATEWAY_DB)
    terminal = [{"type": "bloodbank.agent.invocation.failed", "data": {
        "error_code": "turn_timeout", "error_message": "agent turn timed out after 1800s (detached ceiling)", "lane": "interactive",
        "elapsed_seconds": 1800.4, "timeout_seconds": 1800.0, "timeout_source": "detached_ceiling", "turn_stopped": True,
        "detached": True}}]
    db.execute("UPDATE executions SET terminal_events=? WHERE command_id=?", (json.dumps(terminal), command_id))
    db.commit(); db.close()


class SplitBackground(unittest.TestCase):
    def test_a_long_follow_up_speaks_its_closing_summary_not_its_head(self):
        report = "**Read all 36 READMEs.**\n\n## Services\n\n" + "\n".join(f"- `x{i}/README.md` — does thing {i}." for i in range(60)) \
            + "\n\nThe READMEs mainly cover the voice pipeline and the design system. None were unreadable."
        said = iw.spoken_summary(report, 500)
        self.assertEqual(said, "The READMEs mainly cover the voice pipeline and the design system. None were unreadable.")
        self.assertEqual(iw.spoken_summary("Short and sweet.", 500), "Short and sweet.")

    def test_no_marker_is_the_whole_reply(self):
        self.assertEqual(iw.split_background("All green. Nothing to do."), ("All green. Nothing to do.", None))

    def test_the_marker_line_ends_the_spoken_answer_and_the_rest_is_the_plan(self):
        text = "I'll run the crank circuit and call you back.\n\nBACKGROUND: Walk all 8 zellij tabs.\nReport blockers."
        self.assertEqual(iw.split_background(text),
                         ("I'll run the crank circuit and call you back.", "Walk all 8 zellij tabs.\nReport blockers."))

    def test_markdown_around_the_marker_is_allowed(self):
        for line in ("**BACKGROUND:** do it", "- BACKGROUND: do it", "> BACKGROUND : do it", "`BACKGROUND:` do it"):
            self.assertEqual(iw.split_background("Sure.\n" + line), ("Sure.", "do it"), line)

    def test_only_the_upper_case_marker_outside_code_counts(self):
        # 2026-10-22 review: each of these cut an ordinary reply short and sent its tail back as "do this now, in full"
        for text in ("Status.\n**Background:** the gateway was reloaded at 04:19 and is fine.",
                     "Here is the CSS:\n```css\nbody {\n  background: #222;\n}\n```\nThat is all.",
                     "Config:\n- background: true\n- lane: batch",
                     "Example:\n```\nBACKGROUND: not a real hand-off\n```\nNothing else to do."):
            self.assertEqual(iw.split_background(text), (text, None), text)
        # a real marker after a fenced example still counts
        text = "Example:\n```\nBACKGROUND: x\n```\nOn it.\nBACKGROUND: do the real work"
        self.assertEqual(iw.split_background(text), ("Example:\n```\nBACKGROUND: x\n```\nOn it.", "do the real work"))

    def test_a_word_inside_a_sentence_is_not_the_marker(self):
        text = "The background job finished. BACKGROUND: is how I would hand it off."
        self.assertEqual(iw.split_background(text), (text, None))

    def test_an_empty_marker_has_no_plan_but_is_still_cut(self):
        self.assertEqual(iw.split_background("Done.\nBACKGROUND:"), ("Done.", None))


class VoiceTurnModel(MemoHarness, unittest.TestCase):
    """The command names the voice turn's model route; the dispatched and replied facts record it and what the gateway did."""

    def test_the_command_carries_the_fast_model(self):
        key, m = self.to_await("vm-defaults")
        (_, cmd), = self.cmds(key)
        self.assertEqual(iw.VOICE_MODEL, "automaticai/personal/sol-6.1")
        self.assertEqual(cmd["data"]["model"], iw.VOICE_MODEL)
        self.assertNotIn("reasoning_effort", cmd["data"])  # not a per-turn knob on this provider: the route is
        self.assertEqual(self.of_type("dispatched", key)[-1]["model"], iw.VOICE_MODEL)

    def test_the_gateways_model_override_outcome_reaches_the_replied_fact(self):
        key, m = self.to_await("vm-applied")
        journal(m["command_id"], "holocene-pm")
        mo = {"requested": iw.VOICE_MODEL, "applied": True, "reason": "applied"}
        db = sqlite3.connect(GATEWAY_DB)
        db.execute("UPDATE executions SET terminal_events=? WHERE command_id=?",
                   (json.dumps([{"type": "bloodbank.agent.invocation.completed", "data": {"model_override": mo}}]), m["command_id"]))
        db.commit(); db.close()
        hermes_session("holocene-pm", m["memo_id"], "Fast answer.", ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        r = self.of_type("replied", key)[-1]
        self.assertEqual((r["model"], r["model_override"]), (iw.VOICE_MODEL, mo))

    def test_empty_env_leaves_the_profile_model(self):
        with unittest.mock.patch.object(iw, "VOICE_MODEL", ""):
            key, m = self.to_await("vm-off")
        (_, cmd), = self.cmds(key)
        self.assertNotIn("model", cmd["data"])
        self.assertIsNone(self.of_type("dispatched", key)[-1]["model"])

    def test_the_prefix_puts_the_driver_first_and_teaches_the_background_line(self):
        p = iw.VOICE_PREFIX
        for must in ("A driver is waiting", "within about a minute", "at most 3 tool calls", "vox-speak", "never sleep",
                     "BACKGROUND:", "follow-up"):
            self.assertIn(must, p)
        self.assertIn("delegate_task", p)

    def test_the_follow_up_prefix_carries_the_deploy_rule_and_no_delegation(self):
        p = iw.FOLLOWUP_PREFIX
        for must in ("never delegate to a subagent", "delegate_task", "Run no deploy", "speech-to-text", "read-only part",
                     "spoken summary", "do not write a BACKGROUND: line"):
            self.assertIn(must, p)

    def test_a_follow_up_runs_on_the_profile_model_by_default(self):
        # Sol's weekly pool keeps the VOICE turns fast; nobody waits on a follow-up (2026-10-22 review)
        self.assertEqual(iw.FOLLOWUP_MODEL, "")


class AnswerThenBackground(MemoHarness, unittest.TestCase):
    """A reply with a BACKGROUND: line is spoken at once without it; the plan runs as a follow-up turn on the same thread,
    and its result is spoken later as '<agent>, follow-up.' into a new reply object of the same memo."""

    def setUp(self):
        super().setUp()
        self.w.status_writer = RecordingWriter()

    def quick_answer(self, name, answer="I'll walk the eight tabs and call you back.", plan="Walk all 8 zellij tabs and report."):
        key, m = self.to_await(name)
        cid1 = m["command_id"]
        journal(cid1, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], f"{answer}\n\nBACKGROUND: {plan}", ts=time.time())
        self.tick_until(lambda: m["stage"] == "await_agent" and m["command_id"] != cid1)
        return key, m, cid1

    def test_the_quick_answer_is_spoken_without_the_line_and_the_plan_goes_back_as_a_batch_follow_up(self):
        key, m, cid1 = self.quick_answer("atb-basic")
        self.assertEqual(VOX_TEXTS, ["Holocene PM. I'll walk the eight tabs and call you back."])
        r1, = self.of_type("replied", key)
        self.assertIs(r1["background"], True)
        self.assertEqual(r1["background_plan"], "Walk all 8 zellij tabs and report.")
        self.assertEqual(r1["command_id"], cid1)
        self.assertNotIn("BACKGROUND", r1["reply_text"])
        # the follow-up command: batch lane, same thread, its own prompt, tied to the quick answer's command
        (t1, c1), (t2, c2) = self.cmds(key)
        self.assertEqual((t1, t2), ("bloodbank.cmd.agent.invocation.invoke", "bloodbank.cmd.agent.invocation.start"))
        self.assertEqual(c2["data"]["thread_id"], m["memo_id"])
        self.assertEqual(c2["data"]["prompt"], iw.FOLLOWUP_PREFIX + "Walk all 8 zellij tabs and report.")
        ctx = c2["data"]["context"]
        self.assertEqual((ctx["reason"], ctx["followup_of"], ctx["followup_depth"]), ("voice-followup", cid1, 1))
        self.assertNotIn("model", c2["data"])  # the profile's own model: Sol stays for the voice turns
        self.assertEqual(c1["data"]["model"], iw.VOICE_MODEL)
        a = c2["argv"]
        self.assertEqual(a[a.index("--correlation") + 1], m["memo_id"])  # Candystore and memo:trace group it with the memo
        self.assertEqual(a[a.index("--command-id") + 1], m["command_id"])
        d2 = self.of_type("dispatched", key)[-1]
        self.assertEqual((d2["lane"], d2["lane_reason"], d2["followup"], d2["followup_of_command_id"]),
                         ("batch", mc_.FOLLOWUP_REASON, 1, cid1))
        # the memo keeps going: a long deadline, working in the car, the follow-up recorded
        self.assertEqual(m["status"], "active")
        self.assertAlmostEqual(m["deadline_ts"] - m["dispatched_ts"], iw.BATCH_TURN_TIMEOUT_S, delta=1)
        fu, = m["followups"]
        self.assertEqual((fu["n"], fu["state"], fu["of_command_id"], fu["command_id"]), (1, "running", cid1, m["command_id"]))
        self.w.status_writer.drain()
        doc = self.w.status_writer.last()
        self.assertEqual(doc["stage"], "working")
        self.assertEqual((doc["followup"]["n"], doc["followup"]["state"]), (1, "running"))
        self.assertEqual(self.w.narration_due(m), "followup")  # nothing narrated while the background turn works

    def test_the_follow_up_reply_is_spoken_later_into_a_new_reply_object(self):
        key, m, cid1 = self.quick_answer("atb-reply")
        rkey1 = self.of_type("replied", key)[0]["reply_s3_key"]
        cid2 = m["command_id"]
        time.sleep(1.1)  # a new reply stamp (seconds) for the follow-up's object
        journal(cid2, "holocene-pm")
        say("holocene-pm", m["memo_id"], "user", iw.FOLLOWUP_PREFIX + "Walk all 8 zellij tabs and report.")
        say("holocene-pm", m["memo_id"], "assistant", "All eight tabs are green; tab 3 needs your review.")
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. All eight tabs are green; tab 3 needs your review.")
        r1, r2 = self.of_type("replied", key)
        self.assertEqual((r2["followup"], r2["followup_of_command_id"], r2["command_id"]), (1, cid1, cid2))
        self.assertIs(r2["late"], True)
        self.assertIsNone(r2["background_plan"])
        self.assertNotEqual(r2["reply_s3_key"], rkey1)
        self.assertTrue(r2["reply_s3_key"].endswith(f"-{m['memo_id']}.ogg"))  # the pad plays every unit of its memo
        self.assertEqual(m["followups"][0]["state"], "spoken")
        self.assertEqual(m["followups"][0]["reply_key"], r2["reply_s3_key"])
        self.assertIs(m["prompt_match"], True)
        self.assertEqual(len(self.cmds(key)), 2)

    def test_a_follow_up_does_not_chain_another_by_default(self):
        key, m, cid1 = self.quick_answer("atb-nochain")
        journal(m["command_id"], "holocene-pm")
        say("holocene-pm", m["memo_id"], "assistant", "Half done.\nBACKGROUND: do the other half")
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. Half done.")
        self.assertEqual(len(self.cmds(key)), 2)
        self.assertNotIn("background_plan", m)

    def test_a_failed_follow_up_is_spoken_as_such_and_the_memo_ends(self):
        key, m, cid1 = self.quick_answer("atb-fail")
        journal(m["command_id"], "holocene-pm", outcome="failure")
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. The background work did not finish. Ask me again when you are parked.")
        r2 = self.of_type("replied", key)[-1]
        self.assertIs(r2["followup_failed"], True)
        self.assertEqual(m["followups"][0]["state"], "failed")
        self.assertEqual(self.of_type("failed", key), [])

    def test_a_follow_up_that_wrote_nothing_does_not_repeat_the_quick_answer(self):
        key, m, cid1 = self.quick_answer("atb-silent")
        # completed, but the newest assistant text is the quick answer (older than the follow-up's own prompt)
        say("holocene-pm", m["memo_id"], "user", iw.FOLLOWUP_PREFIX + "Walk all 8 zellij tabs and report.")
        journal(m["command_id"], "holocene-pm")
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. The background work did not finish: it ended without an answer.")

    def test_cancel_during_the_follow_up_keeps_it_quiet(self):
        key, m, cid1 = self.quick_answer("atb-cancel")
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual(m["status"], "cancelled")
        self.assertEqual(m["followups"][0]["state"], "cancelled")
        journal(m["command_id"], "holocene-pm")
        say("holocene-pm", m["memo_id"], "assistant", "Result nobody asked for any more.")
        n = len(VOX_TEXTS)
        self.ticks(10)
        self.assertEqual(len(VOX_TEXTS), n)

    def test_only_a_background_line_gets_a_spoken_acknowledgement(self):
        key, m = self.to_await("atb-only-line")
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "BACKGROUND: build the navi UI", ts=time.time())
        self.tick_until(lambda: len(self.cmds(key)) == 2)
        self.assertEqual(VOX_TEXTS, [f"Holocene PM. {iw.FOLLOWUP_ACK}"])

    def test_a_marker_with_nothing_after_it_never_says_done(self):
        key, m = self.to_await("atb-empty-line")
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "BACKGROUND:", ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS, [f"Holocene PM. {iw.NO_HANDOFF_LINE}"])
        self.assertEqual(len(self.cmds(key)), 1)

    def test_a_follow_up_that_only_hands_off_again_is_spoken_as_not_finished(self):
        key, m, cid1 = self.quick_answer("atb-handoff-again")
        journal(m["command_id"], "holocene-pm")
        say("holocene-pm", m["memo_id"], "user", iw.FOLLOWUP_PREFIX + "Walk all 8 zellij tabs and report.")
        say("holocene-pm", m["memo_id"], "assistant", "BACKGROUND: walk the tabs later")
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. The background work did not finish: it tried to hand "
                                        "the work off again instead of doing it.")
        self.assertEqual(m["followups"][0]["state"], "failed")
        self.assertEqual(len(self.cmds(key)), 2)

    def test_cancel_then_retry_brings_the_follow_up_back_at_reply_too(self):
        # 2026-10-22 review: only await_agent revived the follow-up; at reply the follow-up's answer was looked up by the
        # QUICK answer's prompt and spoken as "<agent>, late reply." with the head cut, its entry left "cancelled".
        key, m, cid1 = self.quick_answer("atb-cancel-retry")
        cid2 = m["command_id"]
        time.sleep(1.1)
        journal(cid2, "holocene-pm")
        say("holocene-pm", m["memo_id"], "user", iw.FOLLOWUP_PREFIX + "Walk all 8 zellij tabs and report.")
        say("holocene-pm", m["memo_id"], "assistant", "All eight tabs are green.")
        self.tick_until(lambda: m["stage"] == "reply")
        with self.w.mu:
            self.w.cancel_memo(m)
        self.assertEqual(m["followups"][0]["state"], "cancelled")
        self.w._control_retry(m, m["memo_id"])
        self.assertEqual((m["stage"], m["followups"][0]["state"]), ("reply", "running"))
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, follow-up. All eight tabs are green.")
        self.assertEqual(m["followups"][0]["state"], "spoken")
        self.assertEqual(len(self.cmds(key)), 2)

    def test_cancel_then_retry_at_dispatch_sends_the_follow_ups_prompt(self):
        key, m, cid1 = self.quick_answer("atb-cancel-dispatch")
        fu = m["followups"][0]
        # as if the cancel had landed while the follow-up was being dispatched
        m.update(stage="dispatch")
        fu["state"] = "dispatching"
        with self.w.mu:
            self.w.cancel_memo(m)
        self.assertEqual(fu["state"], "cancelled")
        self.w._control_retry(m, m["memo_id"])
        self.assertEqual((m["stage"], fu["state"]), ("dispatch", "dispatching"))
        self.assertIs(iw.live_followup(m), fu)
        self.assertEqual(self.w._prompt_for_send(m), fu["prompt"])

    def test_off_switch_strips_the_line_and_sends_nothing(self):
        with unittest.mock.patch.object(iw, "FOLLOWUP_MAX", 0):
            key, m = self.to_await("atb-off")
            journal(m["command_id"], "holocene-pm")
            hermes_session("holocene-pm", m["memo_id"], "Short answer.\nBACKGROUND: long work", ts=time.time())
            self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS, ["Holocene PM. Short answer."])
        self.assertEqual(len(self.cmds(key)), 1)
        self.assertIs(self.of_type("replied", key)[-1]["background"], False)


class Detached(MemoHarness, unittest.TestCase):
    """A gateway that detaches the interactive turn at its wall clock: the watcher keeps waiting (no kill, no batch re-run),
    says once that it will call back, and speaks the reply late."""

    def setUp(self):
        super().setUp()
        self.events = []
        self.cs = unittest.mock.patch.object(mc_, "progress_events", side_effect=lambda mid, limit=200: list(self.events))
        self.cs.start()
        self.ty = unittest.mock.patch.object(mc_, "typed_events", side_effect=lambda mid, t, limit=200, timeout=4: [
            e for e in self.events if e["type"] == t])
        self.ty.start()

    def tearDown(self):
        self.cs.stop()
        self.ty.stop()
        super().tearDown()

    def wait_narration(self, timeout=5.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self.w.mu:
                if not self.w.narrating:
                    return
            time.sleep(0.02)
        self.fail("a narration render never finished")

    def test_a_journal_detach_is_waited_out_and_spoken_late_with_no_escalation(self):
        key, m = self.to_await("det-journal")
        cid = m["command_id"]
        journal_detached(cid)
        self.ticks(4)
        self.assertEqual(m["detached"], cid)
        self.assertTrue(iw.detached_now(m))
        self.assertIs(m["late"], True)
        self.assertGreaterEqual(m["deadline_ts"] - m["dispatched_ts"], iw.DETACHED_WAIT_S - 1)
        self.wait_narration()
        self.assertEqual(VOX_TEXTS, [f"Holocene PM, {iw.DETACHED_LINE}"])
        narr, = self.of_type("narrated", key)
        self.assertEqual(narr["kind"], "detached")
        self.assertEqual(self.w.narration_due(m), "detached")  # no more 30 s updates after the notice
        self.assertEqual(iw.status_doc(m)["detached"], True)
        time.sleep(3.2)  # past MEMO_AGENT_TIMEOUT_S (3 s in tests): a detached turn is not timed out at the old deadline
        self.ticks(4)
        self.assertEqual((m["status"], m["stage"]), ("active", "await_agent"))
        journal(cid, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Finished the long build.", ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM, late reply. Finished the long build.")
        self.assertEqual(len(self.cmds(key)), 1)  # never re-dispatched
        r = self.of_type("replied", key)[-1]
        self.assertEqual((r["late"], r["escalated"], r["detached"]), (True, False, True))

    def test_a_progressed_detach_fact_counts_too(self):
        key, m = self.to_await("det-fact")
        cid = m["command_id"]
        self.events = [{"type": mc_.PROGRESS_TYPE, "time": mc_.iso(time.time()),
                        "data": {"command_id": cid, "detached": True, "lane": "interactive", "elapsed_seconds": 300.1}}]
        self.w.poll_progress()
        self.assertEqual(m["detached"], cid)
        self.wait_narration()

    def test_a_detached_fact_type_counts_after_the_probe_age(self):
        key, m = self.to_await("det-type")
        cid = m["command_id"]
        m["dispatched_ts"] = time.time() - 300
        self.events = [{"type": mc_.DETACHED_TYPE, "time": mc_.iso(time.time()), "data": {"command_id": cid}}]
        self.w.poll_progress()
        self.assertEqual(m["detached"], cid)
        self.wait_narration()

    def test_a_detach_fact_of_another_command_is_ignored(self):
        key, m = self.to_await("det-other")
        self.events = [{"type": mc_.PROGRESS_TYPE, "time": mc_.iso(time.time()),
                        "data": {"command_id": str(uuid.uuid4()), "detached": True}}]
        self.w.poll_progress()
        self.assertNotIn("detached", m)

    def test_a_detached_turn_cut_off_at_the_ceiling_fails_without_a_batch_rerun(self):
        key, m = self.to_await("det-ceiling")
        cid = m["command_id"]
        journal_detached(cid)
        self.ticks(3)
        self.wait_narration()
        journal_ceiling(cid)
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "turn_timeout"))
        self.assertEqual(len(self.cmds(key)), 1)
        f = self.of_type("failed", key)[-1]
        self.assertEqual((f["timeout_source"], f["detached"]), ("detached_ceiling", True))

    def test_a_rerun_stopped_at_the_lane_limit_escalates_even_if_an_earlier_attempt_detached(self):
        # 2026-10-22 review: the same command detached, a restart cut it off and re-ran it, and that re-run was stopped at
        # 300 s with max_detached full (timeout_source lane, no detached flag). It must escalate, not fail.
        key, m = self.to_await("det-rerun")
        cid = m["command_id"]
        journal_detached(cid)
        self.ticks(3)
        self.wait_narration()
        self.assertTrue(iw.detached_now(m))
        journal_turn_timeout(cid)
        self.tick_until(lambda: m["command_id"] != cid and m["stage"] == "await_agent")
        self.assertEqual([t for t, _ in self.cmds(key)], ["bloodbank.cmd.agent.invocation.invoke",
                                                         "bloodbank.cmd.agent.invocation.start"])
        self.assertIs(m["escalated"], True)

    def test_without_detach_the_wall_clock_still_escalates(self):
        key, m = self.to_await("det-none")
        cid = m["command_id"]
        journal_turn_timeout(cid)
        self.tick_until(lambda: m["command_id"] != cid and m["stage"] == "await_agent")
        self.assertEqual([t for t, _ in self.cmds(key)], ["bloodbank.cmd.agent.invocation.invoke",
                                                         "bloodbank.cmd.agent.invocation.start"])


class TraceDetachAndFollowup(unittest.TestCase):
    """memo:trace shows the detach, the quick answer and the follow-up as their own hops; the verdict names both."""

    CMD1, CMD2 = "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
    KEY = "inbox/holocene-pm/2026/10/21/followup-trace.ogg"

    def _events(self, followup_replied=True):
        mid = mc_.memo_id_for(self.KEY)

        def ev(typ, at, **data):
            return {"type": f"bloodbank.{typ}", "time": at, "data": {"memo_id": mid, "occurred_at": at, **data}}
        out = [
            ev("audio.memo.received", "2026-10-21T02:00:00.100Z", detect_lag_ms=5),
            ev("audio.memo.transcribed", "2026-10-21T02:00:01.000Z", transcript_chars=20, processing_seconds=0.5, model="m",
               transcript_text="crank circuit"),
            ev("audio.memo.dispatched", "2026-10-21T02:00:02.000Z", command_id=self.CMD1, command_subject="x", lane="interactive",
               lane_reason=None, model="automaticai/personal/sol-6.1"),
            ev("agent.invocation.started", "2026-10-21T02:00:03.000Z", command_id=self.CMD1),
            ev("agent.invocation.detached", "2026-10-21T02:05:03.000Z", command_id=self.CMD1, elapsed_seconds=300.2,
               timeout_seconds=300.0, ceiling_seconds=2700.0),
            ev("agent.invocation.completed", "2026-10-21T02:06:00.000Z", command_id=self.CMD1, detached=True,
               detached_after_seconds=300.2, elapsed_seconds=357.0,
               model_override={"requested": "automaticai/personal/sol-6.1", "applied": True, "reason": "applied"}),
            ev("audio.memo.replied", "2026-10-21T02:06:05.000Z", reply_chars=40, tts_seconds=1.0, tts_engine="fakevox",
               reply_s3_key="replies/a.ogg", late=True, escalated=False, detached=True, background=True,
               background_plan="walk the tabs", command_id=self.CMD1),
            ev("audio.memo.dispatched", "2026-10-21T02:06:06.000Z", command_id=self.CMD2, command_subject="x", lane="batch",
               lane_reason=mc_.FOLLOWUP_REASON, followup=1, followup_of_command_id=self.CMD1, followup_plan="walk the tabs"),
            ev("agent.invocation.started", "2026-10-21T02:06:07.000Z", command_id=self.CMD2),
        ]
        if followup_replied:
            out += [ev("agent.invocation.completed", "2026-10-21T02:09:00.000Z", command_id=self.CMD2),
                    ev("audio.memo.replied", "2026-10-21T02:09:04.000Z", reply_chars=80, tts_seconds=1.0, tts_engine="fakevox",
                       reply_s3_key="replies/b.ogg", late=True, followup=1, followup_of_command_id=self.CMD1,
                       command_id=self.CMD2, reply_text="All eight tabs are green.")]
        return out

    def _build(self, events, rec):
        import contextlib
        import memo_trace as mt
        rows = {
            self.CMD1: {"state": "completed", "outcome": "success", "profile": "holocene-pm", "created_at": "2026-10-21T02:00:02Z",
                        "updated_at": "2026-10-21T02:06:00Z", "lane": "interactive", "failure_code": None, "terminal": [],
                        "detached_at": "2026-10-21T02:05:03Z"},
            self.CMD2: {"state": "completed" if rec.get("status") == "done" else "started", "outcome": "success",
                        "profile": "holocene-pm", "created_at": "2026-10-21T02:06:06Z", "updated_at": "2026-10-21T02:09:00Z",
                        "lane": "batch", "failure_code": None, "terminal": []}}
        lm = lambda k: {"size": 9, "last_modified": mc_.parse_iso("2026-10-21T02:00:00Z" if k == self.KEY else "2026-10-21T02:06:05Z")}  # noqa: E731
        with contextlib.ExitStack() as st:
            for target, name, kw in ((mt.c, "candystore_events", {"return_value": events}), (mt.c, "s3_stat", {"side_effect": lm}),
                                     (mt.c, "journal_row", {"side_effect": rows.get}),
                                     (mt.c, "find_reply", {"return_value": {"prompt": "hi", "text": "x"}}),
                                     (mt, "upload_log_line", {"return_value": (None, None)}),
                                     (mt, "watcher_record", {"return_value": rec}),
                                     (mt, "watcher_heartbeat", {"return_value": {"age_s": 1.0}}),
                                     (mt, "watcher_unit_active", {"return_value": "active"}),
                                     (mt, "earshot_stat", {"return_value": None}),
                                     (mt, "earshot_beacons", {"return_value": []})):
                st.enter_context(unittest.mock.patch.object(target, name, **kw))
            hops, ctx = mt.build(self.KEY)
            return hops, ctx, mt.verdict(hops, ctx)

    def test_a_spoken_follow_up_shows_the_detach_both_replies_and_completes(self):
        rec = {"status": "done", "lane": "batch", "lane_reason": mc_.FOLLOWUP_REASON, "command_id": self.CMD2,
               "followups": [{"n": 1, "command_id": self.CMD2, "state": "spoken"}]}
        hops, ctx, (v, ok) = self._build(self._events(), rec)
        names = [h.name for h in hops]
        self.assertIn("agent:detached", names)
        self.assertIn("followup#1:dispatched", names)
        self.assertIn("followup#1:agent:invocation.done", names)
        self.assertIn("followup#1:replied", names)
        self.assertEqual(ctx["command_id"], self.CMD1)  # the main hops are the quick answer's command
        main = next(h for h in hops if h.name == "fact:replied")
        self.assertIn("QUICK ANSWER", main.detail)
        done = next(h for h in hops if h.name == "agent:invocation.done")
        self.assertIn("detached after 300.2s", done.detail)
        self.assertIn("applied", done.detail)
        self.assertTrue(ok)
        self.assertTrue(v.startswith("COMPLETE (quick answer)"), v)
        self.assertIn("follow-up 1 spoken 179.0s after the quick answer", v)
        self.assertIn("detached at the wall clock", v)

    def test_a_running_follow_up_is_named_in_the_verdict(self):
        rec = {"status": "active", "stage": "await_agent", "lane": "batch", "lane_reason": mc_.FOLLOWUP_REASON,
               "command_id": self.CMD2, "followups": [{"n": 1, "command_id": self.CMD2, "state": "running"}]}
        hops, ctx, (v, ok) = self._build(self._events(followup_replied=False), rec)
        self.assertTrue(v.startswith("COMPLETE (quick answer)"), v)
        self.assertIn("follow-up 1 RUNNING in the background", v)


if __name__ == "__main__":
    unittest.main()

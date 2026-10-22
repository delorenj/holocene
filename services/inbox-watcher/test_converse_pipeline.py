"""The fast in-car conversation desk end to end through the watcher (HOLOC-23), every external hop faked: the fakes of
test_inbox_watcher (mc, bb-emit, gateway journal, Hermes state.db, vox) plus a fake OpenAI-compatible LLM per rung.

A memo is put at the transcribe stage holding the driver's words (as _transcribe_apply leaves it) and ticked to its end.
Run with the rest:
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'
"""
import hashlib
import json
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

from test_converse import SECRET, decision, fake_server
from test_inbox_watcher import (  # noqa: F401 - importing it sets up the fakes and the environment
    EMITS, HERMES, REGISTRY, VOX_TEXTS, MemoHarness, RecordingWriter, facts, hermes_session, iw, journal, mc_,
)

import converse as cv  # noqa: E402

# a second routable agent for the named handoff
if "flume-pm:" not in REGISTRY.read_text():
    REGISTRY.write_text(REGISTRY.read_text() + "  flume-pm:\n    display_name: Flume PM\n    profile_name: flume-pm\n"
                        "    bloodbank: {enabled: true, gateway_scope: fleet, target_agent_id: flume-pm}\n")
(HERMES / "flume-pm").mkdir(parents=True, exist_ok=True)
ROSTER = Path(tempfile.mkdtemp(prefix="roster-")) / "roster.json"
ROSTER.write_text(json.dumps({"agents": [{"id": "holocene-pm", "name": "Holocene"}, {"id": "flume-pm", "name": "Flume"}]}))
DEVICE = "sim-device-0001"

PROPOSE = decision(action="propose", say="I can have the PM look into that.", title="Why the audio spool is disabled",
                   brief={"goal": "Find out why the audio spool is disabled and report back.",
                          "context": ["The driver noticed it in the car."], "done_when": ["The cause is named."]})


class ConverseHarness(MemoHarness):
    @classmethod
    def setUpClass(cls):
        cls.hyper, cls.gateway = fake_server(), fake_server()

    @classmethod
    def tearDownClass(cls):
        cls.hyper.shutdown()
        cls.gateway.shutdown()

    def setUp(self):
        super().setUp()
        for s in (self.hyper, self.gateway):
            s.modes, s.default, s.calls, s.sleep, s.model, s.decision = [], "ok", [], 2.0, None, decision()
        self.routes = [
            {"id": "r1", "base_url": f"http://127.0.0.1:{self.hyper.server_port}/v1", "key_ref": "op://DeLoSecrets/hyper/credential",
             "model": "deepseek-v4.1-flash-1017", "timeout_s": 3},
            {"id": "r3a", "base_url": f"http://127.0.0.1:{self.gateway.server_port}/v1",
             "key_ref": "op://DeLoSecrets/gw/holocene-converse", "model": "automaticai/personal/kimi-k3s", "timeout_s": 3,
             "temperature": 1, "reasoning_effort": "medium"}]
        self.flag(mode="on", agents="holocene-pm", routes=self.routes)
        self.w.desk.keys = cv.KeyCache(reader=lambda ref: SECRET)
        self.w.desk.cards = cv.CardCache(REGISTRY, HERMES, ROSTER, recall=None)
        self.w.status_writer = RecordingWriter()
        self.sender = {"ok": True, "host": "car", "device": DEVICE}
        p = unittest.mock.patch.object(mc_, "s3_sender", side_effect=lambda key: dict(self.sender))
        p.start()
        self.addCleanup(p.stop)
        self.n = 0

    def flag(self, **kw):
        cv.write_flag(self.state.dir / "converse.json", **kw)

    def llm_calls(self):
        return len(self.hyper.calls) + len(self.gateway.calls)

    def start(self, text, name=None):
        """A memo whose transcript just landed (stage transcribe -> _transcribe_apply), not yet ticked."""
        self.n += 1
        key = self.upload(name or f"conv-{self.id().rsplit('.', 1)[-1][:40]}-{self.n}")
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "next_at": 0.0,
             "status": "active", "stage": "transcribe", "display_name": "Holocene PM", "received_ts": time.time(),
             "detected_ts": time.time(), "uploaded_at": mc_.iso(time.time())}
        with self.w.mu:
            self.state.memos[key] = m
            self.w._transcribe_apply(m, {"text": text, "meta": {"duration_seconds": 4.0}, "took": 0.1, "audio_s": 4.0,
                                         "levels": {}})
        return key, m

    def say(self, text, until=None, name=None):
        before = len(VOX_TEXTS)
        key, m = self.start(text, name)
        self.tick_until(until or (lambda: m["status"] in ("done", "failed") or m["stage"] == "await_agent"))
        self.last_said = " ".join(VOX_TEXTS[before:])  # every chunk of what this turn said, in order
        return key, m

    def sess(self):
        return self.state.data["conversations"].get(cv.session_key(DEVICE, "holocene-pm"))

    def finish_delegation(self, m, reply, profile="holocene-pm"):
        """The delegated agent answers its batch command; the memo runs to done."""
        self.tick_until(lambda: m["stage"] == "await_agent")
        fu = m["followups"][-1]
        before = len(VOX_TEXTS)
        journal(m["command_id"], profile)
        hermes_session(profile, m["memo_id"], reply, prompt=fu["prompt"], ts=time.time())
        self.tick_until(lambda: m["status"] in ("done", "failed"))
        self.last_said = " ".join(VOX_TEXTS[before:])


class FastTurns(ConverseHarness, unittest.TestCase):
    def test_a_reply_turn_publishes_routed_voiced_and_replied_and_no_command(self):
        self.hyper.decision = decision(say="Holocene is finishing the conversation desk; the watcher stage is next.")
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["status"], "done")
        self.assertEqual(self.cmds(key), [])
        self.assertEqual(self.of_type("dispatched", key), [])
        r, = self.of_type("routed", key)
        self.assertEqual((r["action"], r["path"], r["route"], r["model_answered"]),
                         ("reply", "fast", "r1", "deepseek-v4.1-flash-1017"))
        self.assertEqual((r["attempts"], r["cached_tokens"], r["conv_turn"], r["conv_opened"]), (1, 640, 1, True))
        self.assertFalse(cv.forbidden(r["model_answered"]))
        self.assertTrue(self.of_type("voiced", key))
        rep, = self.of_type("replied", key)
        self.assertEqual(rep["conv"]["action"], "reply")
        self.assertEqual(VOX_TEXTS, ["Holocene PM. Holocene is finishing the conversation desk; the watcher stage is next."])
        # the car's status: never an echo of the transcript, a conv block naming this turn's own reply key
        docs = [d for k, d in self.w.status_writer.docs if d["memo_id"] == m["memo_id"]]
        self.assertTrue(any(d["stage"] == "working" for d in docs))
        self.assertTrue(all(d["heard"] is None for d in docs))
        conv = docs[-1]["conv"]
        self.assertEqual((conv["turn"], conv["action"], conv["reply_key"]), (1, "reply", rep["reply_s3_key"]))
        self.assertEqual(conv["sid"], self.sess()["sid"])
        self.assertEqual(set(conv), {"sid", "turn", "action", "draft_title", "reply_key"})

    def test_turn_two_remembers_turn_one_and_drops_the_name(self):
        self.hyper.decision = decision(say="The watcher stage is next.")
        self.say("What's Holocene working on?")
        self.hyper.decision = decision(say="After that, the pad fix.")
        key, m = self.say("And after that?")
        self.assertEqual(self.last_said, "After that, the pad fix.")
        msgs = self.hyper.calls[-1]["body"]["messages"]
        self.assertEqual(msgs[1], {"role": "user", "content": "What's Holocene working on?"})
        self.assertEqual(json.loads(msgs[2]["content"])["say"], "The watcher stage is next.")
        self.assertEqual(m["conv"]["turn"], 2)
        self.assertEqual(len(cv.driver_turns(self.sess())), 2)
        self.assertEqual(self.hyper.calls[0]["body"]["messages"][0], msgs[0])  # the byte-stable prefix

    def test_all_rungs_failing_goes_direct_with_the_echo_restored(self):
        self.hyper.default = self.gateway.default = "500"
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["stage"], "await_agent")
        r, = self.of_type("routed", key)
        self.assertEqual((r["action"], r["path"], r["fallback_reason"]), ("direct", "fallback", "all_routes_failed"))
        self.assertEqual(r["attempts"], 2)
        (t, cmd), = self.cmds(key)
        self.assertEqual(t, "bloodbank.cmd.agent.invocation.invoke")  # today's interactive turn
        self.assertEqual(cmd["data"]["prompt"], iw.VOICE_PREFIX + "What's Holocene working on?")
        self.assertIsNotNone(self.w.status_writer.last()["heard"])

    def test_a_direct_turn_carries_the_conversation_and_its_reply_is_written_back(self):
        self.hyper.decision = decision(say="The watcher stage is next.")
        self.say("What's Holocene working on?")
        calls = self.llm_calls()
        key, m = self.say("Ask Holocene PM directly what's on the board")
        self.assertEqual(self.llm_calls(), calls)  # the lexicon decided: no LLM call
        r, = self.of_type("routed", key)
        self.assertEqual((r["action"], r["path"]), ("direct", "force_direct"))
        (t, cmd), = self.cmds(key)
        self.assertEqual(t, "bloodbank.cmd.agent.invocation.invoke")
        prompt = cmd["data"]["prompt"]
        self.assertEqual(prompt, iw.VOICE_PREFIX + "[Earlier in this car conversation (speech-to-text): Driver: What's Holocene "
                                                   "working on? / Desk: The watcher stage is next.] Ask Holocene PM directly "
                                                   "what's on the board")
        d, = self.of_type("dispatched", key)
        self.assertEqual(d["prompt_sha256"], hashlib.sha256(prompt.encode()).hexdigest())
        self.assertEqual(cmd["data"]["model"], iw.VOICE_MODEL)
        self.assertIsNotNone(self.w.status_writer.last()["heard"])  # a direct turn echoes, as today
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Three tickets are in progress.", prompt=prompt, ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM. Three tickets are in progress.")  # today's agent reply, as today
        turn = cv.driver_turns(self.sess())[-1]
        self.assertEqual(turn["agent_reply"], "Three tickets are in progress.")

    def test_the_kill_switch_file_sends_the_next_memo_down_todays_path_with_no_llm_call(self):
        self.flag(mode="off")
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(self.llm_calls(), 0)
        self.assertEqual(self.of_type("routed", key), [])
        self.assertNotIn("conv", m)
        (t, cmd), = self.cmds(key)
        self.assertEqual(cmd["data"]["prompt"], iw.VOICE_PREFIX + "What's Holocene working on?")
        # and an agent not on the list, or a browser memo, is today's path too
        self.flag(mode="on", agents="flume-pm")
        key, m = self.say("What's Holocene working on?")
        self.assertEqual((self.llm_calls(), len(self.cmds(key))), (0, 1))
        self.flag(mode="on", agents="*")
        self.sender = {"ok": True, "host": "browser", "device": DEVICE}
        key, m = self.say("What's Holocene working on?")
        self.assertEqual((self.llm_calls(), len(self.cmds(key))), (0, 1))

    def test_shadow_mode_leaves_the_memo_on_todays_path_and_only_logs(self):
        self.flag(mode="shadow")
        logs = []
        real = iw.log
        with unittest.mock.patch.object(iw, "log", side_effect=lambda ev, *a, **k: (logs.append(ev), real(ev, *a, **k))):
            key, m = self.say("What's Holocene working on?")
            t0 = time.time()
            while "converse_shadow" not in logs and time.time() - t0 < 5:
                time.sleep(0.05)
        self.assertIn("converse_shadow", logs)
        self.assertEqual(self.llm_calls(), 1)
        self.assertNotIn("conv", m)
        self.assertEqual(self.of_type("routed", key), [])
        (t, cmd), = self.cmds(key)
        self.assertEqual(t, "bloodbank.cmd.agent.invocation.invoke")
        self.assertEqual(cmd["data"]["prompt"], iw.VOICE_PREFIX + "What's Holocene working on?")
        self.assertIsNotNone(self.w.status_writer.last()["heard"])
        self.assertEqual(self.state.data["conversations"], {})

    def test_a_cancel_during_converse_speaks_nothing_and_records_no_turn(self):
        self.hyper.modes, self.hyper.sleep = ["timeout"], 0.8  # slow, but inside the rung's 3 s
        key, m = self.start("What's Holocene working on?")
        self.w.tick(discover=False)
        t0 = time.time()
        while not self.hyper.calls and time.time() - t0 < 5:
            time.sleep(0.02)
        with self.w.mu:
            self.w.cancel_memo(m)
        t0 = time.time()
        while m["key"] in self.w.running and time.time() - t0 < 5:
            time.sleep(0.05)
        self.ticks(4)
        self.assertEqual(m["status"], "cancelled")
        self.assertEqual(VOX_TEXTS, [])
        self.assertEqual(self.of_type("routed", key), [])
        self.assertEqual(self.cmds(key), [])
        self.assertIsNone(self.sess())

    def test_a_restart_at_converse_reuses_the_stored_decision(self):
        self.hyper.decision = decision(say="The watcher stage is next.")
        real = self.w._converse_apply
        boom = {"n": 0}

        def stop_once(*a, **k):
            if not boom["n"]:
                boom["n"] += 1
                raise iw.WatcherStopping()  # the service stopped right after the LLM answered
            return real(*a, **k)
        with unittest.mock.patch.object(self.w, "_converse_apply", side_effect=stop_once):
            key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["status"], "done")
        self.assertEqual(self.llm_calls(), 1)
        self.assertEqual(len(cv.driver_turns(self.sess())), 1)
        self.assertTrue(json.loads((self.state.dir / "state.json").read_text())["memos"][key]["conv_raw"])

    def test_a_failed_contract_check_keeps_routed_out_of_the_bus_and_the_outbox(self):
        self.w.contract_ok["routed"] = False
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["status"], "done")
        self.assertEqual(self.of_type("routed", key), [])
        self.assertEqual(self.state.data["outbox"], [])

    def test_the_heartbeat_reports_the_desk(self):
        self.w.desk.warm_keys()
        self.w.tick(discover=False)
        hb = json.loads((self.state.dir / "heartbeat.json").read_text())["converse"]
        self.assertEqual((hb["mode"], hb["source"], hb["key_status"]), ("on", "flag", "ok"))
        self.assertEqual([r["id"] for r in hb["routes"]], ["r1", "r3a"])
        self.assertNotIn(SECRET, json.dumps(hb))


class FastSpeech(ConverseHarness, unittest.TestCase):
    def test_a_fast_turn_starts_with_a_short_chunk_at_six_steps(self):
        say = ("The watcher stage is next. After it comes the pad fix, then the voice view, and then the live pilot on the "
               "Honda simulator with the overlap audit, which has to print zero overlaps on every check.")
        self.assertGreater(len(say), 180)
        self.hyper.decision = decision(say=say)
        seen = []
        real = iw.synthesize

        def spy(text, tmp, **kw):
            seen.append((text, kw))
            return real(text, tmp, **kw)
        with unittest.mock.patch.object(iw, "synthesize", side_effect=spy):
            key, m = self.say("What's next?")
        chunks = [t for t, kw in seen if "steps" in kw]
        self.assertGreater(len(chunks), 1)
        self.assertLessEqual(len(chunks[0]), 70)
        self.assertTrue(all(kw == {"steps": 6, "prio": iw.TtsGate.FAST} for _, kw in seen))
        # an ordinary memo's render is unchanged
        self.flag(mode="off")
        seen.clear()
        with unittest.mock.patch.object(iw, "synthesize", side_effect=spy):
            key, m = self.say("Summarize recent work.")
            journal(m["command_id"], "holocene-pm")
            hermes_session("holocene-pm", m["memo_id"], "Quick answer.", ts=time.time())
            self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(seen[-1], ("Holocene PM. Quick answer.", {}))

    def test_the_tts_gate_lets_a_fast_turn_in_between_chunks(self):
        gate, order = iw.TtsGate(), []

        def followup():
            for i in (1, 2, 3):
                with gate.hold(gate.REPLY):
                    order.append(f"followup{i}")
                    time.sleep(0.25)

        def fast():
            time.sleep(0.08)
            with gate.hold(gate.FAST):
                order.append("fast")
        a, b = threading.Thread(target=followup), threading.Thread(target=fast)
        a.start(), b.start()
        a.join(5), b.join(5)
        self.assertEqual(order, ["followup1", "fast", "followup2", "followup3"])


class Delegation(ConverseHarness, unittest.TestCase):
    def propose(self, text="Have the PM look into why the audio spool is disabled and report back", dec=PROPOSE):
        self.hyper.decision = dec
        key, m = self.say(text)
        self.assertEqual(self.cmds(key), [])
        return key, m

    def test_propose_then_send_it_sends_exactly_one_batch_command_and_speaks_the_result(self):
        key1, m1 = self.propose()
        self.assertEqual(self.last_said, "Draft for Holocene PM: Why the audio spool is disabled. Read-only. "
                                        "Say send it, or tell me what to change.")
        r1, = self.of_type("routed", key1)
        self.assertEqual((r1["action"], r1["title"], r1["perm"]), ("propose", "Why the audio spool is disabled", "read_only"))
        draft = self.sess()["pending"]
        calls = self.llm_calls()
        key2, m2 = self.say("Send it.")
        self.assertEqual(self.llm_calls(), calls)  # confirm-only: no LLM call
        r2, = self.of_type("routed", key2)
        self.assertEqual((r2["action"], r2["path"], r2["delegate_to"]), ("confirm", "confirm_only", "holocene-pm"))
        self.assertEqual(self.last_said, "Sending to Holocene PM: Why the audio spool is disabled. I'll call you back.")
        self.assertEqual(m2["stage"], "await_agent")
        (t, cmd), = self.cmds(key2)
        self.assertEqual(t, "bloodbank.cmd.agent.invocation.start")  # the batch lane
        cid = cv.command_id_for(draft["brief_id"])
        self.assertEqual(cmd["argv"][cmd["argv"].index("--command-id") + 1], cid)
        self.assertEqual(cmd["data"]["target_agent_id"], "holocene-pm")
        prompt = cmd["data"]["prompt"]
        self.assertTrue(prompt.startswith(cv.DELEGATE_PREFIX))
        self.assertIn(draft["body"], prompt)
        self.assertIn('"Have the PM look into why the audio spool is disabled and report back"', prompt)
        self.assertIn('"Send it."', prompt)
        self.assertEqual(cmd["data"]["model"], iw.VOICE_MODEL)  # the voice model, never the profile's default (automaticai/auto holds Claude routes)
        self.assertFalse(cv.forbidden(cmd["data"]["model"]))
        self.assertEqual(cmd["data"]["context"]["reason"], "voice-delegation")
        d, = self.of_type("dispatched", key2)
        self.assertEqual((d["followup"], d["lane"], d["lane_reason"]), (1, "batch", "voice_delegation"))
        self.assertEqual(d["prompt_sha256"], hashlib.sha256(prompt.encode()).hexdigest())
        dl, = self.of_type("delegated", key2)
        self.assertEqual((dl["target_agent_id"], dl["tile_agent_id"], dl["command_id"], dl["brief_id"], dl["perm"], dl["lane"]),
                         ("holocene-pm", "holocene-pm", cid, draft["brief_id"], "read_only", "batch"))
        self.assertEqual(dl["brief_sha256"], draft["brief_sha256"])
        self.assertIsNone(self.sess()["pending"])
        self.finish_delegation(m2, "The spool is off because the spool flag is unset in the unit. Setting it fixes it.")
        self.assertEqual(self.last_said, "Holocene PM, follow-up on Why the audio spool is disabled. The spool is off because "
                                        "the spool flag is unset in the unit. Setting it fixes it.")
        sess = self.sess()
        self.assertEqual(sess["delegations"][-1]["state"], "done")
        self.assertIn("the spool flag is unset", sess["delegations"][-1]["result"])
        self.assertTrue(any(t.get("kind") == "result" and "the spool flag" in t["say"] for t in sess["turns"]))
        # a second "send it" is refused and publishes nothing
        key3, m3 = self.say("Send it.")
        self.assertTrue(self.last_said.startswith("Already sent to Holocene PM: Why the audio spool is disabled."))
        self.assertEqual(self.cmds(key3), [])
        self.assertEqual(len([1 for t, r in facts() if t.startswith("bloodbank.cmd.")]), 1)
        # and the board answers "what did it find?" from the result, with no agent turn
        self.hyper.decision = decision(say="It found the spool flag unset in the unit.")
        key4, m4 = self.say("What did it find?")
        self.assertIn("the spool flag is unset", self.hyper.calls[-1]["body"]["messages"][-1]["content"])
        self.assertEqual(self.cmds(key4), [])

    def test_a_named_handoff_goes_to_that_agent_and_its_result_is_named(self):
        dec = {**PROPOSE, "target": "flume-pm"}
        self.propose("Have Flume PM look into why the audio spool is disabled", dec=dec)
        self.assertTrue(self.last_said.startswith("Draft for Flume PM: Why the audio spool is disabled."))
        key, m = self.say("Send it.")
        (t, cmd), = self.cmds(key)
        self.assertEqual(cmd["data"]["target_agent_id"], "flume-pm")
        d, = self.of_type("dispatched", key)
        self.assertEqual((d["target_agent_id"], d["tile_agent_id"]), ("flume-pm", "holocene-pm"))
        self.finish_delegation(m, "Nothing is wrong on the Flume side.", profile="flume-pm")
        self.assertEqual(self.last_said, "Flume PM, follow-up on Why the audio spool is disabled. Nothing is wrong on the Flume side.")

    def test_an_unnamed_handoff_stays_with_the_tile(self):
        self.propose("Send that to the other agent instead", dec={**PROPOSE, "target": "flume-pm"})
        self.assertTrue(self.last_said.startswith("Draft for Holocene PM: "))
        self.assertEqual(self.sess()["pending"]["target"], "holocene-pm")
        r, = [x for x in self.of_type("routed", self.keys[-1])]
        self.assertIn("handoff_not_named", r["guard"])

    def test_follow_up_max_zero_still_delegates(self):
        with unittest.mock.patch.object(iw, "FOLLOWUP_MAX", 0):
            self.propose()
            key, m = self.say("Send it.")
            self.assertEqual(len(self.cmds(key)), 1)

    def test_a_delegated_agent_that_only_hands_off_again_is_spoken_as_not_finished(self):
        self.propose()
        key, m = self.say("Send it.")
        self.finish_delegation(m, "BACKGROUND: do the rest later")
        self.assertEqual(self.last_said, "Holocene PM, follow-up on Why the audio spool is disabled. The background work did not "
                                        "finish: it tried to hand the work off again instead of doing it.")
        self.assertEqual(len(self.cmds(key)), 1)
        self.assertEqual(self.sess()["delegations"][-1]["state"], "failed")

    def test_vox_down_on_the_read_back_restores_the_draft(self):
        self.propose()
        real = iw.synthesize

        def no_sending(text, tmp, **kw):
            if text.startswith("Sending to"):
                raise iw.StageError("tts", "vox_failed", "vox synth failed: connection refused")
            return real(text, tmp, **kw)
        with unittest.mock.patch.object(iw, "synthesize", side_effect=no_sending):
            key, m = self.say("Send it.")
        self.assertEqual(m["status"], "failed")
        self.assertEqual(self.cmds(key), [])
        sess = self.sess()
        self.assertEqual(sess["pending"]["state"], "proposed")
        self.assertEqual(sess["delegations"][-1]["state"], "not_sent")
        key2, m2 = self.say("Send it.")  # vox is back: the same draft goes, once
        self.assertEqual(len(self.cmds(key2)), 1)

    def test_yes_but_change_it_reads_back_again_and_sends_nothing(self):
        self.propose()
        self.hyper.decision = {**PROPOSE, "perm": "changes_ok"}
        key, m = self.say("Yes but let it change the code")
        self.assertEqual(self.cmds(key), [])
        self.assertEqual(self.last_said, "Draft for Holocene PM: Why the audio spool is disabled. Code changes OK, no deploy. "
                                        "Say send it, or tell me what to change.")

    def test_a_draft_expires_unsent(self):
        self.propose()
        with self.w.mu:
            self.sess()["pending"]["at"] -= 700
            self.w.last_conv_sweep = 0.0
            self.w.converse_sweep()
        self.assertIsNone(self.sess()["pending"])
        key, m = self.say("Send it.")  # nothing waits: the model is asked, nothing is sent
        self.assertEqual(self.cmds(key), [])


class TraceFastTurns(unittest.TestCase):
    """memo:trace for a desk turn: the routed hop stands where dispatch and the agent turn would be; a delegation is
    follow-up 1, named with its target; the timing line starts with transcribed | routed."""
    KEY = "inbox/holocene-pm/2026/10/22/fast.ogg"
    CMD = "22222222-2222-5222-8222-222222222222"

    def events(self, delegated=False):
        mid = mc_.memo_id_for(self.KEY)

        def ev(typ, at, **data):
            return {"type": f"bloodbank.{typ}", "time": at, "data": {"memo_id": mid, "occurred_at": at, **data}}
        routed = dict(conv_id="c0ffee00-1111-4222-8333-444455556666", conv_turn=2, action="confirm" if delegated else "reply",
                      model_answered=None if delegated else "deepseek-v4.1-flash-1017", route=None if delegated else "r1",
                      attempts=0 if delegated else 2, latency_ms=None if delegated else 812,
                      usage=None if delegated else {"prompt_tokens": 900, "completion_tokens": 40},
                      cached_tokens=None if delegated else 640, path="confirm_only" if delegated else "fast",
                      lexicon=delegated, title="Spool check" if delegated else None,
                      delegate_to="flume-pm" if delegated else None,
                      attempt_log=None if delegated else [{"route": "r1", "outcome": "timeout"}, {"route": "r3a", "outcome": "ok"}])
        out = [ev("audio.memo.received", "2026-10-22T02:00:00.500Z", detect_lag_ms=5),
               ev("audio.memo.transcribed", "2026-10-22T02:00:01.500Z", transcript_chars=20, processing_seconds=0.5, model="m",
                  transcript_text="hi"),
               ev("audio.memo.routed", "2026-10-22T02:00:02.400Z", **routed),
               ev("audio.memo.voiced", "2026-10-22T02:00:04.400Z", chunk=1, chunks=1, reply_s3_key="replies/x.ogg",
                  chunk_s3_key="replies/x.ogg", command_id=None),
               ev("audio.memo.replied", "2026-10-22T02:00:05.000Z", reply_chars=40, tts_seconds=1.9, tts_engine="fakevox",
                  reply_s3_key="replies/x.ogg", command_id=None)]
        if delegated:
            out += [ev("audio.memo.dispatched", "2026-10-22T02:00:06.000Z", command_id=self.CMD, command_subject="x",
                       lane="batch", lane_reason="voice_delegation", followup=1, delegated_to="flume-pm",
                       target_agent_id="flume-pm", brief_title="Spool check", brief_id="b" * 8, perm="read_only",
                       conv_id="c0ffee00")]
        return out

    def build(self, events, rec):
        import contextlib
        import memo_trace as mt
        lm = lambda k: {"size": 9, "last_modified": mc_.parse_iso("2026-10-22T02:00:00Z" if k == self.KEY else "2026-10-22T02:00:04Z")}  # noqa: E731
        with contextlib.ExitStack() as st:
            for target, name, kw in ((mt.c, "candystore_events", {"return_value": events}), (mt.c, "s3_stat", {"side_effect": lm}),
                                     (mt.c, "journal_row", {"return_value": None}),
                                     (mt.c, "gateway_liveness", {"return_value": {"ok": True, "lane": "batch"}}),
                                     (mt.c, "gateway_log_lines", {"return_value": []}),
                                     (mt, "upload_log_line", {"return_value": (None, None)}),
                                     (mt, "watcher_record", {"return_value": rec}),
                                     (mt, "watcher_heartbeat", {"return_value": {"age_s": 1.0}}),
                                     (mt, "watcher_unit_active", {"return_value": "active"}),
                                     (mt, "earshot_stat", {"return_value": None}),
                                     (mt, "earshot_beacons", {"return_value": []})):
                st.enter_context(unittest.mock.patch.object(target, name, **kw))
            hops, ctx = mt.build(self.KEY)
            return hops, ctx, mt.verdict(hops, ctx), mt.timing_line(ctx, hops)

    def test_a_fast_reply_turn_completes_on_the_routed_hop(self):
        hops, ctx, (v, ok), timing = self.build(self.events(), {"status": "done"})
        names = [h.name for h in hops]
        self.assertIn("fast:routed", names)
        self.assertNotIn("fact:dispatched", names)
        self.assertNotIn("gateway_journal", names)
        routed = next(h for h in hops if h.name == "fast:routed")
        self.assertIn("reply deepseek-v4.1-flash-1017@r1 (2 attempts, 812 ms, 900 in / 40 out, 640 cached)", routed.detail)
        self.assertIn("failed: r1 timeout", routed.detail)
        self.assertTrue(ok, v)
        self.assertTrue(v.startswith("COMPLETE in"), v)
        self.assertTrue(timing.startswith("since upload (server clock): transcribed +1.5s | routed +2.4s"), timing)

    def test_a_delegation_shows_as_follow_up_one_with_its_target(self):
        rec = {"status": "active", "stage": "await_agent", "command_id": self.CMD, "lane": "batch",
               "lane_reason": "voice_delegation", "followups": [{"n": 1, "kind": "delegation", "command_id": self.CMD,
                                                                 "state": "running", "target": "flume-pm"}]}
        hops, ctx, (v, ok), timing = self.build(self.events(delegated=True), rec)
        disp = next(h for h in hops if h.name == "followup#1:dispatched")
        self.assertIn("DELEGATED to flume-pm: 'Spool check'", disp.detail)
        routed = next(h for h in hops if h.name == "fast:routed")
        self.assertIn("by the lexicon (confirm_only, no LLM call)", routed.detail)
        self.assertTrue(ok, v)
        self.assertTrue(v.startswith("COMPLETE (read-back)"), v)
        self.assertIn("delegated to flume-pm: follow-up 1 RUNNING in the background", v)


if __name__ == "__main__":
    unittest.main()

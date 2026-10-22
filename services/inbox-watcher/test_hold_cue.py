"""The hold cue (HOLOC-23): a very short spoken line when the desk's decision is slow, a second one later, and a keep-alive line
for a turn the desk handed to the full agent, so the driver never sits in a long silence between the stop tone and the answer.
Every external hop is faked (test_converse_pipeline's harness: fake LLM rungs, vox, mc, bb-emit).
Run with the rest:
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_*.py'
"""
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

from test_converse import decision
from test_converse_pipeline import DEVICE, ConverseHarness
from test_inbox_watcher import BUCKET_DIR, VOX_TEXTS, VOX_VOICES, facts, iw, mc_, progress_fact  # noqa: F401

import converse as cv  # noqa: E402

CUES = set(cv.HOLD_CUE_LINES)
CUES2 = set(cv.HOLD_CUE2_LINES)


class HoldHarness(ConverseHarness):
    def setUp(self):
        super().setUp()
        self.logs = []
        real = iw.log

        def spy(event, *a, **kw):
            self.logs.append((event, kw))
            return real(event, *a, **kw)
        for p in (unittest.mock.patch.object(iw, "log", side_effect=spy),
                  unittest.mock.patch.object(iw, "HOLD_CUE_S", 0.4),
                  unittest.mock.patch.object(iw, "HOLD_CUE2_S", 1.0),
                  unittest.mock.patch.object(iw, "HOLD_MAX_CLIP_S", 60.0),   # the fake vox's clip is 9 s long
                  unittest.mock.patch.object(mc_, "progress_events", side_effect=lambda mid, limit=200: list(self.events))):
            p.start()
            self.addCleanup(p.stop)
        self.events = []
        self.hyper.decision = decision(say="The watcher stage is next.")

    def slow(self, secs):
        """Every rung answers (ok) after `secs`; the route timeout is longer."""
        for srv in (self.hyper, self.gateway):
            srv.default, srv.sleep = "timeout", secs

    def fall_through(self, secs=2.0):
        """Every rung times out: the desk goes direct after ~2 x timeout."""
        for r in self.routes:
            r["timeout_s"] = 0.7
        self.flag(mode="on", agents="holocene-pm", routes=self.routes)
        self.slow(secs)

    def wait_for(self, pred, what, timeout=6.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if pred():
                return
            time.sleep(0.03)
        self.fail(f"never happened: {what}")

    def holds(self, key):
        return [d for d in self.of_type("narrated", key) if str(d.get("kind") or "").startswith("hold_")]

    def dropped(self):
        return [kw for ev, kw in self.logs if ev == "hold_cue_dropped"]


class DeskWait(HoldHarness, unittest.TestCase):
    def test_a_slow_desk_gets_a_cue_at_the_first_mark_and_a_second_one_later_then_the_answer(self):
        self.slow(1.5)
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["status"], "done")
        self.wait_for(lambda: len(self.holds(key)) == 2, "two cues")
        c1, c2 = sorted(self.holds(key), key=lambda d: d["narration"])
        self.assertEqual((c1["kind"], c1["narration"], c2["kind"], c2["narration"]), ("hold_cue", 1, "hold_cue2", 2))
        self.assertIn(c1["spoken_text"], CUES)
        self.assertIn(c2["spoken_text"], CUES2)
        self.assertNotEqual(c1["spoken_text"], c2["spoken_text"])
        # a hold clip is its own key shape: an older pad never matches it
        mid = m["memo_id"]
        self.assertEqual(c1["progress_s3_key"], f"progress/2026/10/19/{mid}-1h.ogg")
        self.assertEqual(c2["progress_s3_key"], f"progress/2026/10/19/{mid}-2h.ogg")
        self.assertTrue((BUCKET_DIR / c1["progress_s3_key"]).exists())
        self.assertIsNone(c1["command_id"])                       # the desk is still deciding: no command yet
        self.assertGreaterEqual(c1["elapsed_seconds"], 0.35)       # not before the first mark
        self.assertLess(c1["elapsed_seconds"], 0.9)
        self.assertGreaterEqual(c2["elapsed_seconds"], 0.95)
        # the cues were said in the tile voice's render and the answer after them
        self.assertEqual(VOX_TEXTS[-1] if VOX_TEXTS else None, "Holocene PM. The watcher stage is next.")
        cue_ix = [VOX_TEXTS.index(c1["spoken_text"]), VOX_TEXTS.index(c2["spoken_text"])]
        self.assertLess(max(cue_ix), len(VOX_TEXTS) - 1)
        # the pad's cursor sees them, and the schema-bearing keys are all there
        doc = [d for k, d in self.w.status_writer.docs if d["memo_id"] == mid][-1]
        self.assertGreaterEqual(doc["spoken_seq"], 2)
        for c in (c1, c2):
            self.assertTrue(c["progress_s3_key"] and c["seq"] >= 1 and c["target_agent_id"] == "holocene-pm")
        # the status object's narration block names the hold clip with its own text and kind, never the previous real line
        self.assertEqual((doc["narration"]["kind"], doc["narration"]["text"], doc["narration"]["seq"]),
                         ("hold_cue2", c2["spoken_text"], None))

    def test_a_desk_that_answers_before_the_first_mark_says_nothing(self):
        with unittest.mock.patch.object(iw, "HOLD_CUE_S", 1.5), unittest.mock.patch.object(iw, "HOLD_CUE2_S", 3.0):
            self.slow(0.2)
            key, m = self.say("What's Holocene working on?")
            self.assertEqual(m["status"], "done")
            time.sleep(0.3)
        self.assertEqual(self.holds(key), [])
        self.assertEqual(self.dropped(), [])
        self.assertEqual(len(VOX_TEXTS), 1)    # only the answer

    def test_the_second_cue_is_not_said_when_the_answer_came_between(self):
        with unittest.mock.patch.object(iw, "HOLD_CUE_S", 0.3), unittest.mock.patch.object(iw, "HOLD_CUE2_S", 5.0):
            self.slow(0.8)
            key, m = self.say("What's Holocene working on?")
            self.wait_for(lambda: len(self.holds(key)) == 1, "the first cue")
            time.sleep(0.2)
        (c1,) = self.holds(key)
        self.assertEqual(c1["kind"], "hold_cue")

    def test_a_cue_not_yet_up_when_the_answer_is_ready_is_dropped_never_uploaded(self):
        slow_voice = self.w._tile_voice

        def slow_tile_voice(*a, **kw):   # the cue is mid-render when the desk's decision lands
            time.sleep(0.9)
            return slow_voice(*a, **kw)
        self.slow(0.6)
        with unittest.mock.patch.object(self.w, "_tile_voice", side_effect=slow_tile_voice), \
                unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0):
            key, m = self.say("What's Holocene working on?")
            self.wait_for(lambda: bool(self.dropped()), "the drop")
        self.assertEqual(self.holds(key), [])
        mid = m["memo_id"]
        self.assertFalse(list((BUCKET_DIR / "progress").rglob(f"{mid}-*")) if (BUCKET_DIR / "progress").exists() else False)
        self.assertEqual(self.dropped()[0]["reason"], "answer_ready")
        self.assertEqual(self.dropped()[0]["stage"], "rendered")   # rendered, then found stale before the upload

    def test_hold_cues_off_with_zero(self):
        with unittest.mock.patch.object(iw, "HOLD_CUE_S", 0):
            self.slow(1.2)
            key, m = self.say("What's Holocene working on?")
            time.sleep(0.2)
        self.assertEqual(self.holds(key), [])
        self.assertEqual(len(VOX_TEXTS), 1)

    def test_the_cue_speaks_in_the_tiles_voice_and_falls_back_to_the_default_when_vox_lacks_it(self):
        self.flag(mode="on", agents="holocene-pm", routes=self.routes, tiles={"holocene-pm": {"voice": "walken"}})
        self.slow(1.0)
        with unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0):
            key, m = self.say("What's Holocene working on?")
            self.wait_for(lambda: len(self.holds(key)) == 1, "the cue")
        (c1,) = self.holds(key)
        self.assertEqual(c1["voice"], "walken")
        self.assertEqual(VOX_VOICES[VOX_TEXTS.index(c1["spoken_text"])], "walken")
        # a tile voice vox does not know: the default voice, at once
        VOX_TEXTS.clear(); VOX_VOICES.clear()
        self.flag(mode="on", agents="holocene-pm", routes=self.routes, tiles={"holocene-pm": {"voice": "nosuchvoice"}})
        with unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0):
            key, m = self.say("What is the board doing?")
            self.wait_for(lambda: len(self.holds(key)) == 1, "the fallback cue")
        (c1,) = self.holds(key)
        self.assertEqual(c1["voice"], iw.VOICE)
        self.assertIn(c1["spoken_text"], VOX_TEXTS)

    def test_the_phrasebank_serves_the_cue_from_disk_after_its_first_render(self):
        self.w.phrases = iw.PhraseBank(Path(tempfile.mkdtemp(prefix="pb-hold-")), enabled=True)
        with unittest.mock.patch.object(cv, "HOLD_CUE_LINES", ("One sec.",)), unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0):
            self.slow(1.0)
            for _ in range(2):
                key, m = self.say("What's Holocene working on?")
                self.wait_for(lambda: len(self.holds(key)) == 1, "the cue")
        self.assertEqual(VOX_TEXTS.count("One sec."), 1)          # rendered once, then a file copy
        self.assertEqual(self.holds(key)[0]["tts_engine"], "phrasebank")

    def test_never_the_same_line_twice_in_a_row(self):
        seen = []
        for i in range(60):
            seen.append(self.w.hold_line("holocene-pm", cv.HOLD_CUE_LINES if i % 2 == 0 else cv.HOLD_CUE2_LINES))
        self.assertTrue(all(a != b for a, b in zip(seen, seen[1:])))
        self.assertGreater(len(set(seen)), 3)                      # it does vary
        self.assertEqual(cv.pick_hold_line(("Only.",), "Only."), "Only.")

    def test_every_cue_line_is_short_and_in_the_phrasebank(self):
        bank = iw.fixed_lines()
        for line in (*cv.HOLD_CUE_LINES, *cv.HOLD_CUE2_LINES):
            self.assertIn(line, bank)
            self.assertLessEqual(len(line), 24)                   # well under a second of speech

    def test_a_cue_whose_render_is_longer_than_the_cap_is_dropped_and_the_line_not_used_again(self):
        with unittest.mock.patch.object(mc_, "probe_audio", return_value={"ok": True, "duration": 2.0, "error": None}), \
                unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0), unittest.mock.patch.object(cv, "HOLD_CUE_LINES", ("One sec.",)), \
                unittest.mock.patch.object(iw, "HOLD_MAX_CLIP_S", 1.2):
            self.slow(1.0)
            key, m = self.say("What's Holocene working on?")
            self.wait_for(lambda: bool(self.dropped()), "the drop")
        self.assertEqual(self.holds(key), [])
        d = self.dropped()[0]
        self.assertEqual((d["reason"], d["text"], d["max_s"]), ("too_long", "One sec.", 1.2))
        self.assertFalse(list((BUCKET_DIR / "progress").rglob(f"{m['memo_id']}-*")) if (BUCKET_DIR / "progress").exists() else False)
        self.assertIsNone(self.w.hold_line("holocene-pm", ("One sec.",)))      # excluded from now on
        self.assertEqual(self.w.hold_line("holocene-pm", ("One sec.", "Hold on.")), "Hold on.")

    def test_every_shipped_cue_line_fits_the_duration_cap_in_the_banked_renders_we_know(self):
        # the cap is enforced on the real clip at run time; here the line set itself stays short and few-worded
        for line in (*cv.HOLD_CUE_LINES, *cv.HOLD_CUE2_LINES):
            self.assertLessEqual(len(line.split()), 3, line)

    def test_a_cue_uploaded_just_before_the_answer_is_removed_from_the_bucket(self):
        key, m = self.say("What's Holocene working on?")
        answers = iter([None, "answer_ready"])         # fresh at the render check, stale at the post-upload check
        with self.w.mu:
            self.w.narrating.add(m["key"])
        self.w._hold_run(m, 77, "One sec.", "hold_cue", lambda mm: next(answers), since=time.time(), cid=None)
        d = [kw for ev, kw in self.logs if ev == "hold_cue_dropped" and kw.get("stage") == "uploaded"]
        self.assertEqual(len(d), 1)
        self.assertTrue(d[0]["removed"])
        self.assertFalse((BUCKET_DIR / d[0]["progress_key"]).exists())
        self.assertEqual(self.holds(key), [])
        self.assertNotEqual(m.get("narr_count"), 77)

    def test_hold_cues_do_not_count_toward_the_narration_limit(self):
        key, m = self.say("What's Holocene working on?")
        m.update(stage="await_agent", status="active", progress_text="x", progress_cmd="c", progress_seq=1,
                 dispatched_ts=time.time() - 100, narr_cmd=None, narr_src_seq=None, narr_last_ts=0)
        m.update(narr_count=iw.NARRATE_MAX, hold_count=2)
        self.assertNotEqual(self.w.narration_due(m), "max_reached")
        m.update(hold_count=0)
        self.assertEqual(self.w.narration_due(m), "max_reached")

    def test_a_voice_that_is_not_banked_is_rendered_during_the_wait_not_at_the_mark(self):
        self.w.phrases = iw.PhraseBank(Path(tempfile.mkdtemp(prefix="pb-prime-")), enabled=True)
        self.flag(mode="on", agents="holocene-pm", routes=self.routes, tiles={"holocene-pm": {"voice": "walken"}})
        with unittest.mock.patch.object(cv, "HOLD_CUE_LINES", ("One sec.",)), unittest.mock.patch.object(iw, "HOLD_CUE2_S", 0), \
                unittest.mock.patch.object(iw, "HOLD_CUE_S", 0.8):
            self.slow(1.4)
            key, m = self.say("What's Holocene working on?")
            self.wait_for(lambda: len(self.holds(key)) == 1, "the cue")
        (c1,) = self.holds(key)
        self.assertEqual(c1["tts_engine"], "phrasebank")        # primed during the wait: a file copy at the mark
        self.assertEqual(VOX_TEXTS.count("One sec."), 1)

    def test_a_cancelled_memo_gets_no_cue(self):
        self.slow(1.5)
        key, m = self.start("What's Holocene working on?")
        for _ in range(3):
            self.w.tick(discover=False)
        with self.w.mu:
            self.w.cancel_memo(m)
        time.sleep(1.0)
        self.assertEqual(self.holds(key), [])

    def test_the_kill_switch_means_no_desk_call_and_so_no_cue(self):
        self.flag(mode="off")
        self.slow(1.2)
        key, m = self.say("What's Holocene working on?")
        time.sleep(0.2)
        self.assertEqual((self.holds(key), self.llm_calls()), ([], 0))


class FallThrough(HoldHarness, unittest.TestCase):
    def go(self):
        self.fall_through()
        key, m = self.say("What's Holocene working on?")
        self.assertEqual(m["stage"], "await_agent")
        self.assertEqual(m["conv"]["action"], "direct")
        self.wait_for(lambda: len(self.holds(key)) >= 2, "the desk-wait cues")
        return key, m

    def poll(self):
        self.w.poll_progress()
        self.wait_narration()

    def wait_narration(self, timeout=5.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self.w.mu:
                if not self.w.narrating:
                    return
            time.sleep(0.02)
        self.fail("a hold render never finished")

    def test_a_turn_the_desk_handed_to_the_agent_gets_a_keepalive_when_it_has_been_quiet(self):
        key, m = self.go()
        before = len(self.holds(key))
        self.poll()
        self.assertEqual(len(self.holds(key)), before)            # just dispatched: inside the first window
        m["dispatched_ts"] = time.time() - (iw.HOLD_FALL_FIRST_S + 1)
        self.poll()
        ka = [d for d in self.holds(key) if d["kind"] == "hold_keepalive"]
        self.assertEqual(len(ka), 1)
        self.assertEqual(ka[0]["command_id"], m["command_id"])
        self.assertIn(ka[0]["spoken_text"], CUES2)
        self.assertEqual(ka[0]["narration"], before + 1)           # the clip numbers continue: no clip is overwritten
        self.assertRegex(ka[0]["progress_s3_key"], rf"-{before + 1}h\.ogg$")
        self.poll()
        self.assertEqual(len([d for d in self.holds(key) if d["kind"] == "hold_keepalive"]), 1)   # not again inside the gap
        # the gap passes: the next one; at most HOLD_FALL_MAX in all
        for i in range(iw.HOLD_FALL_MAX + 2):
            m["hold_ka"]["last"] = time.time() - iw.HOLD_FALL_GAP_S - 1
            self.poll()
        ka = [d for d in self.holds(key) if d["kind"] == "hold_keepalive"]
        self.assertEqual(len(ka), iw.HOLD_FALL_MAX)
        lines = [d["spoken_text"] for d in sorted(ka, key=lambda d: d["narration"])]
        self.assertTrue(all(a != b for a, b in zip(lines, lines[1:])))

    def test_the_gap_between_the_last_spoken_thing_and_the_next_never_passes_the_bound(self):
        key, m = self.go()
        # with the keep-alive every HOLD_FALL_GAP_S after HOLD_FALL_FIRST_S, no stretch of the dispatched turn is quiet longer
        # than the larger of the two (plus the narration's own timing when the agent talks)
        self.assertLessEqual(max(iw.HOLD_FALL_FIRST_S, iw.HOLD_FALL_GAP_S), 8.0)
        self.assertLess(iw.HOLD_FALL_FIRST_S, iw.NARRATE_FIRST_S)

    def test_the_agents_own_first_narration_ends_the_keepalives_and_continues_the_numbering(self):
        key, m = self.go()
        n_cues = len(self.holds(key))
        m["dispatched_ts"] = time.time() - 20
        self.events = [progress_fact(m["command_id"], 1, "Checking the board.", 1)]
        self.poll()
        # the real narration won this poll (a keep-alive never goes in front of it)
        real = [d for d in self.of_type("narrated", key) if not str(d.get("kind") or "").startswith("hold_")]
        self.assertEqual(len(real), 1)
        self.assertEqual(real[0]["narration"], n_cues + 1)
        self.assertEqual(real[0]["progress_s3_key"], f"progress/2026/10/19/{m['memo_id']}-{n_cues + 1}.ogg")
        m["narr_last_ts"] = time.time() - 60
        self.poll()
        self.assertEqual(len([d for d in self.holds(key) if d["kind"] == "hold_keepalive"]), 0)

    def test_no_keepalive_for_a_memo_the_desk_never_saw_or_when_cues_are_off(self):
        self.flag(mode="off")
        key, m = self.say("What's Holocene working on?")           # today's path: no conv block
        self.assertEqual(m["stage"], "await_agent")
        m["dispatched_ts"] = time.time() - 30
        self.poll()
        self.assertEqual(self.of_type("narrated", key), [])
        self.flag(mode="on", agents="holocene-pm", routes=self.routes)
        self.fall_through()
        key, m = self.say("What is the board doing?")
        m["dispatched_ts"] = time.time() - 30
        before = len(self.of_type("narrated", key))
        with unittest.mock.patch.object(iw, "HOLD_CUE_S", 0):
            self.poll()
        self.assertEqual(len(self.of_type("narrated", key)), before)

    def test_the_cue_is_not_said_after_the_agent_turn_is_over(self):
        key, m = self.go()
        m["dispatched_ts"] = time.time() - 30
        real = iw.synthesize

        def finishing(text, tmp, **kw):
            with self.w.mu:
                m["stage"] = "reply"        # the agent finished while the keep-alive was rendering
            return real(text, tmp, **kw)
        n0 = len(self.holds(key))
        with unittest.mock.patch.object(iw, "synthesize", side_effect=finishing), \
                unittest.mock.patch.object(self.w.phrases, "enabled", False):
            self.poll()
        self.assertEqual(len(self.holds(key)), n0)


class PadSources(unittest.TestCase):
    def test_the_unit_documents_nothing_unexpected_and_hold_defaults_are_the_specified_ones(self):
        # defaults live in code: 3 s, 9 s, a keep-alive window under the agent narration's first mark
        src = (Path(__file__).resolve().parent / "inbox_watcher.py").read_text()
        self.assertIn('"MEMO_CONVERSE_HOLD_CUE_S", "3"', src)
        self.assertIn('"MEMO_CONVERSE_HOLD_CUE2_S", "9"', src)
        self.assertEqual(mc_.progress_key_for("inbox/a/2026/10/19/x.ogg", 3, "m", hold=True), "progress/2026/10/19/m-3h.ogg")
        self.assertEqual(mc_.progress_key_for("inbox/a/2026/10/19/x.ogg", 3, "m"), "progress/2026/10/19/m-3.ogg")


if __name__ == "__main__":
    unittest.main()

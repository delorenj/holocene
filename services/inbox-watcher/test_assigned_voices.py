"""HOLOC-23 profile voice regressions. Isolated state; network/subprocess/synthesis boundaries mocked.

Load the existing fake environment before importing the watcher, including when discovery runs this file first.
"""
import contextlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_converse import cv
from test_inbox_watcher import iw, MemoHarness, RecordingWriter
import memo_trace as cli

REAL_SYNTHESIZE = iw.synthesize


class AssignedVoices(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="assigned-voice-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.registry = self.root / "registry.yaml"
        self.profiles = self.root / "profiles"
        self.registry.write_text("agents:\n  tile-a: {profile_name: holocene-pm}\n"
                                 "  tile-b: {profile_name: infra-pm}\n")
        self.config("holocene-pm", "tts: {voice: carlin, vox: {voice: carlin}}\n")
        self.config("infra-pm", "tts: {voice: brule, vox: {voice: carlin}}\n")
        self.cards = cv.CardCache(self.registry, self.profiles, self.root / "roster.json", recall=None)
        self.catalog = cv.VoiceCatalog(fetch=lambda timeout: [{"name": v} for v in ("carlin", "brule", "rick", "walken")])
        self.catalog.get()  # deterministic known availability; never contacts a real endpoint
        self.desk = cv.Desk(self.root, env={"MEMO_VOX_VOICE": "rick"}, cards=self.cards, voices=self.catalog,
                            tools=cv.ToolBox(self.root / "no-tools"), log=lambda *a, **kw: None)
        self.w = object.__new__(iw.Watcher)
        self.w.mu = threading.RLock()
        self.w.desk = self.desk
        self.w.s = SimpleNamespace(memos={}, save=Mock())
        self.w.phrases = iw.PhraseBank(self.root / "phrases")
        self.w.phrases.enabled = True
        self.w.hold_long = set()
        self.w.narrating = set()
        self.w.fact = Mock()
        self.w.status = Mock()
        self.renders = []
        self.logs = []
        for p in (
            patch.object(iw, "synthesize", side_effect=self.fake_synth),
            patch.object(iw, "VOICE", "rick"),
            patch.object(iw, "log", side_effect=lambda event, *a, **kw: self.logs.append((event, kw))),
            patch.object(iw.mc_, "s3_sender", return_value={"ok": False, "host": None}),
            patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")),
            patch("subprocess.run", side_effect=AssertionError("subprocess forbidden")),
            patch.dict(os.environ, {"MEMO_PROGRESS_VOICE": "", "VOX_VOICE": "watcher-is-not-an-agent"}),
        ):
            p.start()
            self.addCleanup(p.stop)

    def config(self, profile, text):
        path = self.profiles / profile / "config.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def fake_synth(self, text, tmp, **kw):
        self.renders.append((text, kw.get("voice") or iw.VOICE, kw.get("steps")))
        path = tmp / "mock.ogg"
        path.write_bytes(b"test fixture, not audio" * 20)
        return path, "voxcpm"

    def memo(self, agent="tile-a", **kw):
        return {"agent": agent, "key": agent + ".ogg", "memo_id": "test", "command_id": "cmd",
                "sender": {"ok": True, "host": "car"}, **kw}

    def choice(self, agent="tile-a", **kw):
        return self.desk.voice_choice(agent, "rick", **kw)

    def test_distinct_assignments_top_level_precedence_and_alias(self):
        self.assertEqual(self.choice()["voice"], "carlin")
        self.assertEqual(self.choice("tile-b")["voice"], "brule")
        self.assertEqual(self.choice()["profile"], "holocene-pm")
        self.assertEqual(self.choice()["source"], "inherited")
        self.assertIsNone(self.choice()["fallback"])

    def test_nested_fallback_blank_and_non_string_top_voice(self):
        for value in ('""', "null", "[]", "42", "false", '"  "'):
            with self.subTest(value=value):
                self.config("infra-pm", f"tts: {{voice: {value}, vox: {{voice: brule}}}}\n")
                self.assertEqual(self.choice("tile-b")["voice"], "brule")

    def test_missing_blank_nonstring_malformed_and_unreadable_config(self):
        for text in ("", "[]", "null", "tts: []", "tts: {voice: []}", "tts: {voice: false}",
                     "tts: {vox: {voice: ''}}", "tts: ["):
            with self.subTest(text=text):
                self.config("infra-pm", text)
                result = self.choice("tile-b")
                self.assertEqual((result["voice"], result["source"]), ("rick", "emergency_fallback"))
                self.assertTrue(result["fallback"])
        self.config("infra-pm", "tts: {voice: brule}").unlink()
        self.assertEqual(self.choice("tile-b")["fallback"], "profile_unreadable")
        with patch.object(Path, "read_text", side_effect=PermissionError("do not leak config")):
            self.assertEqual(self.choice("tile-b")["fallback"], "profile_unreadable")

    def test_identifiers_and_symlink_escape_fail_closed(self):
        for name in ("../infra-pm", "/tmp/infra-pm", ".", "", ["infra-pm"], " infra-pm "):
            with self.subTest(name=name):
                self.assertEqual(self.choice(profile=name)["source"], "emergency_fallback")
        for agent in ("../tile-a", "/tile-a", "", None, ["tile-a"]):
            with self.subTest(agent=agent):
                self.assertEqual(self.choice(agent)["fallback"], "invalid_agent")
                self.assertEqual(self.choice(agent, car=True)["fallback"], "invalid_agent")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "config.yaml").write_text("tts: {voice: walken}")
        (self.profiles / "escape").symlink_to(outside)
        self.assertEqual(self.choice(profile="escape")["fallback"], "invalid_profile_path")

    def test_missing_and_malformed_registry_are_emergency_not_guessed_profiles(self):
        for text in ("agents: []", "[", "agents: {tile-a: {profile_name: '../escape'}}", "agents: {}"):
            self.registry.write_text(text)
            self.assertEqual(self.choice()["source"], "emergency_fallback")
        self.registry.unlink()
        self.assertEqual(self.choice()["fallback"], "profile_missing")

    def test_gateway_confirmed_profile_wins_without_changing_original_tile(self):
        m = self.memo(profile="infra-pm", reply_stamp="one")
        self.assertEqual(self.w._reply_voice(m), "brule")
        self.assertEqual(m["agent"], "tile-a")
        self.assertEqual(m["voice_lock"]["profile"], "infra-pm")

    def test_car_override_only_when_origin_verified_even_explicit_rick(self):
        cv.update_tile(self.desk.flag.path, "tile-a", voice="rick")
        for sender in ({"ok": True, "host": "browser"}, {"ok": False, "host": "car"}, {}):
            m = self.memo(sender=sender, reply_stamp="one")
            self.assertEqual(self.w._reply_voice(m), "carlin")
            self.assertEqual(m["voice_lock"]["source"], "inherited")
        m = self.memo(reply_stamp="one")
        self.assertEqual(self.w._reply_voice(m), "rick")
        self.assertEqual(m["voice_lock"]["source"], "car_override")

    def test_config_registry_and_override_changes_apply_next_stamp_not_current_reply(self):
        m = self.memo(reply_stamp="one")
        self.assertEqual(self.w._reply_voice(m), "carlin")
        self.config("holocene-pm", "tts: {voice: walken}")
        self.assertEqual(self.w._reply_voice(m), "carlin")
        # Simulate durable resume: all lock fields survive JSON serialization.
        m = json.loads(json.dumps(m))
        self.assertEqual(self.w._reply_voice(m), "carlin")
        m["reply_stamp"] = "two"
        self.assertEqual(self.w._reply_voice(m), "walken")
        self.registry.write_text("agents: {tile-a: {profile_name: infra-pm}}")
        self.assertEqual(self.w._reply_voice(m), "walken")
        m["reply_stamp"] = "three"
        self.assertEqual(self.w._reply_voice(m), "brule")
        cv.update_tile(self.desk.flag.path, "tile-a", voice="rick")
        self.assertEqual(self.w._reply_voice(m), "brule")
        m["reply_stamp"] = "four"
        self.assertEqual(self.w._reply_voice(m), "rick")
        cv.update_tile(self.desk.flag.path, "tile-a", voice=None)
        m["reply_stamp"] = "five"
        self.assertEqual(self.w._reply_voice(m), "brule")

    def test_start_cross_agent_followup_drops_old_profile_and_round_locks(self):
        self.w.drop_command = iw.Watcher.drop_command
        m = self.memo(profile="holocene-pm", reply_stamp="one", voice_lock={"stamp": "one", "voice": "carlin"},
                      cue_voice_lock={"voice": "carlin"},
                      delegate={"prompt": "Do the work.", "command_id": "next", "target": "tile-b",
                                "brief_id": "brief", "brief_sha256": "hash"})
        self.w.start_followup(m, "delegation")
        self.assertNotIn("profile", m)
        self.assertNotIn("voice_lock", m)
        self.assertEqual(self.w._reply_voice(m), "brule")
        # Retried completed followups still identify the target, not the original tile.
        m["followups"][-1]["state"] = "done"
        m["reply_stamp"] = "two"
        self.assertEqual(self.w._reply_voice(m), "brule")

    def test_gateway_change_invalidates_pending_cue_but_not_rendering_reply(self):
        m = self.memo()
        self.assertEqual(self.w._cue_voice(m)["voice"], "carlin")
        m.update(profile="infra-pm", reply_stamp="one")
        self.assertEqual(self.w._reply_voice(m), "brule")
        m["profile"] = "holocene-pm"
        self.assertEqual(self.w._reply_voice(m), "brule")

    def test_gateway_confirmation_of_same_profile_and_registry_edits_do_not_mix_round(self):
        m = self.memo(command_id=None)
        self.assertEqual(self.w._cue_voice(m)["voice"], "carlin")
        self.config("holocene-pm", "tts: {voice: walken}")
        self.registry.write_text("agents: {tile-a: {profile_name: infra-pm}}")
        m.update(command_id="cmd", profile="holocene-pm", reply_stamp="one")
        self.assertEqual(self.w._reply_voice(m), "carlin")
        m.pop("profile")
        m["reply_stamp"] = "two"
        self.assertEqual(self.w._reply_voice(m), "brule")

    def test_registry_and_tile_replacement_with_preserved_mtime_invalidates_cache(self):
        self.assertEqual(self.choice()["voice"], "carlin")
        before = self.registry.stat()
        self.registry.write_text("agents: {tile-a: {profile_name: infra-pm}}")
        os.utime(self.registry, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.choice()["voice"], "brule")
        cv.update_tile(self.desk.flag.path, "tile-a", voice="rick")
        self.assertEqual(self.choice(car=True)["voice"], "rick")
        before = self.desk.flag.path.stat()
        data = json.loads(self.desk.flag.path.read_text())
        data["tiles"]["tile-a"]["voice"] = "brule"
        self.desk.flag.path.write_text(json.dumps(data))
        os.utime(self.desk.flag.path, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.choice(car=True)["voice"], "brule")

    def test_cues_phrasebank_chunks_and_retries_share_assignment_until_next_round(self):
        m = self.memo()
        audio, engine, choice, banked = self.w._synth_cue(m, cv.HOLD_CUE_LINES[0], self.root, iw.CONVERSE_TTS_STEPS)
        self.assertEqual(choice["voice"], "carlin")
        self.config("holocene-pm", "tts: {voice: walken}")
        _, _, choice, banked = self.w._synth_cue(m, cv.HOLD_CUE_LINES[0], self.root, iw.CONVERSE_TTS_STEPS)
        self.assertTrue(banked)
        self.assertEqual(choice["voice"], "carlin")
        m["reply_stamp"] = "one"
        for chunk in ("chunk one", "chunk two", "joined reply", "retry"):
            self.w._synth(m, chunk, self.root)
        self.assertEqual({r[1] for r in self.renders}, {"carlin"})
        self.assertEqual(self.w._voice_fields(m), {"voice": "carlin"})
        m["reply_stamp"] = "two"
        self.assertEqual(self.w._reply_voice(m), "walken")

    def test_reply_lock_is_saved_before_render_and_rendered_flag_survives_resume(self):
        m = self.memo(reply_stamp="one")
        snapshots = []
        self.w.s.save.side_effect = lambda: snapshots.append(json.loads(json.dumps(m)))
        self.w._synth(m, "First.", self.root)
        self.assertEqual(snapshots[0]["voice_lock"]["voice"], "carlin")
        self.assertNotIn("rendered", snapshots[0]["voice_lock"])
        self.assertTrue(snapshots[-1]["voice_lock"]["rendered"])
        resumed = json.loads(json.dumps(snapshots[-1]))
        self.config("holocene-pm", "tts: {voice: brule}")
        self.assertEqual(self.w._reply_voice(resumed), "carlin")

    def test_progress_pin_is_truthful_and_does_not_change_final_assignment(self):
        m = self.memo()
        with patch.dict(os.environ, {"MEMO_PROGRESS_VOICE": "walken"}):
            _, _, choice, _ = self.w._synth_cue(m, "Working.", self.root, iw.PROGRESS_TTS_STEPS, progress=True)
        self.assertEqual((choice["voice"], choice["source"]), ("walken", "progress_override"))
        m["reply_stamp"] = "one"
        self.assertEqual(self.w._reply_voice(m), "carlin")

    def test_actual_narration_hold_prime_hold_run_and_final_use_responder_profile(self):
        m = self.memo(profile="infra-pm", stage="await_agent", status="active", dispatched_ts=time.time() - 60)
        self.w.s.memos[m["key"]] = m
        self.w.fact_fast = Mock()
        job = {"key": m["key"], "mid": m["memo_id"], "agent": "tile-a", "cid": "cmd",
               "seq": 1, "n": 1, "spoken": "Working.", "line": "Working."}
        with patch.object(iw.mc_, "mc", return_value=SimpleNamespace(returncode=0)), \
                patch.object(iw.mc_, "probe_audio", return_value={"duration": 0.2}):
            self.w._narrate(job)
            self.w._hold_prime(m, cv.HOLD_CUE_LINES[0])
            self.w._hold_run(m, 2, cv.HOLD_CUE_LINES[0], "hold_cue", lambda mm: None, time.time(), "cmd")
        self.assertEqual(self.w.fact.call_args.args[2]["voice"], "brule")
        self.assertEqual(self.w.fact_fast.call_args.args[2]["voice"], "brule")
        self.assertIsNotNone(self.w.phrases.get(cv.HOLD_CUE_LINES[0], "brule", iw.CONVERSE_TTS_STEPS))
        m["reply_stamp"] = "one"
        self.w._synth(m, "Final.", self.root)
        self.assertEqual({r[1] for r in self.renders}, {"brule"})
        self.assertEqual(m["voice_lock"]["source"], "inherited")

    def test_missing_cue_voice_fallback_is_recorded_and_promoted_to_final(self):
        self.config("holocene-pm", "tts: {voice: ghost}")
        m = self.memo()
        _, _, choice, _ = self.w._synth_cue(m, "Working.", self.root, iw.PROGRESS_TTS_STEPS, progress=True)
        self.assertEqual((choice["voice"], choice["requested"], choice["source"]),
                         ("rick", "ghost", "emergency_fallback"))
        self.assertTrue(any(event == "voice_resolved" and data.get("fallback") == "voice_not_found"
                            for event, data in self.logs))
        m["reply_stamp"] = "one"
        self.assertEqual(self.w._reply_voice(m), "rick")
        self.assertEqual(m["voice_lock"]["requested"], "ghost")

    def test_unknown_progress_pin_falls_back_without_poisoning_assignment(self):
        def missing(text, tmp, **kw):
            if kw.get("voice") == "ghost":
                raise iw.VoiceNotFound("tts", "voice_not_found", "not found", retryable=False)
            return self.fake_synth(text, tmp, **kw)
        m = self.memo()
        with patch.dict(os.environ, {"MEMO_PROGRESS_VOICE": "ghost"}), \
                patch.object(iw, "synthesize", side_effect=missing):
            _, _, choice, _ = self.w._synth_cue(m, "Working.", self.root, iw.PROGRESS_TTS_STEPS, progress=True)
        self.assertEqual((choice["voice"], choice["requested"], choice["fallback"]), ("rick", "ghost", "voice_not_found"))
        m["reply_stamp"] = "one"
        self.assertEqual(self.w._reply_voice(m), "carlin")

    def test_catalog_missing_voice_falls_back_before_any_synthesis(self):
        self.config("holocene-pm", "tts: {voice: ghost}")
        m = self.memo(reply_stamp="one")
        self.w._synth(m, "Final.", self.root)
        self.assertEqual(self.renders[0][1], "rick")
        self.assertEqual(self.w._voice_fields(m), {"voice": "rick", "voice_requested": "ghost",
                                                 "voice_fallback": "voice_not_found"})
        self.assertEqual(m["voice_lock"]["source"], "emergency_fallback")

    def test_synth_404_fallback_is_immediate_and_retained_without_catalog(self):
        self.catalog._list = []
        self.catalog._fetch = lambda timeout: []
        def missing(text, tmp, **kw):
            if kw.get("voice") == "carlin":
                raise iw.VoiceNotFound("tts", "voice_not_found", "not found", retryable=False)
            return self.fake_synth(text, tmp, **kw)
        m = self.memo(reply_stamp="one")
        with patch.object(iw, "synthesize", side_effect=missing) as synth:
            self.w._synth(m, "Final.", self.root)
            self.w._synth(m, "Retry.", self.root)
        self.assertEqual(synth.call_count, 3)
        self.assertEqual(m["voice_lock"]["requested"], "carlin")
        self.assertEqual(m["voice_lock"]["voice"], "rick")

    def test_voice_disappearing_after_first_chunk_never_mixes_rendered_identity(self):
        m = self.memo(reply_stamp="one")
        self.w._synth(m, "First.", self.root)
        with patch.object(iw, "synthesize", side_effect=iw.VoiceNotFound("tts", "voice_not_found", "gone",
                                                                      retryable=False)):
            with self.assertRaises(iw.VoiceNotFound):
                self.w._synth(m, "Second.", self.root)
            # A pre-upgrade, persisted partial reply has chunk history but no new `rendered` marker.
            m["voice_lock"].pop("rendered")
            m["voiced_n"] = 1
            with self.assertRaises(iw.VoiceNotFound):
                self.w._synth(m, "Legacy resume.", self.root)
        self.assertEqual(m["voice_lock"]["voice"], "carlin")

    def test_builtin_explicit_rick_and_clear_restore_profile_inheritance(self):
        result = self.desk._builtin_tool("tile-a", cv.TOOL_VOICE, {"voice": "Rick"}, "test")
        self.assertTrue(result["ok"])
        self.assertFalse(result["out"]["cleared"])
        self.assertEqual(self.desk.tile("tile-a")["voice"], "rick")
        result = self.desk._builtin_tool("tile-a", cv.TOOL_VOICE, {"voice": "default"}, "test")
        self.assertTrue(result["out"]["cleared"])
        self.assertEqual((result["out"]["voice"], result["out"]["source"]), ("carlin", "inherited"))
        self.assertNotIn("voice", self.desk.tile("tile-a"))

    def cli(self, value=None, clear=False):
        args = SimpleNamespace(agent="tile-a", value=value, clear=clear, by="test", json=True)
        env = {"MEMO_HERMES_PROFILES": str(self.profiles), "MEMO_AGENT_REGISTRY": str(self.registry)}
        with patch.object(cli.c, "STATE_DIR", self.root), patch.object(cli, "desk_env", return_value=env), \
                patch.object(cli, "vox_catalog", return_value=self.catalog.get()), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            rc = cli.cmd_voice(args)
        self.assertEqual(rc, 0)
        return json.loads(stdout.getvalue())

    def test_cli_explicit_rick_default_and_clear_with_diagnostics(self):
        result = self.cli("Rick")
        self.assertEqual((result["voice"], result["source"], result["cleared"]), ("rick", "car_override", False))
        self.assertEqual(self.cli()["source"], "car_override")
        result = self.cli("default")
        self.assertEqual((result["voice"], result["source"], result["cleared"]), ("carlin", "inherited", True))
        self.cli("Rick")
        self.assertEqual(self.cli(clear=True)["voice"], "carlin")
        self.assertEqual(self.cli()["profile"], "holocene-pm")
        self.config("holocene-pm", "tts: []")
        self.assertEqual(self.cli()["source"], "emergency_fallback")

    def test_diagnostic_tiles_include_inherited_and_explicit_and_emergency(self):
        cv.update_tile(self.desk.flag.path, "tile-b", voice="rick")
        hb = self.desk.heartbeat(default_voice="rick")
        self.assertEqual(hb["voice_default"], "profile")
        self.assertEqual(hb["tiles"]["tile-a"]["source"], "inherited")
        self.assertEqual(hb["tiles"]["tile-b"]["source"], "car_override")
        self.config("holocene-pm", "tts: {}")
        hb = self.desk.heartbeat(default_voice="rick")
        self.assertEqual(hb["tiles"]["tile-a"]["fallback"], "profile_voice_missing")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            cli.print_tiles(self.desk, self.desk.settings())
        self.assertIn("emergency_fallback", output.getvalue())
        self.assertIn("car_override", output.getvalue())

    def test_diagnostics_share_known_missing_catalog_fallback_including_clear_and_builtin(self):
        self.config("holocene-pm", "tts: {voice: ghost}")
        hb = self.desk.heartbeat(default_voice="rick")["tiles"]["tile-a"]
        for result in (hb, self.cli(), self.cli("default"),
                       self.desk._builtin_tool("tile-a", cv.TOOL_VOICE, {"voice": "default"}, "test")["out"]):
            self.assertEqual((result["configured_voice"], result["requested"]), ("ghost", "ghost"))
            self.assertEqual((result["voice"], result["effective_voice"]), ("rick", "rick"))
            self.assertEqual((result["availability"], result["source"], result["fallback"]),
                             ("unavailable", "emergency_fallback", "voice_not_found"))

    def test_heartbeat_unknown_availability_never_fetches_even_for_many_agents(self):
        self.registry.write_text("agents:\n" + "".join(f"  tile-{i}: {{profile_name: holocene-pm}}\n" for i in range(46)))
        self.catalog._list = []
        with patch.object(self.catalog, "_fetch", side_effect=AssertionError("heartbeat network forbidden")) as fetch:
            tiles = self.desk.heartbeat(default_voice="rick")["tiles"]
        self.assertEqual(len(tiles), 46)
        fetch.assert_not_called()
        for result in tiles.values():
            self.assertEqual((result["configured_voice"], result["effective_voice"], result["availability"]),
                             ("carlin", None, "unknown"))

    def test_warmup_has_no_inline_io_and_only_one_failed_fetch_for_many_profiles(self):
        self.registry.write_text("agents:\n" + "".join(f"  tile-{i}: {{profile_name: holocene-pm}}\n" for i in range(46)))
        self.catalog._list = []
        targets = []
        class NeverRunThread:
            def __init__(self, target, **kw):
                targets.append(target)
            def start(self):
                pass
        self.w.phrases.warm = Mock(return_value=0)  # never execute its render callback
        with patch.object(self.catalog, "_fetch", side_effect=TimeoutError("catalog offline")) as fetch, \
                patch.object(iw.threading, "Thread", NeverRunThread):
            self.w.warm_phrases()
            fetch.assert_not_called()
            self.assertEqual(len(targets), 1)
            targets[0]()  # only collection; phrase rendering remains mocked
            self.assertEqual(fetch.call_count, 1)
            for _ in range(92):
                self.assertEqual(self.catalog.get(), [])
            self.assertEqual(fetch.call_count, 1, "failed empty catalog has a negative-cache interval")
        self.assertEqual(self.renders, [])

    def test_serialized_real_tts_gate_stale_cue_cannot_mutate_rendered_final(self):
        m = self.memo(stage="await_agent", status="active", dispatched_ts=time.time() - 60)
        self.w.s.memos[m["key"]] = m
        job = {"key": m["key"], "mid": m["memo_id"], "agent": "tile-a", "cid": "cmd",
               "seq": 1, "n": 1, "spoken": "Working.", "line": "Working."}
        gate = iw.TtsGate()
        first_done = threading.Event()
        calls, errors = [], []
        def http(req, **kw):
            if isinstance(req, str):
                return io.BytesIO(b"INERT FIXTURE NOT AUDIO " * 20)
            body = json.loads(req.data)
            calls.append((body["text"], body["voice"]))
            if body["text"] == "Working.":
                self.assertTrue(first_done.wait(3))
                raise urllib.error.HTTPError(req.full_url, 500, "fixture", {},
                                             io.BytesIO(b"voice 'carlin' not found"))
            return io.BytesIO(json.dumps({"audio_url": "http://fixture.invalid/inert", "engine": "voxcpm"}).encode())
        def guarded(fn):
            try:
                fn()
            except BaseException as exc:
                errors.append(exc)
        def first():
            with self.w.mu:
                m.update(stage="speak", reply_stamp="one")
            self.w._synth(m, "First reply chunk.", self.root)
            first_done.set()
        def queued(n):
            deadline = time.monotonic() + 3
            while gate.waiting() < n:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.001)
        with patch.object(iw, "TTS_GATE", gate), patch.object(iw, "synthesize", REAL_SYNTHESIZE), \
                patch("urllib.request.urlopen", side_effect=http):
            with gate.hold(iw.TtsGate.REPLY):
                cue = threading.Thread(target=lambda: guarded(lambda: self.w._narrate(job)))
                cue.start()
                queued(1)
                reply = threading.Thread(target=lambda: guarded(first))
                reply.start()
                queued(2)
            reply.join(4)
            cue.join(4)
            self.assertFalse(reply.is_alive() or cue.is_alive())
            self.assertEqual(errors, [])
            self.w._synth(m, "Second reply chunk.", self.root)
        self.assertEqual(calls, [("First reply chunk.", "carlin"), ("Working.", "carlin"),
                                 ("Second reply chunk.", "carlin")])
        self.assertEqual((m["voice_lock"]["voice"], m["voice_lock"]["source"]), ("carlin", "inherited"))
        self.assertTrue(m["voice_lock"]["rendered"])
        self.w.fact.assert_not_called()

    def test_stale_cue_cannot_mutate_new_unrendered_stamp_or_command(self):
        for command, stamp in (("cmd", "new-stamp"), ("new-command", None)):
            with self.subTest(command=command, stamp=stamp):
                m = self.memo(stage="await_agent", status="active", dispatched_ts=time.time() - 60)
                self.w.s.memos[m["key"]] = m
                entered, release = threading.Event(), threading.Event()
                errors = []
                job = {"key": m["key"], "mid": m["memo_id"], "agent": "tile-a", "cid": "cmd",
                       "seq": 1, "n": 1, "spoken": "Working.", "line": "Working."}
                def render(text, tmp, **kw):
                    entered.set()
                    self.assertTrue(release.wait(3))
                    raise iw.VoiceNotFound("tts", "voice_not_found", "fixture", retryable=False)
                def narrate():
                    try:
                        self.w._narrate(job)
                    except BaseException as exc:
                        errors.append(exc)
                with patch.object(iw, "synthesize", side_effect=render):
                    thread = threading.Thread(target=narrate)
                    thread.start()
                    self.assertTrue(entered.wait(3))
                    with self.w.mu:
                        m.pop("cue_voice_lock", None)
                        m.update(command_id=command, reply_stamp=stamp)
                        self.w._reply_voice(m)
                        before = dict(m["voice_lock"])
                    release.set()
                    thread.join(4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(m["voice_lock"], before)

    def test_heard_transcript_status_is_text_only_for_every_origin(self):
        for sender in ({"ok": True, "host": "car"}, {"ok": True, "host": "browser"}, {"ok": False}):
            with self.subTest(sender=sender):
                m = self.memo(stage="await_agent", status="active", transcript="Private transcript.", sender=sender)
                doc = iw.status_doc(m)
                self.assertEqual((doc["heard"], doc["heard_delivery"]), ("Private transcript.", "text_only"))
                self.assertIsNone(doc["spoken_key"])
                self.assertNotIn("heard_ack", doc)
        self.assertEqual(self.renders, [])

    def test_warmup_optout_skips_all_proactive_work_but_preserves_cache_and_reply_rendering(self):
        text = cv.HOLD_CUE_LINES[0]
        fixture = self.root / "cached-fixture.ogg"
        fixture.write_bytes(b"inert test fixture, not audio" * 20)
        self.w.phrases.put(text, "carlin", iw.CONVERSE_TTS_STEPS, fixture, "voxcpm")
        with patch.dict(os.environ, {"MEMO_PHRASEBANK_WARM": "0"}):
            with patch.object(iw.threading, "Thread", side_effect=AssertionError("no warmup thread")) as thread, \
                    patch.object(self.catalog, "get", side_effect=AssertionError("no warmup catalog read")) as catalog, \
                    patch.object(iw, "synthesize", side_effect=AssertionError("no proactive synthesis")) as synth:
                self.w.warm_phrases()
                thread.assert_not_called()
                catalog.assert_not_called()
                synth.assert_not_called()
            self.assertTrue(self.w.phrases.enabled)
            self.assertIsNotNone(self.w.phrases.get(text, "carlin", iw.CONVERSE_TTS_STEPS))
            memo = self.memo(reply_stamp="one")
            _, engine = self.w._synth(memo, text, self.root, steps=iw.CONVERSE_TTS_STEPS)
            self.assertEqual(engine, "phrasebank")
            self.assertEqual(self.renders, [])
            self.w._synth(memo, "User-requested uncached reply.", self.root)
            self.assertEqual(self.renders, [("User-requested uncached reply.", "carlin", None)])

    def test_warmup_default_and_explicit_enable_still_start_worker_without_running_render(self):
        for setting in (None, "1"):
            with self.subTest(setting=setting), patch.dict(os.environ):
                if setting is None:
                    os.environ.pop("MEMO_PHRASEBANK_WARM", None)
                else:
                    os.environ["MEMO_PHRASEBANK_WARM"] = setting
                with patch.object(iw.threading, "Thread") as thread, \
                        patch.object(iw, "synthesize", side_effect=AssertionError("worker not executed")) as synth:
                    self.w.warm_phrases()
                    thread.assert_called_once()
                    thread.return_value.start.assert_called_once()
                    synth.assert_not_called()

    def test_warmup_uses_profiles_not_an_unconditional_rick(self):
        self.w.phrases.warm = Mock(return_value=0)
        # Execute the warming closure synchronously; render callback must never be called.
        class InlineThread:
            def __init__(self, target, **kw):
                self.target = target
            def start(self):
                self.target()
        with patch.object(iw.threading, "Thread", InlineThread):
            self.w.warm_phrases()
        voices = [call.args[0] for call in self.w.phrases.warm.call_args_list]
        self.assertEqual(voices, [["carlin"], ["brule"]])
        self.assertEqual(self.renders, [])


class TranscriptOnlyPipeline(MemoHarness, unittest.TestCase):
    """Real transcribed/direct dispatch path preserves text but never queues transcript speech."""

    def test_direct_dispatch_preserves_private_transcript_without_audio_for_any_origin(self):
        self.w.status_writer = RecordingWriter()
        self.w.desk.env = {"MEMO_CONVERSE": "off"}
        with patch.object(iw, "synthesize", side_effect=AssertionError("private transcript must not be read back")) as synth, \
                patch.object(self.w.pools["narrate"], "submit", side_effect=AssertionError("no heard job")) as submit:
            for i, sender in enumerate(({"ok": True, "host": "car"}, {"ok": True, "host": "browser"}, {"ok": False})):
                key = self.upload(f"text-only-{i}")
                memo = self.transcribed(key, "Private transcript.")
                memo["sender"] = sender
                self.tick_until(lambda: memo["stage"] == "await_agent")
                doc = self.w.status_writer.last(iw.mc_.status_key_for(key))
                self.assertEqual((doc["heard"], doc["heard_delivery"]), ("Private transcript.", "text_only"))
                self.assertIsNone(doc["spoken_key"])
                self.assertEqual(self.of_type("narrated", key), [])
                self.assertEqual(self.of_type("transcribed", key)[0]["transcript_text"], "Private transcript.")
            synth.assert_not_called()
            submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()

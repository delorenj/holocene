"""Publication ownership barriers. Inert fixture bytes only; all synthesis/transport mocked."""
import copy
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_assigned_voices as fixtures
from test_inbox_watcher import iw
from typing import Any


class PublicationRaces(unittest.TestCase):
    w: Any
    root: Path
    renders: list
    setUp = fixtures.AssignedVoices.setUp
    config = fixtures.AssignedVoices.config
    fake_synth = fixtures.AssignedVoices.fake_synth
    memo = fixtures.AssignedVoices.memo

    def ready(self):
        self.w.done_stage = Mock()
        self.w.fact_fast = Mock()
        m = self.memo(reply_stamp="2026-11-22T01:00:00Z", reply_text="Fixture reply.",
                      received_ts=time.time(), status="active", stage="speak")
        self.w.s.memos[m["key"]] = m
        return m

    def mutate(self, m, kind):
        if kind == "responder":
            m["agent"] = "tile-b"
        elif kind == "command":
            m["command_id"] = "cmd-b"
        elif kind == "stamp":
            m["reply_stamp"] = "2026-11-22T02:00:00Z"
        elif kind == "generation":
            m["voice_lock"] = {**m["voice_lock"], "lock_id": "replacement-generation"}
        elif kind == "cancel":
            m["status"] = iw.CANCELLED
        else:
            raise AssertionError(kind)

    def interleave(self, run, entered, release, change):
        errors = []
        def work():
            try:
                run()
            except BaseException as exc:
                errors.append(exc)
        thread = threading.Thread(target=work)
        thread.start()
        try:
            self.assertTrue(entered.wait(5), "publication boundary not reached")
            # A slow upload/render must leave mu available, not serialize the entire watcher.
            acquired = self.w.mu.acquire(timeout=2)
            self.assertTrue(acquired, "slow I/O held the watcher mutex")
            try:
                change()
            finally:
                if acquired:
                    self.w.mu.release()
        finally:
            release.set()
            thread.join(6)
        self.assertFalse(thread.is_alive())
        return errors

    def test_single_reply_post_render_upload_and_precommit_barriers(self):
        for boundary in ("after_render", "upload", "precommit"):
            for kind in ("responder", "command", "stamp", "generation", "cancel"):
                with self.subTest(boundary=boundary, kind=kind):
                    m = self.ready()
                    entered, release = threading.Event(), threading.Event()
                    real = self.w._render_reply_chunk
                    calls = []
                    def barrier():
                        entered.set()
                        self.assertTrue(release.wait(5))
                    def rendered(*a, **kw):
                        result = real(*a, **kw)
                        if boundary == "after_render":
                            barrier()
                        return result
                    def transport(*a, **kw):
                        calls.append(a)
                        if a[0] == "cp" and boundary == "upload":
                            barrier()
                        return SimpleNamespace(returncode=0, stderr="")
                    def stat(*a):
                        if boundary == "precommit":
                            barrier()
                        return {"size": 200}
                    before = {}
                    def change():
                        self.mutate(m, kind)
                        # Model a newer round's cursor without allowing old work to erase it.
                        m["voiced_keys"] = {"new": "new-owner-object"}
                        before.update(copy.deepcopy(m))
                    with patch.object(self.w, "_render_reply_chunk", side_effect=rendered), \
                         patch.object(iw.mc_, "mc", side_effect=transport), \
                         patch.object(iw.mc_, "s3_stat", side_effect=stat):
                        errors = self.interleave(lambda: self.w.step_speak(m), entered, release, change)
                    if kind == "cancel":
                        self.assertEqual(errors, [])
                    else:
                        self.assertEqual([e.code for e in errors], ["voice_round_changed"])
                    self.assertEqual(m, before)
                    self.w.fact_fast.assert_not_called()
                    self.w.done_stage.assert_not_called()
                    uploads = [a for a in calls if a[0] == "cp"]
                    removes = [a for a in calls if a[0] == "rm"]
                    self.assertEqual(len(uploads), int(boundary != "after_render"))
                    self.assertEqual(len(removes), len(uploads))
                    self.assertFalse(any("new-owner-object" in a[-1] for a in removes))

    def chunk_job(self, m):
        owner = {}
        audio, engine = self.w._synth(m, "First chunk.", self.root, publication=owner)
        return {"i": 1, "n": 2, "text": "First chunk.", "audio": audio,
                "ckey": "replies/fixture-c01of02.opus", "rkey": "replies/fixture.ogg",
                "owner": owner, "tts_s": .1, "engine": engine, "t_speak": time.time()}

    def test_chunk_publisher_before_upload_during_upload_and_pre_fact(self):
        for boundary in ("before_upload", "upload", "pre_fact"):
            for kind in ("responder", "command", "stamp", "generation", "cancel"):
                with self.subTest(boundary=boundary, kind=kind):
                    m = self.ready()
                    job = self.chunk_job(m)
                    entered, release = threading.Event(), threading.Event()
                    calls = []
                    def transport(*a, **kw):
                        calls.append(a)
                        if a[0] == "cp" and boundary == "upload":
                            entered.set()
                            self.assertTrue(release.wait(5))
                        return SimpleNamespace(returncode=0, stderr="")
                    class Audio:
                        def __str__(self):
                            return str(job_audio)
                        def stat(self):
                            if boundary == "pre_fact":
                                entered.set()
                                if not release.wait(5):
                                    raise AssertionError("pre-fact barrier timeout")
                            return job_audio.stat()
                    job_audio = job["audio"]
                    job["audio"] = Audio()
                    before = {}
                    def change():
                        self.mutate(m, kind)
                        m["voiced_keys"] = {"new": "new-owner-object"}
                        before.update(copy.deepcopy(m))
                    with patch.object(iw.mc_, "mc", side_effect=transport):
                        if boundary == "before_upload":
                            entered.set()
                            def run():
                                self.assertTrue(release.wait(5))
                                self.w._publish_chunk(m, job)
                        else:
                            run = lambda: self.w._publish_chunk(m, job)
                        errors = self.interleave(run, entered, release, change)
                    self.assertEqual([getattr(e, "code", None) for e in errors],
                                     [] if kind == "cancel" else ["voice_round_changed"])
                    self.assertEqual(m, before)
                    self.w.fact_fast.assert_not_called()
                    self.w.status.assert_not_called()
                    uploads = [a for a in calls if a[0] == "cp"]
                    removes = [a for a in calls if a[0] == "rm"]
                    self.assertEqual(len(uploads), int(boundary != "before_upload"))
                    self.assertEqual(len(removes), len(uploads))

    def test_partial_identity_conflict_refuses_synth_but_real_reset_reselects(self):
        for kind in ("responder", "command"):
            for partial in ("rendered", "voiced_keys", "reply_up", "voiced_one"):
                with self.subTest(kind=kind, partial=partial):
                    m = self.ready()
                    self.w._synth(m, "First chunk.", self.root)
                    if partial != "rendered":
                        m["voice_lock"].pop("rendered")
                        m[partial] = {"1": "first"} if partial != "voiced_one" else "first"
                    lock = copy.deepcopy(m["voice_lock"])
                    self.mutate(m, kind)
                    n = len(self.renders)
                    with self.assertRaises(iw.StageError) as error:
                        self.w._synth(m, "Second chunk.", self.root)
                    self.assertEqual(error.exception.code, "voice_round_changed")
                    self.assertEqual(m["voice_lock"], lock)
                    self.assertEqual(len(self.renders), n)
                    m["background_plan"] = "Fixture next round."
                    self.w.drop_command = iw.Watcher.drop_command
                    self.w.start_followup(m)
                    m.update(agent="tile-b", reply_stamp="2026-11-22T02:00:00Z")
                    self.w._synth(m, "Fresh round.", self.root)
                    self.assertEqual(self.renders[-1][1], "brule")

    def store(self):
        """Fake object store: transport records every operation, tracks live keys and whether mu was held for it."""
        store = SimpleNamespace(live=set(), ops=[], held=[], fail_cp=set())
        def transport(action, *a, **kw):
            key = a[-1]
            store.ops.append((action, key))
            store.held.append(self.w.mu._is_owned())
            if action == "cp" and any(f in key for f in store.fail_cp):
                return SimpleNamespace(returncode=1, stderr="fixture upload refused")
            if action == "cp":
                store.live.add(key)
            elif action == "rm":
                store.live.discard(key)
            return SimpleNamespace(returncode=0, stderr="")
        store.transport = transport
        return store

    def test_real_chunk_pipeline_conflict_after_first_announcement_keeps_announced_audio(self):
        """Policy: a responder/command conflict preserves announced chunks and cursors and only refuses further chunks."""
        for kind in ("responder", "command"):
            with self.subTest(kind=kind):
                self.renders.clear()
                m = self.ready()
                entered, release, first = threading.Event(), threading.Event(), threading.Event()
                real_render = self.w._render_reply_chunk
                seen = []
                def fact(action, memo, payload):
                    seen.append((copy.deepcopy(memo), dict(payload)))
                    first.set()
                self.w.fact_fast.side_effect = fact
                def render(memo, text, *a, **kw):
                    if text == "Second chunk.":
                        self.assertTrue(first.wait(5))
                        entered.set()
                        self.assertTrue(release.wait(5))
                    return real_render(memo, text, *a, **kw)
                store = self.store()
                with tempfile.TemporaryDirectory() as tmp, \
                     patch.object(self.w, "_render_reply_chunk", side_effect=render), \
                     patch.object(iw.mc_, "mc", side_effect=store.transport):
                    errors = self.interleave(lambda: self.w._voice_chunks(
                        m, ["First chunk.", "Second chunk."], iw.mc_.parse_iso(m["reply_stamp"]),
                        Path(tmp), time.time()), entered, release, lambda: self.mutate(m, kind))
                self.assertEqual([e.code for e in errors], ["voice_round_changed"])
                self.assertEqual([v for _, v, _ in self.renders], ["carlin"])  # the changed round got no further chunk
                self.assertEqual(len(seen), 1)
                self.assertEqual(seen[0][1]["command_id"], "cmd")
                self.assertEqual(seen[0][1]["voice"], "carlin")
                self.assertEqual(seen[0][0]["agent"], "tile-a")
                # the announced object is never deleted while a cursor advertises it
                announced = list(m["voiced_keys"].values())
                self.assertEqual(m["voiced_n"], 1)
                self.assertEqual(len(announced), 1)
                self.assertIn("c01of02", announced[0])
                self.assertEqual([k for a, k in store.ops if a == "rm"], [])
                self.assertEqual({iw.mc_.s3_url(k) for k in announced}, store.live)
                self.assertEqual(m["voice_lock"]["identity"], ["cmd", "tile-a"])
                self.assertFalse(any(store.held))

    def test_conflict_discards_only_unannounced_pending_keys(self):
        m = self.ready()
        store = self.store()
        announced = "replies/fixture-announced-c01of03.opus"
        unannounced = "replies/fixture-unannounced-c02of03.opus"
        m["voiced_keys"], m["voiced_n"] = {"1": announced}, 1
        store.live.update({iw.mc_.s3_url(announced), iw.mc_.s3_url(unannounced)})
        owner = self.w._reply_owner(m, selected=False)
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            with self.w._audio_attempt(m, owner) as pending:
                pending.extend([announced, unannounced])
                self.mutate(m, "responder")
        self.assertEqual(sorted(k for a, k in store.ops if a == "rm"), [iw.mc_.s3_url(unannounced)])
        self.assertEqual(m["voiced_keys"], {"1": announced})
        self.assertEqual(m["voiced_n"], 1)

    def retry_cancel_fixture(self, *, via_step_speak):
        """First attempt announces chunk one and loses chunk two's upload; the retry is cancelled mid chunk-one render."""
        m = self.ready()
        store = self.store()
        parts = ["First chunk.", "Second chunk."]
        newer = "replies/newer-round-c01of01.opus"
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        def run():
            if via_step_speak:
                with patch.object(iw, "split_for_speech", return_value=parts):
                    self.w.step_speak(m)
            else:
                with tempfile.TemporaryDirectory() as tmp:
                    return self.w._voice_chunks(m, parts, stamp, Path(tmp), time.time())
        store.fail_cp = {"c02of02"}
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            with self.assertRaises(iw.StageError) as error:
                run()
        self.assertEqual(error.exception.code, "mc_cp_failed")
        # retryable failure: the valid same-owner partial stays announced and playable
        announced = list(m["voiced_keys"].values())
        self.assertEqual(len(announced), 1)
        self.assertEqual(m["voiced_n"], 1)
        self.assertEqual({iw.mc_.s3_url(announced[0])}, store.live)
        self.assertNotIn("rm", [a for a, _ in store.ops])
        # a newer round's object and cursor that the cancelled retry must never touch
        m["voiced_keys"]["9"] = newer
        store.live.add(iw.mc_.s3_url(newer))
        return m, store, run, announced[0], newer

    def test_cancel_during_partial_round_retry_render_withdraws_announced_chunks(self):
        for via_step_speak in (False, True):
            with self.subTest(via_step_speak=via_step_speak):
                m, store, run, announced, newer = self.retry_cancel_fixture(via_step_speak=via_step_speak)
                store.fail_cp = set()
                store.ops.clear(), store.held.clear()
                self.w.fact_fast.reset_mock()
                entered, release = threading.Event(), threading.Event()
                real = self.w._render_reply_chunk
                def render(memo, text, *a, **kw):
                    entered.set()  # the retry's chunk-one render: the cancel lands here, before any new queueing
                    self.assertTrue(release.wait(5))
                    return real(memo, text, *a, **kw)
                with patch.object(self.w, "_render_reply_chunk", side_effect=render), \
                     patch.object(iw.mc_, "mc", side_effect=store.transport):
                    errors = self.interleave(run, entered, release, lambda: self.mutate(m, "cancel"))
                self.assertEqual(errors, [])
                removed = [k for a, k in store.ops if a == "rm"]
                self.assertEqual(removed, [iw.mc_.s3_url(announced)])
                self.assertEqual([a for a, _ in store.ops if a == "cp"], [])  # nothing new went up
                self.assertEqual(store.live, {iw.mc_.s3_url(newer)})
                # the cancelled round's cursor is gone; the newer round's entry and its object are untouched
                self.assertEqual(m["voiced_keys"], {"9": newer})
                self.assertEqual(m["voiced_n"], 1)
                self.assertFalse(any(store.held), "removal must run outside the memo mutex")
                self.w.fact_fast.assert_not_called()

    def test_cancel_after_all_chunks_announced_clears_every_cursor(self):
        m = self.ready()
        store = self.store()
        entered, release = threading.Event(), threading.Event()
        real = self.w._render_reply_chunk
        def render(memo, text, *a, **kw):
            if text == "Second chunk.":
                entered.set()
                self.assertTrue(release.wait(5))
            return real(memo, text, *a, **kw)
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(self.w, "_render_reply_chunk", side_effect=render), \
             patch.object(iw.mc_, "mc", side_effect=store.transport):
            errors = self.interleave(lambda: self.w._voice_chunks(
                m, ["First chunk.", "Second chunk."], iw.mc_.parse_iso(m["reply_stamp"]), Path(tmp), time.time()),
                entered, release, lambda: self.mutate(m, "cancel"))
        self.assertEqual(errors, [])
        self.assertEqual(store.live, set())
        for field in ("voiced_keys", "voiced_n", "voiced_first_s", "voiced_first_ts", "voiced_last_s"):
            self.assertNotIn(field, m)
        self.assertFalse(any(store.held))

    def cancel_idle(self, m):
        """memo:cancel with no audio attempt running: cancel_memo runs under mu (as in tick), the objects go outside it."""
        with self.w.mu:
            self.w.cancel_memo(m)

    def assert_late_attempt_is_inert(self, m, store, prefix):
        """An attempt that outlived the cancel finishes: nothing is deleted twice and no cursor comes back."""
        before = list(store.ops)
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            with self.w._audio_attempt(m, {"chunk_prefix": prefix}) as pending:
                pass
        self.assertEqual(store.ops, before)

    def test_idle_cancel_between_attempts_withdraws_announced_chunk(self):
        """A retryable chunk-two failure leaves chunk one announced; a cancel before the next attempt must withdraw it."""
        m, store, run, announced, newer = self.retry_cancel_fixture(via_step_speak=False)
        prefix = iw.chunk_prefix_for(iw.mc_.parse_iso(m["reply_stamp"]), m["agent"], m["memo_id"])
        store.ops.clear(), store.held.clear()
        self.cancel_idle(m)
        # cursors are fixed under mu at once; no object I/O happened under it
        self.assertEqual(m["voiced_keys"], {"9": newer})
        self.assertEqual(m["voiced_n"], 1)
        self.assertEqual(store.ops, [])
        self.assertEqual(self.w._withdrawn_audio, {announced})
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
        self.assertEqual([k for a, k in store.ops if a == "rm"], [iw.mc_.s3_url(announced)])
        self.assertEqual(store.live, {iw.mc_.s3_url(newer)})
        self.assertFalse(any(store.held), "removal must run outside the memo mutex")
        self.assertEqual(self.w._withdrawn_audio, set())
        self.assert_late_attempt_is_inert(m, store, prefix)
        self.assertEqual(m["voiced_keys"], {"9": newer})

    def test_idle_cancel_after_all_chunks_announced_clears_every_cursor_and_object(self):
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._voice_chunks(m, ["First chunk.", "Second chunk."], stamp, Path(tmp), time.time())
        self.assertEqual(len(m["voiced_keys"]), 2)
        self.assertEqual(len(store.live), 2)
        store.ops.clear(), store.held.clear()
        self.cancel_idle(m)
        for field in ("voiced_keys", "voiced_n", "voiced_first_s", "voiced_first_ts", "voiced_last_s"):
            self.assertNotIn(field, m)
        self.assertEqual(store.ops, [])
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
        self.assertEqual(store.live, set())
        self.assertEqual(len([1 for a, _ in store.ops if a == "rm"]), 2)
        self.assertFalse(any(store.held))
        self.assert_late_attempt_is_inert(m, store, iw.chunk_prefix_for(stamp, m["agent"], m["memo_id"]))

    def test_idle_cancel_leaves_newer_round_and_other_memos_untouched(self):
        m, store, run, announced, newer = self.retry_cancel_fixture(via_step_speak=False)
        # a newer round of the same memo (later stamp) and a same-stamp chunk of another memo are announced too
        later = iw.chunk_key_for(iw.mc_.parse_iso("2026-11-22T03:00:00Z"), m["agent"], m["memo_id"], 1, 1)
        other = iw.chunk_key_for(iw.mc_.parse_iso(m["reply_stamp"]), m["agent"], "othermemo", 1, 1)
        m["voiced_keys"].update({"7": later, "8": other})
        store.live.update(iw.mc_.s3_url(k) for k in (later, other))
        store.ops.clear()
        self.cancel_idle(m)
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
        self.assertEqual(m["voiced_keys"], {"9": newer, "7": later, "8": other})
        self.assertEqual([k for a, k in store.ops if a == "rm"], [iw.mc_.s3_url(announced)])
        self.assertEqual(store.live, {iw.mc_.s3_url(k) for k in (newer, later, other)})

    def test_chunk_upload_overlaps_next_render_and_stale_removal_failure_is_fail_closed(self):
        m = self.ready()
        entered, release, second_rendered = threading.Event(), threading.Event(), threading.Event()
        calls = []
        real = self.w._render_reply_chunk
        def render(memo, text, *a, **kw):
            result = real(memo, text, *a, **kw)
            if text == "Second concurrent chunk.":
                second_rendered.set()
            return result
        def transport(*a, **kw):
            calls.append(a)
            if a[0] == "cp" and "c01of02" in a[-1]:
                self.assertTrue(second_rendered.wait(5), "chunk upload serialized the next render")
                entered.set()
                self.assertTrue(release.wait(5))
            if a[0] == "rm":
                raise RuntimeError("fixture removal unavailable")
            return SimpleNamespace(returncode=0, stderr="")
        def change():
            self.assertTrue(second_rendered.wait(5))
            m.update(agent="tile-b", command_id="cmd-b")
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(self.w, "_render_reply_chunk", side_effect=render), \
             patch.object(iw.mc_, "mc", side_effect=transport):
            errors = self.interleave(lambda: self.w._voice_chunks(
                m, ["First concurrent chunk.", "Second concurrent chunk."], iw.mc_.parse_iso(m["reply_stamp"]),
                Path(tmp), time.time()), entered, release, change)
        self.assertEqual([e.code for e in errors], ["voice_round_changed"])
        self.assertEqual([v for _, v, _ in self.renders], ["carlin", "carlin"])
        self.w.fact_fast.assert_not_called()
        self.assertNotIn("voiced_keys", m)
        self.assertNotIn("voiced_n", m)
        self.assertTrue(any(a[0] == "rm" for a in calls))

    def test_successful_commit_has_one_owner_for_fact_and_cursors(self):
        for chunk in (False, True):
            with self.subTest(chunk=chunk):
                m = self.ready()
                seen = []
                self.w.fact_fast.side_effect = lambda action, memo, payload: seen.append(
                    (copy.deepcopy(memo), dict(payload)))
                with patch.object(iw.mc_, "mc", return_value=SimpleNamespace(returncode=0, stderr="")), \
                     patch.object(iw.mc_, "s3_stat", return_value={"size": 200}):
                    if chunk:
                        self.w._publish_chunk(m, self.chunk_job(m))
                    else:
                        self.w.step_speak(m)
                self.assertEqual(len(seen), 1)
                memo, payload = seen[0]
                self.assertEqual((memo["agent"], payload["command_id"], payload["voice"]),
                                 ("tile-a", "cmd", "carlin"))
                self.assertEqual(memo["voice_lock"]["identity"], ["cmd", "tile-a"])
                if chunk:
                    self.assertEqual(memo["voiced_n"], 1)
                    self.assertEqual(memo["voiced_keys"]["1"], payload["chunk_s3_key"])
                else:
                    self.assertEqual(memo["voiced_one"], payload["reply_s3_key"])
                    self.assertEqual(memo["reply_up"]["voice_owner"]["lock_id"], memo["voice_lock"]["lock_id"])

    def test_courtesy_and_progress_publication_revalidate_owner(self):
        for cue in ("hold", "progress"):
            for boundary in ("after_render", "upload", "pre_fact"):
                for kind in ("responder", "command", "stamp", "generation", "cancel", "final_promotion"):
                    with self.subTest(cue=cue, boundary=boundary, kind=kind):
                        m = self.ready()
                        m.update(stage="await_agent", dispatched_ts=time.time() - 60)
                        self.w.fact.reset_mock()
                        entered, release = threading.Event(), threading.Event()
                        real = self.w._synth_cue
                        def barrier():
                            entered.set()
                            self.assertTrue(release.wait(5))
                        def render(*a, **kw):
                            result = real(*a, **kw)
                            if boundary == "after_render":
                                barrier()
                            return result
                        calls = []
                        def transport(*a, **kw):
                            calls.append(a)
                            if a[0] == "cp" and boundary == "upload":
                                barrier()
                            return SimpleNamespace(returncode=0, stderr="")
                        # stat() is after cp and immediately before the commit mutex.
                        original_stat = Path.stat
                        def stat(path, *a, **kw):
                            if boundary == "pre_fact" and path.name == "mock.ogg":
                                # Avoid the earlier phrasebank stat by waiting for cp.
                                if any(c[0] == "cp" for c in calls):
                                    barrier()
                            return original_stat(path, *a, **kw)
                        before = {}
                        def change():
                            if kind == "generation":
                                m["cue_voice_lock"] = {**m["cue_voice_lock"], "lock_id": "new-cue"}
                            elif kind == "final_promotion":
                                m.update(reply_stamp="2026-11-22T01:00:00Z", stage="speak")
                                self.w._reply_voice(m)
                            else:
                                self.mutate(m, kind)
                            before.update(copy.deepcopy(m))
                        job = {"key": m["key"], "mid": m["memo_id"], "agent": "tile-a", "cid": "cmd",
                               "seq": 1, "n": 1, "spoken": "Working fixture.", "line": "Working fixture."}
                        run = (lambda: self.w._narrate(job)) if cue == "progress" else (
                            lambda: self.w._hold_run(m, 1, "Working fixture.", "hold_cue", lambda mm: None, time.time(), "cmd"))
                        with patch.object(self.w, "_synth_cue", side_effect=render), \
                             patch.object(iw.mc_, "mc", side_effect=transport), \
                             patch.object(iw.mc_, "probe_audio", return_value={"duration": .1}), \
                             patch.object(iw, "on_call", return_value=False), patch.object(Path, "stat", stat):
                            errors = self.interleave(run, entered, release, change)
                        self.assertEqual(errors, [])
                        self.assertEqual(m, before)
                        self.w.fact.assert_not_called()
                        self.w.fact_fast.assert_not_called()
                        self.w.status.assert_not_called()
                        uploads = [a for a in calls if a[0] == "cp"]
                        removes = [a for a in calls if a[0] == "rm"]
                        self.assertEqual(len(uploads), int(boundary != "after_render"))
                        self.assertEqual(len(removes), len(uploads))


if __name__ == "__main__":
    unittest.main()

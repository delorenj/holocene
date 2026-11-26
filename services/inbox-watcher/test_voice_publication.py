"""Publication ownership barriers. Inert fixture bytes only; all synthesis/transport mocked."""
import copy
import json
import os
import random
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

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

    def announce_all(self, m, store, parts=("First chunk.", "Second chunk.")):
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._voice_chunks(m, list(parts), stamp, Path(tmp), time.time())

    def rm_counts(self, store):
        counts = {}
        for action, key in store.ops:
            if action == "rm":
                counts[key] = counts.get(key, 0) + 1
        return counts

    def assert_attempt_in_flight_during_cancel_deletes_once(self, m, store, prefix):
        """Realistic in-flight attempt: its pending list holds announced keys (as _render_chunks leaves it until the round
        ends). A real cancel_memo lands while it runs: cancel queues nothing, the attempt alone removes each key once."""
        announced = set((m.get("voiced_keys") or {}).values())
        self.assertTrue(announced)
        store.ops.clear(), store.held.clear()
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            with self.w._audio_attempt(m, {"chunk_prefix": prefix}) as pending:
                pending.extend(sorted(announced))
                self.cancel_idle(m)
                self.assertEqual(self.w._withdrawn_audio, {}, "an in-flight attempt owns the withdrawal")
            self.w._drain_withdrawn_audio()
        self.assertEqual(self.rm_counts(store), {iw.mc_.s3_url(k): 1 for k in announced})
        self.assertEqual(store.live, set())
        self.assertNotIn("voiced_keys", m)
        self.assertEqual(self.w._withdrawn_audio, {})
        self.assertFalse(any(store.held))

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
        self.assertEqual(self.w._withdrawn_audio, {m["key"]: {announced}})
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
        self.assertEqual([k for a, k in store.ops if a == "rm"], [iw.mc_.s3_url(announced)])
        self.assertEqual(store.live, {iw.mc_.s3_url(newer)})
        self.assertFalse(any(store.held), "removal must run outside the memo mutex")
        self.assertEqual(self.w._withdrawn_audio, {})
        # an attempt that starts after the cancel finds nothing of the cancelled round left to delete
        before = list(store.ops)
        with patch.object(iw.mc_, "mc", side_effect=store.transport), self.w._audio_attempt(m, {"chunk_prefix": prefix}):
            pass
        self.assertEqual(store.ops, before)
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
        self.assertEqual(self.w._withdrawn_audio, {})

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

    def test_cancel_during_attempt_whose_pending_holds_announced_keys_deletes_each_once(self):
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        prefix = iw.chunk_prefix_for(iw.mc_.parse_iso(m["reply_stamp"]), m["agent"], m["memo_id"])
        self.assert_attempt_in_flight_during_cancel_deletes_once(m, store, prefix)

    def render_gate_for_second_chunk(self):
        first, entered, release = threading.Event(), threading.Event(), threading.Event()
        self.w.fact_fast.side_effect = lambda *a, **kw: first.set()
        real = self.w._render_reply_chunk
        def render(memo, text, *a, **kw):
            if text == "Second chunk.":
                self.assertTrue(first.wait(5))
                entered.set()
                self.assertTrue(release.wait(5))
            return real(memo, text, *a, **kw)
        return render, entered, release

    def test_cancel_racing_in_flight_attempt_after_chunk_one_deletes_each_object_once(self):
        """Probe C: chunk one announced by THIS attempt, a real cancel_memo lands during chunk two's render."""
        m = self.ready()
        store = self.store()
        render, entered, release = self.render_gate_for_second_chunk()
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(self.w, "_render_reply_chunk", side_effect=render), \
             patch.object(iw.mc_, "mc", side_effect=store.transport):
            errors = self.interleave(lambda: self.w._voice_chunks(m, ["First chunk.", "Second chunk."], stamp, Path(tmp), time.time()),
                                     entered, release, lambda: self.w.cancel_memo(m))
            self.assertEqual(errors, [])
            self.w._drain_withdrawn_audio()
        counts = self.rm_counts(store)
        self.assertTrue(counts)
        self.assertTrue(all(n == 1 for n in counts.values()), f"double delete: {counts}")
        self.assertEqual(store.live, set())
        self.assertFalse(any(store.held))
        self.assertEqual(self.w._withdrawn_audio, {})
        self.assertEqual(self.w._audio_attempts, {})
        for field in ("voiced_keys", "voiced_n", "voiced_first_s", "voiced_first_ts", "voiced_last_s"):
            self.assertNotIn(field, m)

    def test_cancel_in_flight_then_tick_drain_before_attempt_ends_deletes_each_object_once(self):
        """Probe C2: the tick-end drain runs while the attempt is still blocked, then the attempt finishes."""
        m = self.ready()
        store = self.store()
        render, entered, release = self.render_gate_for_second_chunk()
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(self.w, "_render_reply_chunk", side_effect=render), \
             patch.object(iw.mc_, "mc", side_effect=store.transport):
            thread = threading.Thread(target=lambda: self.w._voice_chunks(
                m, ["First chunk.", "Second chunk."], stamp, Path(tmp), time.time()))
            thread.start()
            self.assertTrue(entered.wait(5))
            with self.w.mu:
                self.w.cancel_memo(m)
            self.w._drain_withdrawn_audio()
            self.assertEqual(self.rm_counts(store), {}, "the in-flight attempt owns the removal; the drain has nothing")
            release.set()
            thread.join(6)
            self.assertFalse(thread.is_alive())
        counts = self.rm_counts(store)
        self.assertTrue(counts)
        self.assertTrue(all(n == 1 for n in counts.values()), f"double delete: {counts}")
        self.assertEqual(store.live, set())
        self.assertNotIn("voiced_keys", m)

    def test_retry_after_idle_cancel_waits_for_the_drain_so_it_cannot_lose_a_reannounced_key(self):
        """Probe D: memo:retry keeps reply_stamp, so a retried worker re-announces the SAME deterministic keys. The memo is
        busy while its withdrawn keys are queued or being removed; the retry is deferred, never run under the rm."""
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        old = set(m["voiced_keys"].values())
        self.w.running = set()
        m["status"] = "active"
        m.setdefault("attempts", {})
        with self.w.mu:
            self.w._control_cancel(m, m["memo_id"])
        self.assertEqual(m["status"], iw.CANCELLED)
        self.assertEqual(self.w._withdrawn_audio, {m["key"]: old})
        self.assertTrue(self.w._audio_draining(m))
        with self.w.mu:   # a direct retry is refused while the keys are queued
            self.w._control_retry(m, m["memo_id"])
        self.assertEqual(m["status"], iw.CANCELLED)
        control = Path(tempfile.mkdtemp(dir=self.root)) / "control"
        control.mkdir()
        retry_file = control / f"retry-{m['memo_id']}"
        retry_file.write_text("")
        seen = {}
        real_discard = self.w._discard_audio
        def discard(keys):
            # the rm is running, outside mu: the memo is still busy and a same-tick retry is still deferred
            with self.w.mu:
                seen["busy"] = self.w._audio_draining(m)
                self.w.process_control()
                seen["file_kept"] = retry_file.exists()
                seen["status"] = m["status"]
            real_discard(keys)
        with patch.object(iw, "STATE_DIR", control.parent):
            with self.w.mu:
                self.w.process_control()
            self.assertTrue(retry_file.exists(), "retry deferred, not lost")
            self.assertEqual(m["status"], iw.CANCELLED)
            with patch.object(self.w, "_discard_audio", side_effect=discard), patch.object(iw.mc_, "mc", side_effect=store.transport):
                self.w._drain_withdrawn_audio()
            self.assertEqual(seen, {"busy": True, "file_kept": True, "status": iw.CANCELLED})
            self.assertEqual(self.w._withdrawn_audio, {})
            self.assertFalse(self.w._audio_draining(m))
            self.assertEqual(store.live, set())
            with self.w.mu:   # next tick: the drain is done, the retry runs
                self.w.process_control()
        self.assertFalse(retry_file.exists())
        self.assertEqual(m["status"], "active")
        self.assertEqual(m["reply_stamp"], "2026-11-22T01:00:00Z", "retry keeps reply_stamp")
        # the retried worker re-announces the same deterministic keys; nothing is left to delete them under it
        self.announce_all(m, store)
        self.assertEqual({k for k in store.live}, {iw.mc_.s3_url(k) for k in old})
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
        self.assertEqual({k for k in store.live}, {iw.mc_.s3_url(k) for k in old})

    # ---- HOLOC-54 guarantees: never delete while advertised; each object removed once per round; queue survives restarts ----

    def guarded(self, store, m, gate=None):
        """Transport over the fake store that records every rm of an object a cursor still advertises (store.violations)."""
        store.violations = []
        def transport(action, *a, **kw):
            if action == "rm":
                with self.w.mu:
                    advertised = {iw.mc_.s3_url(k) for k in (m.get("voiced_keys") or {}).values()}
                if a[-1] in advertised:
                    store.violations.append(a[-1])
            if gate is not None:
                gate(action, a[-1])
            return store.transport(action, *a, **kw)
        return transport

    def partial_round(self, m, store, parts):
        """First attempt announces every chunk but the last, whose upload fails (retryable): the partial stays announced."""
        store.fail_cp = {f"c{len(parts):02d}of{len(parts):02d}"}
        with self.assertRaises(iw.StageError):
            self.announce_all(m, store, parts)
        store.fail_cp = set()
        store.ops.clear(), store.held.clear()

    def test_probe_p_cancel_during_reupload_of_an_announced_chunk_removes_each_object_once_never_advertised(self):
        """Probe P: c01 and c02 announced, the retry attempt re-uploads c01 and a cancel lands mid upload. The inner publisher
        attempt must not delete c01 while the cursor lists it; the outer attempt withdraws and removes it exactly once."""
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        parts = ["First chunk.", "Second chunk.", "Third chunk."]
        self.partial_round(m, store, parts)
        announced = set(m["voiced_keys"].values())
        self.assertEqual(len(announced), 2)
        entered, release = threading.Event(), threading.Event()
        def gate(action, key):
            if action == "cp" and "c01of03" in key:
                entered.set()
                self.assertTrue(release.wait(5))
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(iw.mc_, "mc", side_effect=self.guarded(store, m, gate)):
            errors = self.interleave(lambda: self.w._voice_chunks(m, parts, stamp, Path(tmp), time.time()),
                                     entered, release, lambda: self.w.cancel_memo(m))
            self.w._drain_withdrawn_audio()
        self.assertEqual(errors, [])
        counts = self.rm_counts(store)
        self.assertEqual({k: counts.get(iw.mc_.s3_url(k)) for k in announced}, {k: 1 for k in announced})
        self.assertTrue(all(n == 1 for n in counts.values()), f"double removal: {counts}")
        self.assertEqual(store.violations, [], "an object was removed while a cursor advertised it")
        self.assertEqual(store.live, set())
        self.assertFalse(any(store.held))
        self.assertNotIn("voiced_keys", m)
        self.assertNotIn("withdrawn_audio", m)
        self.assertEqual((self.w._withdrawn_audio, self.w._audio_attempts, self.w._audio_claimed), ({}, {}, {}))

    def test_nested_attempt_leaves_an_advertised_key_to_the_withdrawing_owner_and_siblings_remove_unannounced_once(self):
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        c01 = sorted(m["voiced_keys"].values())[0]
        unannounced = "replies/fixture-unannounced-c03of03.opus"
        store.live.add(iw.mc_.s3_url(unannounced))
        prefix = iw.chunk_prefix_for(iw.mc_.parse_iso(m["reply_stamp"]), m["agent"], m["memo_id"])
        store.ops.clear(), store.held.clear()
        with patch.object(iw.mc_, "mc", side_effect=self.guarded(store, m)):
            with self.w._audio_attempt(m, {"chunk_prefix": prefix}) as outer:
                outer.extend([c01, unannounced])
                with self.w._audio_attempt(m, {}) as inner:   # a publisher attempt whose token names no prefix
                    inner.extend([c01, unannounced])
                    self.cancel_idle(m)
                self.assertEqual(self.rm_counts(store), {iw.mc_.s3_url(unannounced): 1}, "inner removed only the unannounced key")
                self.assertIn(c01, m["voiced_keys"].values(), "c01 is still advertised: it is the outer owner's to withdraw")
            self.w._drain_withdrawn_audio()
        counts = self.rm_counts(store)
        self.assertEqual(counts[iw.mc_.s3_url(unannounced)], 1)
        self.assertTrue(all(n == 1 for n in counts.values()), counts)
        self.assertEqual(store.violations, [])
        self.assertEqual(store.live, set())

    def test_cancel_during_chunk_upload_removes_the_unannounced_chunk_once_across_sibling_attempts(self):
        """Probe H3: chunk two is uploaded but not yet announced when the cancel lands; the publisher attempt and the round's
        attempt both hold it as pending, and only one of them removes it."""
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        entered, release = threading.Event(), threading.Event()
        def gate(action, key):
            if action == "cp" and "c02of02" in key:
                entered.set()
                self.assertTrue(release.wait(5))
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        with tempfile.TemporaryDirectory() as tmp, patch.object(iw.mc_, "mc", side_effect=self.guarded(store, m, gate)):
            errors = self.interleave(lambda: self.w._voice_chunks(m, ["First chunk.", "Second chunk."], stamp, Path(tmp), time.time()),
                                     entered, release, lambda: self.w.cancel_memo(m))
            self.w._drain_withdrawn_audio()
        self.assertEqual(errors, [])
        counts = self.rm_counts(store)
        self.assertEqual(sorted(k.rsplit("-", 1)[-1] for k in counts), ["c01of02.opus", "c02of02.opus"])
        self.assertTrue(all(n == 1 for n in counts.values()), f"double removal: {counts}")
        self.assertEqual(store.violations, [])
        self.assertEqual(store.live, set())
        self.assertNotIn("voiced_keys", m)

    def test_h4_seeded_stress_cancel_racing_attempt_start_upload_and_drain_never_double_removes(self):
        rnd = random.Random(54)
        parts = ["First chunk.", "Second chunk.", "Third chunk."]
        for it in range(120):
            self.w._audio_attempts.clear(), self.w._withdrawn_audio.clear(), self.w._audio_claimed.clear()
            m = self.ready()
            store = self.store()
            self.w.fact_fast.side_effect = lambda *a, **kw: None
            prefix = iw.chunk_prefix_for(iw.mc_.parse_iso(m["reply_stamp"]), m["agent"], m["memo_id"])
            if it % 2:
                self.partial_round(m, store, parts)   # half the runs start with announced chunks (a retry attempt)
            go = threading.Event()
            def gate(action, key):
                time.sleep(rnd.random() * 0.002)
            def attempt():
                go.wait(2)
                time.sleep(rnd.random() * 0.004)
                try:
                    with tempfile.TemporaryDirectory() as tmp:
                        self.w._voice_chunks(m, parts, iw.mc_.parse_iso(m["reply_stamp"]), Path(tmp), time.time())
                except iw.StageError:
                    pass
            def cancel():
                go.wait(2)
                time.sleep(rnd.random() * 0.006)
                with self.w.mu:
                    self.w.cancel_memo(m)
                if rnd.random() < 0.5:
                    self.w._drain_withdrawn_audio()   # a tick end that may fall while the attempt still runs
            with patch.object(iw.mc_, "mc", side_effect=self.guarded(store, m, gate)):
                threads = [threading.Thread(target=attempt), threading.Thread(target=cancel)]
                for t in threads:
                    t.start()
                go.set()
                for t in threads:
                    t.join(10)
                self.assertFalse(any(t.is_alive() for t in threads), f"it={it}")
                self.w._drain_withdrawn_audio()
            counts = self.rm_counts(store)
            self.assertEqual({k: n for k, n in counts.items() if n > 1}, {}, f"it={it} double removal")
            self.assertEqual(store.violations, [], f"it={it} removed while advertised")
            self.assertEqual({k for k in store.live if prefix in k}, set(), f"it={it} orphan objects of the cancelled round")
            self.assertFalse([k for k in (m.get("voiced_keys") or {}).values() if k.startswith(prefix)], f"it={it} cursor left")
            self.assertNotIn("withdrawn_audio", m, f"it={it}")
            self.assertEqual((self.w._audio_attempts, self.w._withdrawn_audio, self.w._audio_claimed), ({}, {}, {}), f"it={it}")
            self.assertFalse(any(store.held), f"it={it} object I/O under mu")

    def control_dir(self):
        cdir = Path(tempfile.mkdtemp(dir=self.root)) / "control"
        cdir.mkdir()
        return cdir

    def drop_control(self, cdir, verb, mid, ns):
        f = cdir / f"{verb}-{mid}"
        f.write_text("")
        os.utime(f, ns=(ns, ns))
        return f

    def running_memo(self):
        m = self.ready()
        m.update(status="active", stage="speak")
        m.setdefault("attempts", {})
        self.w.running = {m["key"]}
        return m

    def control_events(self):
        return [(e, kw.get("reason")) for e, kw in self.logs if e.startswith(("control", "retry", "cancel", "memo_cancel"))]

    def test_probe_r1_cancel_after_a_retry_for_a_running_memo_applies_at_once(self):
        """A merely running memo is not draining: its retry is refused at once and the cancel behind it is never held."""
        m = self.running_memo()
        cdir = self.control_dir()
        t0 = time.time_ns()
        retry = self.drop_control(cdir, "retry", m["memo_id"], t0)
        cancel = self.drop_control(cdir, "cancel", m["memo_id"], t0 + 1000)
        with patch.object(iw, "STATE_DIR", cdir.parent), self.w.mu:
            self.w.process_control()
        self.assertEqual(m["status"], iw.CANCELLED)
        self.assertFalse(retry.exists() or cancel.exists(), "both control files are taken in the same pass")
        events = self.control_events()
        self.assertEqual([e for e, _ in events], ["retry_refused", "memo_cancelled"])
        self.assertEqual(events[0][1], "memo is active at speak, not failed")

    def test_probe_r2_lone_retry_for_a_running_memo_is_refused_at_once(self):
        m = self.running_memo()
        cdir = self.control_dir()
        retry = self.drop_control(cdir, "retry", m["memo_id"], time.time_ns())
        with patch.object(iw, "STATE_DIR", cdir.parent), self.w.mu:
            self.w.process_control()
        self.assertFalse(retry.exists())
        self.assertEqual(m["status"], "active")
        self.assertEqual(self.control_events(), [("retry_refused", "memo is active at speak, not failed")])

    def test_cancel_is_never_held_behind_a_retry_deferred_for_a_draining_memo(self):
        """Only a retry waits for the drain; a cancel newer than it is taken at once and drops the retry it overtook."""
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        m["status"] = "active"
        m.setdefault("attempts", {})
        with self.w.mu:
            self.w._control_cancel(m, m["memo_id"])
        self.assertTrue(self.w._audio_draining(m))
        cdir = self.control_dir()
        t0 = time.time_ns()
        retry = self.drop_control(cdir, "retry", m["memo_id"], t0)
        with patch.object(iw, "STATE_DIR", cdir.parent):
            with self.w.mu:
                self.w.process_control()
            self.assertTrue(retry.exists(), "a retry behind the drain is deferred")
            cancel = self.drop_control(cdir, "cancel", m["memo_id"], t0 + 1000)
            with self.w.mu:
                self.w.process_control()
            self.assertFalse(cancel.exists(), "the cancel was taken at once")
            self.assertFalse(retry.exists(), "the retry the cancel overtook is dropped")
            self.assertIn("control_superseded", [e for e, _ in self.control_events()])
            with patch.object(iw.mc_, "mc", side_effect=store.transport):
                self.w._drain_withdrawn_audio()
            with self.w.mu:
                self.w.process_control()
        self.assertEqual(m["status"], iw.CANCELLED, "the operator's last word was cancel")

    def test_idle_cancel_persists_the_withdrawn_queue_with_the_cursor_clear_and_a_restart_drains_it(self):
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        old = set(m["voiced_keys"].values())
        saved = []
        self.w.s.save.side_effect = lambda: saved.append(json.loads(json.dumps(m)))
        self.cancel_idle(m)
        # one save carries both halves: cursors gone AND the objects still to remove (state.json never forgets them)
        self.assertTrue(saved)
        self.assertNotIn("voiced_keys", saved[-1])
        self.assertEqual(saved[-1]["withdrawn_audio"], sorted(old))
        # crash before the rm: a new process loads the saved memo and queues the same objects
        revived = json.loads(json.dumps(m))
        self.w._withdrawn_audio = {}
        self.w.s.memos = {revived["key"]: revived}
        self.w._load_withdrawn_audio()
        self.assertEqual(self.w._withdrawn_audio, {revived["key"]: old})
        self.assertTrue(self.w._audio_draining(revived))
        store.ops.clear()
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            self.w._drain_withdrawn_audio()
            self.w._drain_withdrawn_audio()
        self.assertEqual(self.rm_counts(store), {iw.mc_.s3_url(k): 1 for k in old})
        self.assertEqual(store.live, set())
        self.assertNotIn("withdrawn_audio", revived)
        self.assertEqual(self.w._withdrawn_audio, {})

    def test_attempt_withdrawal_is_persisted_until_its_objects_are_removed(self):
        m = self.ready()
        store = self.store()
        render, entered, release = self.render_gate_for_second_chunk()
        stamp = iw.mc_.parse_iso(m["reply_stamp"])
        seen = []
        def gate(action, key):
            if action == "rm":
                with self.w.mu:
                    seen.append(list(m.get("withdrawn_audio") or []))
        with tempfile.TemporaryDirectory() as tmp, patch.object(self.w, "_render_reply_chunk", side_effect=render), \
             patch.object(iw.mc_, "mc", side_effect=self.guarded(store, m, gate)):
            errors = self.interleave(lambda: self.w._voice_chunks(m, ["First chunk.", "Second chunk."], stamp, Path(tmp), time.time()),
                                     entered, release, lambda: self.w.cancel_memo(m))
        self.assertEqual(errors, [])
        self.assertTrue(seen and all(len(s_) == 1 for s_ in seen), f"queue at rm time: {seen}")
        self.assertNotIn("withdrawn_audio", m, "forgotten once the rm has finished")
        self.assertEqual(store.live, set())

    def test_shutdown_drains_the_withdrawn_queue_once(self):
        m = self.ready()
        store = self.store()
        self.w.fact_fast.side_effect = lambda *a, **kw: None
        self.announce_all(m, store)
        old = set(m["voiced_keys"].values())
        self.cancel_idle(m)
        self.w.facts = Mock()
        self.w.pools = {}
        store.ops.clear(), store.held.clear()
        with patch.object(iw.mc_, "mc", side_effect=store.transport):
            iw.Watcher.shutdown(self.w, False)
        self.assertEqual(self.rm_counts(store), {iw.mc_.s3_url(k): 1 for k in old})
        self.assertFalse(any(store.held))
        self.assertEqual(self.w._withdrawn_audio, {})
        self.assertNotIn("withdrawn_audio", m)

    def test_drain_with_nothing_queued_takes_no_lock(self):
        self.w._drain_mu = Mock()
        self.w.mu = MagicMock()
        self.w._drain_withdrawn_audio()
        self.assertEqual(self.w._drain_mu.mock_calls, [])
        self.assertEqual(self.w.mu.mock_calls, [])

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

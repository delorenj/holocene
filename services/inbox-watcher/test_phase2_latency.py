"""HOLOC-23 phase 2 latency levers: in-process S3 (SigV4, kept-alive), the ordered async fact queue, PhraseBank, the fast
discovery hand-off and the level probe running alongside Whisper. Every external hop is faked (a local HTTP server stands
in for MinIO)."""
import concurrent.futures
import json
import os
import re
import shutil
import tempfile
import threading
import time
import unittest
import unittest.mock
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["MEMO_PUSH_HINT_URL"] = ""   # never the live upload proxy from a test
os.environ["MEMO_WAKE_PORT"] = "0"
os.environ.setdefault("MEMO_CONVERSE_HOLD_CUE_S", "0")   # the hold cue has its own tests (test_hold_cue.py)

import inbox_watcher as iw  # noqa: E402
import memo_common as mc_  # noqa: E402
import s3direct


class SigV4(unittest.TestCase):
    def test_aws_documented_get_object_vector(self):
        # https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html ("GET Object", Range header)
        h = s3direct.sigv4_headers(
            "GET", "examplebucket.s3.amazonaws.com", "/test.txt", "", {"range": "bytes=0-9"},
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1",
            datetime(2013, 5, 24, tzinfo=timezone.utc))
        self.assertIn("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date", h["authorization"])
        self.assertTrue(h["authorization"].endswith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"))


class FakeS3(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.objects: dict[str, tuple[bytes, dict]] = {}
        self.requests: list[tuple[str, str, dict]] = []
        self.connections = 0
        self.fail = False

        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self):
                super().setup()
                outer.connections += 1

            def log_message(self, *a):
                pass

            def _key(self):
                return self.path.split("?")[0].lstrip("/")

            def _send(self, code, body=b"", headers=None):
                self.send_response(code)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_PUT(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                outer.requests.append(("PUT", self.path, {k.lower(): v for k, v in self.headers.items()}))
                if outer.fail:
                    return self._send(500, b"boom")
                outer.objects[self._key()] = (body, {k.lower(): v for k, v in self.headers.items()})
                self._send(200)

            def do_GET(self):
                outer.requests.append(("GET", self.path, dict(self.headers)))
                if outer.fail:
                    return self._send(500, b"boom")
                if "list-type=2" in self.path:
                    bucket = self._key().split("/")[0]
                    prefix = re.search(r"prefix=([^&]*)", self.path)
                    prefix = prefix.group(1).replace("%2F", "/") if prefix else ""
                    rows = "".join(
                        f"<Contents><Key>{k[len(bucket) + 1:]}</Key><LastModified>2026-10-22T19:30:00.000Z</LastModified>"
                        f"<ETag>&quot;abc&quot;</ETag><Size>{len(v[0])}</Size></Contents>"
                        for k, v in sorted(outer.objects.items()) if k.startswith(f"{bucket}/{prefix}"))
                    xml = f'<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>{rows}</ListBucketResult>'
                    return self._send(200, xml.encode())
                obj = outer.objects.get(self._key())
                if obj is None:
                    return self._send(404, b"<Error/>")
                self._send(200, obj[0])

            def do_HEAD(self):
                outer.requests.append(("HEAD", self.path, dict(self.headers)))
                obj = outer.objects.get(self._key())
                if obj is None:
                    return self._send(404)
                self._send(200, obj[0], {"Content-Type": obj[1].get("content-type", ""), "ETag": '"abc"',
                                         "Last-Modified": "Thu, 22 Oct 2026 19:30:00 GMT",
                                         "x-amz-meta-holocene-device": "e1c40830", "x-amz-meta-holocene-host": "car"})

        super().__init__(("127.0.0.1", 0), H)
        threading.Thread(target=self.serve_forever, daemon=True).start()


class DirectS3(unittest.TestCase):
    def setUp(self):
        self.srv = FakeS3()
        self.addCleanup(self.srv.shutdown)
        self.tmp = Path(tempfile.mkdtemp(prefix="s3d-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.client = s3direct.Client(f"http://127.0.0.1:{self.srv.server_address[1]}", "AK", "SK")
        self.patches = [unittest.mock.patch.object(s3direct, "ENABLED", True),
                        unittest.mock.patch.object(s3direct, "_alias_client", return_value=self.client)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_cp_up_down_stat_cat_list_through_the_mc_shape(self):
        src = self.tmp / "c01.opus"
        src.write_bytes(b"OggS" + b"x" * 500)
        r = mc_.mc("cp", "--quiet", "--attr", "Content-Type=audio/ogg", "--tags", "kind=chunk", str(src), "delo/holocene-auto/replies/c01.opus")
        self.assertEqual((r.returncode, r.args[0]), (0, "s3direct"))
        _, _, h = [x for x in self.srv.requests if x[0] == "PUT"][-1]
        self.assertEqual(h["content-type"], "audio/ogg")
        self.assertEqual(h["x-amz-tagging"], "kind=chunk")
        self.assertTrue(h["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AK/"))
        out = self.tmp / "d.opus"
        self.assertEqual(mc_.mc("cp", "--quiet", "delo/holocene-auto/replies/c01.opus", str(out)).returncode, 0)
        self.assertEqual(out.read_bytes(), src.read_bytes())
        st = json.loads(mc_.mc("stat", "--json", "delo/holocene-auto/replies/c01.opus").stdout)
        self.assertEqual((st["size"], st["etag"]), (504, "abc"))
        self.assertEqual(mc_.s3_sender("replies/c01.opus"), {"device": "e1c40830", "host": "car", "ok": True})
        mc_.mc_pipe("delo/holocene-auto/status/a.json", b'{"a":1}', "Content-Type=application/json;Cache-Control=no-store")
        self.assertEqual(self.srv.objects["holocene-auto/status/a.json"][1]["cache-control"], "no-store")
        self.assertEqual(mc_.mc("cat", "delo/holocene-auto/status/a.json").stdout, '{"a":1}')
        mc_.mc_pipe("delo/holocene-auto/inbox/holocene-pm/2026/10/22/x.ogg", b"OggS", None)
        keys = [o["key"] for o in mc_.s3_list_inbox()]
        self.assertEqual(keys, ["inbox/holocene-pm/2026/10/22/x.ogg"])

    def test_one_connection_serves_many_calls(self):
        for i in range(6):
            self.client.put("holocene-auto", f"k/{i}", b"x" * 100)
        self.assertEqual(self.srv.connections, 1)

    def test_a_text_attr_with_a_semicolon_in_quotes_is_one_content_type(self):
        f = self.tmp / "t.txt"
        f.write_text("hi")
        mc_.mc("cp", "--quiet", "--attr", 'Content-Type="text/plain; charset=utf-8"', str(f), "delo/earshot/phone/t.txt")
        self.assertEqual(self.srv.objects["earshot/phone/t.txt"][1]["content-type"], "text/plain; charset=utf-8")

    def test_a_missing_object_and_a_server_error_fall_back_to_the_real_mc(self):
        calls = []
        real = mc_.subprocess.run
        with unittest.mock.patch.object(mc_.subprocess, "run", side_effect=lambda *a, **k: calls.append(a[0]) or real(["true"], capture_output=True, text=True)):
            mc_.mc("stat", "--json", "delo/holocene-auto/none")        # 404: mc words the error
            self.srv.fail = True
            f = self.tmp / "f"
            f.write_bytes(b"1")
            mc_.mc("cp", "--quiet", str(f), "delo/holocene-auto/x")      # 500: mc runs it
            mc_.mc("rm", "--quiet", "delo/holocene-auto/x")              # not served here
        self.assertEqual([c[1] for c in calls], ["stat", "cp", "rm"])

    def test_off_by_default_means_every_call_is_mc(self):
        with unittest.mock.patch.object(s3direct, "ENABLED", False), \
                unittest.mock.patch.object(mc_.subprocess, "run", return_value=mc_.subprocess.CompletedProcess([], 0, "", "")) as run:
            mc_.mc("stat", "delo/holocene-auto/k")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.srv.requests, [])


class Harness(unittest.TestCase):
    def setUp(self):
        self.state = iw.State(Path(tempfile.mkdtemp(prefix="p2-")))
        self.w = iw.Watcher(self.state)
        self.addCleanup(self.w.shutdown, False)
        self.emitted = []
        self.m = {"memo_id": "11111111-1111-5111-8111-111111111111", "key": "inbox/holocene-pm/2026/10/22/a.ogg", "agent": "holocene-pm"}

    def stub_emit(self, delay=0.0, fail=False):
        def emit(rec):
            time.sleep(delay)
            if fail:
                raise RuntimeError("nats down")
            self.emitted.append((rec["action"], rec["causation"]))
            return {"id": f"id-{len(self.emitted)}"}
        return unittest.mock.patch.object(self.w, "_emit_raw", side_effect=emit)


class AsyncFacts(Harness):
    def test_async_facts_do_not_block_and_keep_order_and_the_causation_chain(self):
        with self.stub_emit(delay=0.15), unittest.mock.patch.object(iw, "FACTS_ASYNC", True):
            t0 = time.time()
            with self.w.mu:
                self.w.fact_fast("received", self.m, {})
                self.w.fact_fast("transcribed", self.m, {})
                self.w.fact("dispatched", self.m, {})        # a sync fact waits for the queue: still third on the bus
            took = time.time() - t0
        self.assertEqual([a for a, _ in self.emitted], ["received", "transcribed", "dispatched"])
        self.assertEqual([c for _, c in self.emitted], [None, "id-1", "id-2"])
        self.assertGreater(took, 0.4)   # the sync one had to wait for both
        with self.stub_emit(delay=0.3), unittest.mock.patch.object(iw, "FACTS_ASYNC", True):
            t0 = time.time()
            with self.w.mu:
                self.w.fact_fast("voiced", self.m, {})
            self.assertLess(time.time() - t0, 0.1)   # the caller did not wait for the publish
            self.assertTrue(self.w.facts.wait_idle(3))

    def test_the_car_is_hinted_over_loopback_before_the_publish_with_only_the_keys_the_proxy_needs(self):
        hints = []
        done = threading.Event()

        def hint(action, memo_id, data):
            hints.append((action, memo_id, data))
            done.set()
        with self.stub_emit(delay=0.3), unittest.mock.patch.object(iw, "FACTS_ASYNC", True), \
                unittest.mock.patch.object(iw, "PUSH_HINT_URL", "http://hint"), unittest.mock.patch.object(iw, "push_hint", side_effect=hint):
            with self.w.mu:
                self.w.fact_fast("voiced", self.m, {"chunk_s3_key": "replies/x-c01of02.opus", "chunk": 1, "chunks": 2,
                                                    "spoken_text": "must not be sent", "tts_seconds": 2.0})
            self.assertTrue(done.wait(1))
            self.assertEqual(self.emitted, [])   # the hint left before the publish finished
            self.assertTrue(self.w.facts.wait_idle(3))
        self.assertEqual(hints, [("voiced", self.m["memo_id"], {"target_agent_id": "holocene-pm",
                                                                "chunk_s3_key": "replies/x-c01of02.opus", "chunk": 1, "chunks": 2})])

    def test_flag_off_is_the_synchronous_fact(self):
        with self.stub_emit(), unittest.mock.patch.object(iw, "FACTS_ASYNC", False):
            self.w.fact_fast("received", self.m, {})
            self.assertEqual(len(self.emitted), 1)   # already published when fact_fast returned

    def test_a_failed_async_publish_goes_to_the_outbox(self):
        with self.stub_emit(fail=True), unittest.mock.patch.object(iw, "FACTS_ASYNC", True):
            with self.w.mu:
                self.w.fact_fast("transcribed", self.m, {"x": 1})
            self.assertTrue(self.w.facts.wait_idle(3))
        self.assertEqual([r["action"] for r in self.state.data["outbox"]], ["transcribed"])

    def test_shutdown_publishes_what_is_queued(self):
        with self.stub_emit(delay=0.2), unittest.mock.patch.object(iw, "FACTS_ASYNC", True):
            with self.w.mu:
                self.w.fact_fast("voiced", self.m, {})
            self.w.shutdown(wait=False)
        self.assertEqual(len(self.emitted), 1)


class PhraseBanking(Harness):
    def test_a_fixed_line_is_rendered_once_per_voice_then_served_from_disk(self):
        line = "Dropped. Nothing was sent."
        bank = iw.PhraseBank(Path(tempfile.mkdtemp(prefix="pb-")), enabled=True)
        self.w.phrases = bank
        renders = []

        def fake_synth(text, tmp, **kw):
            renders.append((text, kw.get("voice")))
            out = tmp / "reply.ogg"
            out.write_bytes(b"OggS" + bytes(300))
            return out, "voxcpm"
        with unittest.mock.patch.object(iw, "synthesize", side_effect=fake_synth):
            for _ in range(3):
                t = Path(tempfile.mkdtemp(prefix="pbt-"))
                audio, engine = self.w._synth(self.m, line, t, 6, iw.TtsGate.FAST)
                self.assertTrue(audio.exists())
            self.assertEqual(len(renders), 1)
            self.assertEqual(engine, "phrasebank")
            self.w._synth(self.m, "Some free text the model wrote.", Path(tempfile.mkdtemp(prefix="pbt-")), 6, iw.TtsGate.FAST)
            self.w._synth(self.m, "Some free text the model wrote.", Path(tempfile.mkdtemp(prefix="pbt-")), 6, iw.TtsGate.FAST)
            self.assertEqual(len(renders), 3)   # free text is never banked
            self.assertIsNone(bank.get(line, "walken", 6))   # another voice is another file

    def test_warm_renders_the_missing_lines_and_stops_when_something_waits(self):
        bank = iw.PhraseBank(Path(tempfile.mkdtemp(prefix="pb-")), lines=lambda: ["A one.", "B two."], enabled=True)

        def render(text, voice):
            p = Path(tempfile.mkdtemp(prefix="pbr-")) / "x.ogg"
            p.write_bytes(bytes(300))
            return p
        self.assertEqual(bank.warm(["rick"], 6, render), 2)
        self.assertEqual(bank.warm(["rick"], 6, render), 0)   # already on disk
        with unittest.mock.patch.object(iw.TTS_GATE, "waiting", return_value=1):
            self.assertEqual(bank.warm(["walken"], 6, render), 0)   # a real render is waiting: the warm-up yields

    def test_every_fixed_line_the_desk_can_say_is_in_the_bank(self):
        lines = iw.fixed_lines()
        for needle in ("Dropped. Nothing was sent.", "Okay. Talk soon.", "Sorry, I didn't catch that. Say it again?"):
            self.assertIn(needle, lines)


class FastDiscovery(Harness):
    def test_the_tick_takes_the_listing_the_watch_thread_saw_a_new_key_in(self):
        o = {"key": "inbox/holocene-pm/2026/10/22/new.ogg", "size": 10, "last_modified": mc_.now_utc(), "etag": None}
        self.w.fresh_listing = ([o], None)
        with unittest.mock.patch.object(self.w, "list_inbox", side_effect=AssertionError("tick must not list again")):
            self.w.tick(discover=False)
        self.assertIn(o["key"], self.state.memos)
        self.assertIsNone(self.w.fresh_listing)

    def test_the_ticks_own_listing_is_skipped_while_the_thread_is_listing(self):
        with unittest.mock.patch.object(iw, "DISCOVER_FAST_S", 0.5), \
                unittest.mock.patch.object(self.w, "list_inbox", return_value=([], None)) as li:
            self.w.fast_listed_at = time.time()
            self.w.tick(discover=True)
            self.assertEqual(li.call_count, 0)
            self.w.fast_listed_at = time.time() - 60   # the thread died: the tick lists again
            self.w.tick(discover=True)
            self.assertEqual(li.call_count, 1)

    def test_the_watch_thread_wakes_the_loop_for_a_new_key_only(self):
        known = {"key": "inbox/holocene-pm/2026/10/22/old.ogg", "size": 1, "last_modified": mc_.now_utc(), "etag": None}
        self.state.memos[known["key"]] = {"memo_id": "x", "key": known["key"], "status": "done"}
        new = dict(known, key="inbox/holocene-pm/2026/10/22/new.ogg")
        iw.WAKE.clear()
        with unittest.mock.patch.object(iw, "DISCOVER_FAST_S", 0.05), \
                unittest.mock.patch.object(self.w, "list_inbox", return_value=([known], None)):
            self.w.start_discovery_watch()
            time.sleep(0.3)
            self.assertFalse(iw.WAKE.is_set())
            self.assertIsNone(self.w.fresh_listing)
        with unittest.mock.patch.object(iw, "DISCOVER_FAST_S", 0.05), \
                unittest.mock.patch.object(self.w, "list_inbox", return_value=([known, new], None)):
            time.sleep(0.4)
            self.assertTrue(iw.WAKE.is_set())
            self.assertEqual({o["key"] for o in self.w.fresh_listing[0]}, {known["key"], new["key"]})
        iw.STOP = True
        time.sleep(0.2)
        iw.STOP = False


class LevelsAlongsideWhisper(Harness):
    def test_the_level_probe_overlaps_the_whisper_request_and_still_gates_the_turn(self):
        order = []

        def mc_stub(*a, timeout=60):
            Path(a[3]).write_bytes(b"OggS fake")
            return mc_.subprocess.CompletedProcess(a, 0, "", "")

        def slow_levels(path):
            order.append("levels_start")
            time.sleep(0.4)
            order.append("levels_end")
            return {"ok": True, "mean_dbfs": -20.0, "max_dbfs": -3.0, "error": None}

        def server(audio, mid, key, agent, audio_s, levels):
            order.append("whisper_start")
            time.sleep(0.4)
            order.append("whisper_end")
            lv = levels.result() if isinstance(levels, concurrent.futures.Future) else levels
            self.assertTrue(lv["ok"])
            return {"text": "hello there", "meta": {"model": "m", "duration_seconds": 3.0}}, None
        with unittest.mock.patch.object(mc_, "mc", side_effect=mc_stub), \
                unittest.mock.patch.object(mc_, "probe_audio", return_value={"ok": True, "duration": 3.0, "error": None}), \
                unittest.mock.patch.object(mc_, "measure_levels", side_effect=slow_levels), \
                unittest.mock.patch.object(self.w, "_transcribe_server", side_effect=server):
            t0 = time.time()
            w = self.w._transcribe_work(self.m["key"], self.m["memo_id"], "holocene-pm", 0, {})
            took = time.time() - t0
        self.assertEqual(w["text"], "hello there")
        self.assertLess(took, 0.7)   # 0.4 + 0.4 serially; overlapped it is ~0.4
        self.assertLess(order.index("levels_start"), order.index("whisper_end"))

    def test_a_silent_clip_is_refused_even_though_whisper_answered(self):
        def mc_stub(*a, timeout=60):
            Path(a[3]).write_bytes(b"OggS fake")
            return mc_.subprocess.CompletedProcess(a, 0, "", "")
        with unittest.mock.patch.object(mc_, "mc", side_effect=mc_stub), \
                unittest.mock.patch.object(mc_, "probe_audio", return_value={"ok": True, "duration": 6.0, "error": None}), \
                unittest.mock.patch.object(mc_, "measure_levels", return_value={"ok": True, "mean_dbfs": -90.0, "max_dbfs": -85.0, "error": None}), \
                unittest.mock.patch.object(self.w, "_transcribe_server", return_value=({"text": "you", "meta": {}}, None)):
            with self.assertRaises(iw.StageError) as cm:
                self.w._transcribe_work(self.m["key"], self.m["memo_id"], "holocene-pm", 0, {})
        self.assertFalse(cm.exception.retryable)


class MainWiring(unittest.TestCase):
    def test_main_starts_the_discovery_watch_and_the_phrase_warm_up_after_the_baseline(self):
        import inspect
        src = inspect.getsource(iw.main)
        base, disc, warm = (src.index(x) for x in ("w.baseline_if_first_start()", "w.start_discovery_watch()", "w.warm_phrases()"))
        self.assertLess(base, disc)   # a first start baselines the inbox before the watch thread can see "new" objects
        self.assertLess(base, warm)


if __name__ == "__main__":
    unittest.main()

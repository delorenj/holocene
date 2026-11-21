"""The upload proxy's wake hint (HOLOC-23 phase 2): a memo starts the moment the proxy has stored it, not at the next
`mc ls` tick, and a hint plus the poll can never start it twice. Reuses the fakes of test_inbox_watcher.
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_wake.py'
"""
import json
import threading
import time
import unittest
import urllib.request

from test_inbox_watcher import MemoHarness, facts, iw, mc_  # noqa: F401 - sets up the fakes and the environment


def hint(key, size=14, etag=None, uploaded_at=None):
    return {"key": key, "size": size, "etag": etag, "uploaded_at": uploaded_at or mc_.iso(mc_.now_utc())}


class WakeEntry(unittest.TestCase):
    def test_a_good_hint_is_one_listing_entry(self):
        e = iw.wake_entry(hint("inbox/holocene-pm/2026/10/22/20261022T101010Z.ogg", 99, "a" * 32))
        self.assertEqual((e["key"], e["size"], e["etag"]), ("inbox/holocene-pm/2026/10/22/20261022T101010Z.ogg", 99, "a" * 32))
        self.assertIsNotNone(e["last_modified"])

    def test_a_bad_etag_is_dropped_not_trusted(self):
        e = iw.wake_entry(hint("inbox/holocene-pm/2026/10/22/x.ogg", 5, "not-an-md5"))
        self.assertIsNone(e["etag"])

    def test_implausible_hints_are_refused(self):
        for bad in (None, [], {}, hint("replies/holocene-pm/2026/10/22/x.ogg"), hint("inbox/../2026/10/22/x.ogg"),
                    hint("inbox/a/2026/10/22/x.txt"), hint("inbox/a/2026/10/22/x.ogg", 0), hint("inbox/a/2026/10/22/x.ogg", True),
                    hint("inbox/a/2026/10/22/x.ogg", "9"), hint("inbox/a/b/2026/10/22/x.ogg"), hint("inbox/a/2026/10/22/")):
            self.assertIsNone(iw.wake_entry(bad), bad)


class WakeApply(MemoHarness, unittest.TestCase):
    def test_a_hint_starts_the_memo_without_a_listing_or_a_tick(self):
        key = self.upload("wake-1")
        size = len(b"OggS fake audio")
        with unittest.mock.patch.object(self.w, "list_inbox", side_effect=AssertionError("no listing")):
            self.assertTrue(iw.wake_apply(self.w, iw.wake_entry(hint(key, size))))
        m = self.state.memos[key]
        self.assertEqual(m["status"], "active")
        self.assertIn(m["stage"], ("transcribe", "converse", "dispatch"))  # received ran inline, transcribe is on its pool
        self.assertEqual(len(self.of_type("received", key)), 1)

    def test_a_hint_then_the_poll_start_the_memo_once(self):
        key = self.upload("wake-2")
        e = iw.wake_entry(hint(key, len(b"OggS fake audio")))
        self.assertTrue(iw.wake_apply(self.w, e))
        self.assertFalse(iw.wake_apply(self.w, e))  # a repeated hint is a no-op
        self.w.discover(([o for o in mc_.s3_list_inbox() if o["key"] == key], None))  # the poll finds it too
        self.tick_until(lambda: self.state.memos[key]["stage"] not in ("receive", "transcribe"))
        self.assertEqual(len(self.of_type("received", key)), 1)
        self.assertEqual(len([1 for m in self.state.memos.values() if m["key"] == key]), 1)

    def test_a_poll_then_the_hint_start_the_memo_once(self):
        key = self.upload("wake-3")
        self.discover(key)
        self.assertFalse(iw.wake_apply(self.w, iw.wake_entry(hint(key, len(b"OggS fake audio")))))
        self.tick_until(lambda: self.state.memos[key]["stage"] not in ("receive", "transcribe"))
        self.assertEqual(len(self.of_type("received", key)), 1)

    def test_a_hint_sets_the_loop_wake(self):
        key = self.upload("wake-4")
        iw.WAKE.clear()
        iw.wake_apply(self.w, iw.wake_entry(hint(key, len(b"OggS fake audio"))))
        self.assertTrue(iw.WAKE.is_set())
        iw.WAKE.clear()


class PushHint(unittest.TestCase):
    def serve(self, status=202):
        import http.server
        seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_address[1]}/internal/push", seen

    def test_the_hint_is_posted_with_the_facts_data(self):
        url, seen = self.serve()
        self.assertTrue(iw.push_hint("voiced", "m", {"chunk_s3_key": "replies/x", "chunk": 1}, url=url))
        self.assertEqual(seen, [{"action": "voiced", "memo_id": "m", "data": {"chunk_s3_key": "replies/x", "chunk": 1}}])

    def test_a_refused_or_dead_proxy_is_just_false(self):
        url, _ = self.serve(status=400)
        self.assertFalse(iw.push_hint("voiced", "m", {}, url=url))
        self.assertFalse(iw.push_hint("voiced", "m", {}, url="http://127.0.0.1:9/internal/push"))
        self.assertFalse(iw.push_hint("failed", "m", {}, url=url))   # an error is never pushed early
        self.assertFalse(iw.push_hint("voiced", "m", {}, url=""))


class WakeListener(MemoHarness, unittest.TestCase):
    def serve(self):
        # a free port, not a fixed one: two suites running at once (an agent's rerun beside the normal run) both bound
        # 18697 and the second logged wake_listener_unavailable [Errno 98] (HOLOC-33). Port 0 means "off" to the
        # listener, so ask the OS for a free one first.
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        srv = iw.start_wake_listener(self.w, port=port)
        self.assertIsNotNone(srv, f"wake listener could not bind {port}")
        self.addCleanup(srv.shutdown)
        self.addCleanup(srv.server_close)
        return f"http://127.0.0.1:{srv.server_address[1]}"

    def post(self, base, body, path="/wake"):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            return urllib.request.urlopen(req, timeout=5).status
        except urllib.error.HTTPError as e:
            return e.code

    def test_post_wake_answers_202_and_starts_the_memo(self):
        base = self.serve()
        key = self.upload("wake-5")
        self.assertEqual(self.post(base, hint(key, len(b"OggS fake audio"))), 202)
        for _ in range(100):
            if key in self.state.memos and self.of_type("received", key):
                break
            time.sleep(0.05)
        self.assertEqual(len(self.of_type("received", key)), 1)

    def test_a_bad_hint_is_a_400_and_starts_nothing(self):
        base = self.serve()
        self.assertEqual(self.post(base, {"key": "../x", "size": 1}), 400)
        self.assertEqual(self.post(base, hint("inbox/a/2026/10/22/x.ogg", 5), path="/other"), 400)
        self.assertEqual(self.state.memos, {})

    def test_port_zero_turns_it_off(self):
        self.assertIsNone(iw.start_wake_listener(self.w, port=0))

    def test_a_beat_makes_the_channel_live(self):
        base = self.serve()
        self.assertFalse(self.w.wake.live())
        self.assertEqual(self.post(base, {"boot": "b1", "wake_sent": 0, "wake_failed": 0}, path="/wake/beat"), 202)
        self.assertTrue(self.w.wake.live())
        for bad in (["not", "an", "object"], {}, {"boot": "b1"}, {"wake_failed": 0}, {"boot": "", "wake_failed": 0},
                    {"boot": "b1", "wake_failed": -1}, {"boot": "b1", "wake_failed": True}, {"boot": 7, "wake_failed": 0}):
            self.assertEqual(self.post(base, bad, path="/wake/beat"), 400, bad)  # only a well-formed beat is proof
        self.assertEqual(self.w.wake.beats, 1)

    def test_a_beat_reporting_a_failed_wake_lists_fast_at_once(self):
        base = self.serve()
        self.assertEqual(self.post(base, {"boot": "b1", "wake_failed": 0}, path="/wake/beat"), 202)
        iw.WAKE.clear()
        self.post(base, {"boot": "b1", "wake_failed": 1}, path="/wake/beat")
        self.assertTrue(iw.WAKE.is_set())
        self.assertFalse(self.w.wake.live())
        iw.WAKE.clear()


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class WakeChannelRules(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.ch = iw.WakeChannel(clock=self.clock, backstop_s=15)

    def test_not_live_until_the_first_beat(self):
        self.assertFalse(self.ch.live())
        self.assertEqual(self.ch.period(1.0), 1.0)
        self.ch.beat("b1", 0)
        self.assertTrue(self.ch.live())
        self.assertEqual(self.ch.period(1.0), 15)

    def test_a_stale_beat_is_not_live(self):
        self.ch.beat("b1", 0)
        self.clock.t += iw.WAKE_STALE_S + 0.1
        self.assertFalse(self.ch.live())
        self.assertEqual(self.ch.period(1.0), 1.0)

    def test_a_miss_distrusts_the_channel_for_a_while(self):
        self.ch.beat("b1", 0)
        self.ch.missed()
        self.assertFalse(self.ch.live())
        self.clock.t += iw.WAKE_DISTRUST_S - 1
        self.ch.beat("b1", 0)
        self.assertFalse(self.ch.live())
        self.clock.t += 2
        self.ch.beat("b1", 0)
        self.assertTrue(self.ch.live())

    def test_a_grown_failure_count_is_a_miss(self):
        self.assertFalse(self.ch.beat("b1", 0))
        self.assertFalse(self.ch.beat("b1", 0))
        self.assertTrue(self.ch.beat("b1", 1))       # a wake failed since the last beat
        self.assertFalse(self.ch.live())

    def test_a_new_boot_that_already_failed_is_a_miss(self):
        # the failures may predate this watcher hearing of the boot (a proxy restart, a watcher restart, two proxies)
        self.assertTrue(self.ch.beat("b1", 3))
        ch = iw.WakeChannel(clock=self.clock, backstop_s=15)
        ch.beat("b1", 9)
        self.assertFalse(ch.beat("b2", 0))           # a restarted proxy with a clean count starts again
        self.assertFalse(ch.beat("b2", 0))
        self.assertTrue(ch.beat("b1", 9))            # a second proxy alternating boots never hides its failures

    def test_backstop_zero_keeps_the_old_fast_poll(self):
        ch = iw.WakeChannel(clock=self.clock, backstop_s=0)
        ch.beat("b1", 0)
        self.assertFalse(ch.live())
        self.assertEqual(ch.period(1.0), 1.0)

    def test_the_snapshot_says_why(self):
        self.ch.beat("b1", 0)
        self.clock.t += 3
        s = self.ch.snapshot()
        self.assertEqual((s["live"], s["beat_age_s"], s["beats"], s["misses"], s["proxy_boot"]), (True, 3.0, 1, 0, "b1"))


class WakeBackstop(MemoHarness, unittest.TestCase):
    def test_a_listing_that_finds_an_unwoken_memo_while_live_is_a_miss(self):
        self.w.wake.beat("b1", 0)
        key = self.upload("miss-1")
        o = [dict(x, last_modified=mc_.now_utc() - __import__("datetime").timedelta(seconds=30))
             for x in mc_.s3_list_inbox() if x["key"] == key]
        self.w.discover((o, None))
        self.assertFalse(self.w.wake.live())
        self.assertEqual(self.w.wake.misses, 1)

    def test_a_woken_memo_or_a_fresh_object_is_not_a_miss(self):
        self.w.wake.beat("b1", 0)
        key = self.upload("miss-2")
        iw.wake_apply(self.w, iw.wake_entry(hint(key, len(b"OggS fake audio"))))
        self.w.discover(([x for x in mc_.s3_list_inbox() if x["key"] == key], None))  # seen after its wake: already known
        key2 = self.upload("miss-3")
        self.w.discover(([x for x in mc_.s3_list_inbox() if x["key"] == key2], None))  # just landed: its wake may be in flight
        self.assertTrue(self.w.wake.live())
        self.assertEqual(self.w.wake.misses, 0)
        iw.WAKE.clear()

    def test_while_live_the_tick_lists_itself_even_after_a_recent_fast_listing(self):
        # the discovery thread idles once the channel is live, so its last listing must not make the tick skip its own
        self.w.wake.beat("b1", 0)
        self.w.fast_listed_at = time.time()
        calls = []
        real = self.w.list_inbox
        with unittest.mock.patch.object(self.w, "list_inbox", side_effect=lambda: calls.append(1) or real()):
            self.w.tick(discover=True)
        self.assertEqual(len(calls), 1)

    def test_the_heartbeat_reports_the_channel(self):
        self.w.wake.beat("b1", 0)
        self.assertTrue(self.w.wake.snapshot()["live"])


if __name__ == "__main__":
    unittest.main()

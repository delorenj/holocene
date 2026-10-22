"""The upload proxy's wake hint (HOLOC-23 phase 2): a memo starts the moment the proxy has stored it, not at the next
`mc ls` tick, and a hint plus the poll can never start it twice. Reuses the fakes of test_inbox_watcher.
    cd services && /usr/bin/python3 -B -m unittest discover -s inbox-watcher -p 'test_wake.py'
"""
import json
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


class WakeListener(MemoHarness, unittest.TestCase):
    def serve(self):
        srv = iw.start_wake_listener(self.w, port=18697)
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


if __name__ == "__main__":
    unittest.main()

"""The uploaded fact the proxy publishes must satisfy the Bloodbank contract and match the watcher's memo id."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "inbox-watcher"))
import upload_proxy as up  # noqa: E402
import memo_common as mc  # noqa: E402

BB_HOOKS = Path("/home/delorenj/code/33GOD/bloodbank/services/agent-hooks")
KEY = "inbox/holocene-pm/2026/10/15/20261015T201500Z.ogg"


class UploadedFact(unittest.TestCase):
    def test_memo_id_matches_watcher(self):
        self.assertEqual(up.memo_id_for(KEY), mc.memo_id_for(KEY))
        self.assertEqual(up.agent_from_key(KEY), mc.agent_from_key(KEY))
        self.assertIsNone(up.agent_from_key("inbox/loose.ogg"))

    def test_envelope_is_contract_and_schema_valid(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        env = up.build_uploaded_envelope(KEY, 1234, "audio/ogg", "HoloceneAuto/0.2.7", 12.5)
        self.assertEqual(env["correlationid"], mc.memo_id_for(KEY))
        validate.assert_contract(env)
        try:
            validate.validate_envelope(env)
        except validate.ValidationUnavailable:
            self.skipTest("jsonschema not installed")


MEMO = mc.memo_id_for(KEY)
REPLY = f"replies/2026/10/15/201846Z-holocene-pm-{MEMO}.ogg"


class PlaybackBeacon(unittest.TestCase):
    def test_reply_key_parsing(self):
        memo, agent, rendered = up.parse_reply_key(REPLY)
        self.assertEqual((memo, agent), (MEMO, "holocene-pm"))
        self.assertEqual(rendered.hour, 20)
        self.assertIsNone(up.parse_reply_key("replies/2026/10/15/201846Z-holocene-pm-bf892df0.ogg"))  # legacy 8-char key
        self.assertIsNone(up.parse_reply_key("replies/x.ogg"))

    def test_started_and_ended_become_played(self):
        for phase in ("started", "ended"):
            env = up.build_playback_envelope({"reply_key": REPLY, "phase": phase, "seconds": 2.4}, "ua")
            self.assertEqual(env["type"], "bloodbank.audio.memo.played")
            self.assertEqual(env["correlationid"], MEMO)
            self.assertEqual(env["data"]["phase"], phase)

    def test_errors_become_retryable_playback_failures(self):
        for phase, code in (("blocked", "autoplay_blocked"), ("error", "playback_error")):
            env = up.build_playback_envelope({"reply_key": REPLY, "phase": phase}, "ua")
            self.assertEqual(env["type"], "bloodbank.audio.memo.failed")
            self.assertEqual((env["data"]["stage"], env["data"]["error_code"], env["data"]["retryable"]), ("playback", code, True))

    def test_untied_beacons_are_ignored(self):
        self.assertIsNone(up.build_playback_envelope({"reply_key": "replies/x.ogg", "phase": "started"}, "ua"))
        self.assertIsNone(up.build_playback_envelope({"reply_key": REPLY, "phase": "dancing"}, "ua"))

    def test_envelopes_pass_the_bloodbank_contract(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        for beacon in ({"phase": "started"}, {"phase": "ended", "seconds": 2.5}, {"phase": "blocked"}, {"phase": "error", "error": "decode"}):
            env = up.build_playback_envelope({"reply_key": REPLY, **beacon}, "HoloceneAuto")
            validate.assert_contract(env)
            try:
                validate.validate_envelope(env)
            except validate.ValidationUnavailable:
                self.skipTest("jsonschema not installed")


class HttpBehaviour(unittest.TestCase):
    """The real Handler on a loopback port, mc replaced by /bin/true."""

    @classmethod
    def setUpClass(cls):
        import socketserver, threading, io, contextlib
        up.MC_BIN = "/bin/true"
        up.EMIT_FACTS = False
        cls.published = []
        up.publish_async = lambda env, key: cls.published.append((env, key))
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def raw(self, request: bytes, read=True) -> bytes:
        import socket
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(request)
        if not read:
            s.shutdown(socket.SHUT_WR)
        out = b""
        try:
            while True:
                d = s.recv(4096)
                if not d:
                    break
                out += d
        except socket.timeout:
            pass
        s.close()
        return out

    def put(self, key, body, claimed=None):
        head = (f"PUT /upload/{key} HTTP/1.1\r\nHost: x\r\nContent-Length: {claimed if claimed is not None else len(body)}\r\n"
                f"Content-Type: audio/ogg\r\nConnection: close\r\n\r\n").encode()
        return self.raw(head + body, read=claimed is None or claimed == len(body))

    def test_complete_upload_is_accepted(self):
        self.assertIn(b" 200 ", self.put(KEY, b"OggS" + b"\0" * 100).split(b"\r\n")[0])

    def test_truncated_upload_is_rejected_not_stored_as_a_complete_memo(self):
        n0 = len(self.published)
        out = self.put(KEY, b"OggS" + b"\0" * 96, claimed=1000)
        self.assertNotIn(b" 200 ", out.split(b"\r\n")[0] if out else b"")
        self.assertEqual(len(self.published), n0 + 1)
        env, key = self.published[-1]
        self.assertEqual((env["type"], env["data"]["stage"], env["data"]["error_code"], env["data"]["retryable"]),
                         ("bloodbank.audio.memo.failed", "upload", "short_body", True))
        self.assertEqual(env["correlationid"], mc.memo_id_for(KEY))

    def test_ogg_key_must_hold_an_ogg(self):
        self.assertIn(b" 400 ", self.put(KEY, b"RIFF" + b"\0" * 100).split(b"\r\n")[0])


class ClientEvents(unittest.TestCase):
    def test_record_and_upload_failures_become_failed_facts_for_the_would_be_key(self):
        for kind, stage, retry in (("record_failed", "record", False), ("upload_failed", "upload", True)):
            env = up.build_client_envelope({"event": kind, "key": KEY, "error": "boom", "attempts": 4}, "ua")
            self.assertEqual((env["data"]["stage"], env["data"]["retryable"], env["data"]["attempt"]), (stage, retry, 4))
            self.assertEqual(env["correlationid"], mc.memo_id_for(KEY))

    def test_progress_events_and_bad_keys_publish_nothing(self):
        self.assertIsNone(up.build_client_envelope({"event": "record_started", "key": KEY}, "ua"))
        self.assertIsNone(up.build_client_envelope({"event": "upload_failed", "key": "inbox/../x.ogg"}, "ua"))

    def test_client_failure_facts_pass_the_bloodbank_contract(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        for kind in ("record_failed", "upload_failed"):
            env = up.build_client_envelope({"event": kind, "key": KEY, "error": "mic"}, "ua")
            validate.assert_contract(env)
            try:
                validate.validate_envelope(env)
            except validate.ValidationUnavailable:
                self.skipTest("jsonschema not installed")

    def test_skipped_playback_is_a_retryable_playback_failure(self):
        env = up.build_playback_envelope({"reply_key": REPLY, "phase": "skipped", "error": "stale"}, "ua")
        self.assertEqual((env["data"]["stage"], env["data"]["error_code"]), ("playback", "not_played"))


if __name__ == "__main__":
    unittest.main()

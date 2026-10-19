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


class CaptureLevels(unittest.TestCase):
    GOOD = {"peak_dbfs": -12.34, "rms_dbfs": -30.0, "samples": 50, "source": "native"}

    def test_parse_accepts_header_json_and_dicts(self):
        import json
        c = up.parse_capture(json.dumps(self.GOOD))
        self.assertEqual((c["peak_dbfs"], c["rms_dbfs"], c["samples"], c["source"]), (-12.3, -30.0, 50, "native"))
        self.assertEqual(up.parse_capture(self.GOOD), c)
        self.assertTrue(up.parse_capture({**self.GOOD, "sent_anyway": True})["sent_anyway"])

    def test_parse_drops_malformed_levels(self):
        for bad in (None, "", "not json", "[1]", {}, {"peak_dbfs": "x", "rms_dbfs": -3}, {"peak_dbfs": True, "rms_dbfs": -3},
                    {"peak_dbfs": float("nan"), "rms_dbfs": -3}, {"peak_dbfs": -3}):
            self.assertIsNone(up.parse_capture(bad), bad)

    def test_parse_clamps_absurd_values(self):
        c = up.parse_capture({"peak_dbfs": -9999, "rms_dbfs": 99})
        self.assertEqual((c["peak_dbfs"], c["rms_dbfs"]), (-120.0, 6.0))

    def test_uploaded_fact_carries_capture_only_when_known(self):
        env = up.build_uploaded_envelope(KEY, 10, "audio/ogg", "ua", 1.0, up.parse_capture(self.GOOD))
        self.assertEqual(env["data"]["capture"]["peak_dbfs"], -12.3)
        self.assertNotIn("capture", up.build_uploaded_envelope(KEY, 10, "audio/ogg", "ua", 1.0)["data"])

    def test_uploaded_fact_with_capture_passes_the_contract(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        env = up.build_uploaded_envelope(KEY, 10, "audio/ogg", "ua", 1.0, up.parse_capture(self.GOOD))
        validate.assert_contract(env)
        try:
            validate.validate_envelope(env)
        except validate.ValidationUnavailable:
            self.skipTest("jsonschema not installed")

    def test_silent_recording_becomes_a_terminal_record_failure_with_levels(self):
        env = up.build_client_envelope({"event": "record_silent", "key": KEY, "capture": {"peak_dbfs": -84.0, "rms_dbfs": -90.0}}, "ua")
        d = env["data"]
        self.assertEqual((d["stage"], d["error_code"], d["retryable"]), ("record", "silent_capture", False))
        self.assertEqual(d["capture"]["peak_dbfs"], -84.0)
        self.assertIn("no sound reached the microphone", d["error_message"])
        self.assertEqual(env["correlationid"], mc.memo_id_for(KEY))

    def test_silent_fact_without_levels_still_publishes(self):
        env = up.build_client_envelope({"event": "record_silent", "key": KEY}, "ua")
        self.assertEqual(env["data"]["error_code"], "silent_capture")
        self.assertNotIn("capture", env["data"])

    def test_silent_fact_passes_the_contract(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        env = up.build_client_envelope({"event": "record_silent", "key": KEY, "capture": {"peak_dbfs": -84.0, "rms_dbfs": -90.0}}, "ua")
        validate.assert_contract(env)
        try:
            validate.validate_envelope(env)
        except validate.ValidationUnavailable:
            self.skipTest("jsonschema not installed")

    def test_stopped_event_publishes_nothing(self):
        self.assertIsNone(up.build_client_envelope({"event": "record_stopped", "key": KEY, "capture": self.GOOD}, "ua"))


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

    def test_capture_header_reaches_the_uploaded_fact(self):
        import json
        captured = []
        real = up.emit_uploaded_async
        up.emit_uploaded_async = lambda *a, **k: captured.append(a)
        try:
            cap = json.dumps({"peak_dbfs": -20.5, "rms_dbfs": -33.0, "samples": 12})
            body = b"OggS" + b"\0" * 100
            head = (f"PUT /upload/{KEY} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\nContent-Type: audio/ogg\r\n"
                    f"X-Holocene-Capture: {cap}\r\nConnection: close\r\n\r\n").encode()
            self.assertIn(b" 200 ", self.raw(head + body).split(b"\r\n")[0])
        finally:
            up.emit_uploaded_async = real
        self.assertEqual(captured[-1][5]["peak_dbfs"], -20.5)

    def test_upload_without_capture_header_still_works(self):
        captured = []
        real = up.emit_uploaded_async
        up.emit_uploaded_async = lambda *a, **k: captured.append(a)
        try:
            self.assertIn(b" 200 ", self.put(KEY, b"OggS" + b"\0" * 100).split(b"\r\n")[0])
        finally:
            up.emit_uploaded_async = real
        self.assertIsNone(captured[-1][5])

    def test_truncated_upload_is_rejected_not_stored_as_a_complete_memo(self):
        n0 = len(self.published)
        out = self.put(KEY, b"OggS" + b"\0" * 96, claimed=1000)
        self.assertNotIn(b" 200 ", out.split(b"\r\n")[0] if out else b"")
        self.assertEqual(len(self.published), n0 + 1)
        env, key = self.published[-1]
        self.assertEqual((env["type"], env["data"]["stage"], env["data"]["error_code"], env["data"]["retryable"]),
                         ("bloodbank.audio.memo.failed", "upload", "short_body", True))
        self.assertEqual(env["correlationid"], mc.memo_id_for(KEY))

    def post(self, body: bytes):
        head = (f"POST /upload/heard HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\n"
                f"Content-Type: application/json\r\nConnection: close\r\n\r\n").encode()
        return self.raw(head + body).split(b"\r\n")[0]

    def test_good_beacon_is_logged_and_published(self):
        import json
        n0 = len(self.published)
        self.assertIn(b" 200 ", self.post(json.dumps(BEACON).encode()))
        self.assertEqual(len(self.published), n0 + 1)
        env, key = self.published[-1]
        self.assertEqual((key, env["type"]), (EKEY, "bloodbank.audio.earshot.detected"))

    def test_bad_beacon_is_400_and_publishes_nothing(self):
        import json
        n0 = len(self.published)
        self.assertIn(b" 400 ", self.post(b"not json"))
        self.assertIn(b" 400 ", self.post(json.dumps({**BEACON, "phase": "dancing"}).encode()))
        self.assertEqual(len(self.published), n0)

    def test_ogg_key_must_hold_an_ogg(self):
        self.assertIn(b" 400 ", self.put(KEY, b"RIFF" + b"\0" * 100).split(b"\r\n")[0])


EKEY = "phone/2026/10/19/120000123Z-hello.ogg"
BEACON = {"channel": "phone", "key": EKEY, "phase": "detected", "at": "2026-10-19T12:00:02.100Z",
          "last_modified": "2026-10-19T12:00:00.000Z", "device": "S26", "app_version": "0.1.0"}


class EarshotBeacon(unittest.TestCase):
    def test_valid_shape_is_accepted_and_cleaned(self):
        clean, why = up.validate_heard({**BEACON, "extra": "dropped", "error": "boom\nline"})
        self.assertIsNone(why)
        self.assertNotIn("extra", clean)
        self.assertEqual(clean["error"], "boom line")
        clean, _ = up.validate_heard(BEACON)
        self.assertNotIn("error", clean)

    def test_malformed_beacons_are_refused_with_a_reason(self):
        bad = [
            (None, "not a JSON object"), ([], "not a JSON object"),
            ({**BEACON, "channel": "Phone"}, "bad channel"), ({**BEACON, "channel": 5}, "bad channel"),
            ({**BEACON, "channel": "tablet"}, "bad key"),            # key not under the channel
            ({**BEACON, "key": "phone/"}, "bad key"), ({**BEACON, "key": "phone/../x.ogg"}, "bad key"),
            ({**BEACON, "key": "phone/a\nb.ogg"}, "bad key"),
            ({**BEACON, "phase": "done"}, "bad phase"), ({k: v for k, v in BEACON.items() if k != "phase"}, "bad phase"),
            ({**BEACON, "at": "yesterday"}, "bad at"), ({**BEACON, "at": "2026-10-19T12:00:02"}, "bad at"),  # no zone
            ({**BEACON, "last_modified": 1760875200}, "bad last_modified"),
            ({**BEACON, "device": ""}, "bad device"), ({k: v for k, v in BEACON.items() if k != "app_version"}, "bad app_version"),
            ({**BEACON, "error": 7}, "bad error"),
        ]
        for beacon, why in bad:
            clean, got = up.validate_heard(beacon)
            self.assertIsNone(clean, beacon)
            self.assertIn(why, got, beacon)

    def test_phases_map_to_contract_actions_and_keep_the_device_word(self):
        want = {"detected": "detected", "started": "started", "finished": "ended", "failed": "failed", "missed": "skipped"}
        for phase, action in want.items():
            env = up.build_heard_envelope({**BEACON, "phase": phase}, "ua")
            self.assertEqual(env["type"], f"bloodbank.audio.earshot.{action}")
            self.assertEqual(env["subject"], f"bloodbank.evt.audio.earshot.{action}")
            self.assertEqual(env["data"]["phase"], phase)
            self.assertEqual(env["correlationid"], up.earshot_event_id(EKEY))
            self.assertEqual(env["ordering_key"], "earshot:" + env["correlationid"])

    def test_envelopes_pass_the_bloodbank_contract_and_schema(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        for phase in up.EARSHOT_PHASES:
            env = up.build_heard_envelope({**BEACON, "phase": phase, "error": "x" if phase == "failed" else None}, "S26/0.1.0")
            if env["data"]["error"] is None:
                del env["data"]["error"]
            validate.assert_contract(env)
            try:
                validate.validate_envelope(env)
            except validate.ValidationUnavailable:
                self.skipTest("jsonschema not installed")


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


class WheelKeyLines(unittest.TestCase):
    def test_only_bounded_strings_survive(self):
        lines = up.wheel_key_lines({"event": "wheel_keys", "lines": ["a key\nline", 5, None, "x" * 1000] + ["y"] * 500})
        self.assertEqual(len(lines), up.WHEEL_KEYS_MAX_LINES - 2)  # 200 taken, 2 of them not strings
        self.assertEqual(lines[0], "a key line")
        self.assertTrue(all(len(x) <= 300 for x in lines))

    def test_garbage_is_ignored(self):
        self.assertEqual(up.wheel_key_lines({"lines": "nope"}), [])
        self.assertEqual(up.wheel_key_lines({}), [])


if __name__ == "__main__":
    unittest.main()

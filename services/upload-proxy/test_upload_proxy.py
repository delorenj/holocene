"""The uploaded fact the proxy publishes must satisfy the Bloodbank contract and match the watcher's memo id."""
import json
import sys
import tempfile
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
        # the route check is its own test (RoutableAgents); here every agent answers per `routes`, default routable
        cls.routes = {}
        cls.real_agent_route = up.agent_route
        up.agent_route = lambda agent: cls.routes.get(agent, {"ok": True, "reason": None})
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        up.agent_route = cls.real_agent_route

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

    # ---- an unroutable agent is refused, not shown as SENT ----

    GONE = "inbox/zz-gone/2026/10/18/20261018T101500Z.ogg"
    BODY = b"OggS" + b"\0" * 100

    def _unroutable(self, agent="zz-gone"):
        type(self).routes[agent] = {"ok": False, "reason": f"{agent!r} is not in agents-registry.yaml"}

    def test_a_put_for_an_unroutable_agent_is_422_with_the_reason_and_not_stored(self):
        self._unroutable()
        captured = []
        real = up.emit_uploaded_async
        up.emit_uploaded_async = lambda *a, **k: captured.append(a)
        try:
            resp = self.put(self.GONE, self.BODY)
            head = resp.split(b"\r\n")[0]
        finally:
            up.emit_uploaded_async = real
        self.assertIn(b" 422 unroutable agent zz-gone", head)
        # the pad reads the reason from a JSON body (HTTP/2 drops the reason phrase)
        self.assertEqual(json.loads(resp.split(b"\r\n\r\n", 1)[1])["reason"], "unroutable agent zz-gone")
        self.assertEqual(captured, [])  # nothing was stored, so no uploaded fact either

    def test_the_rejection_is_published_as_a_terminal_upload_failure_once(self):
        self._unroutable("zz-once")
        key = "inbox/zz-once/2026/10/18/20261018T101501Z.ogg"
        n0 = len(self.published)
        for _ in range(3):  # the pad re-PUTs a rejected memo; one fact is enough
            self.assertIn(b" 422 ", self.put(key, self.BODY).split(b"\r\n")[0])
        self.assertEqual(len(self.published), n0 + 1)
        env, k = self.published[-1]
        d = env["data"]
        self.assertEqual((k, env["type"], d["stage"], d["error_code"], d["retryable"], d["target_agent_id"]),
                         (key, "bloodbank.audio.memo.failed", "upload", "unknown_agent", False, "zz-once"))
        self.assertIn("not in agents-registry.yaml", d["error_message"])
        self.assertEqual(env["correlationid"], mc.memo_id_for(key))

    def test_an_unreadable_registry_fails_open_and_the_upload_is_accepted(self):
        type(self).routes["zz-blind"] = {"ok": None, "reason": "registry unreadable: FileNotFoundError"}
        n0 = len(self.published)
        out = self.put("inbox/zz-blind/2026/10/18/20261018T101502Z.ogg", self.BODY)
        self.assertIn(b" 200 ", out.split(b"\r\n")[0])
        self.assertEqual(len(self.published), n0)

    def test_a_routable_agent_and_non_inbox_keys_are_unaffected(self):
        self._unroutable("zz-reply")
        self.assertIn(b" 200 ", self.put(KEY, self.BODY).split(b"\r\n")[0])
        # a reply object is the watcher's own write path: the agent segment there is never checked
        self.assertIn(b" 200 ", self.put("replies/2026/10/18/101500Z-zz-reply-x.ogg", self.BODY).split(b"\r\n")[0])

    def test_a_non_ascii_agent_segment_cannot_break_the_status_line(self):
        self._unroutable("zz-\u00e9x")
        head = self.put("inbox/zz-%C3%A9x/2026/10/18/20261018T101503Z.ogg", self.BODY).split(b"\r\n")[0]
        self.assertIn(b" 422 unroutable agent zz-?x", head)


class RoutableAgents(unittest.TestCase):
    """agent_route reuses the watcher's registry_route and never blocks on a broken check."""

    def setUp(self):
        self.mc = up._load_memo_common()
        self.saved = self.mc.REGISTRY_PATH
        self.reg = Path(tempfile.mkdtemp(prefix="up-reg-")) / "agents-registry.yaml"
        self.reg.write_text("agents:\n"
                            "  holocene-pm:\n    display_name: Holocene PM\n    profile_name: holocene-pm\n"
                            "    bloodbank: {enabled: true, gateway_scope: fleet, target_agent_id: holocene-pm}\n"
                            "  off-pm:\n    profile_name: off-pm\n"
                            "    bloodbank: {enabled: false, gateway_scope: fleet, target_agent_id: off-pm}\n")
        self.mc.REGISTRY_PATH = self.reg

    def tearDown(self):
        self.mc.REGISTRY_PATH = self.saved

    def test_it_is_the_watchers_own_function(self):
        self.assertTrue(up._load_memo_common().__file__.endswith("inbox-watcher/memo_common.py"))

    def test_routable_unknown_and_disabled_agents(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed")
        self.assertIs(up.agent_route("holocene-pm")["ok"], True)
        r = up.agent_route("zz-nonexistent")
        self.assertIs(r["ok"], False)
        self.assertIn("not in", r["reason"])
        self.assertIs(up.agent_route("off-pm")["ok"], False)

    def test_an_unreadable_registry_is_unknown_not_unroutable(self):
        self.mc.REGISTRY_PATH = self.reg.with_name("missing.yaml")
        r = up.agent_route("holocene-pm")
        self.assertIsNone(r["ok"])
        self.assertIn("unreadable", r["reason"])

    def test_a_missing_memo_common_is_unknown_not_unroutable(self):
        def boom():
            raise ImportError("memo_common.py not found")
        real = up._load_memo_common
        up._load_memo_common = boom
        try:
            r = up.agent_route("holocene-pm")
        finally:
            up._load_memo_common = real
        self.assertIsNone(r["ok"])
        self.assertIn("route check unavailable", r["reason"])


EKEY = "phone/2026/10/19/120000123Z-hello.ogg"
BEACON = {"channel": "phone", "key": EKEY, "phase": "detected", "at": "2026-10-19T12:00:02.100Z",
          "last_modified": "2026-10-19T12:00:00.000Z", "device": "S26", "app_version": "0.1.0"}
HEARTBEAT = {"channel": "phone", "phase": "heartbeat", "at": "2026-10-19T12:00:09.000Z",
             "device": "S26", "app_version": "0.1.0"}


class EarshotHeartbeatAndSkew(unittest.TestCase):
    def test_heartbeat_is_accepted_without_key_or_last_modified(self):
        clean, why = up.validate_heard(HEARTBEAT)
        self.assertIsNone(why)
        self.assertEqual(clean["phase"], "heartbeat")
        self.assertNotIn("key", clean)
        self.assertNotIn("last_modified", clean)

    def test_heartbeat_with_a_key_still_validates_the_key(self):
        clean, why = up.validate_heard({**HEARTBEAT, "key": EKEY, "last_modified": BEACON["last_modified"]})
        self.assertIsNone(why)
        self.assertEqual(clean["key"], EKEY)
        clean, why = up.validate_heard({**HEARTBEAT, "key": "tablet/x.ogg"})
        self.assertIn("bad key", why)
        clean, why = up.validate_heard({**HEARTBEAT, "last_modified": "yesterday"})
        self.assertIn("bad last_modified", why)

    def test_playback_phases_still_require_key_and_last_modified(self):
        for phase in up.EARSHOT_PHASES:
            clean, why = up.validate_heard({k: v for k, v in {**BEACON, "phase": phase}.items() if k != "key"})
            self.assertIn("bad key", why)
            clean, why = up.validate_heard({k: v for k, v in {**BEACON, "phase": phase}.items() if k != "last_modified"})
            self.assertIn("bad last_modified", why)

    def test_clock_skew_ms_is_numeric_and_bounded(self):
        for good in (0, 120, -120, 120.4, -86_400_000, 86_400_000):
            clean, why = up.validate_heard({**BEACON, "clock_skew_ms": good})
            self.assertIsNone(why, good)
            self.assertEqual(clean["clock_skew_ms"], int(round(good)), good)
        for bad in (True, "120", float("nan"), float("inf"), 86_400_001, -86_400_001, [120]):
            clean, why = up.validate_heard({**BEACON, "clock_skew_ms": bad})
            self.assertIsNone(clean, bad)
            self.assertIn("clock_skew_ms", why)
        clean, _ = up.validate_heard(BEACON)
        self.assertNotIn("clock_skew_ms", clean)

    def test_skew_reaches_the_fact_data(self):
        env = up.build_heard_envelope({**BEACON, "clock_skew_ms": 250}, "ua")
        self.assertEqual(env["data"]["clock_skew_ms"], 250)


class BeaconJsonl(unittest.TestCase):
    def test_every_accepted_beacon_lands_as_one_json_line(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "beacons.jsonl"
            real = up.EARSHOT_JSONL
            up.EARSHOT_JSONL = str(p)
            try:
                up.persist_heard({"ts": "2026-10-19T12:00:09.000Z", "event": "heard", "status": 200,
                                  "device": "S26", "phase": "heartbeat"})
                up.persist_heard({"ts": "2026-10-19T12:00:10.000Z", "event": "heard", "status": 200,
                                  "device": "S26", "phase": "detected", "key": EKEY})
            finally:
                up.EARSHOT_JSONL = real
            lines = p.read_text().splitlines()
            self.assertEqual(len(lines), 2)
            import json
            recs = [json.loads(x) for x in lines]
            self.assertEqual([r["phase"] for r in recs], ["heartbeat", "detected"])

    def test_unwritable_target_fails_open(self):
        real = up.EARSHOT_JSONL
        up.EARSHOT_JSONL = "/proc/definitely/not/writable.jsonl"
        try:
            up.persist_heard({"event": "heard", "status": 200, "phase": "heartbeat"})   # must not raise
        finally:
            up.EARSHOT_JSONL = real

    def test_oversized_log_rotates_to_one_old_generation(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "beacons.jsonl"
            p.write_bytes(b"x" * 100)
            real_max = up.EARSHOT_JSONL_MAX_BYTES
            up.EARSHOT_JSONL_MAX_BYTES = 50
            real = up.EARSHOT_JSONL
            up.EARSHOT_JSONL = str(p)
            try:
                up.persist_heard({"event": "heard", "status": 200, "phase": "heartbeat", "device": "S26"})
            finally:
                up.EARSHOT_JSONL = real
                up.EARSHOT_JSONL_MAX_BYTES = real_max
            self.assertTrue(Path(str(p) + ".old").exists())
            self.assertEqual(len(p.read_text().splitlines()), 1)


class HttpEarshotLifecycle(unittest.TestCase):
    """Heartbeat and persistence behaviour over the wire on a loopback port."""

    @classmethod
    def setUpClass(cls):
        import threading, tempfile
        cls._t = tempfile.TemporaryDirectory()
        cls.jsonl = Path(cls._t.name) / "beacons.jsonl"
        cls._real_jsonl = up.EARSHOT_JSONL
        cls._real_emit = up.EMIT_FACTS
        up.EARSHOT_JSONL = str(cls.jsonl)
        up.EMIT_FACTS = False
        cls.published = []
        cls._real_publish = up.publish_async
        up.publish_async = lambda env, key: cls.published.append((env, key))
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        up.EARSHOT_JSONL = cls._real_jsonl
        up.EMIT_FACTS = cls._real_emit
        up.publish_async = cls._real_publish
        cls._t.cleanup()

    def post(self, body: bytes):
        import socket
        head = (f"POST /upload/heard HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\n"
                f"Content-Type: application/json\r\nConnection: close\r\n\r\n").encode()
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(head + body)
        out = b""
        while True:
            d = s.recv(4096)
            if not d:
                break
            out += d
        s.close()
        return out.split(b"\r\n")[0]

    def test_heartbeat_is_200_persisted_and_never_published(self):
        import json
        n0 = len(self.published)
        body = json.dumps({**HEARTBEAT, "clock_skew_ms": -42}).encode()
        self.assertIn(b" 200 ", self.post(body))
        self.assertEqual(len(self.published), n0)                      # no fact for a heartbeat
        lines = [json.loads(x) for x in self.jsonl.read_text().splitlines()]
        mine = [r for r in lines if r.get("phase") == "heartbeat"]
        self.assertTrue(mine)
        self.assertEqual(mine[-1]["clock_skew_ms"], -42)
        self.assertEqual(mine[-1]["event"], "heard")
        self.assertIn("ts", mine[-1])                                  # server receive time captured

    def test_playback_beacon_is_persisted_and_published(self):
        import json
        n0 = len(self.published)
        self.assertIn(b" 200 ", self.post(json.dumps(BEACON).encode()))
        self.assertEqual(len(self.published), n0 + 1)
        lines = [json.loads(x) for x in self.jsonl.read_text().splitlines()]
        mine = [r for r in lines if r.get("key") == EKEY]
        self.assertEqual(mine[-1]["last_modified"], BEACON["last_modified"])

    def test_rejected_beacons_persist_nothing(self):
        import json
        before = self.jsonl.read_text().splitlines()
        self.assertIn(b" 400 ", self.post(json.dumps({**BEACON, "phase": "dancing"}).encode()))
        self.assertIn(b" 400 ", self.post(json.dumps({**HEARTBEAT, "channel": "Phone"}).encode()))
        self.assertEqual(self.jsonl.read_text().splitlines(), before)


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

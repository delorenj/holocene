"""The uploaded fact the proxy publishes must satisfy the Bloodbank contract and match the watcher's memo id."""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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

    def client_event(self, body: bytes):
        head = (f"POST /upload/client-event HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\n"
                f"Content-Type: application/json\r\nUser-Agent: HoloceneAuto/0.9.0\r\nConnection: close\r\n\r\n").encode()
        return self.raw(head + body).split(b"\r\n")[0]

    def test_memo_tied_speech_decisions_are_published_and_mic_ones_only_logged(self):
        import json
        n0 = len(self.published)
        mid = mc.memo_id_for(KEY)
        start = {"action": "start", "kind": "ack", "id": f"ack-{mid}", "seq": 4, "reason": "waited_ms=3", "mic": "idle",
                 "at": 1760990100123, "mono_ms": 5512, "memo_id": mid}
        self.assertIn(b" 200 ", self.client_event(json.dumps({"event": "speech", "key": KEY, "speech": start}).encode()))
        self.assertIn(b" 200 ", self.client_event(json.dumps({"event": "speech", "speech": {**start, "action": "queued"}}).encode()))
        mic = {"action": "mic", "kind": "", "id": "", "seq": 0, "reason": "recording", "mic": "recording", "at": 1760990100200}
        self.assertIn(b" 200 ", self.client_event(json.dumps({"event": "speech", "key": KEY, "speech": mic}).encode()))
        new = self.published[n0:]
        self.assertEqual(len(new), 1)  # queued is bookkeeping, mic names no utterance: both log only
        env, key = new[0]
        self.assertEqual((env["type"], env["correlationid"], key), ("bloodbank.audio.memo.notified", mid, KEY))
        d = env["data"]
        self.assertEqual((d["utterance"], d["decision"], d["reason"], d["recording"], d["seq"]), ("ack", "start", "waited_ms=3", False, 4))
        self.assertEqual(d["device_at"], "2025-10-20T19:55:00.123Z")
        self.assertEqual((d["s3_key"], d["target_agent_id"], d["client_user_agent"]), (KEY, "holocene-pm", "HoloceneAuto/0.9.0"))
        # a decision the proxy cannot read is 202 and publishes nothing
        self.assertIn(b" 202 ", self.client_event(json.dumps({"event": "speech", "speech": {"action": "explode"}}).encode()))
        self.assertEqual(len(self.published), n0 + 1)

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
        type(self).routes[agent] = {"ok": False, "reason": f"{agent!r} is not in the pad roster"}

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
        self.assertIn("not in the pad roster", d["error_message"])
        self.assertEqual(env["correlationid"], mc.memo_id_for(key))

    def test_an_unreadable_roster_fails_open_and_the_upload_is_accepted(self):
        type(self).routes["zz-blind"] = {"ok": None, "reason": "pad roster unreadable: /roster/roster.json"}
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
    """agent_route reads the pad roster (a directory mount, re-read on change) and never blocks on a broken check."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="up-roster-"))
        self.saved = up.PAD_ROSTER_DIR
        up.PAD_ROSTER_DIR = self.dir
        self._write(agents=[{"id": "holocene-pm"}],
                    skipped=[{"id": "off-pm", "reason": "'off-pm' has bloodbank.enabled=False (default-deny)"}])

    def tearDown(self):
        up.PAD_ROSTER_DIR = self.saved
        up._roster_cache.update(stamp=None, roster=None)

    def _write(self, agents=(), skipped=(), generated_at=None):
        gen = generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        (self.dir / "roster.json").write_text(json.dumps({"generated_at": gen, "agents": list(agents), "skipped": list(skipped)}))

    def test_a_listed_agent_is_routable(self):
        self.assertEqual(up.agent_route("holocene-pm"), {"ok": True, "reason": None})

    def test_a_skipped_id_is_refused_with_its_reason(self):
        r = up.agent_route("off-pm")
        self.assertIs(r["ok"], False)
        self.assertIn("bloodbank.enabled=False", r["reason"])

    def test_an_id_absent_from_a_fresh_roster_is_refused(self):
        r = up.agent_route("zz-new-hire")
        self.assertIs(r["ok"], False)
        self.assertIn("not in the pad roster", r["reason"])

    def test_an_id_absent_from_a_stale_roster_fails_open(self):
        old = (datetime.now(timezone.utc) - timedelta(seconds=up.ROSTER_FRESH_S + 60)).isoformat(timespec="seconds").replace("+00:00", "Z")
        self._write(agents=[{"id": "holocene-pm"}], generated_at=old)
        r = up.agent_route("zz-new-hire")
        self.assertIs(r["ok"], None)
        self.assertIn("stale", r["reason"])
        # ...but a skipped entry is positive knowledge and still refuses
        self._write(agents=[{"id": "holocene-pm"}], skipped=[{"id": "off-pm", "reason": "disabled"}], generated_at=old)
        self.assertIs(up.agent_route("off-pm")["ok"], False)

    def test_a_missing_or_unreadable_roster_fails_open(self):
        (self.dir / "roster.json").unlink()
        r = up.agent_route("holocene-pm")
        self.assertIs(r["ok"], None)
        self.assertIn("unreadable", r["reason"])
        (self.dir / "roster.json").write_text("not json")
        self.assertIs(up.agent_route("holocene-pm")["ok"], None)
        (self.dir / "roster.json").write_text(json.dumps({"agents": "oops"}))
        self.assertIs(up.agent_route("holocene-pm")["ok"], None)

    def test_a_replaced_roster_file_is_picked_up(self):
        # the roster writer os.replace()s roster.json: a new inode, which the old single-file registry mount hid
        self.assertIs(up.agent_route("zz-new-hire")["ok"], False)
        tmp = self.dir / "roster.json.tmp"
        gen = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        tmp.write_text(json.dumps({"generated_at": gen,
                                   "agents": [{"id": "holocene-pm"}, {"id": "zz-new-hire"}, {"id": "off-pm"}], "skipped": []}))
        import os
        os.replace(tmp, self.dir / "roster.json")
        self.assertIs(up.agent_route("zz-new-hire")["ok"], True)
        self.assertIs(up.agent_route("off-pm")["ok"], True)  # no longer skipped, and now listed, in the new roster


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

class SpeechFacts(unittest.TestCase):
    """audio.memo.notified: a memo-tied decision of the car's speech queue, contract- and schema-valid."""

    def test_only_start_end_halt_drop_deferred_become_facts(self):
        mid = mc.memo_id_for(KEY)
        base = {"speech_kind": "echo", "speech_id": "echo-1", "speech_reason": "recording", "mic": "recording", "device_at": 5}
        for action in ("start", "end", "halt", "drop", "deferred"):
            env = up.build_speech_envelope({**base, "speech_action": action}, mid, None, "ua")
            self.assertEqual(env["data"]["decision"], action)
            self.assertIs(env["data"]["recording"], True)
            self.assertIsNone(env["data"]["device_at"])  # 5 is not epoch milliseconds
        for action in ("queued", "ignored", "mic"):
            self.assertIsNone(up.build_speech_envelope({**base, "speech_action": action}, mid, None, "ua"))

    def test_the_fact_passes_the_bloodbank_contract_and_schema(self):
        if not BB_HOOKS.is_dir():
            self.skipTest("bloodbank repo not available")
        sys.path.insert(0, str(BB_HOOKS))
        from core import validate
        d = up.speech_decision({"action": "end", "kind": "reply", "id": "replies/x.ogg", "seq": 9, "reason": "", "mic": "idle",
                                "at": 1760990100123, "mono_ms": 7})
        env = up.build_speech_envelope(d, mc.memo_id_for(KEY), KEY, "HoloceneAuto/0.9.0")
        self.assertEqual((env["subject"], env["ordering_key"]),
                         ("bloodbank.evt.audio.memo.notified", f"memo:{mc.memo_id_for(KEY)}"))
        validate.assert_contract(env)
        try:
            validate.validate_envelope(env)
        except validate.ValidationUnavailable:
            self.skipTest("jsonschema not installed")


if __name__ == "__main__":
    unittest.main()


class SpeechDecisions(unittest.TestCase):
    def test_a_decision_is_bounded_and_typed(self):
        d = up.speech_decision({"action": "start", "kind": "reply", "id": "replies/x\n.ogg", "seq": 0, "reason": "waited_ms=3",
                                "mic": "idle", "at": 1760000000000, "mono_ms": 12, "memo_id": "11111111-1111-5111-8111-111111111111"})
        self.assertEqual(d["speech_action"], "start")
        self.assertEqual(d["speech_id"], "replies/x .ogg")
        self.assertEqual(d["device_at"], 1760000000000)
        self.assertEqual(d["memo_id"], "11111111-1111-5111-8111-111111111111")

    def test_junk_is_refused(self):
        self.assertIsNone(up.speech_decision({"action": "explode"}))
        self.assertIsNone(up.speech_decision("start"))
        self.assertNotIn("memo_id", up.speech_decision({"action": "drop", "memo_id": "../etc"}))
        self.assertNotIn("seq", up.speech_decision({"action": "drop", "seq": True}))


PUSH_MEMO = "f753985b-d3fb-5836-9db4-f9fb8e7dbe6b"


def memo_env(action, **data):
    return {"type": f"bloodbank.audio.memo.{action}", "correlationid": PUSH_MEMO, "time": "2026-10-20T19:20:45Z",
            "data": {"memo_id": PUSH_MEMO, "target_agent_id": "holocene-pm", **data}}


class PushEvents(unittest.TestCase):
    """The car's push channel: which facts become events, and what they carry."""

    def test_reply_chunk_and_progress_facts_carry_their_keys(self):
        ck = f"replies/2026/10/20/192041Z-holocene-pm-{PUSH_MEMO}-c01of03.opus"
        ev = up.push_event(memo_env("voiced", chunk=1, chunks=3, chunk_s3_key=ck,
                                    reply_s3_key=f"replies/2026/10/20/192041Z-holocene-pm-{PUSH_MEMO}.ogg", spoken_text="x" * 400))
        self.assertEqual(ev["fact"], "voiced")
        self.assertEqual((ev["chunk"], ev["chunks"], ev["chunk_s3_key"]), (1, 3, ck))
        self.assertNotIn("spoken_text", ev)  # the car needs the key, not the words
        self.assertEqual(up.push_event(memo_env("narrated", narration=2, progress_s3_key=f"progress/2026/10/20/{PUSH_MEMO}-2.ogg"))["narration"], 2)
        self.assertEqual(up.push_event(memo_env("replied", reply_s3_key="replies/2026/10/20/a.ogg"))["reply_s3_key"], "replies/2026/10/20/a.ogg")

    def test_the_pads_own_facts_and_foreign_keys_are_not_pushed(self):
        for action in ("uploaded", "notified", "played"):
            self.assertIsNone(up.push_event(memo_env(action)), action)
        ev = up.push_event(memo_env("replied", reply_s3_key="inbox/../x.ogg"))
        self.assertNotIn("reply_s3_key", ev)
        self.assertIsNone(up.push_event({"type": "bloodbank.audio.memo.replied", "data": {"memo_id": "nope"}}))
        self.assertIsNone(up.push_event("not a dict"))

    def test_agent_progress_only_for_a_memo_turn(self):
        env = {"type": "bloodbank.agent.invocation.progressed", "time": "t", "data": {"seq": 3, "text": "Reading", "context": {"memo_id": PUSH_MEMO}}}
        self.assertEqual(up.push_event(env), {"fact": "progressed", "memo_id": PUSH_MEMO, "at": "t", "seq": 3})
        self.assertIsNone(up.push_event({"type": "bloodbank.agent.invocation.progressed", "data": {"seq": 1, "context": {}}}))

    def test_a_failure_says_where(self):
        ev = up.push_event(memo_env("failed", stage="tts", error_code="vox_failed"))
        self.assertEqual((ev["stage"], ev["error_code"]), ("tts", "vox_failed"))


class PushHubBehaviour(unittest.TestCase):
    def test_fanout_replay_by_last_event_id_and_overflow(self):
        hub = up.PushHub(ring=5, max_clients=3)
        a, back = hub.subscribe(None)
        self.assertEqual(back, [])
        ids = [hub.publish({"n": i}) for i in range(7)]
        self.assertEqual(a.q.get_nowait(), (ids[0], {"n": 0}))
        # a reconnect replays only what came after its last id, from the ring (the oldest fell out of it)
        b, back = hub.subscribe(ids[3])
        self.assertEqual([e["n"] for _, e in back], [4, 5, 6])
        _, back = hub.subscribe(f"other-{3}")  # another boot: nothing to replay (and the hub is now full)
        self.assertEqual(back, [])
        self.assertIsNone(hub.subscribe(None))
        hub.unsubscribe(b)
        self.assertIsNotNone(hub.subscribe(None))
        # a client that does not read loses events and is flagged to re-poll
        for i in range(300):
            hub.publish({"n": i})
        self.assertTrue(a.overflow)

    def test_nats_protocol_loop_answers_ping_and_publishes_msgs(self):
        import io
        hub = up.PushHub()
        c, _ = hub.subscribe(None)
        body = json.dumps(memo_env("replied", reply_s3_key="replies/2026/10/20/a.ogg")).encode()
        noise = json.dumps({"type": "bloodbank.audio.memo.played", "data": {"memo_id": PUSH_MEMO}}).encode()
        stream = (b"PING\r\n" + f"MSG bloodbank.evt.audio.memo.replied 1 {len(body)}\r\n".encode() + body + b"\r\n"
                  + f"MSG bloodbank.evt.audio.memo.played 1 {len(noise)}\r\n".encode() + noise + b"\r\n")
        sent = []
        with self.assertRaises(IOError):
            up.nats_read_loop(io.BytesIO(stream), sent.append, hub)
        self.assertEqual(sent, [b"PONG\r\n"])
        _, ev = c.q.get_nowait()
        self.assertEqual((ev["fact"], ev["reply_s3_key"]), ("replied", "replies/2026/10/20/a.ogg"))
        self.assertTrue(c.q.empty())  # the pad's own played fact is not echoed


class PushStream(unittest.TestCase):
    """GET /upload/events on the real Handler: headers, hello, events, heartbeat, Last-Event-ID replay."""

    @classmethod
    def setUpClass(cls):
        import threading
        cls.old = (up.PUSH, up.PUSH_HEARTBEAT_S, up.PUSH_MAX_AGE_S)
        up.PUSH = up.PushHub()
        up.PUSH_HEARTBEAT_S = 0.3
        up.PUSH_MAX_AGE_S = 1.2
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        up.PUSH, up.PUSH_HEARTBEAT_S, up.PUSH_MAX_AGE_S = cls.old

    def stream(self, headers="", publish=()):
        import socket, threading, time as t
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(f"GET /upload/events HTTP/1.1\r\nHost: x\r\n{headers}\r\n".encode())

        def later():
            t.sleep(0.2)
            for ev in publish:
                up.PUSH.publish(ev)
        threading.Thread(target=later, daemon=True).start()
        out = b""
        while True:  # the stream ends at PUSH_MAX_AGE_S
            d = s.recv(65536)
            if not d:
                break
            out += d
        s.close()
        return out.decode()

    def test_a_stream_says_hello_then_events_then_beats_and_ends_at_its_max_age(self):
        out = self.stream(publish=[{"fact": "replied", "memo_id": PUSH_MEMO}])
        head, _, body = out.partition("\r\n\r\n")
        self.assertIn("200", head.splitlines()[0])
        self.assertIn("Content-Type: text/event-stream", head)
        self.assertIn("Cache-Control: no-cache, no-transform", head)
        self.assertTrue(body.startswith("retry: 3000\n"))
        self.assertIn("event: hello\n", body)
        self.assertRegex(body, r"id: [0-9a-f]{8}-\d+\nevent: memo\ndata: \{\"fact\":\"replied\"")
        self.assertIn("event: beat\n", body)
        self.assertLess(body.index("event: hello"), body.index("event: memo"))

    def test_a_reconnect_with_last_event_id_gets_what_it_missed(self):
        first = up.PUSH.publish({"fact": "received", "memo_id": PUSH_MEMO})
        up.PUSH.publish({"fact": "transcribed", "memo_id": PUSH_MEMO})
        out = self.stream(headers=f"Last-Event-ID: {first}\r\n")
        self.assertIn('"fact":"transcribed"', out)
        self.assertNotIn('"fact":"received"', out)
        self.assertIn('"replayed":1', out)


class PlayedChunks(unittest.TestCase):
    def test_a_chunked_playback_says_so_on_the_played_fact(self):
        key = f"replies/2026/10/20/192041Z-holocene-pm-{PUSH_MEMO}.ogg"
        env = up.build_playback_envelope({"reply_key": key, "phase": "started", "chunks": 3}, "ua")
        self.assertEqual(env["data"]["chunks"], 3)
        self.assertNotIn("chunks", up.build_playback_envelope({"reply_key": key, "phase": "started", "chunks": True}, "ua")["data"])

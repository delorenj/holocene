"""The uploaded fact the proxy publishes must satisfy the Bloodbank contract and match the watcher's memo id."""
import json
import sys
import time
import tempfile
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "inbox-watcher"))
import upload_proxy as up  # noqa: E402
import memo_common as mc  # noqa: E402

up.WAKE_URL = ""  # no test PUT should reach for a real watcher; WakeHint passes its own URL
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

    def test_a_reply_speech_decision_settles_that_replys_claim_not_the_memos_newest(self):
        # Recheck 2026-10-22: _speech settled claims by memo only, so a quick answer's late start/end could land on its
        # follow-up's claim. The reply utterance's id is its reply key; pass it through.
        import json
        from unittest import mock
        mid = mc.memo_id_for(KEY)
        rkey = f"replies/2026/10/22/063546Z-holocene-pm-{mid}.ogg"
        start = {"action": "start", "kind": "reply", "id": rkey, "seq": 9, "reason": "", "mic": "idle",
                 "at": 1760990100123, "mono_ms": 5512, "memo_id": mid}
        with mock.patch.object(up.CLAIMS, "played", return_value=True) as played:
            self.client_event(json.dumps({"event": "speech", "key": KEY, "speech": start}).encode())
            self.client_event(json.dumps({"event": "speech", "key": KEY, "speech": {**start, "id": "chunk-1"}}).encode())
        self.assertEqual(played.call_args_list[0], mock.call(mid, "start", reply_key=rkey))
        self.assertEqual(played.call_args_list[1], mock.call(mid, "start", reply_key=None), "not a reply key: the memo")

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


class DevicePresence(unittest.TestCase):
    """Which car sent a memo, and is its push stream live: the watcher leaves the Earshot phone copy out then."""
    DEV = "6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f"

    def test_a_device_and_host_are_taken_only_when_well_formed(self):
        self.assertEqual(up.clean_device(self.DEV, "car"), (self.DEV, "car"))
        self.assertEqual(up.clean_device("a b", "car"), (None, "car"))
        self.assertEqual(up.clean_device(self.DEV, "phone"), (self.DEV, None))
        self.assertEqual(up.clean_device(None, None), (None, None))

    def test_a_car_is_live_while_its_stream_is_open_and_a_moment_after(self):
        p = up.Presence(grace_s=30)
        p.sent(PUSH_MEMO, self.DEV, "car")
        self.assertFalse(p.live(self.DEV, now=1000)["live"], "no stream yet")
        p.opened(self.DEV, "car", now=1000)
        p.opened(self.DEV, "car", now=1100)  # a reconnect overlapping the old stream
        p.closed(self.DEV, now=1180)
        self.assertTrue(p.live(self.DEV, now=1190)["live"], "one stream still open")
        p.closed(self.DEV, now=1200)
        self.assertTrue(p.live(self.DEV, now=1225)["live"], "recycled at max age, reconnecting")
        self.assertFalse(p.live(self.DEV, now=1231)["live"], "gone (switched off)")
        ans = up.presence_answer(PUSH_MEMO, None, p, lookup=lambda k: None)
        self.assertEqual((ans["device"], ans["host"], ans["source"]), (self.DEV, "car", "upload"))

    def test_presence_answer_falls_back_to_the_inbox_objects_metadata_and_says_car_live(self):
        p = up.Presence()
        p.opened(self.DEV, "car")
        seen = []
        ans = up.presence_answer(PUSH_MEMO, KEY, p, lookup=lambda k: seen.append(k) or (self.DEV, "car"))
        self.assertEqual(seen, [KEY])
        self.assertTrue(ans["car_live"])
        self.assertEqual(ans["source"], "s3_metadata")
        self.assertEqual(p.sender(PUSH_MEMO), (self.DEV, "car"), "remembered after the lookup")

    def test_a_browser_or_an_unknown_sender_is_never_a_live_car(self):
        p = up.Presence()
        p.sent(PUSH_MEMO, self.DEV, "browser")
        p.opened(self.DEV, "browser")
        self.assertFalse(up.presence_answer(PUSH_MEMO, None, p)["car_live"])
        other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
        ans = up.presence_answer(other, None, up.Presence(), lookup=lambda k: None)
        self.assertEqual((ans["car_live"], ans["device"], ans["source"]), (False, None, None))

    def test_the_memo_map_is_bounded(self):
        p = up.Presence(memos_max=3)
        for i in range(5):
            p.sent(f"{i:08d}-0000-5000-8000-000000000000", self.DEV, "car")
        self.assertIsNone(p.sender("00000000-0000-5000-8000-000000000000"))
        self.assertIsNotNone(p.sender("00000004-0000-5000-8000-000000000000"))

    def test_the_uploaded_fact_names_the_sender(self):
        env = up.build_uploaded_envelope(KEY, 10, "audio/ogg", "ua", 1.0, None, self.DEV, "car")
        self.assertEqual((env["data"]["device_id"], env["data"]["device_host"]), (self.DEV, "car"))
        self.assertNotIn("device_id", up.build_uploaded_envelope(KEY, 10, "audio/ogg", "ua", 1.0)["data"])

    def test_stored_sender_reads_the_s3_metadata(self):
        import subprocess as sp
        real = up.subprocess.run
        out = json.dumps({"status": "success", "metadata": {"X-Amz-Meta-Holocene-Device": self.DEV, "X-Amz-Meta-Holocene-Host": "car"}})
        up.subprocess.run = lambda *a, **k: sp.CompletedProcess(a, 0, out + "\n", "")
        try:
            self.assertEqual(up.stored_sender(KEY), (self.DEV, "car"))
        finally:
            up.subprocess.run = real
        up.subprocess.run = lambda *a, **k: sp.CompletedProcess(a, 1, "", "no such object")
        try:
            self.assertIsNone(up.stored_sender(KEY))
        finally:
            up.subprocess.run = real


class PresenceHttp(unittest.TestCase):
    """The push stream registers the device; /upload/presence answers for a memo it sent."""
    DEV = "6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f"

    @classmethod
    def setUpClass(cls):
        import threading
        cls.old = (up.PUSH, up.PRESENCE, up.PUSH_HEARTBEAT_S, up.PUSH_MAX_AGE_S)
        up.PUSH = up.PushHub()
        up.PRESENCE = up.Presence(grace_s=0.2)
        up.PUSH_HEARTBEAT_S = 0.2
        up.PUSH_MAX_AGE_S = 1.0
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        up.PUSH, up.PRESENCE, up.PUSH_HEARTBEAT_S, up.PUSH_MAX_AGE_S = cls.old

    def get(self, path):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as r:
            return r.status, json.loads(r.read())

    def test_a_car_with_an_open_stream_is_live_for_its_memo_and_not_after(self):
        import socket, time as t
        up.PRESENCE.sent(PUSH_MEMO, self.DEV, "car")
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(f"GET /upload/events?device={self.DEV}&host=car HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        s.recv(4096)  # headers + hello: the stream is open
        t.sleep(0.1)
        code, body = self.get(f"/upload/presence?memo={PUSH_MEMO}")
        self.assertEqual(code, 200)
        self.assertTrue(body["car_live"], body)
        self.assertEqual(body["streams"], 1)
        while s.recv(65536):  # the stream ends at its max age
            pass
        s.close()
        t.sleep(0.4)
        self.assertFalse(self.get(f"/upload/presence?memo={PUSH_MEMO}")[1]["car_live"])
        self.assertIn("devices", self.get("/upload/presence")[1])

    def test_a_bad_memo_id_is_refused(self):
        import urllib.error, urllib.request
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/upload/presence?memo=nope", timeout=5)
        self.assertEqual(e.exception.code, 400)


class ReplyClaims(unittest.TestCase):
    """Who speaks a reply in the cabin: the car that sent the memo, or the phone's Earshot copy. Exactly one."""
    DEV = "6f1c2a9e-1b2c-4d5e-8f90-0a1b2c3d4e5f"
    RKEY = f"replies/2026/10/21/101500Z-holocene-pm-{PUSH_MEMO}.ogg"

    def test_a_car_that_holds_the_reply_keeps_the_phone_out_until_its_lease_lapses(self):
        c = up.ReplyClaims(lease_s=20, boot_at=0)
        self.assertTrue(c.car(PUSH_MEMO, "hold", self.DEV, now=100)["ok"])
        self.assertFalse(c.take(PUSH_MEMO, now=110)["ok"], "the car holds it (queued behind a recording)")
        self.assertTrue(c.car(PUSH_MEMO, "hold", self.DEV, now=115)["ok"], "renewed")
        self.assertFalse(c.take(PUSH_MEMO, now=130)["ok"])
        v = c.view(PUSH_MEMO, now=130)
        self.assertEqual((v["car"], v["car_holds"], v["held_ever"], v["lease_left_s"]), ("held", True, True, 5.0))
        # switched off: no renewal, the lease lapses and the phone takes it
        self.assertTrue(c.take(PUSH_MEMO, now=136)["ok"])
        self.assertEqual(c.view(PUSH_MEMO, now=136)["owner"], "phone")
        # the car comes back: its hold and its start are refused, it leaves the reply to the phone
        self.assertFalse(c.car(PUSH_MEMO, "hold", self.DEV, now=200)["ok"])
        self.assertFalse(c.car(PUSH_MEMO, "start", self.DEV, now=201)["ok"])

    def test_a_car_that_started_the_reply_owns_it_for_good(self):
        c = up.ReplyClaims(lease_s=20, boot_at=0)
        c.car(PUSH_MEMO, "hold", now=100)
        c.car(PUSH_MEMO, "start", now=101)
        self.assertFalse(c.take(PUSH_MEMO, now=500)["ok"], "a start is final, whatever the lease")
        c.car(PUSH_MEMO, "end", now=130)
        self.assertEqual(c.view(PUSH_MEMO, now=500)["car"], "ended")
        self.assertFalse(c.take(PUSH_MEMO, now=900)["ok"])

    def test_nobody_claimed_the_phone_takes_it_and_a_late_beacon_is_a_conflict(self):
        c = up.ReplyClaims(boot_at=0)
        self.assertTrue(c.offer(PUSH_MEMO, now=100)["ok"])
        self.assertTrue(c.take(PUSH_MEMO, now=112)["ok"])
        self.assertTrue(c.take(PUSH_MEMO, now=113)["ok"], "a second take is the same answer")
        self.assertFalse(c.played(PUSH_MEMO, "start", now=120), "a page from before claims played it anyway")
        c2 = up.ReplyClaims(boot_at=0)
        self.assertTrue(c2.played(PUSH_MEMO, "start", now=100), "an unclaimed reply the car plays is the car's")
        self.assertFalse(c2.take(PUSH_MEMO, now=200)["ok"])

    def test_the_claims_are_bounded(self):
        c = up.ReplyClaims(memos_max=3, boot_at=0)
        for i in range(5):
            c.car(f"{i:08d}-0000-5000-8000-000000000000", "start")
        self.assertIsNone(c.view("00000000-0000-5000-8000-000000000000")["owner"])
        self.assertEqual(c.view("00000004-0000-5000-8000-000000000000")["owner"], "car")

    def test_claim_request_validates_and_the_offer_names_the_sender_and_pushes_a_one_file_reply(self):
        c, hub, p = up.ReplyClaims(boot_at=0), up.PushHub(), up.Presence()
        p.sent(PUSH_MEMO, self.DEV, "car")
        self.assertEqual(up.claim_request("x", c)[0], 400)
        self.assertEqual(up.claim_request({"by": "car", "action": "take", "memo_id": PUSH_MEMO}, c)[0], 400)
        self.assertEqual(up.claim_request({"by": "car", "action": "hold", "memo_id": "nope"}, c)[0], 400)
        other = f"replies/2026/10/21/101500Z-holocene-pm-0c7effbf-a048-5aa3-84f4-0d12650848cc.ogg"
        self.assertEqual(up.claim_request({"by": "car", "action": "hold", "memo_id": PUSH_MEMO, "reply_key": other}, c)[0], 400)
        code, ans = up.claim_request({"by": "watcher", "action": "offer", "reply_key": self.RKEY, "key": KEY, "announce": True},
                                     c, p, lookup=lambda k: None, hub=hub)
        self.assertEqual((code, ans["ok"], ans["sender_host"], ans["sender_device"], ans["announced"]), (200, True, "car", self.DEV, True))
        hub2 = up.PushHub()
        code, ans = up.claim_request({"by": "watcher", "action": "offer", "reply_key": self.RKEY}, c, p, lookup=lambda k: None, hub=hub2)
        self.assertNotIn("announced", ans, "a chunked reply was already pushed chunk by chunk")
        self.assertEqual(hub2.published, 0)
        [(_, _, ev)] = hub._ring
        self.assertEqual((ev["fact"], ev["memo_id"], ev["reply_s3_key"], ev["agent"]), ("offered", PUSH_MEMO, self.RKEY, "holocene-pm"))
        code, ans = up.claim_request({"by": "car", "action": "hold", "reply_key": self.RKEY, "device": self.DEV}, c)
        self.assertEqual((code, ans["ok"], ans["owner"], ans["device"]), (200, True, "car", self.DEV))
        self.assertFalse(up.claim_request({"by": "watcher", "action": "take", "memo_id": PUSH_MEMO}, c)[1]["ok"])

    def test_the_watcher_gives_the_phones_take_back_and_the_car_may_hold_the_reply_again(self):
        # Finding 1: the phone took the reply, then its Earshot drop failed: nobody would ever play it.
        c, hub = up.ReplyClaims(boot_at=0), up.PushHub()
        c.offer(PUSH_MEMO, now=100)
        self.assertTrue(c.take(PUSH_MEMO, now=112)["ok"])
        self.assertFalse(c.car(PUSH_MEMO, "hold", self.DEV, now=113)["ok"], "the car gave way")
        ans = c.release(PUSH_MEMO, now=120)
        self.assertEqual((ans["ok"], ans["owner"], ans["released"]), (True, None, True))
        self.assertTrue(c.car(PUSH_MEMO, "hold", self.DEV, now=121)["ok"], "released: the car holds it again")
        self.assertFalse(c.take(PUSH_MEMO, now=122)["ok"], "and its live hold keeps the phone out")
        # a reply the car owns (started) is never released by the watcher
        other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
        c.car(other, "start", self.DEV, now=100)
        self.assertEqual(c.release(other, now=101)["owner"], "car")
        self.assertEqual(c.view(other, now=101)["car"], "started")
        # over HTTP: validated, answers, and tells the car (push) that the reply is its again
        c2 = up.ReplyClaims(boot_at=0)
        c2.take(PUSH_MEMO, now=1)
        code, ans = up.claim_request({"by": "watcher", "action": "release", "reply_key": self.RKEY}, c2, hub=hub)
        self.assertEqual((code, ans["ok"], ans["owner"]), (200, True, None))
        [(_, _, ev)] = hub._ring
        self.assertEqual((ev["fact"], ev["memo_id"], ev["reply_s3_key"]), ("released", PUSH_MEMO, self.RKEY))
        self.assertEqual(up.claim_request({"by": "car", "action": "release", "memo_id": PUSH_MEMO}, c2)[0], 200)

    def test_a_car_that_cannot_play_the_reply_releases_its_hold_and_the_phone_takes_it_at_once(self):
        # Finding 3: the car held the reply, then playback failed before any audio: the phone must not wait out the lease.
        c = up.ReplyClaims(boot_at=0, settle_s=0)
        c.car(PUSH_MEMO, "hold", self.DEV, now=100)
        self.assertFalse(c.take(PUSH_MEMO, now=105)["ok"], "a live hold keeps the phone out")
        ans = c.car(PUSH_MEMO, "release", self.DEV, now=106)
        self.assertEqual((ans["ok"], ans["car"], ans["car_holds"], ans["owner"], ans["held_ever"]), (True, None, False, None, True))
        self.assertTrue(c.take(PUSH_MEMO, now=107)["ok"], "no lease left to wait for")
        # a reply the car already started cannot be released: it was heard
        other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
        c.car(other, "start", self.DEV, now=100)
        self.assertEqual(c.car(other, "release", self.DEV, now=101)["car"], "started")
        self.assertFalse(c.take(other, now=900)["ok"])

    def test_a_restart_forgets_nothing_a_take_or_a_start(self):
        # The review's double play: claims lived only in memory, so a restart let the phone take a reply the car was
        # speaking, or let a car that came back speak one the phone had already played.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = str(Path(d) / "claims.json")
            a = up.ReplyClaims(state_file=f, boot_at=0)
            other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
            a.offer(PUSH_MEMO, now=100)
            self.assertTrue(a.take(PUSH_MEMO, now=112)["ok"], "no car: the phone took it")
            a.car(other, "hold", self.DEV, now=100)
            a.car(other, "start", self.DEV, now=101)
            b = up.ReplyClaims(state_file=f, boot_at=200, settle_s=10)
            self.assertEqual(b.loaded, 2)
            self.assertFalse(b.car(PUSH_MEMO, "hold", self.DEV, now=203)["ok"], "the take survived the restart")
            self.assertFalse(b.car(PUSH_MEMO, "start", self.DEV, now=204)["ok"])
            self.assertFalse(b.take(other, now=500)["ok"], "the car's start survived the restart")
            self.assertEqual(b.view(other, now=500)["device"], self.DEV)
            # a claim older than CLAIM_KEEP_S is not read back
            c = up.ReplyClaims(state_file=f, boot_at=101 + up.CLAIM_KEEP_S + 1)
            self.assertEqual(c.loaded, 1, "only the take, touched at 112, is still young enough")

    def test_a_hold_live_across_a_restart_still_keeps_the_phone_out(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = str(Path(d) / "claims.json")
            up.ReplyClaims(state_file=f, boot_at=0).car(PUSH_MEMO, "hold", self.DEV, now=100)
            b = up.ReplyClaims(state_file=f, boot_at=101, settle_s=10)
            self.assertFalse(b.take(PUSH_MEMO, now=115)["ok"], "the lease from before the restart still runs")
            self.assertTrue(b.view(PUSH_MEMO, now=115)["car_holds"])

    def test_every_take_waits_out_the_settle_window_after_a_start(self):
        # A blank or stale memory after a restart: a car that played the reply on its live hold while the proxy was down
        # re-sends its start within a few seconds of the proxy answering; the take must not beat it.
        c = up.ReplyClaims(boot_at=1000, settle_s=10, lease_s=20)
        c.offer(PUSH_MEMO, now=1001)
        ans = c.take(PUSH_MEMO, now=1002)
        self.assertEqual((ans["ok"], ans.get("settling"), ans["settling_s"], ans["owner"]), (False, True, 8.0, None))
        self.assertTrue(c.car(PUSH_MEMO, "start", self.DEV, now=1004)["ok"], "the car's re-sent start lands first")
        self.assertFalse(c.take(PUSH_MEMO, now=1020)["ok"], "and it is the car's for good")
        # no car at all: the phone gets it once the window is over
        other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
        self.assertFalse(c.take(other, now=1009.9)["ok"])
        ans = c.take(other, now=1010)
        self.assertEqual((ans["ok"], ans["owner"], ans["settling_s"]), (True, "phone", 0.0))

    def test_an_unreadable_state_file_starts_empty_and_settles(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "claims.json"
            f.write_text("{not json")
            with mock.patch.object(up, "log") as lg:
                c = up.ReplyClaims(state_file=str(f), boot_at=100, settle_s=10)
            self.assertIsNone(c.loaded)
            self.assertEqual(lg.call_args[0][0], "claims_load_failed")
            self.assertFalse(c.take(PUSH_MEMO, now=105)["ok"])
            self.assertTrue(c.car(PUSH_MEMO, "hold", now=106)["ok"])
            self.assertEqual(json.loads(f.read_text())["memos"][PUSH_MEMO]["car"], "held", "written through")
            self.assertFalse(Path(f"{f}.tmp").exists())
            # a write that fails is logged, and the answer still goes out
            c.state_file = str(Path(d) / "gone" / "claims.json")
            with mock.patch.object(up, "log") as lg:
                self.assertTrue(c.car(PUSH_MEMO, "start", now=107)["ok"])
            self.assertEqual(lg.call_args[0][0], "claims_save_failed")

    def test_a_follow_up_reply_of_the_same_memo_has_its_own_claim(self):
        # Review 2026-10-22: claims were per memo. The car played the quick answer (car=ended), so the follow-up of the
        # same memo read "car spoke it" at once and the phone's take was refused: with the car switched off by then, the
        # follow-up was heard nowhere, while trace and /voice said it was spoken.
        c = up.ReplyClaims(lease_s=20, boot_at=0)
        quick = self.RKEY
        follow = f"replies/2026/10/21/102800Z-holocene-pm-{PUSH_MEMO}.ogg"
        c.offer(PUSH_MEMO, now=100, reply_key=quick)
        c.car(PUSH_MEMO, "hold", self.DEV, now=101, reply_key=quick)
        c.car(PUSH_MEMO, "start", self.DEV, now=102, reply_key=quick)
        c.car(PUSH_MEMO, "end", self.DEV, now=110, reply_key=quick)
        self.assertFalse(c.take(PUSH_MEMO, now=130, reply_key=quick)["ok"], "the quick answer is the car's")
        # the car is switched off; 13 minutes later the follow-up's reply is offered
        ans = c.offer(PUSH_MEMO, now=900, reply_key=follow)
        self.assertEqual((ans["car"], ans["owner"], ans["held_ever"], ans["reply_key"]), (None, None, False, follow))
        ans = c.take(PUSH_MEMO, now=921, reply_key=follow)
        self.assertEqual((ans["ok"], ans["owner"]), (True, "phone"), "nobody holds the follow-up: the phone takes it")
        # a car that comes back later is refused the follow-up, and keeps its quick answer
        self.assertFalse(c.car(PUSH_MEMO, "hold", self.DEV, now=950, reply_key=follow)["ok"])
        self.assertEqual(c.view(PUSH_MEMO, now=950, reply_key=quick)["car"], "ended")
        # a late beacon for the quick answer touches only the quick answer's claim
        self.assertTrue(c.played(PUSH_MEMO, "end", now=951, reply_key=quick))
        self.assertEqual(c.view(PUSH_MEMO, now=951, reply_key=follow)["owner"], "phone")

    def test_a_live_car_still_keeps_its_follow_up_and_a_memo_only_request_gets_the_newest_claim(self):
        c = up.ReplyClaims(lease_s=20, boot_at=0)
        quick, follow = self.RKEY, f"replies/2026/10/21/102800Z-holocene-pm-{PUSH_MEMO}.ogg"
        c.offer(PUSH_MEMO, now=100, reply_key=quick)
        self.assertTrue(c.take(PUSH_MEMO, now=121, reply_key=quick)["ok"], "car off: the phone took the quick answer")
        c.offer(PUSH_MEMO, now=900, reply_key=follow)
        self.assertTrue(c.car(PUSH_MEMO, "hold", self.DEV, now=901, reply_key=follow)["ok"], "the car is back: it holds the follow-up")
        self.assertFalse(c.take(PUSH_MEMO, now=915, reply_key=follow)["ok"])
        # memo only (a watcher or pad from before per-reply claims): the newest claim answers...
        self.assertEqual(c.view(PUSH_MEMO, now=916)["reply_key"], follow)
        self.assertFalse(c.take(PUSH_MEMO, now=916)["ok"])
        # ...except the old pad's "does the phone still have it" look, which gets the claim the phone owns, so it never
        # takes back a quick answer the phone already played
        v = c.view(PUSH_MEMO, now=922, prefer_phone=True)
        self.assertEqual((v["owner"], v["reply_key"]), ("phone", quick))

    def test_the_module_starts_on_a_v2_state_file_keyed_by_reply(self):
        # 2026-10-22: the live arbiter was built at import before parse_reply_key existed; the first restart after a
        # reply-keyed claim was written crash-looped the proxy (NameError), taking car uploads down.
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "claims.json"
            f.write_text(json.dumps({"v": 2, "memos": {self.RKEY: {"owner": "car", "car": "ended", "touched": 9e12,
                                                                    "memo_id": PUSH_MEMO, "reply_key": self.RKEY}}}))
            here = Path(up.__file__).resolve().parent
            r = subprocess.run([sys.executable, "-B", "-c", "import upload_proxy as up; print(up.CLAIMS.loaded)"],
                               cwd=here, env={**__import__("os").environ, "CLAIM_STATE_FILE": str(f)},
                               capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            self.assertEqual(r.stdout.strip().splitlines()[-1], "1")

    def test_a_v1_state_file_keyed_by_memo_still_loads(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "claims.json"
            other = "0c7effbf-a048-5aa3-84f4-0d12650848cc"
            f.write_text(json.dumps({"v": 1, "memos": {
                PUSH_MEMO: {"owner": "phone", "touched": 100, "phone_at": 100},
                other: {"owner": "car", "car": "ended", "touched": 100},
                "nope": {"owner": "car", "touched": 100}}}))
            c = up.ReplyClaims(state_file=str(f), boot_at=200, settle_s=0)
            self.assertEqual(c.loaded, 2)
            self.assertEqual(c.view(PUSH_MEMO, now=200)["owner"], "phone", "memo-only lookups still see a v1 claim")
            self.assertFalse(c.car(PUSH_MEMO, "hold", now=201)["ok"])
            # a reply named by its key is its own claim: a new reply of the other memo is free
            fresh = f"replies/2026/10/21/103000Z-holocene-pm-{other}.ogg"
            self.assertTrue(c.take(other, now=202, reply_key=fresh)["ok"])
            doc = json.loads(f.read_text())
            self.assertEqual(doc["v"], 2)
            self.assertEqual((doc["memos"][fresh]["memo_id"], doc["memos"][fresh]["reply_key"]), (other, fresh))
            b = up.ReplyClaims(state_file=str(f), boot_at=300, settle_s=0)
            self.assertEqual(b.view(other, now=300, reply_key=fresh)["owner"], "phone")


class ReplyClaimsHttp(unittest.TestCase):
    """POST /upload/claim and GET /upload/claim?memo= over HTTP, and the playback beacon counting as the car's start."""

    @classmethod
    def setUpClass(cls):
        import threading
        cls.old = (up.CLAIMS, up.EMIT_FACTS)
        up.CLAIMS = up.ReplyClaims(boot_at=0)
        up.EMIT_FACTS = False
        cls.srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        up.CLAIMS, up.EMIT_FACTS = cls.old

    def call(self, path, body=None):
        import urllib.request, urllib.error
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method="POST" if body is not None else "GET",
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                raw = r.read()
                return r.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            return e.code, None

    def test_claim_round_trip(self):
        memo = "a1b2c3d4-0000-5000-8000-000000000001"
        rkey = f"replies/2026/10/21/101500Z-holocene-pm-{memo}.ogg"
        self.assertEqual(self.call(f"/upload/claim?memo={memo}")[1]["owner"], None)
        code, ans = self.call("/upload/claim", {"by": "car", "action": "hold", "reply_key": rkey})
        self.assertEqual((code, ans["ok"], ans["car_holds"]), (200, True, True))
        self.assertFalse(self.call("/upload/claim", {"by": "watcher", "action": "take", "memo_id": memo})[1]["ok"])
        self.assertEqual(self.call("/upload/claim", {"by": "nobody", "action": "take", "memo_id": memo})[0], 400)
        self.assertEqual(self.call("/upload/claim?memo=nope")[0], 400)

    def test_claim_requests_name_the_reply(self):
        memo = "a1b2c3d4-0000-5000-8000-000000000003"
        quick = f"replies/2026/10/21/101500Z-holocene-pm-{memo}.ogg"
        follow = f"replies/2026/10/21/102800Z-holocene-pm-{memo}.ogg"
        self.call("/upload/claim", {"by": "car", "action": "end", "reply_key": quick})
        self.assertEqual(self.call("/upload/claim", {"by": "watcher", "action": "offer", "reply_key": follow})[1]["car"], None)
        self.assertEqual(self.call(f"/upload/claim?memo={memo}&reply={urllib.parse.quote(quick)}")[1]["car"], "ended")
        code, ans = self.call(f"/upload/claim?memo={memo}&reply={urllib.parse.quote(follow)}")
        self.assertEqual((code, ans["car"], ans["reply_key"]), (200, None, follow))
        other = "replies/2026/10/21/102800Z-holocene-pm-0c7effbf-a048-5aa3-84f4-0d12650848cc.ogg"
        self.assertEqual(self.call(f"/upload/claim?memo={memo}&reply={urllib.parse.quote(other)}")[0], 400)
        # the playback beacon of the follow-up is the car's start of the follow-up, not of the memo's first reply
        self.assertEqual(self.call("/upload/played", {"reply_key": follow, "phase": "started"})[0], 200)
        self.assertEqual(self.call(f"/upload/claim?memo={memo}&reply={urllib.parse.quote(follow)}")[1]["car"], "started")

    def test_a_playback_beacon_is_the_cars_start(self):
        memo = "a1b2c3d4-0000-5000-8000-000000000002"
        rkey = f"replies/2026/10/21/101600Z-holocene-pm-{memo}.ogg"
        self.assertEqual(self.call("/upload/played", {"reply_key": rkey, "phase": "started"})[0], 200)
        self.assertEqual(self.call(f"/upload/claim?memo={memo}")[1]["car"], "started")
        self.assertFalse(self.call("/upload/claim", {"by": "watcher", "action": "take", "memo_id": memo})[1]["ok"])


class WakeHint(unittest.TestCase):
    """The proxy tells the inbox watcher a memo landed (key, size, md5 etag), fail-open, off the PUT's own path."""

    @classmethod
    def setUpClass(cls):
        import http.server, threading
        cls.got, cls.delay = [], 0.0

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                cls.got.append((self.path, json.loads(self.rfile.read(n))))
                time.sleep(cls.delay)
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/wake"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.got.clear()
        type(self).delay = 0.0

    def wait(self, n=1):
        for _ in range(100):
            if len(self.got) >= n:
                return
            time.sleep(0.02)

    def test_hint_carries_what_a_listing_would(self):
        import hashlib
        body = b"OggS" + b"\x01" * 500
        h = up.build_wake_hint(KEY, body, "dev-12345678", "car")
        self.assertEqual((h["key"], h["size"], h["etag"], h["memo_id"], h["device"], h["host"]),
                         (KEY, len(body), hashlib.md5(body).hexdigest(), mc.memo_id_for(KEY), "dev-12345678", "car"))
        self.assertTrue(h["uploaded_at"].endswith("Z"))

    def test_a_large_body_sends_no_etag(self):
        self.assertNotIn("etag", up.build_wake_hint(KEY, b"\0" * (up.WAKE_ETAG_MAX_BYTES + 1)))

    def test_the_hint_is_posted(self):
        up.wake_watcher_async(KEY, b"OggS1234", None, None, url=self.url)
        self.wait()
        self.assertEqual(self.got[0][0], "/wake")
        self.assertEqual(self.got[0][1]["key"], KEY)

    def test_only_inbox_memos_with_an_agent_are_hinted(self):
        up.wake_watcher_async("replies/2026/10/15/x.ogg", b"OggS", url=self.url)
        up.wake_watcher_async("inbox/loose.ogg", b"OggS", url=self.url)
        up.wake_watcher_async(KEY, b"OggS", url="")
        time.sleep(0.2)
        self.assertEqual(self.got, [])

    def test_a_slow_watcher_never_delays_the_caller(self):
        type(self).delay = 1.0
        t0 = time.time()
        up.wake_watcher_async(KEY, b"OggS1234", url=self.url)
        self.assertLess(time.time() - t0, 0.1)
        self.wait()  # let the request land before the next test clears the list

    def test_a_dead_watcher_is_fail_open(self):
        up.wake_watcher_async(KEY, b"OggS1234", url="http://127.0.0.1:9/wake")
        time.sleep(0.3)  # nothing raised into the caller

    def test_a_put_hints_the_watcher_after_the_object_is_stored(self):
        import socketserver, threading
        real_mc, real_url = up.MC_BIN, up.WAKE_URL
        up.MC_BIN, up.WAKE_URL, up.EMIT_FACTS = "/bin/true", self.url, False
        real_route = up.agent_route
        up.agent_route = lambda agent: {"ok": True, "reason": None}
        srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            import socket
            body = b"OggS" + b"\0" * 64
            s = socket.create_connection(("127.0.0.1", srv.server_address[1]), timeout=5)
            s.sendall((f"PUT /upload/{KEY} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\nContent-Type: audio/ogg\r\n"
                       f"X-Holocene-Device: abcdef0123456789\r\nX-Holocene-Host: car\r\nConnection: close\r\n\r\n").encode() + body)
            out = b""
            while True:
                d = s.recv(4096)
                if not d:
                    break
                out += d
            s.close()
            self.assertIn(b" 200 ", out.split(b"\r\n")[0])
            self.wait()
            self.assertEqual((self.got[0][1]["key"], self.got[0][1]["size"], self.got[0][1]["host"]), (KEY, len(body), "car"))
        finally:
            srv.shutdown()
            up.MC_BIN, up.WAKE_URL, up.agent_route = real_mc, real_url, real_route

    def test_a_failed_store_sends_no_hint(self):
        import threading, socket
        real_mc, real_url = up.MC_BIN, up.WAKE_URL
        up.MC_BIN, up.WAKE_URL = "/bin/false", self.url
        real_route = up.agent_route
        up.agent_route = lambda agent: {"ok": True, "reason": None}
        srv = up.ThreadedServer(("127.0.0.1", 0), up.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            body = b"OggS" + b"\0" * 64
            s = socket.create_connection(("127.0.0.1", srv.server_address[1]), timeout=5)
            s.sendall((f"PUT /upload/{KEY} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
            while s.recv(4096):
                pass
            s.close()
            time.sleep(0.2)
            self.assertEqual(self.got, [])
        finally:
            srv.shutdown()
            up.MC_BIN, up.WAKE_URL, up.agent_route = real_mc, real_url, real_route

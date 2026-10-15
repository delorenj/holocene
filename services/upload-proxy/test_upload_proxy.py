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


if __name__ == "__main__":
    unittest.main()

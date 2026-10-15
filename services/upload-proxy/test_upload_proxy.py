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


if __name__ == "__main__":
    unittest.main()

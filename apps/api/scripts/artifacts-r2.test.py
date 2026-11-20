"""Isolated pagination/enrichment contract for the read-only R2 adapter."""
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name("artifacts-r2.py")


class FakeBody:
    def __init__(self, value):
        self.value = value

    def read(self, limit):
        return self.value[:limit]


class FakeClient:
    def get_paginator(self, operation):
        assert operation == "list_objects_v2"
        return self

    def paginate(self, Bucket):
        assert Bucket == "video"
        yield {"Contents": [{"Key": "aaaabbbbccccdddd/gallery", "LastModified": FakeDate(), "Size": 40},
                            {"Key": "aaaabbbbccccdddd/gallery.json", "LastModified": FakeDate(), "Size": 80}]}
        yield {"Contents": [{"Key": "eeeeffffaaaabbbb/member", "LastModified": FakeDate(), "Size": 60},
                            {"Key": "eeeeffffaaaabbbb/movie.mp4", "LastModified": FakeDate(), "Size": 100}]}

    def get_object(self, Bucket, Key):
        if Key.endswith("gallery.json"):
            return {"Body": FakeBody(b'{"title":"Campaign","items":[] }')}
        if Key.endswith("member"):
            raise ValueError("optional page enrichment failed")
        return {"Body": FakeBody(b"<meta name='description' content='hello'>")}

    def head_object(self, Bucket, Key):
        return {"Metadata": {"title": "Gallery page", "published": "2026-11-18T12:00:00Z"}}


class FakeDate:
    def isoformat(self):
        return "2026-11-20T12:00:00+00:00"


class AdapterTest(unittest.TestCase):
    def test_all_pages_retained_and_optional_failure_isolated(self):
        boto3 = types.ModuleType("boto3")
        setattr(boto3, "client", lambda *args, **kwargs: FakeClient())
        botocore = types.ModuleType("botocore")
        config = types.ModuleType("botocore.config")
        setattr(config, "Config", lambda **kwargs: kwargs)
        spec = importlib.util.spec_from_file_location("artifacts_r2", SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"boto3": boto3, "botocore": botocore, "botocore.config": config}), patch.dict("os.environ", {
            "R2_VIDEO_ENDPOINT": "https://example.invalid", "R2_VIDEO_ACCESS_KEY_ID": "fixture", "R2_VIDEO_SECRET_ACCESS_KEY": "fixture"}):
            spec.loader.exec_module(module)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                module.main()
        result = json.loads(stdout.getvalue())
        self.assertEqual(len(result["objects"]), 4)
        self.assertEqual(result["enrichment"]["aaaabbbbccccdddd/gallery"]["title"], "Gallery page")
        self.assertEqual(result["enrichment"]["aaaabbbbccccdddd/gallery.json"]["manifest"]["title"], "Campaign")
        self.assertTrue(result["enrichment"]["eeeeffffaaaabbbb/member"]["enrichmentFailed"])
        self.assertNotIn("secret", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()

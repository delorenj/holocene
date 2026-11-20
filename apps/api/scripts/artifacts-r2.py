#!/usr/bin/env python3
"""Read-only R2 listing for Holocene. Secrets are read by op, never emitted."""
import json
import os
import subprocess
import sys
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

ITEM = "yd5qvshbstx2kfn2gualwm2jwa"


def secret(field):
    return os.environ.get("R2_VIDEO_" + field.upper()) or subprocess.check_output(
        ["op", "read", f"op://DeLoSecrets/{ITEM}/{field}"], text=True, timeout=20
    ).strip()


class Description(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and (attrs.get("name") or "").lower() == "description":
            self.text = (attrs.get("content") or "")[:1000]


def main():
    client = boto3.client(
        "s3", endpoint_url=secret("endpoint"), aws_access_key_id=secret("access_key_id"),
        aws_secret_access_key=secret("secret_access_key"), region_name="auto",
        config=Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 2}),
    )
    bucket = os.environ.get("R2_VIDEO_BUCKET", "video")
    objects = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        objects.extend({"key": obj["Key"], "modified": obj["LastModified"].isoformat(), "size": obj["Size"]}
                       for obj in page.get("Contents", []))
    pages = [o for o in objects if len(o["key"].split("/")) == 2 and "." not in o["key"].split("/")[1]]
    manifests = [o for o in objects if o["key"].endswith("/gallery.json")]

    def enrich(obj):
        try:
            if obj in manifests:
                body = client.get_object(Bucket=bucket, Key=obj["key"])["Body"].read(262145)
                return {"key": obj["key"], "manifest": json.loads(body) if len(body) <= 262144 else None}
            meta = client.head_object(Bucket=bucket, Key=obj["key"]).get("Metadata", {})
            description = Description()
            body = client.get_object(Bucket=bucket, Key=obj["key"])["Body"].read(262145)
            if len(body) <= 262144:
                description.feed(body.decode("utf-8", "replace"))
            return {"key": obj["key"], "title": meta.get("title"),
                    "published": meta.get("published"), "description": description.text}
        except Exception:
            return {"key": obj["key"], "enrichmentFailed": True}

    with ThreadPoolExecutor(max_workers=6) as pool:
        enriched = {entry["key"]: entry for entry in pool.map(enrich, pages + manifests)}
    print(json.dumps({"objects": objects, "enrichment": enriched}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("R2 listing unavailable", file=sys.stderr)
        sys.exit(1)

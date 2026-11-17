#!/usr/bin/env python3
"""Ephemeral loopback fixture for HOLOC-37. No real bucket, keys or beacons."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from email.utils import formatdate
from urllib.parse import urlsplit, parse_qs
from pathlib import Path
from xml.sax.saxutils import escape
import json

ROOT = Path(__file__).parent
ITEMS = ROOT / 'holoc37-items.json'
AUDIO = ROOT / 'holoc37-tone.wav'
BEACONS = ROOT / 'holoc37-beacons.jsonl'

def items():
    return json.loads(ITEMS.read_text()) if ITEMS.exists() else []

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == '/earshot':
            prefix = parse_qs(path.query).get('prefix', [''])[0]
            entries = []
            for item in items():
                if item['key'].startswith(prefix):
                    entries.append(f'<Contents><Key>{escape(item["key"])}</Key><LastModified>{item["modified"]}</LastModified><Size>{AUDIO.stat().st_size}</Size></Contents>')
            body = ('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + ''.join(entries) + '<IsTruncated>false</IsTruncated></ListBucketResult>').encode()
            self.send_response(200); self.send_header('Content-Type','application/xml'); self.send_header('Date',formatdate(usegmt=True)); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        elif path.path.startswith('/earshot/') and any(i['key'] == path.path.removeprefix('/earshot/') for i in items()):
            body = AUDIO.read_bytes(); self.send_response(200); self.send_header('Content-Type','audio/wav'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with BEACONS.open('ab') as file: file.write(body + b'\n')
        self.send_response(200); self.send_header('Content-Length','0'); self.end_headers()

    def log_message(self, fmt, *args):
        with (ROOT/'holoc37-http.log').open('a') as file: file.write(f'{datetime.now(timezone.utc).isoformat()} {fmt % args}\n')

ThreadingHTTPServer(('127.0.0.1',18737), Handler).serve_forever()

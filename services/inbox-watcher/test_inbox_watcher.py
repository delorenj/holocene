"""End-to-end state machine test with every external hop faked.

Fake mc (a directory is the bucket), fake transcribe, fake bb-emit (records the
envelope args), fake gateway journal + hermes state.db (sqlite), fake vox (local
HTTP server). Proves: baseline-on-first-start, one memo id end to end, facts
for every stage, no 'latest row' correlation, retry then failed fact, timeout.
Run: python3 -m unittest services/inbox-watcher/test_inbox_watcher.py
"""
import json
import os
import sqlite3
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="memo-test-"))
BUCKET_DIR = ROOT / "bucket"
(BUCKET_DIR / "inbox").mkdir(parents=True)
(BUCKET_DIR / "replies").mkdir(parents=True)
EMITS = ROOT / "emits.jsonl"

FAKE_MC = ROOT / "mc"
FAKE_MC.write_text(textwrap.dedent(f"""\
    #!/usr/bin/env python3
    import json, shutil, sys, os, datetime
    B = {str(BUCKET_DIR)!r}
    a = [x for x in sys.argv[1:] if not x.startswith("--") ]
    def local(p):  # delo/holocene-auto/<key> -> path
        return os.path.join(B, p.split("/", 2)[2]) if p.startswith("delo/") else p
    def info(path, rel):
        st = os.stat(path)
        return {{"status":"success","type":"file","key":rel,"size":st.st_size,
                 "lastModified": datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat()}}
    if a[0] == "ls":
        root = local(a[1])
        for dp, _, fs in os.walk(root):
            for f in sorted(fs):
                p = os.path.join(dp, f)
                print(json.dumps(info(p, os.path.relpath(p, root))))
    elif a[0] == "stat":
        p = local(a[1])
        if not os.path.exists(p):
            print(json.dumps({{"status":"error"}})); sys.exit(1)
        print(json.dumps(info(p, a[1])))
    elif a[0] == "cp":
        src, dst = local(a[1]), local(a[2])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    """))
FAKE_MC.chmod(0o755)

FAKE_TRANSCRIBE = ROOT / "transcribe"
FAKE_TRANSCRIBE.write_text(textwrap.dedent("""\
    #!/usr/bin/env python3
    import sys, json
    args = sys.argv[1:]
    out = args[args.index("--output") + 1]
    text = "" if "SILENT" in open(args[0], "rb").read().decode("latin1") else "Summarize recent work."
    open(out, "w").write("---\\nsource-audio: x\\n---\\n# Transcription: x\\n\\n" + text + "\\n")
    print(json.dumps({"mdPath": out}), file=sys.stderr)
    print('Transcription-Metadata: {"model":"large-v3","backend":"faster-whisper","duration_seconds":1.5,"language":"en","word_count":3}', file=sys.stderr)
    print(out)
    """))
FAKE_TRANSCRIBE.chmod(0o755)

FAKE_BB = ROOT / "bb-emit"
FAKE_BB.write_text(textwrap.dedent(f"""\
    #!/usr/bin/env python3
    import sys, json, uuid, os
    a = sys.argv[1:]
    body = sys.stdin.read()
    if os.path.exists({str(ROOT / "bb-fail")!r}):
        print("bb-emit: publish FAILED (nats down)", file=sys.stderr); sys.exit(1)
    rec = {{"argv": a, "data": json.loads(body or "{{}}")}}
    open({str(EMITS)!r}, "a").write(json.dumps(rec) + "\\n")
    t = a[a.index("--type") + 1]
    print(json.dumps({{"id": str(uuid.uuid4()), "type": t, "subject": "x", "command_id": (a[a.index("--command-id")+1] if "--command-id" in a else None),
                      "idempotency_key": "ik-1"}}))
    """))
FAKE_BB.chmod(0o755)

GATEWAY_DB = ROOT / "gateway.sqlite3"
HERMES = ROOT / "profiles"
(HERMES / "holocene-pm").mkdir(parents=True)

class Vox(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        body = json.dumps({"audio_url": f"http://127.0.0.1:{self.server.server_port}/a.ogg", "engine": "fakevox"}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        blob = b"OggS" + b"\0" * 400
        self.send_response(200); self.send_header("Content-Length", str(len(blob))); self.end_headers(); self.wfile.write(blob)

vox = HTTPServer(("127.0.0.1", 0), Vox)
threading.Thread(target=vox.serve_forever, daemon=True).start()

os.environ.update({
    "MC_BIN": str(FAKE_MC), "BB_EMIT": str(FAKE_BB), "MEMO_TRANSCRIBE": str(FAKE_TRANSCRIBE),
    "MEMO_STATE_DIR": str(ROOT / "state"), "MEMO_GATEWAY_DB": str(GATEWAY_DB),
    "MEMO_HERMES_PROFILES": str(HERMES), "MEMO_VOX_URL": f"http://127.0.0.1:{vox.server_port}",
    "MEMO_CANDYSTORE_URL": "http://127.0.0.1:9", "MEMO_NATS_MONITOR_URL": "http://127.0.0.1:9",
    "MEMO_AGENT_TIMEOUT_S": "3", "MEMO_AWAIT_POLL_S": "0", "MEMO_MAX_ATTEMPTS": "2",
})
sys.path.insert(0, str(Path(__file__).resolve().parent))
import memo_common as mc_  # noqa: E402
import inbox_watcher as iw  # noqa: E402

# backoffs would make the test slow
iw.BACKOFF = {k: 0 for k in iw.BACKOFF}


def put(key, content=b"OggS fake audio"):
    p = BUCKET_DIR / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)


def facts():
    out = []
    if EMITS.exists():
        for line in EMITS.read_text().splitlines():
            r = json.loads(line)
            t = r["argv"][r["argv"].index("--type") + 1]
            out.append((t, r))
    return out


def journal(command_id, profile, state="completed", outcome="success"):
    db = sqlite3.connect(GATEWAY_DB)
    db.execute("CREATE TABLE IF NOT EXISTS executions (command_id TEXT PRIMARY KEY, envelope_digest TEXT, profile TEXT,"
               " state TEXT, outcome TEXT, started_events TEXT, terminal_events TEXT, rejection_reason TEXT,"
               " rejected_at TEXT, created_at TEXT, updated_at TEXT)")
    db.execute("INSERT OR REPLACE INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (command_id, "d", profile, state, outcome, "[]", "[]", None, None, "2026-10-15T00:00:00Z", "2026-10-15T00:00:05Z"))
    db.commit(); db.close()


def hermes_session(profile, chat_id, reply):
    p = HERMES / profile / "state.db"
    db = sqlite3.connect(p)
    db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, chat_id TEXT, session_key TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,"
               " content TEXT, timestamp REAL, active INTEGER DEFAULT 1)")
    db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (f"s-{chat_id}", "bloodbank", time.time(), chat_id, f"agent:{profile}:bloodbank:dm:{chat_id}"))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "user", "prompt", 1))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "assistant", reply, 2))
    db.commit(); db.close()


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        put("inbox/holocene-pm/2026/10/14/old.ogg")  # exists BEFORE first start -> baseline
        cls.state = iw.State(Path(os.environ["MEMO_STATE_DIR"]))
        cls.w = iw.Watcher(cls.state)
        cls.w.baseline_if_first_start()

    def tick_until(self, pred, n=40):
        for _ in range(n):
            self.w.tick()
            if pred():
                return
            time.sleep(0.05)
        self.fail("condition never met; memos=" + json.dumps(self.state.memos, default=str)[:800])

    def test_01_baseline_never_replays_old_memos(self):
        self.assertEqual(self.state.memos["inbox/holocene-pm/2026/10/14/old.ogg"]["status"], "baseline")
        self.w.tick()
        self.assertEqual(facts(), [])

    def test_02_full_journey_one_id(self):
        key = "inbox/holocene-pm/2026/10/15/20261015T201500Z.ogg"
        mid = mc_.memo_id_for(key)
        self.assertEqual(mid, str(uuid.uuid5(uuid.NAMESPACE_URL, "s3://holocene-auto/" + key)))
        put(key)
        m = None

        def at_await():
            nonlocal m
            m = self.state.memos.get(key)
            return m and m["stage"] == "await_agent"
        self.tick_until(at_await)
        cid = m["command_id"]
        # another profile's newer row must NOT satisfy this memo
        journal(str(uuid.uuid4()), "holocene-pm")
        self.w.tick()
        self.assertEqual(m["stage"], "await_agent")
        journal(cid, "holocene-pm")
        hermes_session("holocene-pm", mid, "Here is the summary of recent work. It went well.")
        self.tick_until(lambda: m["status"] == "done")
        types = [t.replace("bloodbank.", "") for t, _ in facts()]
        self.assertEqual(types, ["audio.memo.received", "audio.memo.transcribed", "cmd.agent.invocation.start",
                                 "audio.memo.dispatched", "audio.memo.replied"])
        for t, r in facts():
            a = r["argv"]
            self.assertEqual(a[a.index("--correlation") + 1], mid)
        cmd = facts()[2][1]
        self.assertEqual(cmd["data"]["target_agent_id"], "holocene-pm")
        self.assertEqual(cmd["data"]["prompt"], "Summarize recent work.")
        self.assertEqual(cmd["data"]["context"]["memo_id"], mid)
        self.assertEqual(cmd["data"]["thread_id"], mid)
        self.assertTrue(m["reply_key"].startswith("replies/") and m["reply_key"].endswith(f"-holocene-pm-{mid}.ogg"))
        self.assertTrue((BUCKET_DIR / m["reply_key"]).exists())
        replied = facts()[-1][1]["data"]
        self.assertEqual(replied["reply_s3_key"], m["reply_key"])
        self.assertEqual(replied["tts_engine"], "fakevox")

    def test_03_agent_timeout_emits_failed_not_retryable(self):
        key = "inbox/holocene-pm/2026/10/15/timeout.ogg"
        put(key)
        n0 = len(facts())
        self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed", n=200)
        failed = [r for t, r in facts()[n0:] if t == "bloodbank.audio.memo.failed"][-1]["data"]
        self.assertEqual(failed["stage"], "agent_reply")
        self.assertIs(failed["retryable"], False)

    def test_04_empty_transcript_fails_terminally(self):
        key = "inbox/holocene-pm/2026/10/15/silent.ogg"
        put(key, b"OggS SILENT")
        self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed")
        f = [r for t, r in facts() if t == "bloodbank.audio.memo.failed" and r["data"]["s3_key"] == key][-1]["data"]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("transcribe", "empty_transcript", False))

    def test_05_dispatch_failure_retries_then_fails(self):
        key = "inbox/holocene-pm/2026/10/15/nonats.ogg"
        put(key)
        (ROOT / "bb-fail").write_text("x")
        try:
            # received/transcribed facts are queued in the outbox, dispatch fails twice
            self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed", n=60)
            self.assertGreater(len(self.state.data["outbox"]), 0)
        finally:
            (ROOT / "bb-fail").unlink()
        self.w.tick()  # outbox flushes once NATS is back
        self.assertEqual(self.state.data["outbox"], [])

    def test_06_agent_in_unknown_path_is_skipped(self):
        key = "inbox/stray.ogg"
        put(key)
        self.w.tick()
        self.assertEqual(self.state.memos[key]["status"], "skipped")

    def test_07_helpers(self):
        self.assertEqual(iw.parse_transcript("---\na: b\n---\n# T\n\nhello there\n"), "hello there")
        self.assertEqual(iw.clean_for_speech("**Done** see `x` https://a.b/c", 100), "Done see x link")
        self.assertLessEqual(len(iw.clean_for_speech("word " * 300, 50)), 54)
        self.assertEqual(mc_.agent_from_key("inbox/33god-pm/2026/10/15/a.ogg"), "33god-pm")
        self.assertIsNone(mc_.agent_from_key("inbox/a.ogg"))

    def test_08_listing_survives_mc_prefix_quirk(self):
        """mc sometimes reports key relative to the bucket ("inbox/<agent>/...") instead of the prefix."""
        import subprocess
        from unittest import mock
        line = lambda k: json.dumps({"status": "success", "type": "file", "key": k, "size": 5,
                                     "lastModified": "2026-10-15T12:00:00Z"})
        out = "\n".join([line("inbox/33god-pm/2026/10/15/a.ogg"), line("holocene-pm/2026/10/15/b.ogg")])
        fake = subprocess.CompletedProcess([], 0, stdout=out, stderr="")
        with mock.patch.object(mc_, "mc", return_value=fake):
            keys = [o["key"] for o in mc_.s3_list_inbox()]
        self.assertEqual(keys, ["inbox/33god-pm/2026/10/15/a.ogg", "inbox/holocene-pm/2026/10/15/b.ogg"])


if __name__ == "__main__":
    unittest.main()

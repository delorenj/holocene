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

FAKE_FFPROBE = ROOT / "ffprobe"
FAKE_FFPROBE.write_text(textwrap.dedent("""\
    #!/usr/bin/env python3
    import sys
    data = open(sys.argv[-1], "rb").read().decode("latin1")
    if "GARBAGE" in data:
        print("Invalid data found when processing input", file=sys.stderr); sys.exit(1)
    print("0.2" if "TINY" in data else "9.0")
    """))
FAKE_FFPROBE.chmod(0o755)

# ffmpeg -af volumedetect: DEADMIC = a microphone that delivered no sound (the corked emulator capture, 2026-10-16)
FAKE_FFMPEG = ROOT / "ffmpeg"
FAKE_FFMPEG.write_text(textwrap.dedent("""\
    #!/usr/bin/env python3
    import sys
    args = sys.argv[1:]
    data = open(args[args.index("-i") + 1], "rb").read().decode("latin1")
    if "NOFFMPEGOUT" in data:
        print("Output file #0 does not contain any stream", file=sys.stderr); sys.exit(1)
    mean, peak = ("-83.3", "-73.4") if "DEADMIC" in data else ("-31.0", "-20.1")
    print("[Parsed_volumedetect_0 @ 0x1] n_samples: 305280", file=sys.stderr)
    print(f"[Parsed_volumedetect_0 @ 0x1] mean_volume: {mean} dB", file=sys.stderr)
    print(f"[Parsed_volumedetect_0 @ 0x1] max_volume: {peak} dB", file=sys.stderr)
    """))
FAKE_FFMPEG.chmod(0o755)

REGISTRY = ROOT / "agents-registry.yaml"
REGISTRY.write_text(textwrap.dedent("""\
    schema_version: 1
    agents:
      holocene-pm:
        display_name: Holocene PM
        profile_name: holocene-pm
        bloodbank: {enabled: true, gateway_scope: fleet, target_agent_id: holocene-pm}
      off-pm:
        display_name: Off PM
        profile_name: off-pm
        bloodbank: {enabled: false, gateway_scope: fleet, target_agent_id: off-pm}
    """))

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
    "MEMO_FFPROBE": str(FAKE_FFPROBE), "MEMO_FFMPEG": str(FAKE_FFMPEG), "MEMO_AGENT_REGISTRY": str(REGISTRY), "MEMO_RETRY_BUDGET_S": "0.4",
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
               " rejected_at TEXT, created_at TEXT, updated_at TEXT, lane TEXT)")
    db.execute("INSERT OR REPLACE INTO executions (command_id, envelope_digest, profile, state, outcome, started_events,"
               " terminal_events, rejection_reason, rejected_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
               (command_id, "d", profile, state, outcome, "[]", "[]", None, None, "2026-10-15T00:00:00Z", "2026-10-15T00:00:05Z"))
    db.commit(); db.close()


def hermes_session(profile, chat_id, reply, prompt=None):
    p = HERMES / profile / "state.db"
    db = sqlite3.connect(p)
    db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, chat_id TEXT, session_key TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,"
               " content TEXT, timestamp REAL, active INTEGER DEFAULT 1)")
    db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (f"s-{chat_id}", "bloodbank", time.time(), chat_id, f"agent:{profile}:bloodbank:dm:{chat_id}"))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "user", prompt if prompt is not None else iw.VOICE_PREFIX + "Summarize recent work.", 1))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "assistant", reply, 2))
    db.commit(); db.close()


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        put("inbox/holocene-pm/2026/10/14/old.ogg")  # exists BEFORE first start -> baseline
        cls.state = iw.State(Path(os.environ["MEMO_STATE_DIR"]))
        cls.w = iw.Watcher(cls.state)
        cls.w.baseline_if_first_start()

    def tick_until(self, pred, n=120):
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
        # a human is waiting: the memo rides the interactive lane (invoke), not the batch lane (start)
        self.assertEqual(types, ["audio.memo.received", "audio.memo.transcribed", "cmd.agent.invocation.invoke",
                                 "audio.memo.dispatched", "audio.memo.replied"])
        dispatched = facts()[3][1]["data"]
        self.assertEqual((dispatched["lane"], dispatched["lane_reason"]), ("interactive", None))
        self.assertEqual(m["lane"], "interactive")
        for t, r in facts():
            a = r["argv"]
            self.assertEqual(a[a.index("--correlation") + 1], mid)
        cmd = facts()[2][1]
        self.assertEqual(cmd["data"]["target_agent_id"], "holocene-pm")
        self.assertEqual(cmd["data"]["prompt"], iw.VOICE_PREFIX + "Summarize recent work.")
        self.assertTrue(iw.VOICE_PREFIX)
        self.assertEqual(cmd["data"]["context"]["memo_id"], mid)
        self.assertEqual(cmd["data"]["thread_id"], mid)
        self.assertTrue(m["reply_key"].startswith("replies/") and m["reply_key"].endswith(f"-holocene-pm-{mid}.ogg"))
        self.assertTrue((BUCKET_DIR / m["reply_key"]).exists())
        replied = facts()[-1][1]["data"]
        self.assertEqual(replied["reply_s3_key"], m["reply_key"])
        self.assertEqual(replied["tts_engine"], "fakevox")
        self.assertIs(replied["prompt_match"], True)
        # the reply key is deterministic per memo: a retried upload overwrites instead of duplicating
        self.assertEqual(m["reply_key"].split("/")[-1].split("Z-", 1)[1], f"holocene-pm-{mid}.ogg")

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
        # audible audio that Whisper found no words in: say so, with the levels
        self.assertEqual((f["audio_max_dbfs"], f["audio_mean_dbfs"]), (-20.1, -31.0))
        self.assertIn("audible (max -20 dBFS, mean -31 dBFS over 9.0 s) but no words recognised", f["error_message"])

    def test_04b_a_silent_recording_fails_before_whisper_naming_the_microphone(self):
        key = "inbox/holocene-pm/2026/10/15/deadmic.ogg"
        put(key, b"OggS DEADMIC")
        n0 = len(facts())
        # a transcription that is spent anyway would drop a marker file: the fake whisper must never run
        self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed")
        new = [(t, r["data"]) for t, r in facts()[n0:] if r["data"].get("s3_key") == key]
        self.assertEqual([t.split(".")[-1] for t, _ in new], ["received", "failed"])  # no transcribed, no dispatched
        f = new[-1][1]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("transcribe", "silent_audio", False))
        self.assertEqual((f["audio_max_dbfs"], f["audio_mean_dbfs"], f["audio_duration_seconds"]), (-73.4, -83.3, 9.0))
        self.assertIn("recording is silent (max -73 dBFS, mean -83 dBFS over 9.0 s)", f["error_message"])
        self.assertIn("microphone delivered no sound", f["error_message"])
        self.assertIn("mise run auto:sim:mic-check", f["error_message"])
        self.assertEqual(self.state.memos[key]["attempts"]["transcribe"], 1)  # terminal, not retried
        self.assertEqual(self.state.memos[key]["resume_stage"], "transcribe")  # memo:retry re-enters at the level check

    def test_04c_levels_ride_the_transcribed_fact(self):
        key = "inbox/holocene-pm/2026/10/15/audible.ogg"
        put(key)
        n0 = len(facts())
        self.tick_until(lambda: any(t.endswith("audio.memo.transcribed") and r["data"]["s3_key"] == key for t, r in facts()[n0:]))
        d = next(r["data"] for t, r in facts()[n0:] if t.endswith("audio.memo.transcribed") and r["data"]["s3_key"] == key)
        self.assertEqual((d["audio_max_dbfs"], d["audio_mean_dbfs"], d["audio_duration_seconds"]), (-20.1, -31.0, 1.5))

    def test_04d_levels_are_diagnostic_never_a_gate_when_unmeasurable(self):
        from unittest import mock
        self.assertIsNone(iw.silent_reason({"ok": None, "max_dbfs": None, "mean_dbfs": None}, 5))
        self.assertIsNone(iw.silent_reason({"ok": True, "max_dbfs": -59.0, "mean_dbfs": -70.0}, 5))  # quiet room, not a dead mic
        self.assertEqual(iw.silent_reason({"ok": True, "max_dbfs": -60.5, "mean_dbfs": -70.0}, 5)[0], "silent_audio")
        # ffmpeg missing: no levels, no fields, and the transcript still decides
        with mock.patch.object(mc_, "FFMPEG", "/nonexistent/ffmpeg"):
            lv = mc_.measure_levels(Path(__file__))
        self.assertEqual((lv["ok"], iw.level_fields(lv)), (None, {}))
        self.assertEqual(iw.junk_reason(" . ", 2.0, lv)[1], "transcript is empty (silence or unrecognised audio)")
        # -inf (all-zero stream) stays a finite number
        fake = mock.Mock(stderr="mean_volume: -inf dB\nmax_volume: -inf dB\n")
        with mock.patch.object(mc_.subprocess, "run", return_value=fake):
            self.assertEqual(mc_.measure_levels(Path("x")), {"ok": True, "mean_dbfs": -96.0, "max_dbfs": -96.0, "error": None})

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

    def test_06_agent_in_unknown_path_is_skipped_with_a_failed_fact(self):
        key = "inbox/stray.ogg"
        put(key)
        n0 = len(facts())
        self.w.tick()
        self.assertEqual(self.state.memos[key]["status"], "skipped")
        f = [r for t, r in facts()[n0:] if t == "bloodbank.audio.memo.failed"][-1]["data"]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("receive", "no_agent", False))

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

    def test_09_unroutable_agent_fails_before_whisper(self):
        for agent, frag in (("zz-nonexistent", "not in"), ("off-pm", "default-deny")):
            key = f"inbox/{agent}/2026/10/15/x.ogg"
            put(key)
            self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed")
            f = [r for t, r in facts() if t == "bloodbank.audio.memo.failed" and r["data"]["s3_key"] == key][-1]["data"]
            self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("dispatch", "unknown_agent", False))
            self.assertIn(frag, f["error_message"])
            self.assertNotIn("transcript", self.state.memos[key])  # failed before transcription

    def test_10_undecodable_and_tiny_audio_fail_fast_and_terminally(self):
        for name, content, code in (("garbage", b"OggS GARBAGE", "undecodable_audio"), ("tiny", b"OggS TINY", "too_short")):
            key = f"inbox/holocene-pm/2026/10/15/{name}.ogg"
            put(key, content)
            self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed")
            f = [r for t, r in facts() if t == "bloodbank.audio.memo.failed" and r["data"]["s3_key"] == key][-1]["data"]
            self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("transcribe", code, False))
            self.assertEqual(self.state.memos[key]["attempts"]["transcribe"], 1)  # not retried

    def test_11_whisper_hallucination_is_not_dispatched(self):
        self.assertEqual(iw.junk_reason("Thank you.", 2.0)[0], "garbage_transcript")
        self.assertEqual(iw.junk_reason(" . ", 2.0)[0], "empty_transcript")
        self.assertIsNone(iw.junk_reason("Status", 2.0))
        self.assertIsNone(iw.junk_reason("Thank you for the summary of the board", 2.0))

    def test_12_transcribe_timeout_scales_with_audio_and_grows_after_a_timeout(self):
        self.assertEqual(iw.transcribe_timeout(None, 0), iw.TRANSCRIBE_TIMEOUT_S)
        self.assertGreaterEqual(iw.transcribe_timeout(120, 0), 60 + 8 * 120)  # a 2 minute memo is not killed at 420 s
        self.assertGreater(iw.transcribe_timeout(120, 1), iw.transcribe_timeout(120, 0))
        self.assertLessEqual(iw.transcribe_timeout(100000, 3), iw.TRANSCRIBE_MAX_S)

    def test_13_slow_step_does_not_block_the_tick(self):
        """A long transcription runs on a worker: tick() keeps returning, discovering and writing the heartbeat."""
        import inbox_watcher as m_
        key = "inbox/holocene-pm/2026/10/15/slow.ogg"
        put(key)
        gate = threading.Event()
        orig = self.w._transcribe_work
        self.w._transcribe_work = lambda *a, **k: (gate.wait(5), orig(*a, **k))[1]
        try:
            self.tick_until(lambda: self.state.memos.get(key, {}).get("stage") == "transcribe" and key in self.w.running)
            t0 = time.time()
            for _ in range(5):
                self.w.tick()
            self.assertLess(time.time() - t0, 2.0)
            hb = json.loads((Path(os.environ["MEMO_STATE_DIR"]) / "heartbeat.json").read_text())
            self.assertTrue(any(a["key"] == key and a["running"] for a in hb["active"]))
            put("inbox/holocene-pm/2026/10/15/slow2.ogg")  # discovered while the first one is still transcribing
            self.tick_until(lambda: "inbox/holocene-pm/2026/10/15/slow2.ogg" in self.state.memos)
        finally:
            gate.set()
            self.w._transcribe_work = orig
        self.tick_until(lambda: self.state.memos[key]["stage"] != "transcribe")

    def test_14_retry_budget_outlasts_a_short_nats_outage(self):
        """dispatch retries on a time budget, not 3 attempts: the memo survives an outage and completes."""
        key = "inbox/holocene-pm/2026/10/15/outage.ogg"
        iw.RETRY_BUDGET_S = {k: 30.0 for k in iw.RETRY_BUDGET_S}
        try:
            put(key)
            (ROOT / "bb-fail").write_text("x")
            self.tick_until(lambda: self.state.memos.get(key, {}).get("attempts", {}).get("dispatch", 0) >= 4)
            self.assertEqual(self.state.memos[key]["status"], "active")
        finally:
            (ROOT / "bb-fail").unlink()
        self.tick_until(lambda: self.state.memos[key]["stage"] == "await_agent")
        self.assertEqual(self.state.memos[key]["status"], "active")
        iw.RETRY_BUDGET_S = {k: 0.4 for k in iw.RETRY_BUDGET_S}

    def test_15_failed_memo_can_be_retried_and_late_agent_is_rescued(self):
        key = "inbox/holocene-pm/2026/10/15/late.ogg"
        put(key)
        self.tick_until(lambda: self.state.memos.get(key, {}).get("status") == "failed", n=300)
        m = self.state.memos[key]
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "timeout"))
        # the agent finishes after the deadline: the late rescue speaks the reply
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Late but done.")
        self.w.last_rescue = 0
        self.tick_until(lambda: m["status"] == "done")
        self.assertTrue(m["late"])
        # memo:retry: a control file revives a failed memo at its resume stage
        k2 = "inbox/holocene-pm/2026/10/15/retryme.ogg"
        put(k2, b"OggS TINY")
        self.tick_until(lambda: self.state.memos.get(k2, {}).get("status") == "failed")
        ctl = Path(os.environ["MEMO_STATE_DIR"]) / "control"
        ctl.mkdir(exist_ok=True)
        (ctl / f"retry-{self.state.memos[k2]['memo_id']}").write_text("")
        self.w.tick()
        self.assertEqual(self.state.memos[k2]["status"], "active")
        self.assertEqual(self.state.memos[k2]["stage"], "transcribe")

    def test_16_state_is_written_only_when_it_changes_and_corrupt_state_recovers(self):
        d0 = ROOT / "idle-state"
        idle = iw.State(d0)
        idle.save()
        m1 = (d0 / "state.json").stat().st_mtime_ns
        time.sleep(0.02)
        idle.save()
        self.assertEqual((d0 / "state.json").stat().st_mtime_ns, m1)
        idle.memos["k"] = {"status": "done"}
        idle.save()
        self.assertNotEqual((d0 / "state.json").stat().st_mtime_ns, m1)
        d = ROOT / "corrupt-state"
        d.mkdir(exist_ok=True)
        (d / "state.json").write_text("{not json")
        st = iw.State(d)
        self.assertTrue(st.fresh)
        self.assertTrue(list(d.glob("state.corrupt-*.json")))

    def test_18_command_consumed_and_dropped_by_the_gateway_is_detected(self):
        from unittest import mock
        key = "inbox/holocene-pm/2026/10/15/dropped.ogg"
        put(key)
        empty = {"ok": True, "num_waiting": 1, "num_pending": 0, "num_ack_pending": 0}
        self.tick_until(lambda: self.state.memos.get(key, {}).get("stage") == "await_agent")
        m = self.state.memos[key]
        m["dispatched_ts"] -= 100
        m["deadline_ts"] += 1000
        with mock.patch.object(mc_, "gateway_liveness", return_value=empty), \
                mock.patch.object(mc_, "gateway_log_lines", return_value=["WARNING Terminally rejecting Bloodbank command: has no configured profile route"]):
            self.w.tick()
            self.assertEqual(m["status"], "active")  # first observation only starts the clock
            m["dropped_since"] -= 30
            self.w.tick()
        self.assertEqual((m["status"], m["failed_stage"], m["failed_code"]), ("failed", "agent", "gateway_terminated"))
        f = [r for t, r in facts() if t == "bloodbank.audio.memo.failed" and r["data"]["s3_key"] == key][-1]["data"]
        self.assertIn("Terminally rejecting", f["error_message"])
        self.assertIs(f["retryable"], False)

    def test_19_deadline_is_extended_while_the_command_is_queued(self):
        from unittest import mock
        key = "inbox/holocene-pm/2026/10/15/queued.ogg"
        put(key)
        busy = {"ok": True, "num_waiting": 0, "num_pending": 7, "num_ack_pending": 4}
        self.tick_until(lambda: self.state.memos.get(key, {}).get("stage") == "await_agent")
        m = self.state.memos[key]
        m["deadline_ts"] = time.time() - 1
        with mock.patch.object(mc_, "gateway_liveness", return_value=busy):
            self.w.tick()
        self.assertEqual(m["status"], "active")
        self.assertGreater(m["deadline_ts"], time.time())

    def test_17_pad_tiles_are_all_routable(self):
        """A tile whose agent id is not a routable registry row would silently strand every memo for it."""
        src = (Path(__file__).resolve().parents[2] / "apps/agent-pad/src/main.tsx").read_text()
        ids = __import__("re").findall(r"\{ id: '([a-z0-9-]+)', name:", src)
        self.assertGreaterEqual(len(ids), 5)
        real = Path.home() / ".hermes/agents-registry.yaml"
        if not real.exists():
            self.skipTest("no live agent registry on this machine")
        saved = mc_.REGISTRY_PATH
        mc_.REGISTRY_PATH = real
        try:
            # REGISTRY_PATH is read at call time; the test registry above is swapped out for the real one
            bad = {}
            for a in ids:
                r = mc_.registry_route(a)
                if r["ok"] is False:
                    bad[a] = r["reason"]
            self.assertEqual(bad, {})
        finally:
            mc_.REGISTRY_PATH = saved

    # ---- gateway lanes (interactive = invoke, batch = start) ----------------------------------

    def _await(self, name):
        key = f"inbox/holocene-pm/2026/10/15/{name}.ogg"
        put(key)
        self.tick_until(lambda: self.state.memos.get(key, {}).get("stage") == "await_agent")
        return key, self.state.memos[key]

    @staticmethod
    def _cmd(key):
        return [(t, r) for t, r in facts() if t.startswith("bloodbank.cmd.") and r["data"]["context"]["memo_key"] == key][-1]

    @staticmethod
    def _dispatched(key):
        return [r for t, r in facts() if t == "bloodbank.audio.memo.dispatched" and r["data"]["s3_key"] == key][-1]["data"]

    @staticmethod
    def _lanes(interactive_ok, batch_ok):
        def one(lane, ok):
            return {"ok": ok, "lane": lane, "num_waiting": 1 if ok else 0, "num_pending": 0, "num_ack_pending": 0,
                    **({"error": f"consumer for {lane} not registered"} if ok is False else {})}
        return {"interactive": one("interactive", interactive_ok), "batch": one("batch", batch_ok)}

    def _await_with(self, name, answers):
        """Run a dispatch with gateway_lanes() answering from `answers` (last answer repeats); returns (key, memo, probes)."""
        from unittest import mock
        probes = []

        def lanes():
            probes.append(1)
            return answers[min(len(probes), len(answers)) - 1]
        old_gap, iw.LANE_PROBE_GAP_S = iw.LANE_PROBE_GAP_S, 0
        try:
            with mock.patch.object(mc_, "gateway_lanes", side_effect=lanes):
                key, m = self._await(name)
        finally:
            iw.LANE_PROBE_GAP_S = old_gap
        return key, m, probes

    def test_20_interactive_consumer_down_falls_back_to_batch_loudly(self):
        # interactive has no puller but batch does (lane disabled / durable missing): batch is the better bet
        key, m, probes = self._await_with("fallback", [self._lanes(False, True)])
        self.assertGreaterEqual(len(probes), 2)  # two failed probes before giving up
        t, _ = self._cmd(key)
        self.assertEqual(t, "bloodbank.cmd.agent.invocation.start")
        d = self._dispatched(key)
        self.assertEqual((d["lane"], d["lane_reason"]), ("batch", "interactive_consumer_not_pulling"))
        self.assertEqual((m["lane"], m["lane_reason"]), ("batch", "interactive_consumer_not_pulling"))

    def test_21_one_failed_probe_is_not_enough_to_leave_the_interactive_lane(self):
        key, m, _ = self._await_with("blip", [self._lanes(False, True), self._lanes(True, True)])
        self.assertEqual(self._cmd(key)[0], "bloodbank.cmd.agent.invocation.invoke")
        self.assertEqual(self._dispatched(key)["lane"], "interactive")
        self.assertIsNone(self._dispatched(key)["lane_reason"])

    def test_21b_both_lanes_down_means_the_gateway_is_down_so_the_memo_stays_interactive(self):
        # a gateway restart leaves BOTH consumers unpulled for ~2 min; batch would queue the memo behind grooming
        key, m, probes = self._await_with("gwdown", [self._lanes(False, False)])
        self.assertGreaterEqual(len(probes), 2)
        self.assertEqual(self._cmd(key)[0], "bloodbank.cmd.agent.invocation.invoke")
        d = self._dispatched(key)
        self.assertEqual(d["lane"], "interactive")
        self.assertEqual(d["lane_reason"], "gateway_not_pulling_queued_on_interactive")
        self.assertEqual(m["lane"], "interactive")

    def test_21c_batch_unreadable_is_not_a_reason_to_leave_interactive(self):
        key, m, _ = self._await_with("batchunk", [self._lanes(False, None)])
        self.assertEqual(self._cmd(key)[0], "bloodbank.cmd.agent.invocation.invoke")

    def test_21d_an_unrecognised_memo_lane_refuses_to_start(self):
        import subprocess
        r = subprocess.run([sys.executable, "-c", "import inbox_watcher"], cwd=str(Path(iw.__file__).parent),
                           env={**os.environ, "MEMO_LANE": "bacth"}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("bad_memo_lane", r.stderr)
        ok = subprocess.run([sys.executable, "-c", "import inbox_watcher"], cwd=str(Path(iw.__file__).parent),
                            env={**os.environ, "MEMO_LANE": " Batch "}, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)

    def test_22_lane_is_pinned_to_the_command_id_across_dispatch_retries(self):
        from unittest import mock
        key = "inbox/holocene-pm/2026/10/15/pinned.ogg"
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "stage": "dispatch",
             "transcript": "Pin the lane.", "attempts": {}}
        (ROOT / "bb-fail").write_text("")  # bb-emit fails: the dispatch is retried with the same command id
        try:
            with self.assertRaises(iw.StageError):
                self.w.step_dispatch(m)
        finally:
            (ROOT / "bb-fail").unlink()
        self.assertEqual(m["lane"], "interactive")
        cid = m["command_id"]
        # the interactive consumer now disappears; the retry must NOT hop to the start subject
        old_gap, iw.LANE_PROBE_GAP_S = iw.LANE_PROBE_GAP_S, 0
        try:
            with mock.patch.object(mc_, "gateway_lanes", return_value=self._lanes(False, True)):
                self.w.step_dispatch(m)
        finally:
            iw.LANE_PROBE_GAP_S = old_gap
        self.assertEqual(m["command_id"], cid)
        self.assertEqual(self._cmd(key)[0], "bloodbank.cmd.agent.invocation.invoke")
        self.assertEqual(self._dispatched(key)["lane"], "interactive")
        self.assertIsNone(self._dispatched(key)["lane_reason"])

    def test_23_configured_batch_lane_and_pre_lane_memos_use_start(self):
        old, iw.LANE = iw.LANE, "batch"
        try:
            key, m = self._await("batchcfg")
        finally:
            iw.LANE = old
        self.assertEqual(self._cmd(key)[0], "bloodbank.cmd.agent.invocation.start")
        d = self._dispatched(key)
        self.assertEqual((d["lane"], d["lane_reason"]), ("batch", None))
        # a memo dispatched before lanes existed has no lane in the state file: it is a batch memo
        self.assertEqual(iw.memo_lane({"command_id": "c", "publish_attempted": True}), "batch")
        self.assertEqual(iw.memo_lane({"lane": "interactive"}), "interactive")

    def test_24_the_wait_is_judged_against_the_memos_own_lane(self):
        from unittest import mock
        key, m = self._await("ownlane")
        self.assertEqual(m["lane"], "interactive")
        m["deadline_ts"] = time.time() - 1
        seen = []
        # grooming has saturated the BATCH lane; the interactive lane is idle and empty
        lanes = {"interactive": {"ok": True, "lane": "interactive", "num_waiting": 1, "num_pending": 0, "num_ack_pending": 0},
                 "batch": {"ok": True, "lane": "batch", "num_waiting": 0, "num_pending": 17, "num_ack_pending": 4}}

        def liveness(lane="batch"):
            seen.append(lane)
            return lanes[lane]
        with mock.patch.object(mc_, "gateway_liveness", side_effect=liveness):
            with self.assertRaises(iw.StageError) as cm:
                self.w.step_await_agent(m)
        self.assertEqual(set(seen), {"interactive"})
        # not extended on account of batch queue depth: an interactive memo that exceeds its deadline is a real alarm
        self.assertEqual(cm.exception.code, "timeout")

    def test_25_heartbeat_reports_both_lanes(self):
        from unittest import mock
        info = {lane: {"ok": True, "lane": lane, "consumer": mc_.GATEWAY_CONSUMERS[lane], "num_waiting": 1,
                       "num_pending": 0, "num_ack_pending": 0, "max_ack_pending": 2 if lane == "interactive" else 4}
                for lane in mc_.LANES}
        probe = iw.LaneProbe(every_s=999)
        with mock.patch.object(mc_, "gateway_lanes", return_value=info):
            probe.probe_once()
        self.w.lane_probe = probe
        try:
            self.w.tick()
        finally:
            self.w.lane_probe = None
        hb = json.loads((Path(os.environ["MEMO_STATE_DIR"]) / "heartbeat.json").read_text())
        self.assertEqual(hb["lane"], "interactive")
        self.assertEqual(hb["lanes"]["interactive"]["max_ack_pending"], 2)
        self.assertEqual(hb["lanes"]["batch"]["max_ack_pending"], 4)
        self.assertIs(hb["lanes"]["interactive"]["ok"], True)


    def test_26_a_gateway_turn_timeout_is_its_own_final_outcome(self):
        """The gateway stopped the agent's turn at its per-turn wall clock: failed fact stage agent_reply /
        turn_timeout (not 'agent'), non-retryable, no reply, trace verdict names it, memo:retry sends a fresh command."""
        key = "inbox/holocene-pm/2026/10/16/slowturn.ogg"
        put(key)
        m = None

        def at_await():
            nonlocal m
            m = self.state.memos.get(key)
            return m and m["stage"] == "await_agent"
        self.tick_until(at_await)
        cid = m["command_id"]
        message = "agent turn timed out after 300s on interactive lane (limit 300s)"
        terminal = [{"type": "bloodbank.agent.invocation.failed", "data": {
            "error_code": "turn_timeout", "error_message": message, "lane": "interactive", "elapsed_seconds": 300.2,
            "timeout_seconds": 300.0, "timeout_source": "lane", "turn_stopped": True}}]
        journal(cid, "holocene-pm", outcome="failure")
        db = sqlite3.connect(GATEWAY_DB)
        try:
            db.execute("ALTER TABLE executions ADD COLUMN failure_code TEXT")
        except sqlite3.OperationalError:
            pass
        db.execute("UPDATE executions SET failure_code='turn_timeout', lane='interactive', terminal_events=? WHERE command_id=?",
                   (json.dumps(terminal), cid))
        db.commit(); db.close()
        n0 = len(facts())
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "turn_timeout"))
        failed = [r for t, r in facts()[n0:] if t == "bloodbank.audio.memo.failed"][-1]["data"]
        self.assertEqual((failed["stage"], failed["error_code"], failed["retryable"]), ("agent_reply", "turn_timeout", False))
        self.assertEqual(failed["error_message"], message)
        self.assertEqual((failed["lane"], failed["elapsed_seconds"], failed["timeout_seconds"], failed["turn_stopped"]),
                         ("interactive", 300.2, 300.0, True))
        self.assertEqual(failed["command_id"], cid)
        self.assertEqual(m["resume_stage"], "dispatch")  # not await_agent: waiting longer would never produce a reply

        import memo_trace as mt
        row = mc_.journal_row(cid)
        self.assertEqual(row["failure_code"], "turn_timeout")
        hop = mt.Hop("fact:failed[agent_reply]", mt.FAILED, None,
                     f"turn_timeout: {message} (retryable=False, attempt=1)")
        text, complete = mt.verdict([hop], {})
        self.assertFalse(complete)
        self.assertEqual(text, f"STOPPED AT agent finished: turn timeout - {message}")
        # the gateway's own failed fact alone (the watcher's has not landed yet) reads the same
        inv = mt.Hop("agent:invocation.done", mt.FAILED, None, f"invocation.failed turn_timeout: {message}")
        self.assertTrue(mt.verdict([inv], {})[0].startswith("STOPPED AT agent finished: turn timeout"))

        # memo:retry: the old command is dead; a fresh one is sent
        ctl = Path(os.environ["MEMO_STATE_DIR"]) / "control"
        ctl.mkdir(exist_ok=True)
        (ctl / f"retry-{m['memo_id']}").write_text("")
        self.w.tick()
        self.assertEqual(m["status"], "active")
        self.assertEqual(m["stage"], "dispatch")
        self.assertNotIn("command_id", m)

    def test_26b_timeout_message_is_rebuilt_when_the_fact_has_no_text(self):
        self.assertEqual(mc_.turn_timeout_message({"lane": "interactive", "elapsed_seconds": 20.1, "timeout_seconds": 20.0}),
                         "agent turn timed out after 20.1s on interactive lane (limit 20.0s)")
        self.assertIsNone(mc_.turn_timeout_data({"failure_code": None, "terminal": []}))
        self.assertEqual(mc_.turn_timeout_data({"failure_code": "turn_timeout", "terminal": []}), {"error_code": "turn_timeout"})


class LaneProbes(unittest.TestCase):
    """memo_common's two-lane view of the NATS monitor and memo_trace's lane resolution."""

    JSZ = {"account_details": [{"stream_detail": [{"name": "BLOODBANK_COMMANDS", "consumer_detail": [
        {"name": "bloodbank-hermes-gateway", "num_waiting": 0, "num_pending": 17, "num_ack_pending": 4,
         "config": {"max_ack_pending": 4}},
        {"name": "bloodbank-hermes-gateway-interactive", "num_waiting": 1, "num_pending": 0, "num_ack_pending": 0,
         "config": {"max_ack_pending": 2}}]}]}]}

    def _patched(self, body):
        from unittest import mock
        return mock.patch.object(mc_, "http_json", return_value=body)

    def test_both_lanes_come_from_one_monitor_read(self):
        with self._patched(self.JSZ) as hj:
            lanes = mc_.gateway_lanes()
        self.assertEqual(hj.call_count, 1)
        self.assertIn("config=true", hj.call_args[0][0])
        self.assertTrue(lanes["interactive"]["ok"] and lanes["batch"]["ok"])
        self.assertEqual(lanes["interactive"]["max_ack_pending"], 2)
        self.assertEqual(lanes["batch"]["num_pending"], 17)
        self.assertEqual(mc_.gateway_lanes_text(lanes),
                         "interactive: pulling, 0/2 in flight, 0 queued | batch: pulling, 4/4 in flight, 17 queued")

    def test_a_missing_interactive_consumer_is_nobody_pulling_interactive(self):
        body = json.loads(json.dumps(self.JSZ))
        body["account_details"][0]["stream_detail"][0]["consumer_detail"].pop()
        with self._patched(body):
            info = mc_.gateway_liveness("interactive")
            batch = mc_.gateway_liveness("batch")
        self.assertIs(info["ok"], False)
        self.assertTrue(batch["ok"])
        self.assertIn("NOBODY PULLING interactive", mc_.gateway_liveness_text(info, "interactive"))
        self.assertIn("batch: pulling", mc_.gateway_liveness_text(batch, "batch"))

    def test_an_unreadable_monitor_is_unknown_not_down(self):
        from unittest import mock
        with mock.patch.object(mc_, "http_json", side_effect=OSError("refused")):
            lanes = mc_.gateway_lanes()
        self.assertTrue(all(v["ok"] is None for v in lanes.values()))
        self.assertIn("unknown", mc_.gateway_lanes_text(lanes))

    def test_unpulled_registered_consumer(self):
        body = json.loads(json.dumps(self.JSZ))
        body["account_details"][0]["stream_detail"][0]["consumer_detail"][1]["num_waiting"] = 0
        with self._patched(body):
            info = mc_.gateway_liveness("interactive")
        self.assertIs(info["ok"], False)
        self.assertIn("NOBODY PULLING interactive", mc_.gateway_liveness_text(info, "interactive"))

    def test_trace_resolves_the_lane_from_the_fact_then_the_subject_then_legacy(self):
        import memo_trace as mt
        self.assertEqual(mt.lane_of({"data": {"lane": "interactive"}}), "interactive")
        self.assertEqual(mt.lane_of({"data": {"command_subject": "bloodbank.cmd.agent.invocation.invoke"}}), "interactive")
        self.assertEqual(mt.lane_of({"data": {"command_subject": "bloodbank.cmd.agent.invocation.start"}}), "batch")
        self.assertEqual(mt.lane_of({"data": {"command_id": "x"}}), "batch")  # a pre-lane fact
        self.assertEqual(mt.lane_of(None, {"lane": "interactive"}), "interactive")
        self.assertEqual(mt.lane_of(None, None, {"lane": "interactive"}), "interactive")

    def test_journal_row_carries_the_lane_when_the_column_exists(self):
        cid = str(uuid.uuid4())
        journal(cid, "holocene-pm")  # creates the table if this test runs first
        db = sqlite3.connect(GATEWAY_DB)
        db.execute("UPDATE executions SET lane='interactive' WHERE command_id=?", (cid,))
        db.commit(); db.close()
        self.assertEqual(mc_.journal_row(cid)["lane"], "interactive")

    def test_trace_names_a_silent_microphone_and_shows_levels(self):
        import memo_trace as mt
        d = {"audio_max_dbfs": -73.4, "audio_mean_dbfs": -83.3, "audio_duration_seconds": 6.38}
        self.assertEqual(mt.level_of(d), "max -73 dBFS, mean -83 dBFS over 6.4 s")
        self.assertEqual(mt.level_of({}), "")
        self.assertEqual(mt.capture_of({"capture": {"peak_dbfs": -71.2, "rms_dbfs": -80}}), "device heard peak -71 dBFS, rms -80 dBFS")
        self.assertEqual(mt.capture_of({}), "")
        detail = ("silent_audio: recording is silent (max -73 dBFS, mean -83 dBFS over 6.4 s): the microphone delivered no sound "
                  "(retryable=False, attempt=1)")
        failed = mt.Hop("fact:failed[transcribe]", mt.FAILED, None, detail)
        level = mt.Hop("audio_level", mt.FAILED, None, "max -73 dBFS  -> SILENT: no sound reached the recording | device heard peak -71 dBFS", optional=True)
        text, complete = mt.verdict([failed, level], {"watcher_record": {}})
        self.assertFalse(complete)
        self.assertTrue(text.startswith("STOPPED AT transcribe: SILENT MICROPHONE - recording is silent (max -73 dBFS"), text)
        self.assertNotIn("retryable", text)
        self.assertTrue(text.endswith("[device heard peak -71 dBFS]"), text)
        # audible-but-unrecognised keeps the ordinary verdict, with its levels
        empty = mt.Hop("fact:failed[transcribe]", mt.FAILED, None, "empty_transcript: audible (max -20 dBFS) but no words recognised (retryable=False, attempt=1)")
        self.assertTrue(mt.verdict([empty], {"watcher_record": {}})[0].startswith("STOPPED AT transcribe: empty_transcript: audible (max -20 dBFS)"))


if __name__ == "__main__":
    unittest.main()

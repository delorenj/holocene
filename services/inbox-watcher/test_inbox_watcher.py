"""End-to-end state machine test with every external hop faked.

Fake mc (a directory is the bucket), fake transcribe, fake bb-emit (records the
envelope args), fake gateway journal + hermes state.db (sqlite), fake vox (local
HTTP server). Proves: baseline-on-first-start, one memo id end to end, facts
for every stage, no 'latest row' correlation, retry then failed fact, timeout.
Run: python3 -m unittest services/inbox-watcher/test_inbox_watcher.py
"""
import json
import re
import os
import sqlite3
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import unittest.mock
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="memo-test-"))
BUCKET_DIR = ROOT / "bucket"
(BUCKET_DIR / "inbox").mkdir(parents=True)
(BUCKET_DIR / "replies").mkdir(parents=True)
EMITS = ROOT / "emits.jsonl"
MC_LOG = ROOT / "mc-cp.jsonl"          # every `mc cp` the watcher ran: {src, dst, attr}
MC_RM_LOG = ROOT / "mc-rm.jsonl"       # every `mc rm` the watcher ran: the url it removed
MC_FAIL_TXT = ROOT / "mc-fail-txt"     # while this file exists, uploading a .txt fails (the text sidecar is fail-open)
MC_PIPE_LOG = ROOT / "mc-pipe.jsonl"   # every `mc pipe` (status objects): {dst, attr}

FAKE_MC = ROOT / "mc"
FAKE_MC.write_text(textwrap.dedent(f"""\
    #!/usr/bin/env python3
    import json, shutil, sys, os, datetime, hashlib
    B = {str(BUCKET_DIR)!r}
    argv, a, attr, i = sys.argv[1:], [], None, 0
    while i < len(argv):
        if argv[i] == "--attr":    # mc cp --attr 'Content-Type="text/plain; charset=utf-8"': the value is not a path
            attr = argv[i + 1]; i += 2
        elif argv[i].startswith("--"):
            i += 1
        else:
            a.append(argv[i]); i += 1
    def local(p):  # delo/holocene-auto/<key> -> path
        return os.path.join(B, p.split("/", 2)[2]) if p.startswith("delo/") else p
    def info(path, rel):
        st = os.stat(path)
        return {{"status":"success","type":"file","key":rel,"size":st.st_size,
                 "etag": hashlib.md5(open(path, "rb").read()).hexdigest(),
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
        with open({str(MC_LOG)!r}, "a") as f:
            f.write(json.dumps({{"src": a[1], "dst": a[2], "attr": attr}}) + "\\n")
        if a[2].endswith(".txt") and os.path.exists({str(MC_FAIL_TXT)!r}):
            print("mc: <ERROR> refusing the text upload", file=sys.stderr); sys.exit(1)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    elif a[0] == "pipe":
        dst = local(a[1])
        with open({str(MC_PIPE_LOG)!r}, "a") as f:
            f.write(json.dumps({{"dst": a[1], "attr": attr}}) + "\\n")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(sys.stdin.buffer.read())
    elif a[0] == "cat":
        p = local(a[1])
        if not os.path.exists(p):
            print("mc: <ERROR> object does not exist", file=sys.stderr); sys.exit(1)
        sys.stdout.write(open(p).read())
    elif a[0] == "rm":
        with open({str(MC_RM_LOG)!r}, "a") as f:
            f.write(json.dumps({{"url": a[1]}}) + "\\n")
        p = local(a[1])
        if not os.path.exists(p):
            print("mc: <ERROR> object does not exist", file=sys.stderr); sys.exit(1)
        os.remove(p)
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
    if "concat" in args:  # joining reply chunks: the output is the inputs back to back
        names = [l.split("'")[1] for l in open(args[args.index("-i") + 1]).read().splitlines() if l.startswith("file ")]
        if any("NOJOIN" in open(n, "rb").read().decode("latin1") for n in names):
            print("concat failed", file=sys.stderr); sys.exit(1)
        with open(args[-1], "wb") as out:
            for n in names:
                out.write(open(n, "rb").read())
        sys.exit(0)
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

VOX_TEXTS = []   # every text the watcher asked the fake vox to speak, in order


class Vox(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        VOX_TEXTS.append(json.loads(self.rfile.read(int(self.headers["Content-Length"])))["text"])
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
iw.OUTBOX_RETRY_S = 0   # the pipeline tests tick fast; ReviewGuards re-enables the throttles locally
iw.SLOW_PROBE_S = 0


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


def journal_turn_timeout(command_id, lane="interactive", message=None, turn_stopped=True):
    """The gateway stopped this command's turn at its wall clock: journal completed/failure/failure_code=turn_timeout."""
    message = message or f"agent turn timed out after 300s on {lane} lane (limit 300s)"
    journal(command_id, "holocene-pm", outcome="failure")
    terminal = [{"type": "bloodbank.agent.invocation.failed", "data": {
        "error_code": "turn_timeout", "error_message": message, "lane": lane, "elapsed_seconds": 300.2,
        "timeout_seconds": 300.0, "timeout_source": "lane", "turn_stopped": turn_stopped}}]
    db = sqlite3.connect(GATEWAY_DB)
    try:
        db.execute("ALTER TABLE executions ADD COLUMN failure_code TEXT")
    except sqlite3.OperationalError:
        pass
    db.execute("UPDATE executions SET failure_code='turn_timeout', lane=?, terminal_events=? WHERE command_id=?",
               (lane, json.dumps(terminal), command_id))
    db.commit(); db.close()


def mc_rms():
    """Every object url the watcher has `mc rm`-ed so far, oldest first."""
    return [json.loads(line)["url"] for line in MC_RM_LOG.read_text().splitlines()] if MC_RM_LOG.exists() else []


def mc_cps():
    """Every `mc cp` the watcher has run so far, oldest first: {src, dst, attr}."""
    return [json.loads(line) for line in MC_LOG.read_text().splitlines()] if MC_LOG.exists() else []


def hermes_session(profile, chat_id, reply, prompt=None, ts=2):
    """A bloodbank session for `chat_id` whose last assistant message is `reply`, written at `ts` (epoch seconds)."""
    p = HERMES / profile / "state.db"
    db = sqlite3.connect(p)
    db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, chat_id TEXT, session_key TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,"
               " content TEXT, timestamp REAL, active INTEGER DEFAULT 1)")
    db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (f"s-{chat_id}", "bloodbank", time.time(), chat_id, f"agent:{profile}:bloodbank:dm:{chat_id}"))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "user", prompt if prompt is not None else iw.VOICE_PREFIX + "Summarize recent work.", ts - 1))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "assistant", reply, ts))
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
        # the same audio is mirrored into the Earshot phone channel, keyed by agent + memo id, and recorded on the fact
        self.assertTrue(m["earshot_key"].startswith("phone/") and m["earshot_key"].endswith(f"Z-holocene-pm-{mid}.ogg"))
        self.assertEqual((BUCKET_DIR / m["earshot_key"]).read_bytes(), (BUCKET_DIR / m["reply_key"]).read_bytes())
        self.assertEqual(replied["earshot_key"], m["earshot_key"])

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
        turn_timeout (not 'agent'), non-retryable, no reply, trace verdict names it, memo:retry sends a fresh command.
        (The FIRST timeout of an interactive memo escalates to the batch lane instead: see Escalation. This is the final
        outcome when that one escalation is already spent.)"""
        key = "inbox/holocene-pm/2026/10/16/slowturn.ogg"
        put(key)
        m = None

        def at_await():
            nonlocal m
            m = self.state.memos.get(key)
            return m and m["stage"] == "await_agent"
        self.tick_until(at_await)
        m["escalated"] = True  # the memo's one escalation is spent: a second turn timeout is final
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
        self.assertEqual(mt.capture_of({"capture": {"peak_dbfs": -71.2, "rms_dbfs": -80}}), "device heard peak -71 dBFS, window avg -80 dBFS")
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

    def test_trace_pad_held_silent_recording_and_send_anyway(self):
        import memo_trace as mt
        from datetime import datetime, timezone
        t = lambda sec: datetime(2026, 10, 16, 20, 29, sec, tzinfo=timezone.utc)  # noqa: E731
        held = mt.Hop("fact:failed[record]", mt.FAILED, t(18),
                      "silent_capture: no sound reached the microphone (peak -72.2 dBFS, threshold -60) (retryable=False, attempt=1)")
        text, complete = mt.verdict([held], {"watcher_record": {}})
        self.assertFalse(complete)
        self.assertTrue(text.startswith("STOPPED AT record: SILENT MICROPHONE - no sound reached the microphone (peak -72.2 dBFS"), text)
        self.assertIn("nothing was uploaded", text)
        self.assertNotIn("retryable", text)
        # "send anyway": an upload after the held-back failure supersedes it, the stage hops decide
        up = mt.Hop("fact:uploaded", mt.OK, t(25), "37082 bytes", optional=True)
        rcv = mt.Hop("fact:received", mt.MISSING, None, "no received fact")
        text, complete = mt.verdict([held, up, rcv], {"watcher_record": {}})
        self.assertTrue(text.startswith("STOPPED AT fact:received"), text)
        # while any other terminal failure still wins over a later upload
        other = mt.Hop("fact:failed[transcribe]", mt.FAILED, t(18), "empty_transcript: x (retryable=False, attempt=1)")
        self.assertTrue(mt.verdict([other, up], {"watcher_record": {}})[0].startswith("STOPPED AT transcribe: empty_transcript"))


def iso_z(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class Pacing(unittest.TestCase):
    """The loop wakes for the earliest due memo and at once when a stage finishes, never on a fixed 1 s beat."""

    def test_defaults_are_tight(self):
        self.assertLessEqual(iw.AWAIT_POLL_S, 0.5)

    def test_sleep_for_is_capped_by_the_earliest_due_memo_and_the_next_listing(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="pace-"))))
        self.assertEqual(w.sleep_for(10), iw.TICK_S)
        self.assertAlmostEqual(w.sleep_for(0.3), 0.3, places=2)
        w.s.memos["k"] = {"key": "k", "status": "active", "stage": "await_agent", "next_at": time.time() + 0.2}
        with unittest.mock.patch.object(w, "active", return_value=[w.s.memos["k"]]):
            self.assertLess(w.sleep_for(10), 0.25)
            w.running.add("k")  # a step already running on a worker is not "due"
            self.assertEqual(w.sleep_for(10), iw.TICK_S)
        self.assertEqual(w.sleep_for(-5), 0.05)

    def test_a_finished_stage_wakes_the_loop(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="pace-"))))
        iw.WAKE.clear()
        w.done_stage({"memo_id": "m", "key": "k", "agent": "a", "stage": "agent"}, "agent", "reply")
        self.assertTrue(iw.WAKE.is_set())
        iw.WAKE.clear()


class ReviewGuards(unittest.TestCase):
    """d5500f0 review: slow probes are rate-limited per memo, a blocked outbox is not retried every tick."""

    def test_a_running_journal_row_never_asks_candystore(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="guard-"))))
        row = {"state": "running", "outcome": None, "profile": "holocene-pm"}
        with unittest.mock.patch.object(iw.mc_, "journal_row", return_value=row), \
                unittest.mock.patch.object(iw.mc_, "candystore_events", return_value=[]) as cs:
            self.assertEqual(w.agent_status({"memo_id": "m", "command_id": "c"})["state"], "running")
        cs.assert_not_called()

    @unittest.mock.patch.object(iw, "SLOW_PROBE_S", 5.0)
    def test_candystore_is_asked_at_most_every_slow_probe_interval(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="guard-"))))
        m = {"memo_id": "m", "command_id": "c"}
        with unittest.mock.patch.object(iw.mc_, "journal_row", return_value=None), \
                unittest.mock.patch.object(iw.mc_, "candystore_events", return_value=[]) as cs:
            for _ in range(5):
                self.assertEqual(w.agent_status(m)["state"], "pending")
            self.assertEqual(cs.call_count, 1)
            m["cs_checked_ts"] -= iw.SLOW_PROBE_S
            w.agent_status(m)
            self.assertEqual(cs.call_count, 2)

    @unittest.mock.patch.object(iw, "OUTBOX_RETRY_S", 5.0)
    def test_a_blocked_outbox_waits_before_the_next_try(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="guard-"))))
        w.s.data["outbox"] = [{"memo_id": "m", "action": "received"}]
        with unittest.mock.patch.object(w, "_emit_raw", side_effect=RuntimeError("nats down")) as emit:
            w.flush_outbox()
            w.flush_outbox()
            self.assertEqual(emit.call_count, 1)
            w.outbox_blocked_at -= iw.OUTBOX_RETRY_S
            w.flush_outbox()
            self.assertEqual(emit.call_count, 2)

    def test_listing_runs_outside_the_lock(self):
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="guard-"))))
        held = []

        def listing(timeout=60):
            held.append(w.mu._is_owned())
            return []
        with unittest.mock.patch.object(iw.mc_, "s3_list_inbox", side_effect=listing):
            w.tick()
        self.assertEqual(held, [False])


class PromptIntegrity(unittest.TestCase):
    """HOLOC-12: a prompt is never sent shortened, the object that is transcribed is the one that was discovered, and a
    memo held for an unroutable agent can be retried from the start. Memos are driven one at a time on a private State."""

    def setUp(self):
        self.before = EMITS.read_text() if EMITS.exists() else ""
        self.state = iw.State(Path(tempfile.mkdtemp(prefix="memo-pi-")))
        self.w = iw.Watcher(self.state)
        self.keys = []

    def tearDown(self):
        EMITS.write_text(self.before)  # the Pipeline tests count every fact in this shared log
        for k in self.keys:
            (BUCKET_DIR / k).unlink(missing_ok=True)

    def upload(self, name, content=b"OggS fake audio", agent="holocene-pm"):
        key = f"inbox/{agent}/2026/10/18/{name}.ogg"
        put(key, content)
        self.keys.append(key)
        return key

    def discover(self, key):
        self.w.discover(([o for o in mc_.s3_list_inbox() if o["key"] == key], None))
        return self.state.memos[key]

    def tick_until(self, pred, n=120):
        for _ in range(n):
            self.w.tick(discover=False)
            if pred():
                return
            time.sleep(0.05)
        self.fail("condition never met; memos=" + json.dumps(self.state.memos, default=str)[:800])

    def transcribed(self, key, text):
        """A memo at the dispatch stage holding `text` as its transcript, as _transcribe_apply leaves it."""
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "next_at": 0.0,
             "status": "active", "stage": "transcribe"}
        self.state.memos[key] = m
        self.w._transcribe_apply(m, {"text": text, "meta": {}, "took": 0.1, "audio_s": 5.0, "levels": {}})
        return m

    @staticmethod
    def sent_prompts(key):
        return [r["data"]["prompt"] for t, r in facts() if t.startswith("bloodbank.cmd.") and r["data"]["context"]["memo_key"] == key]

    def failed_fact(self, key):
        return [r["data"] for t, r in facts() if t == "bloodbank.audio.memo.failed" and r["data"]["s3_key"] == key][-1]

    # ---- 1. no silent truncation -------------------------------------------------------------

    def test_a_long_transcript_is_kept_whole_and_dispatched_whole(self):
        key = self.upload("long")
        text = " ".join(f"word{i}" for i in range(5000))  # about 44k chars: the old slice cut at 20000
        self.assertGreater(len(text), 40000)
        m = self.transcribed(key, text)
        self.assertEqual(m["transcript"], text)
        self.assertEqual(m["prompt"], iw.VOICE_PREFIX + text)
        self.assertEqual(m["prompt_sha256"], iw.hashlib.sha256(m["prompt"].encode()).hexdigest())
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual(self.sent_prompts(key), [iw.VOICE_PREFIX + text])
        dispatched = [r["data"] for t, r in facts() if t == "bloodbank.audio.memo.dispatched" and r["data"]["s3_key"] == key][-1]
        self.assertEqual(dispatched["prompt_sha256"], m["prompt_sha256"])
        self.assertEqual(dispatched["prompt_chars"], len(iw.VOICE_PREFIX + text))

    def test_a_transcript_over_the_cap_is_held_not_cut(self):
        key = self.upload("huge")
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "status": "active", "stage": "transcribe"}
        self.state.memos[key] = m
        with unittest.mock.patch.object(iw, "MAX_TRANSCRIPT_CHARS", 100):
            with self.assertRaises(iw.StageError) as ctx:
                self.w._transcribe_apply(m, {"text": "x" * 101, "meta": {}, "took": 0.1, "audio_s": 5.0, "levels": {}})
        e = ctx.exception
        self.assertEqual((e.stage, e.code, e.retryable), ("transcribe", "transcript_too_long", False))
        self.assertNotIn("transcript", m)
        self.assertNotIn("prompt", m)
        self.assertEqual(self.sent_prompts(key), [])

    def test_the_cap_is_far_above_real_speech(self):
        self.assertGreaterEqual(iw.MAX_TRANSCRIPT_CHARS, 200000)

    def test_a_failed_memo_keeps_its_full_prompt_and_retry_sends_all_of_it(self):
        key = self.upload("revive")
        text = " ".join(f"w{i}" for i in range(9000))
        m = self.transcribed(key, text)
        self.tick_until(lambda: m["stage"] == "await_agent")
        full = iw.VOICE_PREFIX + text
        self.assertEqual(self.sent_prompts(key), [full])
        # the gateway stops the turn: a terminal, non-retryable failure that compacts the memo
        self.w.on_error(m, iw.StageError("agent_reply", mc_.TURN_TIMEOUT, "turn stopped", retryable=False))
        self.assertEqual((m["status"], m["resume_stage"]), ("failed", "dispatch"))
        self.assertEqual((m["prompt"], m["transcript"]), (full, text))
        ctl = Path(mc_.STATE_DIR) / "control"
        ctl.mkdir(parents=True, exist_ok=True)
        (ctl / f"retry-{m['memo_id']}").write_text("")
        self.w.tick(discover=False)
        self.tick_until(lambda: len(self.sent_prompts(key)) == 2)
        self.assertEqual(self.sent_prompts(key), [full, full])

    def test_only_a_finished_memo_is_compacted(self):
        big = {"transcript": "t" * 1000, "prompt": "p" * 1000, "reply_text": "r" * 1000}
        for status in ("failed", "active"):
            m = {**big, "status": status}
            iw.compact(m)
            self.assertEqual((len(m["transcript"]), len(m["prompt"]), len(m["reply_text"])), (1000, 1000, 1000), status)
        for status in ("done", "skipped"):
            m = {**big, "status": status}
            iw.compact(m)
            self.assertEqual((len(m["transcript"]), len(m["prompt"]), len(m["reply_text"])), (300, 300, 300), status)

    def test_a_prompt_that_no_longer_matches_its_hash_is_held_not_sent(self):
        key = self.upload("tamper")
        m = self.transcribed(key, "Summarize recent work.")
        m["prompt"] = m["prompt"][:10]  # whatever truncated it
        self.tick_until(lambda: m["status"] == "failed")
        f = self.failed_fact(key)
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("dispatch", "prompt_changed", False))
        self.assertEqual(self.sent_prompts(key), [])

    def test_the_prompt_hash_is_saved_before_the_publish(self):
        key = self.upload("hashfirst")
        m = self.transcribed(key, "Summarize recent work.")
        seen = []
        real_run = iw.run

        def spy(cmd, *a, **k):
            if "--kind" in cmd:  # the command publish: what state.json holds right now
                seen.append(json.loads((self.state.dir / "state.json").read_text())["memos"][key].get("prompt_sha256"))
            return real_run(cmd, *a, **k)
        with unittest.mock.patch.object(iw, "run", side_effect=spy):
            self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual(seen, [m["prompt_sha256"]])
        self.assertTrue(seen[0])

    def test_a_memo_with_a_prompt_cut_by_the_old_watcher_retranscribes_on_retry(self):
        key = self.upload("oldcut")
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "status": "failed",
             "stage": "agent", "failed_stage": "agent_reply", "failed_code": mc_.TURN_TIMEOUT, "resume_stage": "dispatch",
             "prompt": "p" * 300, "transcript": "t" * 300,
             "size": len(b"OggS fake audio"), "etag": iw.hashlib.md5(b"OggS fake audio").hexdigest()}
        self.state.memos[key] = m
        ctl = Path(mc_.STATE_DIR) / "control"
        ctl.mkdir(parents=True, exist_ok=True)
        (ctl / f"retry-{m['memo_id']}").write_text("")
        self.w.tick(discover=False)
        # not refused: the audio is still in the inbox, so the memo is revived at transcribe with the cut text dropped
        self.assertEqual((m["status"], m["stage"]), ("active", "transcribe"))
        for k in ("transcript", "prompt", "prompt_sha256"):
            self.assertNotIn(k, m)
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual(self.sent_prompts(key), [iw.VOICE_PREFIX + "Summarize recent work."])
        self.assertTrue(m["prompt_sha256"])

    def test_memo_retry_cli_prints_the_real_resume_stage(self):
        import argparse
        import contextlib
        import io
        import memo_trace as mt
        key = self.upload("oldcutcli")
        mid = mc_.memo_id_for(key)
        cut = {"memo_id": mid, "key": key, "agent": "holocene-pm", "attempts": {}, "status": "failed",
               "stage": "agent", "failed_stage": "agent_reply", "failed_code": mc_.TURN_TIMEOUT,
               "resume_stage": "dispatch", "prompt": "p" * 300, "transcript": "t" * 300}
        key2 = self.upload("plainretry")
        mid2 = mc_.memo_id_for(key2)
        plain = {"memo_id": mid2, "key": key2, "agent": "holocene-pm", "attempts": {}, "status": "failed",
                 "stage": "agent", "failed_stage": "agent_reply", "failed_code": mc_.TURN_TIMEOUT,
                 "resume_stage": "dispatch", "prompt": "a full prompt", "transcript": "a full transcript"}
        d = Path(tempfile.mkdtemp(prefix="memo-mt-"))
        (d / "state.json").write_text(json.dumps({"memos": {key: cut, key2: plain}}))
        real = mt.c.STATE_DIR
        mt.c.STATE_DIR = d
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = mt.cmd_retry(argparse.Namespace(target=key))
                rc2 = mt.cmd_retry(argparse.Namespace(target=key2))
        finally:
            mt.c.STATE_DIR = real
        self.assertEqual((rc, rc2), (0, 0))
        text = out.getvalue()
        self.assertIn(f"retry requested for {mid} (resumes at transcribe; re-transcribe", text)
        self.assertIn(f"retry requested for {mid2} (resumes at dispatch)", text)
        self.assertTrue((d / "control" / f"retry-{mid}").exists())
        self.assertTrue((d / "control" / f"retry-{mid2}").exists())

    # ---- 2. content integrity ----------------------------------------------------------------

    def test_discovery_records_size_and_etag(self):
        key = self.upload("recorded")
        m = self.discover(key)
        self.assertEqual(m["size"], len(b"OggS fake audio"))
        self.assertEqual(m["etag"], iw.hashlib.md5(b"OggS fake audio").hexdigest())

    def test_an_object_replaced_with_a_different_size_is_held(self):
        key = self.upload("grew")
        m = self.discover(key)
        put(key, b"OggS fake audio, and then a lot more")
        self.tick_until(lambda: m["status"] == "failed")
        f = self.failed_fact(key)
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("download", "object_changed", False))
        self.assertEqual(self.sent_prompts(key), [])
        self.assertNotIn("transcript", m)

    def test_an_object_replaced_by_one_of_the_same_size_is_held_by_its_etag(self):
        key = self.upload("swapped")
        m = self.discover(key)
        put(key, b"OggS fake audi0")  # same length, different bytes
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual(self.failed_fact(key)["error_code"], "object_changed")
        self.assertIn("content hash", self.failed_fact(key)["error_message"])

    def test_an_unchanged_object_is_transcribed(self):
        key = self.upload("same")
        m = self.discover(key)
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual(m["transcript"], "Summarize recent work.")

    def test_a_multipart_etag_is_judged_by_size_alone(self):
        audio = Path(tempfile.mkdtemp(prefix="memo-etag-")) / "a.ogg"
        audio.write_bytes(b"OggS fake audio")
        iw.Watcher._check_object(audio, "k", {"size": 15, "etag": "0123456789abcdef0123456789abcdef-3"})  # no raise
        with self.assertRaises(iw.StageError):
            iw.Watcher._check_object(audio, "k", {"size": 16, "etag": "0123456789abcdef0123456789abcdef-3"})

    def test_retrying_a_changed_object_takes_it_as_it_is_now(self):
        key = self.upload("retried")
        m = self.discover(key)
        put(key, b"OggS fake audio, replaced")
        self.tick_until(lambda: m["status"] == "failed")
        ctl = Path(mc_.STATE_DIR) / "control"
        ctl.mkdir(parents=True, exist_ok=True)
        (ctl / f"retry-{m['memo_id']}").write_text("")
        self.w.tick(discover=False)
        self.assertEqual(m["size"], len(b"OggS fake audio, replaced"))
        self.tick_until(lambda: m["stage"] == "await_agent")

    # ---- 3. held unroutable memos ------------------------------------------------------------

    def test_a_memo_held_for_an_unroutable_agent_retries_from_receive(self):
        key = self.upload("held", agent="zz-nonexistent")
        m = self.discover(key)
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"], m["resume_stage"]), ("dispatch", "unknown_agent", "receive"))
        ctl = Path(mc_.STATE_DIR) / "control"
        ctl.mkdir(parents=True, exist_ok=True)
        (ctl / f"retry-{m['memo_id']}").write_text("")
        self.w.process_control()
        self.assertEqual((m["status"], m["stage"]), ("active", "receive"))

    def test_an_old_failed_memo_with_a_dispatch_resume_and_no_transcript_restarts_at_receive(self):
        self.assertEqual(iw.resume_for({"resume_stage": "dispatch"}), "receive")
        self.assertEqual(iw.resume_for({"resume_stage": "dispatch", "transcript": "hello"}), "dispatch")
        self.assertEqual(iw.resume_for({"resume_stage": "speak"}), "speak")
        self.assertEqual(iw.resume_for({}), "receive")

    def test_dispatch_without_a_transcript_is_held_not_a_keyerror(self):
        key = self.upload("notranscript")
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "next_at": 0.0,
             "status": "active", "stage": "dispatch"}
        self.state.memos[key] = m
        self.tick_until(lambda: m["status"] == "failed")
        f = self.failed_fact(key)
        self.assertEqual((f["stage"], f["error_code"], f["retryable"]), ("dispatch", "no_transcript", False))
        self.assertEqual(m["resume_stage"], "receive")
        self.assertEqual(self.sent_prompts(key), [])


class MemoHarness:
    """A private State and Watcher per test; memos are driven one at a time (as PromptIntegrity does). The shared fact
    log is restored afterwards: the Pipeline tests count every fact in it."""

    def setUp(self):
        self.before = EMITS.read_text() if EMITS.exists() else ""
        self.state = iw.State(Path(tempfile.mkdtemp(prefix="memo-h-")))
        self.w = iw.Watcher(self.state)
        self.keys = []
        journal(str(uuid.uuid4()), "holocene-pm")  # the gateway journal exists before any memo has a row in it
        VOX_TEXTS.clear()

    def tearDown(self):
        EMITS.write_text(self.before)
        MC_FAIL_TXT.unlink(missing_ok=True)
        for k in self.keys:
            (BUCKET_DIR / k).unlink(missing_ok=True)
        self.w.shutdown(wait=False)

    def upload(self, name, content=b"OggS fake audio", agent="holocene-pm"):
        key = f"inbox/{agent}/2026/10/19/{name}.ogg"
        put(key, content)
        self.keys.append(key)
        return key

    def discover(self, key):
        self.w.discover(([o for o in mc_.s3_list_inbox() if o["key"] == key], None))
        return self.state.memos[key]

    def tick_until(self, pred, n=200):
        for _ in range(n):
            self.w.tick(discover=False)
            if pred():
                return
            time.sleep(0.05)
        self.fail("condition never met; memos=" + json.dumps(self.state.memos, default=str)[:900])

    def transcribed(self, key, text="Summarize recent work."):
        """A memo at the dispatch stage holding `text` as its transcript, as _transcribe_apply leaves it."""
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "next_at": 0.0,
             "status": "active", "stage": "transcribe"}
        self.state.memos[key] = m
        self.w._transcribe_apply(m, {"text": text, "meta": {}, "took": 0.1, "audio_s": 5.0, "levels": {}})
        return m

    def to_await(self, name):
        """Upload a memo and run it until its command is published and the watcher waits for the agent."""
        key = self.upload(name)
        m = self.discover(key)
        self.tick_until(lambda: m["stage"] == "await_agent")
        return key, m

    @staticmethod
    def cmds(key):
        return [(t, r) for t, r in facts() if t.startswith("bloodbank.cmd.") and r["data"]["context"]["memo_key"] == key]

    @staticmethod
    def of_type(action, key):
        return [r["data"] for t, r in facts() if t == f"bloodbank.audio.memo.{action}" and r["data"]["s3_key"] == key]

    @staticmethod
    def control(verb, m):
        ctl = Path(mc_.STATE_DIR) / "control"
        ctl.mkdir(parents=True, exist_ok=True)
        f = ctl / f"{verb}-{m['memo_id']}"
        f.write_text("")
        return f

    def ticks(self, n=8):
        for _ in range(n):
            self.w.tick(discover=False)
            time.sleep(0.02)


class Escalation(MemoHarness, unittest.TestCase):
    """An interactive turn the gateway stopped at its wall clock is re-dispatched ONCE on the batch lane, not failed."""

    def escalate(self, name):
        """A memo whose interactive turn timed out and that has been re-dispatched: (key, memo, first command id, its envelope id)."""
        key, m = self.to_await(name)
        cid1, env1 = m["command_id"], m["command_envelope_id"]
        journal_turn_timeout(cid1)
        self.tick_until(lambda: m["command_id"] != cid1 and m["stage"] == "await_agent")
        return key, m, cid1, env1

    def test_a_turn_timeout_escalates_the_same_prompt_to_the_batch_lane_instead_of_failing(self):
        key, m = self.to_await("esc-basic")
        cid1, env1, sha = m["command_id"], m["command_envelope_id"], m["prompt_sha256"]
        seen = []
        real_run = iw.run

        def spy(cmd, *a, **k):
            if "--kind" in cmd:  # the command publish: what state.json holds right now
                seen.append((cmd[cmd.index("--command-id") + 1], json.loads((self.state.dir / "state.json").read_text())["memos"][key]))
            return real_run(cmd, *a, **k)
        journal_turn_timeout(cid1)
        with unittest.mock.patch.object(iw, "run", side_effect=spy):
            self.tick_until(lambda: m["command_id"] != cid1 and m["stage"] == "await_agent")
        cid2 = m["command_id"]
        self.assertEqual(m["status"], "active")
        self.assertEqual(self.of_type("failed", key), [])  # the timeout is not the memo's outcome
        # two commands: the interactive one, then the batch one with the SAME prompt on the SAME thread
        cmds = self.cmds(key)
        self.assertEqual([t for t, _ in cmds], ["bloodbank.cmd.agent.invocation.invoke", "bloodbank.cmd.agent.invocation.start"])
        (_, first), (_, second) = cmds
        self.assertEqual(second["data"]["prompt"], first["data"]["prompt"])
        self.assertEqual(iw.hashlib.sha256(second["data"]["prompt"].encode()).hexdigest(), sha)
        self.assertEqual(second["data"]["thread_id"], first["data"]["thread_id"])
        self.assertEqual(second["data"]["thread_id"], m["memo_id"])  # so the Hermes session keeps its context
        a = second["argv"]
        self.assertEqual(a[a.index("--correlation") + 1], m["memo_id"])
        self.assertNotEqual(cid2, cid1)
        self.assertEqual(a[a.index("--command-id") + 1], cid2)
        self.assertEqual(a[a.index("--causation") + 1], env1)  # caused by the command that timed out
        self.assertEqual(second["data"]["context"]["escalated_from_command_id"], cid1)
        # the new command id (and the prompt hash) were on disk BEFORE the publish
        self.assertEqual([c for c, _ in seen], [cid2])
        self.assertEqual((seen[0][1]["command_id"], seen[0][1]["prompt_sha256"]), (cid2, sha))
        # the second dispatched fact says what happened
        d1, d2 = self.of_type("dispatched", key)
        self.assertEqual((d1["lane"], d1["lane_reason"]), ("interactive", None))
        self.assertNotIn("escalated_from_command_id", d1)
        self.assertEqual((d2["lane"], d2["lane_reason"]), ("batch", "turn_timeout_escalated"))
        self.assertEqual((d2["command_id"], d2["escalated_from_command_id"], d2["thread_id"]), (cid2, cid1, m["memo_id"]))
        self.assertEqual(d2["prompt_sha256"], sha)
        # a long deadline for the batch turn, not the interactive memo's AGENT_TIMEOUT_S
        self.assertEqual(iw.BATCH_TURN_TIMEOUT_S, 7200)
        self.assertAlmostEqual(m["deadline_ts"] - m["dispatched_ts"], iw.BATCH_TURN_TIMEOUT_S, delta=1)
        # nothing was said aloud on the way
        self.assertEqual(VOX_TEXTS, [])

    def test_the_escalated_reply_is_spoken_as_a_late_reply_and_flagged(self):
        key, m, cid1, _ = self.escalate("esc-reply")
        cid2 = m["command_id"]
        journal(cid2, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Here is the long answer.", ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        self.assertEqual(VOX_TEXTS, ["Holocene PM, late reply. Here is the long answer."])
        r = self.of_type("replied", key)[-1]
        self.assertIs(r["late"], True)
        self.assertIs(r["escalated"], True)
        self.assertEqual(r["command_id"], cid2)

    def test_an_ordinary_reply_is_neither_late_nor_escalated(self):
        key, m = self.to_await("esc-plain")
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Quick answer.", ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        r = self.of_type("replied", key)[-1]
        self.assertEqual((r["late"], r["escalated"]), (False, False))
        self.assertEqual(VOX_TEXTS, ["Holocene PM. Quick answer."])

    def test_escalation_happens_at_most_once_per_memo(self):
        key, m, cid1, _ = self.escalate("esc-once")
        cid2 = m["command_id"]
        journal_turn_timeout(cid2, lane="batch")  # the batch turn is stopped too (an envelope deadline, say)
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"], m["resume_stage"]), ("agent_reply", "turn_timeout", "dispatch"))
        f = self.of_type("failed", key)[-1]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"], f["command_id"]), ("agent_reply", "turn_timeout", False, cid2))
        self.ticks()
        self.assertEqual(len(self.cmds(key)), 2)  # no third command
        # an explicit memo:retry sends ONE fresh command; the lane is sticky: a memo that escalated stays on the batch
        # lane (reason unchanged) and is not escalated again
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual(m["status"], "active")
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertNotEqual(m["command_id"], cid2)
        self.assertTrue(mc_.memo_escalated(m))
        self.assertEqual((m["lane"], m["lane_reason"]), ("batch", "turn_timeout_escalated"))
        self.assertEqual([t for t, _ in self.cmds(key)][-1], "bloodbank.cmd.agent.invocation.start")
        journal_turn_timeout(m["command_id"], lane="batch")
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual(len(self.cmds(key)), 3)  # the retried command failed final, it did not escalate

    def test_other_failures_do_not_escalate(self):
        # a turn that failed for another reason
        key, m = self.to_await("esc-agentfail")
        journal(m["command_id"], "holocene-pm", outcome="failure")
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent", "agent_failure"))
        self.assertEqual(len(self.cmds(key)), 1)
        # the watcher's own agent deadline (the command never finished) is not a gateway turn timeout either
        key, m = self.to_await("esc-deadline")
        m["deadline_ts"] = time.time() - 1
        idle = {"ok": True, "num_pending": 0, "num_ack_pending": 0}
        with unittest.mock.patch.object(mc_, "gateway_liveness", return_value=idle):
            self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "timeout"))
        self.assertEqual(len(self.cmds(key)), 1)

    def test_a_turn_timeout_on_the_batch_lane_is_final(self):
        old, iw.LANE = iw.LANE, "batch"
        try:
            key, m = self.to_await("esc-batchlane")
        finally:
            iw.LANE = old
        self.assertEqual(m["lane"], "batch")
        journal_turn_timeout(m["command_id"], lane="batch")
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "turn_timeout"))
        self.assertEqual(len(self.cmds(key)), 1)

    def test_zero_batch_deadline_switches_escalation_off(self):
        key, m = self.to_await("esc-off")
        journal_turn_timeout(m["command_id"])
        with unittest.mock.patch.object(iw, "BATCH_TURN_TIMEOUT_S", 0):
            self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "turn_timeout"))
        self.assertEqual(len(self.cmds(key)), 1)

    def test_a_batch_turn_that_wrote_no_text_never_speaks_the_stopped_turns_partial_output(self):
        key, m, cid1, _ = self.escalate("esc-stale")
        journal(m["command_id"], "holocene-pm")
        # the stopped interactive turn left a half sentence in the shared session; the batch turn added nothing
        hermes_session("holocene-pm", m["memo_id"], "Let me look into that...", ts=m["dispatched_ts"] - 60)
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "no_reply_text"))
        self.assertEqual(VOX_TEXTS, [])
        self.assertNotIn("reply_key", m)

    def test_a_turn_timeout_that_lands_after_the_watcher_gave_up_escalates_too(self):
        key, m = self.to_await("esc-latetimeout")
        cid1 = m["command_id"]
        m["deadline_ts"] = time.time() - 1
        idle = {"ok": True, "num_pending": 0, "num_ack_pending": 0}
        with unittest.mock.patch.object(mc_, "gateway_liveness", return_value=idle):
            self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual((m["failed_stage"], m["failed_code"]), ("agent_reply", "timeout"))
        journal_turn_timeout(cid1)  # the queued command ran after the deadline, and the gateway stopped it at its wall clock
        self.w.last_rescue = 0
        self.tick_until(lambda: m["command_id"] != cid1 and m["stage"] == "await_agent")
        self.assertEqual((m["status"], m["lane"], m["lane_reason"], m["escalated"]), ("active", "batch", "turn_timeout_escalated", True))
        self.assertEqual([t for t, _ in self.cmds(key)],
                         ["bloodbank.cmd.agent.invocation.invoke", "bloodbank.cmd.agent.invocation.start"])

    def test_a_retried_escalated_command_is_waited_for_with_the_batch_deadline(self):
        key, m, cid1, _ = self.escalate("esc-retry")
        m["deadline_ts"] = time.time() - 1
        busy = {"ok": True, "num_pending": 7, "num_ack_pending": 4}  # a queued ordinary memo would be stretched here (test_19)
        with unittest.mock.patch.object(mc_, "gateway_liveness", return_value=busy):
            self.tick_until(lambda: m["status"] == "failed")
        # an escalated turn already has its long deadline: the queue-extension rule does not stretch it further
        self.assertEqual((m["failed_stage"], m["failed_code"], m["resume_stage"]), ("agent_reply", "timeout", "await_agent"))
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"]), ("active", "await_agent"))
        self.assertAlmostEqual(m["deadline_ts"] - time.time(), iw.BATCH_TURN_TIMEOUT_S, delta=2)


class Cancel(MemoHarness, unittest.TestCase):
    """`memo:cancel`: before the publish nothing is sent; after it the agent may run on, but its reply is never spoken."""

    def test_the_after_dispatch_rule(self):
        self.assertFalse(mc_.cancel_after_dispatch({"stage": "receive"}))
        self.assertFalse(mc_.cancel_after_dispatch({"stage": "transcribe"}))
        self.assertFalse(mc_.cancel_after_dispatch({"stage": "dispatch"}))
        self.assertTrue(mc_.cancel_after_dispatch({"stage": "dispatch", "publish_attempted": True}))
        for stage in ("await_agent", "reply", "speak"):
            self.assertTrue(mc_.cancel_after_dispatch({"stage": stage}), stage)

    def test_cancel_before_the_receive_stage_has_run(self):
        key = self.upload("cancel-receive")
        m = self.discover(key)
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"]), ("cancelled", "receive"))
        self.ticks()
        for action in ("received", "transcribed", "dispatched"):
            self.assertEqual(self.of_type(action, key), [], action)
        self.assertEqual(self.cmds(key), [])
        (f,) = self.of_type("failed", key)
        self.assertEqual((f["stage"], f["error_code"], f["retryable"], f["after_dispatch"]), ("cancelled", "cancelled", False, False))
        self.assertNotIn("command_id", f)
        self.assertIn("nothing was sent", f["error_message"])

    def test_cancel_before_the_publish_dispatches_nothing(self):
        key = self.upload("cancel-dispatch")
        m = self.transcribed(key)  # at the dispatch stage: the very next tick would publish
        self.assertEqual(m["stage"], "dispatch")
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"], m["resume_stage"]), ("cancelled", "dispatch", "dispatch"))
        self.ticks()
        self.assertEqual(self.cmds(key), [])
        self.assertEqual(self.of_type("dispatched", key), [])
        self.assertNotIn("publish_attempted", m)
        f = self.of_type("failed", key)[-1]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"], f["after_dispatch"]), ("cancelled", "cancelled", False, False))
        self.assertEqual(m["attempts"], {})  # not a failure of any stage

    def test_cancel_while_whisper_runs_drops_the_transcript(self):
        key = self.upload("cancel-whisper")
        m = self.discover(key)
        gate = threading.Event()
        orig = self.w._transcribe_work
        self.w._transcribe_work = lambda *a, **k: (gate.wait(5), orig(*a, **k))[1]
        try:
            self.tick_until(lambda: m["stage"] == "transcribe" and key in self.w.running)
            self.control("cancel", m)
            self.w.tick(discover=False)
            self.assertEqual(m["status"], "cancelled")  # at once: not after the minutes Whisper may still need
            gate.set()
            self.tick_until(lambda: key not in self.w.running)
        finally:
            gate.set()
            self.w._transcribe_work = orig
        self.ticks()
        self.assertEqual(m["status"], "cancelled")
        self.assertNotIn("transcript", m)
        self.assertEqual(self.of_type("transcribed", key), [])
        self.assertEqual(self.cmds(key), [])

    def test_a_step_that_was_already_running_cannot_publish_for_a_cancelled_memo(self):
        key = self.upload("cancel-race-dispatch")
        m = self.transcribed(key)
        m["status"] = "cancelled"  # the cancel landed while the dispatch worker was probing the lane
        self.w.step_dispatch(m)
        self.assertEqual(self.cmds(key), [])
        self.assertNotIn("publish_attempted", m)

    def test_cancel_landing_while_the_publish_is_in_flight_is_after_dispatch(self):
        key = self.upload("cancel-inflight")
        m = self.transcribed(key)
        real_run = iw.run

        def spy(cmd, *a, **k):
            if "--kind" in cmd:  # publish_attempted is already set: the operator cancels right now
                with self.w.mu:
                    self.w.cancel_memo(m)
            return real_run(cmd, *a, **k)
        with unittest.mock.patch.object(iw, "run", side_effect=spy):
            self.tick_until(lambda: m["status"] == "cancelled" and key not in self.w.running)
        f = self.of_type("failed", key)[-1]
        self.assertEqual((f["stage"], f["after_dispatch"]), ("cancelled", True))
        self.assertEqual(len(self.cmds(key)), 1)  # it WAS published; the fact says so
        self.assertEqual(len(self.of_type("dispatched", key)), 1)
        self.assertEqual((m["status"], m["stage"]), ("cancelled", "dispatch"))  # and the memo did not move on to await

    def test_cancel_after_the_publish_leaves_the_agent_running_and_speaks_nothing(self):
        key, m = self.to_await("cancel-after")
        cid = m["command_id"]
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"]), ("cancelled", "await_agent"))
        f = self.of_type("failed", key)[-1]
        self.assertEqual((f["stage"], f["error_code"], f["retryable"], f["after_dispatch"], f["command_id"]),
                         ("cancelled", "cancelled", False, True, cid))
        self.assertIn("may still run", f["error_message"])
        # the agent finishes anyway
        journal(cid, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Done anyway.", ts=time.time())
        self.w.last_rescue = 0
        self.ticks(12)
        self.assertEqual(m["status"], "cancelled")
        self.assertEqual(VOX_TEXTS, [])  # not even synthesized
        self.assertEqual(self.of_type("replied", key), [])
        self.assertNotIn("reply_key", m)
        self.assertEqual([p for p in BUCKET_DIR.rglob("*") if m["memo_id"] in p.name], [])  # no car copy, no phone copy

    def test_a_reply_that_is_being_spoken_when_the_cancel_lands_is_not_spoken_or_mirrored(self):
        key = self.upload("cancel-speak")
        mid = mc_.memo_id_for(key)
        m = {"memo_id": mid, "key": key, "agent": "holocene-pm", "reply_text": "A reply that must not be heard.",
             "attempts": {}, "status": "cancelled", "stage": "speak", "received_ts": time.time()}
        self.state.memos[key] = m
        n0 = len(mc_cps())
        self.w.step_speak(m)  # the worker had started; the memo was cancelled under it
        self.assertEqual(mc_cps()[n0:], [])  # nothing uploaded: not the car's copy, not the phone's
        self.assertEqual(self.of_type("replied", key), [])
        self.assertNotIn("reply_key", m)

    def test_a_cancelled_memo_is_skipped_by_the_late_rescue(self):
        key, m = self.to_await("cancel-rescue")
        cid = m["command_id"]
        m["deadline_ts"] = time.time() - 1
        idle = {"ok": True, "num_pending": 0, "num_ack_pending": 0}
        with unittest.mock.patch.object(mc_, "gateway_liveness", return_value=idle):
            self.tick_until(lambda: m["status"] == "failed")
        self.assertTrue(mc_.rescue_open(m))  # failed agent_reply/timeout: the watcher still waits for a late reply
        self.control("cancel", m)  # ... and the operator does not want it
        self.w.tick(discover=False)
        self.assertEqual(m["status"], "cancelled")
        self.assertFalse(mc_.rescue_open(m))
        journal(cid, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "Late, but wanted by nobody.", ts=time.time())
        self.w.last_rescue = 0
        self.ticks()
        self.assertEqual((m["status"], VOX_TEXTS), ("cancelled", []))
        self.assertNotIn("late", m)

    def test_a_cancelled_memo_is_never_escalated(self):
        key, m = self.to_await("cancel-noescalate")
        self.control("cancel", m)
        self.w.tick(discover=False)
        journal_turn_timeout(m["command_id"])  # the gateway stops the turn after the cancel
        self.ticks(12)
        self.assertEqual(m["status"], "cancelled")
        self.assertEqual(len(self.cmds(key)), 1)
        self.assertNotIn("escalated", m)

    def test_cancel_while_the_escalation_is_waiting_to_publish_sends_no_batch_command(self):
        key, m = self.to_await("cancel-escalating")
        cid1 = m["command_id"]
        journal_turn_timeout(cid1)
        self.w.tick(discover=False)  # the await step escalates: stage is dispatch, the batch command is minted, not sent
        self.assertEqual((m["stage"], m["lane"], m["lane_reason"]), ("dispatch", "batch", "turn_timeout_escalated"))
        self.assertTrue(m["escalated"])
        self.assertNotIn("publish_attempted", m)
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.ticks()
        self.assertEqual(m["status"], "cancelled")
        self.assertEqual(len(self.cmds(key)), 1)  # only the interactive one ever went out
        f = self.of_type("failed", key)[-1]
        # the interactive command DID go out and ran: after_dispatch says so, the message is about the batch one
        self.assertEqual((f["stage"], f["after_dispatch"]), ("cancelled", True))
        self.assertIn("batch command was not sent", f["error_message"])

    def test_memo_retry_revives_a_cancelled_memo_and_it_dispatches_once(self):
        key = self.upload("cancel-retry")
        m = self.transcribed(key)
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual(m["status"], "cancelled")
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"]), ("active", "dispatch"))
        for k in ("cancelled_ts", "cancelled_stage", "cancelled_after_dispatch", "failed_stage", "failed_code", "resume_stage"):
            self.assertNotIn(k, m)
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual(len(self.cmds(key)), 1)

    def test_control_files_are_taken_in_the_order_they_were_written(self):
        t = time.time_ns()
        # cancel, then retry: the memo ends active
        key = self.upload("cancel-order-a")
        m = self.transcribed(key)
        a, b = self.control("cancel", m), self.control("retry", m)
        os.utime(a, ns=(t, t))
        os.utime(b, ns=(t + 10**9, t + 10**9))
        self.w.process_control()
        self.assertEqual(m["status"], "active")
        # retry, then cancel: the retry is refused (the memo is running), the cancel wins
        key2 = self.upload("cancel-order-b")
        m2 = self.transcribed(key2)
        a, b = self.control("retry", m2), self.control("cancel", m2)
        os.utime(a, ns=(t, t))
        os.utime(b, ns=(t + 10**9, t + 10**9))
        self.w.process_control()
        self.assertEqual(m2["status"], "cancelled")

    def test_cancel_is_refused_for_a_memo_that_is_not_in_flight(self):
        done = self.transcribed(self.upload("cancel-done"))
        done["status"] = "done"
        failed = self.transcribed(self.upload("cancel-failed"))
        failed.update(status="failed", failed_stage="tts", failed_code="vox_failed")
        ghost = self.control("cancel", {"memo_id": str(uuid.uuid4())})
        n0 = len(facts())
        for m in (done, failed):
            self.control("cancel", m)
        self.w.tick(discover=False)
        self.assertEqual((done["status"], failed["status"]), ("done", "failed"))
        self.assertEqual(len(facts()), n0)  # no fact for a refusal
        self.assertFalse(ghost.exists())  # an unknown memo is consumed and logged, never an exception
        again = self.transcribed(self.upload("cancel-twice"))
        self.control("cancel", again)
        self.w.tick(discover=False)
        n1 = len(facts())
        self.control("cancel", again)
        self.w.tick(discover=False)
        self.assertEqual(len(facts()), n1)  # a second cancel of the same memo says nothing new

    def test_the_cancel_command_writes_the_control_file_and_says_what_it_can_mean(self):
        import argparse
        import contextlib
        import io
        import memo_trace as mt
        k1, k2, k3, k4 = (f"inbox/holocene-pm/2026/10/19/cli-{n}.ogg" for n in ("early", "late", "done", "twice"))
        rec = lambda k, **kw: {"memo_id": mc_.memo_id_for(k), "key": k, "agent": "holocene-pm", "attempts": {}, **kw}  # noqa: E731
        d = Path(tempfile.mkdtemp(prefix="memo-cancel-cli-"))
        (d / "state.json").write_text(json.dumps({"memos": {
            k1: rec(k1, status="active", stage="transcribe"),
            k2: rec(k2, status="active", stage="await_agent", publish_attempted=True, command_id="c"),
            k3: rec(k3, status="done", stage="done"),
            k4: rec(k4, status="cancelled", stage="speak")}}))
        real = mt.c.STATE_DIR
        mt.c.STATE_DIR = d
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rcs = [mt.cmd_cancel(argparse.Namespace(target=k)) for k in (k1, k2, k3, k4)]
        finally:
            mt.c.STATE_DIR = real
        self.assertEqual(rcs, [0, 0, 1, 1])
        text = out.getvalue()
        self.assertIn(f"cancel requested for {mc_.memo_id_for(k1)} (before dispatch: nothing will be sent to the agent)", text)
        self.assertIn(f"cancel requested for {mc_.memo_id_for(k2)} (after dispatch: the command is already out, so the agent may "
                      "still run, but its reply will not be spoken)", text)
        self.assertIn("only a memo still in flight can be cancelled", text)
        self.assertIn("is already cancelled", text)
        self.assertEqual(sorted(p.name for p in (d / "control").iterdir()),
                         sorted([f"cancel-{mc_.memo_id_for(k1)}", f"cancel-{mc_.memo_id_for(k2)}"]))
        # the memo:retry command accepts a cancelled memo as well
        (d / "state.json").write_text(json.dumps({"memos": {k4: rec(k4, status="cancelled", stage="speak", resume_stage="speak")}}))
        mt.c.STATE_DIR = d
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mt.cmd_retry(argparse.Namespace(target=k4)), 0)
        finally:
            mt.c.STATE_DIR = real
        self.assertTrue((d / "control" / f"retry-{mc_.memo_id_for(k4)}").exists())


class DecisionReviewFixes(MemoHarness, unittest.TestCase):
    """HOLOC-12 operator-decision review: a re-transcribe sends a fresh command, a retry of an escalated memo stays on the
    batch lane, the reply is matched to the command's own prompt, and the cancel / sidecar / unwind edges."""

    def stale(self, name, **extra):
        """A memo the old watcher cut to 300 characters, that failed on an interactive turn_timeout and still carries that
        command (id, publish_attempted, lane, envelope id) with the gateway journal row to prove it."""
        key = self.upload(name)
        old = str(uuid.uuid4())
        m = {"memo_id": mc_.memo_id_for(key), "key": key, "agent": "holocene-pm", "attempts": {}, "status": "failed",
             "stage": "agent", "failed_stage": "agent_reply", "failed_code": mc_.TURN_TIMEOUT, "resume_stage": "dispatch",
             "prompt": "p" * 300, "transcript": "t" * 300, "command_id": old, "publish_attempted": True, "lane": "interactive",
             "command_envelope_id": "env-old", "dispatched_ts": time.time() - 900,
             "size": len(b"OggS fake audio"), "etag": iw.hashlib.md5(b"OggS fake audio").hexdigest(), **extra}
        self.state.memos[key] = m
        journal_turn_timeout(old)
        return key, m, old

    def escalated(self, name):
        key, m = self.to_await(name)
        cid1 = m["command_id"]
        journal_turn_timeout(cid1)
        self.tick_until(lambda: m["command_id"] != cid1 and m["stage"] == "await_agent")
        return key, m, cid1

    # ---- 1. a re-transcribe is a fresh send -----------------------------------------------------

    def test_a_retranscribe_publishes_a_fresh_interactive_command_and_never_reuses_the_old_id(self):
        key, m, old = self.stale("fix-retranscribe")
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"]), ("active", "transcribe"))
        for k in ("command_id", "publish_attempted", "lane", "lane_reason", "command_envelope_id"):
            self.assertNotIn(k, m, k)
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertNotEqual(m["command_id"], old)
        (cmd,) = self.cmds(key)  # exactly one command, on the interactive lane
        self.assertEqual(cmd[0], "bloodbank.cmd.agent.invocation.invoke")
        self.assertEqual(cmd[1]["data"]["prompt"], iw.VOICE_PREFIX + "Summarize recent work.")
        disp = self.of_type("dispatched", key)
        self.assertEqual([d["command_id"] for d in disp], [m["command_id"]])  # the old id is in no dispatched fact
        self.assertEqual((disp[0]["lane"], disp[0]["idempotency_key"]), ("interactive", "ik-1"))
        self.assertEqual(disp[0]["prompt_chars"], len(iw.VOICE_PREFIX + "Summarize recent work."))
        self.assertEqual(self.of_type("failed", key), [])

    def test_a_retranscribe_of_an_escalated_memo_starts_over_on_the_interactive_lane(self):
        key, m, old = self.stale("fix-retranscribe-esc", escalated=True, lane_reason=mc_.ESCALATED_REASON, lane="batch",
                                 escalated_from_command_id="first", escalation_causation="env-first")
        self.control("retry", m)
        self.w.tick(discover=False)
        for k in ("escalated", "escalated_from_command_id", "escalation_causation", "lane_reason"):
            self.assertNotIn(k, m, k)
        self.tick_until(lambda: m["stage"] == "await_agent")
        self.assertEqual([t for t, _ in self.cmds(key)], ["bloodbank.cmd.agent.invocation.invoke"])
        self.assertFalse(mc_.memo_escalated(m))

    def test_a_revive_to_dispatch_after_an_agent_failure_drops_the_command_but_one_to_await_agent_keeps_it(self):
        _, m, old = self.stale("fix-revive-dispatch")
        self.w.revive(m, "dispatch", "test")
        self.assertEqual([k in m for k in ("command_id", "publish_attempted", "lane", "command_envelope_id")], [False] * 4)
        key2 = self.upload("fix-revive-await")
        live = {"memo_id": mc_.memo_id_for(key2), "key": key2, "agent": "holocene-pm", "attempts": {}, "status": "failed",
                "stage": "agent", "failed_stage": "agent_reply", "failed_code": "timeout", "resume_stage": "await_agent",
                "command_id": "live-cmd", "publish_attempted": True, "lane": "interactive", "dispatched_ts": time.time() - 700}
        self.state.memos[key2] = live
        self.w.revive(live, "await_agent", "test")
        self.assertEqual((live["command_id"], live["publish_attempted"], live["lane"]), ("live-cmd", True, "interactive"))

    def test_a_cancelled_memo_revived_after_its_command_went_out_keeps_that_command(self):
        key, m = self.to_await("fix-cancel-keep")
        cid = m["command_id"]
        self.control("cancel", m)
        self.w.tick(discover=False)
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual((m["status"], m["stage"], m["command_id"]), ("active", "await_agent", cid))
        self.assertEqual(len(self.cmds(key)), 1)

    # ---- 2. a revive is visible to the journey --------------------------------------------------

    def test_a_revive_publishes_a_marker_fact_except_at_receive(self):
        _, m, old = self.stale("fix-marker")
        self.w.revive(m, "await_agent", "memo:retry")
        marks = [r["data"] for t, r in facts() if t == "bloodbank.audio.memo.received" and r["data"]["s3_key"] == m["key"]]
        self.assertEqual(len(marks), 1)
        self.assertEqual((marks[0]["revived"], marks[0]["revived_to"], marks[0]["revive_why"]), (True, "await_agent", "memo:retry"))
        self.assertNotIn("detect_lag_ms", marks[0])
        self.assertTrue(m["revived_ts"])
        key2 = self.upload("fix-marker-receive")
        m2 = {"memo_id": mc_.memo_id_for(key2), "key": key2, "agent": "holocene-pm", "attempts": {}, "status": "skipped",
              "stage": "skipped", "failed_stage": "receive", "failed_code": "too_old"}
        self.state.memos[key2] = m2
        self.w.revive(m2, "receive", "memo:retry")
        self.assertEqual([r for t, r in facts() if t == "bloodbank.audio.memo.received" and r["data"]["s3_key"] == key2], [])

    # ---- 3. the reply is matched to the command's own prompt ------------------------------------

    @staticmethod
    def add_user(chat_id, text, ts):
        db = sqlite3.connect(HERMES / "holocene-pm" / "state.db")
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (f"s-{chat_id}", "user", text, ts))
        db.commit(); db.close()

    def test_find_reply_compares_against_the_newest_user_message_of_the_command_not_the_first(self):
        chat = str(uuid.uuid4())
        now = time.time()
        hermes_session("holocene-pm", chat, "The answer.", prompt="OLD prompt, cut by the old watcher", ts=now - 1000)
        self.add_user(chat, "NEW prompt, re-transcribed", now - 100)
        self.add_user(chat, "a later follow-up nobody sent", now - 50)
        sha = lambda t: iw.hashlib.sha256(t.encode()).hexdigest()  # noqa: E731
        by_hash = mc_.find_reply("holocene-pm", chat, prompt_sha256=sha("NEW prompt, re-transcribed"))
        self.assertEqual(by_hash["prompt"], "NEW prompt, re-transcribed")
        by_time = mc_.find_reply("holocene-pm", chat, since=now - 101)
        self.assertEqual(by_time["prompt"], "a later follow-up nobody sent")  # newest at or after the dispatch
        self.assertEqual(mc_.find_reply("holocene-pm", chat, since=now - 60)["prompt"], "a later follow-up nobody sent")
        self.assertEqual(mc_.find_reply("holocene-pm", chat)["prompt"], "a later follow-up nobody sent")

    def test_a_retranscribed_memo_in_an_old_session_is_not_a_prompt_mismatch(self):
        key, m = self.to_await("fix-prompt-match")
        journal(m["command_id"], "holocene-pm")
        now = time.time()
        # the session already holds the stale first prompt; this command's prompt is the second user message
        hermes_session("holocene-pm", m["memo_id"], "Real answer.", prompt="stale 300-char prompt", ts=now - 5000)
        self.add_user(m["memo_id"], m["prompt"], now - 1)
        db = sqlite3.connect(HERMES / "holocene-pm" / "state.db")
        db.execute("UPDATE messages SET timestamp=? WHERE session_id=? AND role='assistant'", (now, f"s-{m['memo_id']}"))
        db.commit(); db.close()
        self.tick_until(lambda: m["status"] == "done")
        self.assertIs(self.of_type("replied", key)[-1]["prompt_match"], True)

    # ---- 4. sticky batch lane, rescue window from the batch deadline ----------------------------

    def test_a_retry_after_a_non_timeout_batch_failure_stays_on_the_batch_lane(self):
        key, m, cid1 = self.escalated("fix-sticky")
        cid2 = m["command_id"]
        journal(cid2, "holocene-pm", outcome="failure")  # the batch turn fails for another reason
        self.tick_until(lambda: m["status"] == "failed")
        self.assertEqual(m["failed_stage"], "agent")
        self.control("retry", m)
        self.w.tick(discover=False)
        self.assertEqual((m["lane"], m["lane_reason"]), ("batch", mc_.ESCALATED_REASON))
        self.tick_until(lambda: m["stage"] == "await_agent" and m["command_id"] != cid2)
        self.assertEqual([t for t, _ in self.cmds(key)][-1], "bloodbank.cmd.agent.invocation.start")
        self.assertEqual(len(self.cmds(key)), 3)
        last = self.of_type("dispatched", key)[-1]
        self.assertEqual((last["lane"], last["lane_reason"], last["escalated_from_command_id"]), ("batch", mc_.ESCALATED_REASON, cid1))
        self.assertEqual(m["deadline_ts"] - m["dispatched_ts"], iw.BATCH_TURN_TIMEOUT_S)

    def test_the_rescue_window_of_an_escalated_memo_starts_at_its_batch_deadline(self):
        now = time.time()
        batch = {"status": "failed", "failed_stage": "agent_reply", "failed_code": "timeout", "command_id": "c",
                 "lane_reason": mc_.ESCALATED_REASON, "dispatched_ts": now - 7300, "deadline_ts": now - 100}
        self.assertGreater(iw.rescue_closes_at(batch), now)  # a batch reply 100 s past the 2 h deadline is still taken
        self.assertAlmostEqual(iw.rescue_closes_at(batch), now - 100 + iw.RESCUE_WINDOW_S, delta=1)
        plain = {**batch, "lane_reason": None}
        self.assertLess(iw.rescue_closes_at(plain), now)  # an ordinary memo's window still runs from its dispatch
        key, m = self.to_await("fix-rescue")
        cid = m["command_id"]
        m.update(status="failed", failed_stage="agent_reply", failed_code="timeout", lane_reason=mc_.ESCALATED_REASON,
                 escalated=True, dispatched_ts=now - 7300, deadline_ts=now - 100)
        journal(cid, "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "A reply after the two hours.", ts=time.time())
        self.w.last_rescue = 0
        self.tick_until(lambda: m["status"] == "done")
        self.assertTrue(self.of_type("replied", key)[-1]["late"])

    # ---- 5. a cancel landing mid-upload takes the objects back ----------------------------------

    def test_a_cancel_that_lands_during_the_upload_removes_the_uploaded_objects(self):
        key, m = self.to_await("fix-retract")
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], "A reply that gets cancelled while it uploads. " * 20, ts=time.time())
        real = mc_.mc
        fired = []

        def spy(*a, **k):
            r = real(*a, **k)
            if a[0] == "cp" and "/replies/" in a[-1] and not fired:  # the car's copy is up: the operator cancels right now
                fired.append(1)
                with self.w.mu:
                    self.w.cancel_memo(m)
            return r
        n_rm = len(mc_rms())
        with unittest.mock.patch.object(mc_, "mc", side_effect=spy), unittest.mock.patch.object(iw, "REPLY_CHUNKS", False):
            self.tick_until(lambda: m["status"] == "cancelled" and key not in self.w.running and len(mc_rms()) > n_rm)
            self.ticks(6)
        self.assertTrue(fired)
        self.assertEqual(self.of_type("replied", key), [])
        gone = mc_rms()[n_rm:]
        self.assertEqual(len(gone), 3, gone)  # the car's copy, the phone's audio and its text
        self.assertEqual([p for p in BUCKET_DIR.rglob("*") if m["memo_id"] in p.name], [])
        for k in ("earshot_key", "earshot_text_key", "earshot_attempted"):
            self.assertNotIn(k, m, k)

    # ---- 6. after_dispatch ----------------------------------------------------------------------

    def test_after_dispatch_is_true_whenever_any_command_was_ever_published(self):
        self.assertTrue(mc_.cancel_after_dispatch({"stage": "dispatch", "escalated": True}))
        self.assertTrue(mc_.cancel_after_dispatch({"stage": "transcribe", "dispatched_ts": 1.0}))
        self.assertFalse(mc_.cancel_after_dispatch({"stage": "dispatch"}))

    # ---- 7. the phone's text is capped ----------------------------------------------------------

    def test_a_huge_reply_is_cut_for_the_phone_with_a_note_and_never_mid_character(self):
        self.assertEqual(iw.cap_earshot_text("small"), ("small", False))
        capped, cut = iw.cap_earshot_text("é" * 50000)  # 100 KB of two-byte characters
        self.assertTrue(cut)
        self.assertLessEqual(len(capped.encode("utf-8")), iw.EARSHOT_TEXT_MAX_BYTES)
        self.assertGreater(len(capped.encode("utf-8")), iw.EARSHOT_TEXT_MAX_BYTES - 200)
        self.assertTrue(capped.endswith("[truncated; full text in Holocene /voice]"))
        key, m = self.to_await("fix-huge")
        journal(m["command_id"], "holocene-pm")
        reply = "Long batch reply sentence. " * 4000  # about 108 KB
        hermes_session("holocene-pm", m["memo_id"], reply, ts=time.time())
        self.tick_until(lambda: m["status"] == "done")
        sidecar = (BUCKET_DIR / m["earshot_text_key"]).read_bytes()
        self.assertLessEqual(len(sidecar), iw.EARSHOT_TEXT_MAX_BYTES)
        self.assertTrue(sidecar.decode("utf-8").endswith("[truncated; full text in Holocene /voice]"))
        self.assertEqual(self.of_type("replied", key)[-1]["reply_chars"], len(reply.strip()))  # the fact and /voice keep it all

    # ---- 8. turn_stopped=false ------------------------------------------------------------------

    def test_an_unconfirmed_stop_waits_briefly_before_escalating(self):
        key, m = self.to_await("fix-unwind")
        cid1 = m["command_id"]
        journal_turn_timeout(cid1, turn_stopped=False)
        with unittest.mock.patch.object(iw, "TURN_UNWIND_WAIT_S", 0.4):
            self.w.tick(discover=False)
            self.assertEqual((m["stage"], m["command_id"]), ("await_agent", cid1))  # waiting, not escalated yet
            self.assertTrue(m.get("unwind_since"))
            self.ticks(3)
            self.assertEqual(m["command_id"], cid1)
            self.tick_until(lambda: m["command_id"] != cid1 and m["stage"] == "await_agent")
        self.assertNotIn("unwind_since", m)
        self.assertEqual([t for t, _ in self.cmds(key)], ["bloodbank.cmd.agent.invocation.invoke", "bloodbank.cmd.agent.invocation.start"])


class TextSidecar(MemoHarness, unittest.TestCase):
    """The phone gets the FULL reply text next to its audio: same Earshot key, .txt, uploaded first, fail-open."""

    LONG = "First sentence of a long and detailed answer. " * 40  # about 1800 chars: far over the 500-char spoken digest

    def replied_memo(self, name, reply=None):
        key, m = self.to_await(name)
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], reply or self.LONG, ts=time.time())
        return key, m

    def test_the_full_text_goes_up_before_the_audio_as_a_sibling_object(self):
        key, m = self.replied_memo("txt-basic")
        n0 = len(mc_cps())
        self.tick_until(lambda: m["status"] == "done")
        calls = mc_cps()[n0:]
        ogg, txt = m["earshot_key"], m["earshot_text_key"]
        self.assertTrue(ogg.startswith("phone/") and ogg.endswith(f"Z-holocene-pm-{m['memo_id']}.ogg"))
        self.assertEqual(txt, ogg[:-len(".ogg")] + ".txt")  # the same key, another extension
        # the whole reply, not the digest the voice speaks
        self.assertEqual((BUCKET_DIR / txt).read_text(encoding="utf-8"), self.LONG.strip())
        self.assertGreater(len(self.LONG.strip()), iw.SPEAK_CHARS)
        self.assertLessEqual(len(VOX_TEXTS[-1]), iw.SPEAK_CHARS + 40)
        phone = [c["dst"] for c in calls if "/earshot/" in c["dst"]]
        self.assertEqual([p.split("/earshot/")[1] for p in phone], [txt, ogg])  # text first, then the audio
        self.assertEqual(next(c for c in calls if c["dst"].endswith(txt))["attr"], 'Content-Type="text/plain; charset=utf-8"')
        r = self.of_type("replied", key)[-1]
        self.assertEqual((r["earshot_key"], r["earshot_text_key"]), (ogg, txt))
        self.assertEqual(r["reply_chars"], len(self.LONG.strip()))
        # the car's path: the reply's chunks (.opus), then one full audio object under replies/, no text beside it
        car = [c["dst"] for c in calls if "/holocene-auto/replies/" in c["dst"]]
        self.assertEqual(len(car), r["reply_chunks"] + 1)
        self.assertTrue(all(c.endswith(".opus") for c in car[:-1]))
        self.assertTrue(car[-1].endswith(".ogg"))

    def test_the_text_upload_failing_is_fail_open_and_the_audio_still_reaches_the_phone(self):
        MC_FAIL_TXT.write_text("x")
        key, m = self.replied_memo("txt-failopen")
        self.tick_until(lambda: m["status"] == "done")
        self.assertIsNone(m.get("earshot_text_key"))
        self.assertTrue((BUCKET_DIR / m["earshot_key"]).exists())
        self.assertFalse((BUCKET_DIR / (m["earshot_key"][:-len(".ogg")] + ".txt")).exists())
        r = self.of_type("replied", key)[-1]
        self.assertIsNone(r["earshot_text_key"])
        self.assertEqual(r["earshot_key"], m["earshot_key"])

    def test_the_text_is_not_dropped_again_when_the_audio_is_retried(self):
        key = self.upload("txt-once")
        mid = mc_.memo_id_for(key)
        stamp = mc_.parse_iso("2026-10-20T02:15:30.123Z")
        tkey = iw.earshot_key_for(stamp, "holocene-pm", mid, ext="txt")
        m = {"memo_id": mid, "key": key, "agent": "holocene-pm", "reply_text": "A reply.", "reply_stamp": iso_z(stamp),
             "earshot_text_key": tkey, "attempts": {}, "status": "active", "stage": "speak", "received_ts": time.time()}
        self.state.memos[key] = m
        n0 = len(mc_cps())
        self.w.step_speak(m)  # an earlier attempt left the text on the phone channel; the audio had failed
        dst = [c["dst"] for c in mc_cps()[n0:] if "/earshot/" in c["dst"]]
        self.assertEqual([d.split("/earshot/")[1] for d in dst], [iw.earshot_key_for(stamp, "holocene-pm", mid)])
        self.assertEqual(self.of_type("replied", key)[-1]["earshot_text_key"], tkey)

    def test_keys_follow_the_audio_key_with_a_txt_extension(self):
        stamp = mc_.parse_iso("2026-10-20T02:15:30.123Z")
        self.assertEqual(iw.earshot_key_for(stamp, "holocene-pm", "abc"), "phone/2026/10/20/021530123Z-holocene-pm-abc.ogg")
        self.assertEqual(iw.earshot_key_for(stamp, "holocene-pm", "abc", ext="txt"), "phone/2026/10/20/021530123Z-holocene-pm-abc.txt")
        self.assertEqual(iw.EARSHOT_TEXT_TYPE, "text/plain; charset=utf-8")

    def test_mirror_uploads_the_text_first_reports_it_at_once_and_survives_its_failure(self):
        import subprocess
        stamp = mc_.parse_iso("2026-10-20T02:15:30.123Z")
        order, recorded = [], []

        def fake(*args, **kw):
            order.append(args[-1].split("/earshot/")[1])
            return subprocess.CompletedProcess([], 0, "", "")
        with unittest.mock.patch.object(iw.mc_, "mc", side_effect=fake):
            ekey = iw.mirror_to_earshot(Path("/dev/null"), stamp, "holocene-pm", "abc", "k", "full text", recorded.append)
        self.assertEqual(order, ["phone/2026/10/20/021530123Z-holocene-pm-abc.txt", "phone/2026/10/20/021530123Z-holocene-pm-abc.ogg"])
        self.assertEqual(ekey, order[1])
        self.assertEqual(recorded, [order[0]])
        # the text refused: no text key reported, the audio still goes
        order.clear(), recorded.clear()

        def refuse_text(*args, **kw):
            order.append(args[-1].split("/earshot/")[1])
            return subprocess.CompletedProcess([], 1 if args[-1].endswith(".txt") else 0, "", "S3 said no")
        with unittest.mock.patch.object(iw.mc_, "mc", side_effect=refuse_text):
            ekey = iw.mirror_to_earshot(Path("/dev/null"), stamp, "holocene-pm", "abc", "k", "full text", recorded.append)
        self.assertEqual((ekey, recorded), (order[1], []))
        # no text given (it is already up): the audio alone
        order.clear()
        with unittest.mock.patch.object(iw.mc_, "mc", side_effect=fake):
            iw.mirror_to_earshot(Path("/dev/null"), stamp, "holocene-pm", "abc", "k")
        self.assertEqual(order, ["phone/2026/10/20/021530123Z-holocene-pm-abc.ogg"])


class TraceEscalationAndCancel(unittest.TestCase):
    """memo_trace shows an escalated memo's two dispatches and turns, a cancelled memo's verdict, and the phone text key."""

    def hop(self, name, status, **kw):
        import memo_trace as mt
        return mt.Hop(name, status, **kw)

    def test_a_cancelled_memos_verdict_says_whether_anything_was_sent(self):
        import memo_trace as mt
        before = self.hop("fact:failed[cancelled]", mt.FAILED, detail="cancelled: cancelled at transcribe by memo:cancel before "
                          "the command was published: nothing was sent to the agent (retryable=False, attempt=1, after_dispatch=False)")
        after = self.hop("fact:failed[cancelled]", mt.FAILED, detail="cancelled: cancelled at await_agent by memo:cancel after the "
                         "command was published: the agent may still run, its reply is not spoken (retryable=False, attempt=1, after_dispatch=True)")
        self.assertEqual(mt.verdict([before], {"watcher_record": {}}), ("CANCELLED before dispatch", False))
        self.assertEqual(mt.verdict([after], {"watcher_record": {}}), ("CANCELLED after dispatch; reply not spoken", False))
        # missing hops downstream of the cancel do not outvote it
        gone = self.hop("fact:dispatched", mt.MISSING, detail="no bloodbank.audio.memo.dispatched")
        self.assertEqual(mt.verdict([gone, before], {"watcher_record": {}})[0], "CANCELLED before dispatch")

    def test_a_cancel_that_a_later_reply_got_past_is_history(self):
        import memo_trace as mt
        t = lambda s: mc_.parse_iso(f"2026-10-20T02:00:{s:02d}Z")  # noqa: E731
        cancelled = self.hop("fact:failed[cancelled]", mt.FAILED, ts=t(5),
                             detail="cancelled: x (retryable=False, attempt=1, after_dispatch=True)")
        replied = self.hop("fact:replied", mt.OK, ts=t(40), detail="300 chars")
        self.assertTrue(mt.verdict([cancelled, replied], {"watcher_record": {}})[0].startswith("COMPLETE"))
        self.assertEqual(mt.verdict([replied, self.hop("fact:failed[cancelled]", mt.FAILED, ts=t(50),
                                                       detail="cancelled: x (retryable=False, attempt=1, after_dispatch=False)")],
                                    {"watcher_record": {}})[0], "CANCELLED before dispatch")

    def test_a_failure_the_memo_moved_past_does_not_decide_the_verdict(self):
        import memo_trace as mt
        t = lambda s: mc_.parse_iso(f"2026-10-20T02:00:{s:02d}Z")  # noqa: E731
        stuck = self.hop("fact:failed[agent_reply]", mt.FAILED, ts=t(10),
                         detail="turn_timeout: agent turn timed out after 300s (retryable=False, attempt=1)")
        later = self.hop("fact:dispatched", mt.OK, ts=t(30), detail="batch")
        waiting = self.hop("agent:invocation.done", mt.MISSING, detail="no invocation.completed/failed for this command")
        ctx = {"watcher_record": None, "stage_times": [(t(30), "dispatched")]}
        v, ok = mt.verdict([later, waiting, stuck], ctx)
        self.assertNotIn("turn timeout", v)  # a later dispatch: the old failure is history
        self.assertTrue(v.startswith("STOPPED AT agent:invocation.done"))
        # the same failure with nothing after it still decides
        self.assertIn("turn timeout", mt.verdict([waiting, stuck], {"watcher_record": None, "stage_times": []})[0])

    def test_while_the_watcher_has_the_memo_active_a_revive_or_dispatch_after_the_failure_supersedes_it(self):
        import memo_trace as mt
        t = lambda s: mc_.parse_iso(f"2026-10-20T02:00:{s:02d}Z")  # noqa: E731
        cancelled = self.hop("fact:failed[cancelled]", mt.FAILED, ts=t(10),
                             detail="cancelled: x (retryable=False, attempt=1, after_dispatch=True)")
        revived = {"status": "active", "stage": "await_agent", "revived_ts": t(20).timestamp()}
        self.assertFalse(mt.verdict([cancelled], {"watcher_record": revived})[0].startswith("CANCELLED"))
        # an operator who has not retried yet: the record says cancelled, and so does the verdict
        self.assertTrue(mt.verdict([cancelled], {"watcher_record": {"status": "cancelled", "revived_ts": t(20).timestamp()}})[0]
                        .startswith("CANCELLED"))
        # a dispatched fact after an after-dispatch cancel is bookkeeping, not a revival (no record to say otherwise)
        late_dispatch = {"watcher_record": None, "stage_times": [(t(11), "dispatched")]}
        self.assertTrue(mt.verdict([cancelled], late_dispatch)[0].startswith("CANCELLED"))
        # ... but a revive marker (a `received` fact) is
        marker = {"watcher_record": None, "stage_times": [(t(11), "received")]}
        self.assertFalse(mt.verdict([cancelled], marker)[0].startswith("CANCELLED"))

    def test_list_shows_the_live_stage_not_a_stale_failure(self):
        import memo_trace as mt
        ev = lambda typ, ts, **d: {"type": f"bloodbank.{typ}", "time": f"2026-10-20T02:00:{ts:02d}Z", "data": d}  # noqa: E731
        failed = ev("audio.memo.failed", 10, stage="agent_reply", retryable=False)
        events = [ev("audio.memo.dispatched", 5), failed, ev("audio.memo.dispatched", 30)]
        self.assertEqual(mt.furthest(events, None), "dispatched")
        self.assertEqual(mt.furthest(events[:2], None), "FAILED@agent_reply")
        # revived at await_agent: the marker fact is a received fact
        marked = [ev("audio.memo.dispatched", 5), ev("audio.memo.failed", 10, stage="cancelled", retryable=False, after_dispatch=True),
                  ev("audio.memo.received", 20, revived=True)]
        self.assertEqual(mt.furthest(marked, {"status": "active"}), "dispatched")
        self.assertEqual(mt.furthest(marked[:2], {"status": "cancelled"}), "CANCELLED")
        # a record that is failed keeps what its facts say, even with a later stage fact
        self.assertEqual(mt.furthest(events, {"status": "failed"}), "FAILED@agent_reply")

    def test_list_marks_a_cancelled_memo_until_a_reply_follows(self):
        import memo_trace as mt
        ev = lambda typ, **d: {"type": f"bloodbank.{typ}", "time": "t", "data": d}  # noqa: E731
        cancelled = ev("audio.memo.failed", stage="cancelled", retryable=False)
        self.assertEqual(mt.furthest([ev("audio.memo.dispatched"), cancelled], None), "CANCELLED")
        self.assertEqual(mt.furthest([ev("audio.memo.dispatched"), cancelled, ev("audio.memo.replied")], None), "replied")
        self.assertEqual(mt.furthest([ev("audio.memo.failed", stage="tts", retryable=False)], None), "FAILED@tts")

    def test_the_phone_text_hop_comes_before_the_audio_and_is_optional(self):
        import memo_trace as mt
        lm = mc_.parse_iso("2026-10-20T02:15:30.123Z")
        tkey = "phone/2026/10/20/021530123Z-holocene-pm-abc.txt"
        ekey = tkey[:-4] + ".ogg"
        with unittest.mock.patch.object(mt, "earshot_stat", return_value={"size": 1800, "last_modified": lm}), \
                unittest.mock.patch.object(mt, "earshot_beacons", return_value=[]):
            names = [h.name for h in mt.earshot_hops(ekey, tkey)]
            hops = {h.name: h for h in mt.earshot_hops(ekey, tkey)}
            missing = {h.name: h for h in mt.earshot_hops(ekey, None)}
        self.assertEqual(names[:2], ["phone_text", "phone_object"])
        self.assertEqual(hops["phone_text"].status, mt.OK)
        self.assertIn(f"s3://earshot/{tkey}", hops["phone_text"].detail)
        self.assertIn("1800 bytes", hops["phone_text"].detail)
        self.assertEqual((missing["phone_text"].status, missing["phone_text"].optional), (mt.UNKNOWN, True))  # an old reply
        with unittest.mock.patch.object(mt, "earshot_stat", return_value=None), unittest.mock.patch.object(mt, "earshot_beacons", return_value=[]):
            gone = {h.name: h for h in mt.earshot_hops(ekey, tkey)}["phone_text"]
        self.assertEqual((gone.status, gone.optional), (mt.MISSING, True))  # fail-open: never a reason to stop

    CMD1, CMD2 = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    KEY = "inbox/holocene-pm/2026/10/20/escalated-trace.ogg"

    def _events(self, escalated_dispatch=True, replied=True):
        mid = mc_.memo_id_for(self.KEY)

        def ev(typ, at, **data):
            return {"type": f"bloodbank.{typ}", "time": at, "data": {"memo_id": mid, "occurred_at": at, **data}}
        out = [
            ev("audio.memo.received", "2026-10-20T02:00:00.100Z", detect_lag_ms=5),
            ev("audio.memo.transcribed", "2026-10-20T02:00:01.000Z", transcript_chars=20, processing_seconds=1, model="m", transcript_text="hi"),
            ev("audio.memo.dispatched", "2026-10-20T02:00:02.000Z", command_id=self.CMD1, command_subject="x", lane="interactive", lane_reason=None),
            ev("agent.invocation.started", "2026-10-20T02:00:03.000Z", command_id=self.CMD1),
            ev("agent.invocation.failed", "2026-10-20T02:05:03.000Z", command_id=self.CMD1, error_code="turn_timeout",
               error_message="agent turn timed out after 300s on interactive lane (limit 300s)"),
        ]
        if escalated_dispatch:
            out += [ev("audio.memo.dispatched", "2026-10-20T02:05:04.000Z", command_id=self.CMD2, command_subject="x", lane="batch",
                       lane_reason="turn_timeout_escalated", escalated_from_command_id=self.CMD1),
                    ev("agent.invocation.started", "2026-10-20T02:05:05.000Z", command_id=self.CMD2),
                    ev("agent.invocation.completed", "2026-10-20T02:12:00.000Z", command_id=self.CMD2)]
        if replied:
            out.append(ev("audio.memo.replied", "2026-10-20T02:12:05.000Z", reply_chars=300, tts_seconds=1.0, tts_engine="fakevox",
                          reply_s3_key="replies/x.ogg", late=True, escalated=True, earshot_key="phone/a.ogg", earshot_text_key="phone/a.txt"))
        return out

    def _build(self, events, rec):
        import contextlib
        import memo_trace as mt
        rows = {
            self.CMD1: {"state": "completed", "outcome": "failure", "profile": "holocene-pm", "created_at": "2026-10-20T02:00:02Z",
                        "updated_at": "2026-10-20T02:05:03Z", "lane": "interactive", "failure_code": "turn_timeout", "terminal": []},
            self.CMD2: {"state": "completed", "outcome": "success", "profile": "holocene-pm", "created_at": "2026-10-20T02:05:04Z",
                        "updated_at": "2026-10-20T02:12:00Z", "lane": "batch", "failure_code": None, "terminal": []}}
        lm = lambda k: {"size": 9, "last_modified": mc_.parse_iso("2026-10-20T02:00:00Z" if k == self.KEY else "2026-10-20T02:12:05Z")}  # noqa: E731
        with contextlib.ExitStack() as st:
            for target, name, kw in ((mt.c, "candystore_events", {"return_value": events}), (mt.c, "s3_stat", {"side_effect": lm}),
                                     (mt.c, "journal_row", {"side_effect": rows.get}),
                                     (mt.c, "find_reply", {"return_value": {"prompt": "hi", "text": "x"}}),
                                     (mt, "upload_log_line", {"return_value": (None, None)}),
                                     (mt, "watcher_record", {"return_value": rec}),
                                     (mt, "watcher_heartbeat", {"return_value": {"age_s": 1.0}}),
                                     (mt, "watcher_unit_active", {"return_value": "active"}),
                                     (mt, "earshot_stat", {"return_value": {"size": 5, "last_modified": mc_.parse_iso("2026-10-20T02:12:05Z")}}),
                                     (mt, "earshot_beacons", {"return_value": []})):
                st.enter_context(unittest.mock.patch.object(target, name, **kw))
            hops, ctx = mt.build(self.KEY)
            return hops, ctx, mt.verdict(hops, ctx)

    def test_an_escalated_memo_shows_both_dispatches_and_both_turns_and_completes(self):
        import memo_trace as mt
        rec = {"status": "done", "escalated": True, "lane": "batch", "lane_reason": "turn_timeout_escalated",
               "command_id": self.CMD2, "escalated_from_command_id": self.CMD1}
        hops, ctx, (text, complete) = self._build(self._events(), rec)
        by = {h.name: h for h in hops}
        # both dispatches, the second one saying why
        self.assertIn(self.CMD1, by["fact:dispatched(1)"].detail)
        self.assertIn("lane=interactive", by["fact:dispatched(1)"].detail)
        self.assertIn("ESCALATED", by["fact:dispatched"].detail)
        self.assertIn(self.CMD1, by["fact:dispatched"].detail)
        self.assertIn("lane=batch", by["fact:dispatched"].detail)
        # both turns: the timed-out one is history, the batch one is current
        for name in ("turn1:gateway_journal", "turn1:agent:invocation.started", "turn1:agent:invocation.done"):
            self.assertTrue(by[name].superseded, name)
        self.assertEqual(by["turn1:agent:invocation.done"].status, mt.FAILED)
        self.assertIn("turn_timeout", by["turn1:agent:invocation.done"].detail)
        self.assertEqual(by["turn1:gateway_journal"].status, mt.FAILED)
        for name in ("gateway_journal", "agent:invocation.started", "agent:invocation.done"):
            self.assertEqual((by[name].status, by[name].superseded), (mt.OK, False), name)
        self.assertEqual((ctx["command_id"], ctx["escalated_from"], ctx["lane"]), (self.CMD2, self.CMD1, "batch"))
        self.assertIn("late reply", by["fact:replied"].detail)
        # the phone text sits next to the phone hops
        self.assertEqual(ctx["earshot_text_key"], "phone/a.txt")
        self.assertIn("phone/a.txt", by["phone_text"].detail)
        # the superseded failure never decides the verdict
        self.assertTrue(complete, text)
        self.assertTrue(text.startswith("COMPLETE in"), text)
        self.assertIn("escalated to the batch lane", text)

    def test_progress_narrations_and_car_speech_are_shown_per_turn_and_timed(self):
        import io
        import contextlib
        import memo_trace as mt
        mid = mc_.memo_id_for(self.KEY)

        def ev(typ, at, **data):
            return {"type": f"bloodbank.{typ}", "time": at, "data": {"memo_id": mid, "occurred_at": at, **data}}
        events = self._events()
        events += [ev("agent.invocation.progressed", f"2026-10-20T02:00:1{i}.000Z", command_id=self.CMD1, seq=i,
                      text=f"first turn step {i}", elapsed_seconds=10 + i) for i in (1, 2)]
        events += [ev("agent.invocation.progressed", f"2026-10-20T02:06:{10 + i}.000Z", command_id=self.CMD2, seq=i,
                      text=f"batch step {i}", elapsed_seconds=60 + i) for i in range(1, 11)]
        events.append(ev("audio.memo.narrated", "2026-10-20T02:06:30.000Z", command_id=self.CMD2, seq=10, narration=1,
                         progress_s3_key="progress/2026/10/20/x-1.ogg", tts_seconds=2.1, tts_engine="voxcpm", elapsed_seconds=86))
        events += [ev("audio.memo.notified", "2026-10-20T01:59:59.600Z", utterance="ack", decision="started", since_stop_ms=410),
                   ev("audio.memo.notified", "2026-10-20T02:00:02.900Z", utterance="echo", decision="start",
                      device_at="2026-10-20T02:00:02.500Z", mic="idle"),
                   ev("audio.memo.notified", "2026-10-20T02:06:31.000Z", utterance="progress", decision="deferred",
                      reason="recording", recording=True),
                   ev("audio.memo.notified", "2026-10-20T02:12:09.000Z", utterance="reply", decision="started")]
        rec = {"status": "done", "escalated": True, "lane": "batch", "lane_reason": "turn_timeout_escalated",
               "command_id": self.CMD2, "escalated_from_command_id": self.CMD1}
        hops, ctx, (text, complete) = self._build(events, rec)
        names = [h.name for h in hops]
        # the timed-out turn's progress is history, named for its turn
        self.assertIn("turn1:agent:progress#1", names)
        self.assertTrue(next(h for h in hops if h.name == "turn1:agent:progress#2").superseded)
        # the batch turn's ten lines: first three, a count, last three, with the narration placed by time
        cur = [n for n in names if n.startswith(("agent:progress", "car:narrated"))]
        self.assertEqual(cur, ["agent:progress#1", "agent:progress#2", "agent:progress#3", "agent:progress...",
                               "agent:progress#8", "agent:progress#9", "agent:progress#10", "car:narrated#1"])
        self.assertIn("4 more", next(h for h in hops if h.name == "agent:progress...").detail)
        self.assertIn("progress/2026/10/20/x-1.ogg", next(h for h in hops if h.name == "car:narrated#1").detail)
        self.assertTrue(all(h.optional for h in hops if h.name.startswith(("agent:progress", "car:", "turn1:agent:progress"))))
        self.assertTrue(complete, text)  # annotations never decide the verdict
        self.assertEqual(next(h for h in hops if h.name == "car_status_object").status, mt.UNKNOWN)
        # car speech and the time-to-first-sound line
        self.assertEqual([e["data"]["utterance"] for e in ctx["speech"]], ["ack", "echo", "progress", "reply"])
        t0 = mc_.parse_iso("2026-10-20T02:00:00Z")
        lines = mt.speech_lines(ctx["speech"], t0)
        self.assertTrue(lines[0].strip().startswith("-0.4s") and "since stop 410 ms" in lines[0], lines[0])
        self.assertIn("while recording", lines[2])
        timing = mt.timing_line(ctx, hops)
        for part in ("ack -0.4s", "heard-echo +2.5s", "first progress +11.0s", "first narration +390.0s", "reply played +729.0s"):
            self.assertIn(part, timing)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            mt.render(hops, ctx)
        self.assertIn("car speech (4 arbiter decisions", out.getvalue())
        self.assertIn("timing   since upload:", out.getvalue())

    def test_a_memo_between_the_timeout_and_the_batch_dispatch_is_in_progress_not_stopped(self):
        import memo_trace as mt
        rec = {"status": "active", "stage": "dispatch", "escalated": True, "lane": "batch", "lane_reason": "turn_timeout_escalated",
               "command_id": self.CMD2, "escalated_from_command_id": self.CMD1, "step_started_ts": time.time()}
        hops, ctx, (text, complete) = self._build(self._events(escalated_dispatch=False, replied=False), rec)
        by = {h.name: h for h in hops}
        self.assertEqual(by["fact:dispatched"].status, mt.MISSING)
        self.assertIn("escalating", by["fact:dispatched"].detail)
        self.assertTrue(by["turn1:agent:invocation.done"].superseded)
        self.assertEqual(ctx["command_id"], self.CMD2)
        self.assertFalse(complete)
        self.assertTrue(text.startswith("IN PROGRESS at dispatch"), text)
        self.assertNotIn("turn1", text)  # the timed-out turn is not the reason the memo is waiting


class RecordingWriter(iw.StatusWriter):
    """The real StatusWriter, recording every document the watcher hands it (key, doc), superseded ones included."""

    def __init__(self):
        self.docs = []
        super().__init__(upload=lambda key, body: (True, ""))

    def put(self, key, doc):
        self.docs.append((key, json.loads(json.dumps(doc, default=str))))
        super().put(key, doc)

    def stages(self, key=None):
        out = []
        for k, d in self.docs:
            if (key is None or k == key) and (not out or out[-1] != d["stage"]):
                out.append(d["stage"])
        return out

    def last(self, key=None):
        return [d for k, d in self.docs if key is None or k == key][-1]


def progress_fact(cid, seq, text, secs_ago=0.0):
    at = mc_.iso(time.time() - secs_ago)
    return {"type": mc_.PROGRESS_TYPE, "time": at,
            "data": {"command_id": cid, "seq": seq, "text": text, "elapsed_seconds": 10.0 + seq}}


class CarStatus(MemoHarness, unittest.TestCase):
    """status/<date>/<memo_id>.json follows the memo; the newest progress line is in it and, throttled, spoken."""

    def setUp(self):
        super().setUp()
        self.w.status_writer = RecordingWriter()
        self.events = []
        self.cs = unittest.mock.patch.object(mc_, "progress_events", side_effect=lambda mid, limit=200: list(self.events))
        self.cs.start()
        MC_PIPE_LOG.unlink(missing_ok=True)

    def tearDown(self):
        self.cs.stop()
        super().tearDown()

    def drain(self):
        self.w.status_writer.drain()

    def wait_narration(self, timeout=5.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self.w.mu:
                if not self.w.narrating:
                    return
            time.sleep(0.02)
        self.fail("a narration render never finished")

    def working(self, name, since_dispatch=20.0):
        """A memo whose command is out and whose agent is working, dispatched `since_dispatch` seconds ago."""
        key, m = self.to_await(name)
        m["dispatched_ts"] = time.time() - since_dispatch
        return key, m

    def test_the_status_object_follows_every_stage_and_carries_what_the_car_needs(self):
        key = self.upload("status-journey")
        mid = mc_.memo_id_for(key)
        skey = f"status/2026/10/19/{mid}.json"
        self.assertEqual(mc_.status_key_for(key), skey)
        m = self.discover(key)
        self.tick_until(lambda: m["stage"] == "await_agent")
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", mid, "Here is the summary.")
        self.tick_until(lambda: m["status"] == "done")
        rec = self.w.status_writer
        self.assertEqual(rec.stages(skey), ["received", "transcribing", "heard", "working", "replying", "done"])
        heard = next(d for k, d in rec.docs if k == skey and d["stage"] == "heard")
        self.assertEqual(heard["heard"], "Summarize recent work.")
        self.assertEqual((heard["memo_id"], heard["agent"], heard["agent_name"], heard["s3_key"]),
                         (mid, "holocene-pm", "Holocene PM", key))
        self.assertIsNone(heard["progress"])
        working = next(d for k, d in rec.docs if k == skey and d["stage"] == "working")
        self.assertEqual(working["command_id"], m["command_id"])
        self.assertIsNotNone(working["dispatched_at"])
        done = rec.last(skey)
        self.assertEqual(done["reply_key"], m["reply_key"])
        self.assertEqual(done["started_at"], m["uploaded_at"])
        self.assertGreaterEqual(done["elapsed_s"], 0)
        self.assertNotIn("error", done)

    def test_the_real_writer_uploads_json_that_is_never_cached(self):
        w = iw.StatusWriter()
        key = "status/2026/10/19/abc.json"
        w.put(key, {"stage": "heard"})
        w.put(key, {"stage": "working"})  # newest wins: one upload
        self.assertEqual(w.drain(), 1)
        self.assertEqual(json.loads((BUCKET_DIR / key).read_text()), {"stage": "working"})
        pipes = [json.loads(line) for line in MC_PIPE_LOG.read_text().splitlines()]
        self.assertEqual(pipes, [{"dst": f"delo/holocene-auto/{key}", "attr": iw.STATUS_ATTR}])
        (BUCKET_DIR / key).unlink()

    def test_a_failed_write_is_retried_unless_something_newer_replaced_it(self):
        calls = []
        w = iw.StatusWriter(upload=lambda k, b: (calls.append(json.loads(b)), (len(calls) > 1, "down"))[1])
        w.put("k", {"n": 1})
        self.assertEqual(w.drain(), 0)
        self.assertEqual(w.pending(), 1)  # kept for the retry
        self.assertEqual(w.drain(), 1)
        self.assertEqual(calls, [{"n": 1}, {"n": 1}])

    def test_a_failed_memo_says_why(self):
        key = self.upload("status-deadmic", b"OggS DEADMIC")
        m = self.discover(key)
        self.tick_until(lambda: m["status"] == "failed")
        doc = self.w.status_writer.last(mc_.status_key_for(key))
        self.assertEqual((doc["stage"], doc["error_code"]), ("failed", "silent_audio"))
        self.assertIn("recording is silent", doc["error"])

    def test_a_cancelled_memo_is_failed_for_the_car(self):
        key, m = self.to_await("status-cancel")
        self.w.cancel_memo(m)
        doc = self.w.status_writer.last(mc_.status_key_for(key))
        self.assertEqual((doc["stage"], doc["error_code"]), ("failed", iw.CANCELLED))

    def test_the_newest_progress_line_reaches_the_status_and_is_spoken_once(self):
        key, m = self.working("status-progress")
        cid = m["command_id"]
        self.events = [progress_fact(cid, 1, "I'll check the board first.", 5),
                       progress_fact(cid, 2, "**Reading** the `open` tickets now: https://x.y/z", 1)]
        self.w.poll_progress()
        self.wait_narration()
        doc = self.w.status_writer.last(mc_.status_key_for(key))
        self.assertEqual((doc["stage"], doc["progress_seq"]), ("working", 2))
        self.assertEqual(doc["progress"], "Reading the open tickets now: link")
        # spoken: the newest line, with the agent's name, through the progress voice
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM: Reading the open tickets now: link")
        pkey = f"progress/2026/10/19/{m['memo_id']}-1.ogg"
        self.assertTrue((BUCKET_DIR / pkey).exists())
        self.assertIn({"src": unittest.mock.ANY, "dst": f"delo/holocene-auto/{pkey}", "attr": "Content-Type=audio/ogg"},
                      mc_cps())
        (narr,) = self.of_type("narrated", key)
        self.assertEqual((narr["seq"], narr["narration"], narr["progress_s3_key"], narr["command_id"]), (2, 1, pkey, cid))
        self.assertEqual(narr["tts_engine"], "fakevox")
        doc = self.w.status_writer.last(mc_.status_key_for(key))
        self.assertEqual((doc["narration"]["n"], doc["narration"]["key"], doc["narration"]["seq"]), (1, pkey, 2))
        # the pad's cursor: the newest clip number (progress/<day>/<memo>-<spoken_seq>.ogg), not the gateway's seq
        self.assertEqual((doc["spoken_seq"], doc["spoken_key"]), (1, pkey))
        # nothing new: nothing spoken again
        self.w.poll_progress()
        self.wait_narration()
        self.assertEqual(len(self.of_type("narrated", key)), 1)
        (BUCKET_DIR / pkey).unlink()

    def test_at_most_one_update_per_gap_and_the_newest_one_wins(self):
        key, m = self.working("status-gap")
        cid = m["command_id"]
        self.events = [progress_fact(cid, 1, "Checking the date.")]
        self.w.poll_progress()
        self.wait_narration()
        self.events.append(progress_fact(cid, 2, "Counting the files."))
        self.w.poll_progress()
        self.wait_narration()
        self.assertEqual(len(self.of_type("narrated", key)), 1)  # inside the 30 s gap: shown, not spoken
        self.assertEqual(self.w.status_writer.last(mc_.status_key_for(key))["progress_seq"], 2)
        self.assertEqual(self.w.narration_due(m), "too_soon")
        self.events.append(progress_fact(cid, 3, "Writing the answer."))
        m["narr_last_ts"] -= iw.NARRATE_GAP_S + 1
        self.w.poll_progress()
        self.wait_narration()
        spoken = self.of_type("narrated", key)
        self.assertEqual([(n["narration"], n["seq"]) for n in spoken], [(1, 1), (2, 3)])  # seq 2 was never spoken
        self.assertEqual(VOX_TEXTS[-1], "Holocene PM: Writing the answer.")
        for n in (1, 2):
            (BUCKET_DIR / mc_.progress_key_for(key, n)).unlink(missing_ok=True)

    def test_nothing_is_spoken_in_the_first_seconds_of_a_turn(self):
        key, m = self.working("status-early", since_dispatch=2.0)
        self.events = [progress_fact(m["command_id"], 1, "On it.")]
        self.w.poll_progress()
        self.wait_narration()
        self.assertEqual(self.w.status_writer.last(mc_.status_key_for(key))["progress"], "On it.")  # shown at once
        self.assertEqual(self.of_type("narrated", key), [])
        self.assertEqual(self.w.narration_due(m), "too_early")
        self.assertEqual(VOX_TEXTS, [])

    def test_a_turn_that_is_done_gets_no_narration_even_with_a_render_in_flight(self):
        key, m = self.working("status-done")
        cid = m["command_id"]
        self.events = [progress_fact(cid, 1, "Looking it up.")]
        real = iw.synthesize

        def finishing(text, tmp, **kw):
            with self.w.mu:
                m["stage"] = "reply"  # the agent finished while the progress line was being voiced
            return real(text, tmp, **kw)
        with unittest.mock.patch.object(iw, "synthesize", side_effect=finishing):
            self.w.poll_progress()
            self.wait_narration()
        self.assertEqual(self.of_type("narrated", key), [])
        self.assertFalse((BUCKET_DIR / mc_.progress_key_for(key, 1)).exists())
        # and once it is past await_agent the poller does not even ask
        self.w.poll_progress()
        self.wait_narration()
        self.assertEqual(self.of_type("narrated", key), [])

    def test_progress_of_another_command_is_not_this_memos(self):
        key, m = self.working("status-other")
        self.events = [progress_fact(str(uuid.uuid4()), 4, "Somebody else's work.")]
        self.w.poll_progress()
        self.wait_narration()
        self.assertIsNone(m.get("progress_text"))
        self.assertEqual(self.of_type("narrated", key), [])

    def test_a_new_command_starts_its_seq_again(self):
        key, m = self.working("status-esc")
        old = m["command_id"]
        self.events = [progress_fact(old, 5, "First turn, step five.")]
        self.w.poll_progress()
        self.wait_narration()
        m["command_id"] = new = str(uuid.uuid4())  # escalated: the batch command reports seq 1 again
        self.events = [progress_fact(new, 1, "Batch turn, step one.")]
        m["narr_last_ts"] -= iw.NARRATE_GAP_S + 1
        self.w.poll_progress()
        self.wait_narration()
        self.assertEqual((m["progress_cmd"], m["progress_seq"], m["progress_text"]), (new, 1, "Batch turn, step one."))
        spoken = self.of_type("narrated", key)
        self.assertEqual([(n["narration"], n["command_id"]) for n in spoken], [(1, old), (2, new)])
        for n in (1, 2):
            (BUCKET_DIR / mc_.progress_key_for(key, n)).unlink(missing_ok=True)

    def test_candystore_down_keeps_the_last_line_and_never_raises(self):
        key, m = self.working("status-cs-down")
        self.events = [progress_fact(m["command_id"], 1, "Step one.")]
        self.w.poll_progress()
        self.wait_narration()
        with unittest.mock.patch.object(mc_, "progress_events", side_effect=OSError("connection refused")):
            self.w.poll_progress()
            self.w.poll_progress()
        self.assertEqual(m["progress_text"], "Step one.")
        (BUCKET_DIR / mc_.progress_key_for(key, 1)).unlink(missing_ok=True)

    def test_keys_stages_and_the_prompt_asks_for_narration(self):
        key = "inbox/holocene-pm/2026/10/19/x.ogg"
        mid = mc_.memo_id_for(key)
        self.assertEqual(mc_.progress_key_for(key, 3), f"progress/2026/10/19/{mid}-3.ogg")
        self.assertTrue(mc_.status_key_for("inbox/stray.ogg").startswith("status/"))
        self.assertEqual(iw.car_stage({"status": "active", "stage": "dispatch"}), "heard")
        self.assertEqual(iw.car_stage({"status": "active", "stage": "dispatch", "escalated": True}), "working")
        self.assertEqual(iw.car_stage({"status": "failed", "stage": "await_agent"}), "failed")
        self.assertEqual(iw.car_stage({"status": "active", "stage": "speak"}), "replying")
        self.assertIn("before each tool call", iw.VOICE_PREFIX)
        # the phone's bucket is never written: progress and status live in holocene-auto
        self.assertTrue(mc_.s3_url(mc_.progress_key_for(key, 1)).startswith(f"delo/{mc_.BUCKET}/progress/"))


class EarshotMirror(unittest.TestCase):
    """Agent replies also play on the phone (Earshot); the phone's beacons become memo:trace hops."""

    def test_key_is_dated_and_carries_agent_and_memo(self):
        from datetime import datetime, timezone
        k = iw.earshot_key_for(datetime(2026, 10, 19, 20, 1, 2, 345000, tzinfo=timezone.utc), "holocene-pm", "abc")
        self.assertEqual(k, "phone/2026/10/19/200102345Z-holocene-pm-abc.ogg")

    def test_mirror_failure_is_logged_and_never_fails_the_reply(self):
        import subprocess
        from datetime import datetime, timezone
        from unittest import mock
        bad = subprocess.CompletedProcess([], 1, "", "S3 down")
        with mock.patch.object(iw.mc_, "mc", return_value=bad):
            self.assertIsNone(iw.mirror_to_earshot(Path("/dev/null"), datetime.now(timezone.utc), "a", "m", "k"))
        with mock.patch.object(iw.mc_, "mc", side_effect=OSError("no mc")):
            self.assertIsNone(iw.mirror_to_earshot(Path("/dev/null"), datetime.now(timezone.utc), "a", "m", "k"))
        with mock.patch.object(iw, "EARSHOT_CHANNEL", ""):
            self.assertIsNone(iw.mirror_to_earshot(Path("/dev/null"), datetime.now(timezone.utc), "a", "m", "k"))

    def test_phone_beacons_become_hops_with_skew_corrected_times(self):
        import memo_trace as mt
        from unittest import mock
        ekey = "phone/2026/10/19/200102345Z-holocene-pm-abc.ogg"
        jl = ROOT / "beacons.jsonl"
        rows = [
            # an earlier generation of the same key: ignored
            {"key": ekey, "phase": "started", "at": "2026-10-19T19:00:00.000Z", "ts": "2026-10-19T19:00:00.100Z", "status": 200},
            {"key": ekey, "phase": "detected", "at": "2026-10-19T20:01:04.500Z", "clock_skew_ms": 500, "device": "SM-S948U",
             "app_version": "0.1.1", "ts": "2026-10-19T20:01:04.100Z", "status": 200},
            {"key": ekey, "phase": "started", "at": "2026-10-19T20:01:04.600Z", "clock_skew_ms": 500, "device": "SM-S948U",
             "ts": "2026-10-19T20:01:04.200Z", "status": 200},
            {"key": "phone/other.ogg", "phase": "finished", "at": "2026-10-19T20:01:09Z", "status": 200},
        ]
        jl.write_text("".join(json.dumps(r) + "\n" for r in rows))
        lm = mc_.parse_iso("2026-10-19T20:01:02.400Z")
        with mock.patch.object(mt, "EARSHOT_JSONL", jl), \
                mock.patch.object(mt, "earshot_stat", return_value={"size": 9, "last_modified": lm}):
            hops = {h.name: h for h in mt.earshot_hops(ekey)}
        self.assertEqual(hops["phone_object"].status, mt.OK)
        self.assertEqual(mc_.iso(hops["phone_detected"].ts), mc_.iso(mc_.parse_iso("2026-10-19T20:01:04.000Z")))
        self.assertEqual(hops["phone_started"].status, mt.OK)
        self.assertEqual(hops["phone_finished"].status, mt.UNKNOWN)   # not reported yet: annotation, not a stop
        self.assertTrue(hops["phone_finished"].optional)

    def test_a_landed_but_unrecorded_drop_is_recorded_not_dropped_again(self):
        # A crash (or an mc timeout after commit) left earshot_attempted but no earshot_key: the retry must stat,
        # find the object, and record it instead of re-uploading (a new LastModified plays the reply twice).
        key = "inbox/holocene-pm/2026/10/19/redrop.ogg"
        mid = mc_.memo_id_for(key)
        w = iw.Watcher(iw.State(Path(tempfile.mkdtemp(prefix="redrop-"))))
        stamp = mc_.parse_iso("2026-10-19T21:00:00.123Z")
        want = iw.earshot_key_for(stamp, "holocene-pm", mid)
        m = {"memo_id": mid, "key": key, "agent": "holocene-pm", "reply_text": "Done.", "reply_stamp": iso_z(stamp),
             "earshot_attempted": want, "attempts": {}, "status": "active", "stage": "speak", "received_ts": time.time()}
        w.s.memos[key] = m
        calls = []
        real_mc = iw.mc_.mc

        def spy(*a, **k):
            calls.append(a)
            return real_mc(*a, **k)
        (BUCKET_DIR / want).parent.mkdir(parents=True, exist_ok=True)
        (BUCKET_DIR / want).write_bytes(b"OggS-already-there")
        before = EMITS.read_text() if EMITS.exists() else ""
        try:
            with unittest.mock.patch.object(iw.mc_, "mc", side_effect=spy):
                w.step_speak(m)
        finally:
            EMITS.write_text(before)  # the Pipeline tests count every fact in this shared log
        self.assertEqual(m["earshot_key"], want)
        dropped = [a for a in calls if a[0] == "cp" and "/earshot/" in a[-1]]
        self.assertEqual(dropped, [])
        self.assertEqual((BUCKET_DIR / want).read_bytes(), b"OggS-already-there")

    def test_no_mirror_recorded_is_an_optional_annotation(self):
        import memo_trace as mt
        (h,) = mt.earshot_hops(None)
        self.assertTrue(h.optional and h.status == mt.UNKNOWN)


class ChunkedSpeech(MemoHarness, unittest.TestCase):
    """A long reply is voiced chunk by chunk (the car starts on the first sentence), then joined into the full file."""

    LONG = ("The board has three tickets waiting. The first is the speech queue fix, which is ready to merge today. "
            "The second is progress narration, which still needs a drive test in the real car before it ships. "
            "The third is chunked replies, which I am starting now, and it should land by the end of the evening. "
            "Nothing else is blocked.")

    def replied_memo(self, name, reply=None):
        key, m = self.to_await(name)
        journal(m["command_id"], "holocene-pm")
        hermes_session("holocene-pm", m["memo_id"], reply or self.LONG, ts=time.time())
        return key, m

    # ---- the split ----

    def test_a_short_reply_is_one_piece_and_a_long_one_grows_by_sentences(self):
        self.assertEqual(iw.split_for_speech("Holocene PM. Quick answer."), ["Holocene PM. Quick answer."])
        self.assertEqual(iw.split_for_speech("   "), [])
        spoken = "Holocene PM. " + self.LONG
        parts = iw.split_for_speech(spoken)
        self.assertGreater(len(parts), 2)
        self.assertEqual(" ".join(parts), re.sub(r"\s+", " ", spoken).strip())  # nothing lost, nothing added
        self.assertTrue(parts[0].startswith("Holocene PM. "))            # the name rides in the first chunk
        for i, p in enumerate(parts[:-1]):
            self.assertLessEqual(len(p), iw.CHUNK_CHARS[min(i, len(iw.CHUNK_CHARS) - 1)], p)
            self.assertTrue(p.endswith((".", "!", "?", ",", ";", ":")) or " " not in p[-3:], p)
        self.assertLessEqual(len(parts[0]), iw.CHUNK_CHARS[0])
        self.assertGreaterEqual(len(parts[-1]), iw.CHUNK_TAIL_CHARS)

    def test_one_endless_sentence_is_cut_at_a_clause_or_a_word_never_mid_word(self):
        spoken = "Holocene PM. " + ", ".join(f"item number {i} is fine" for i in range(40))
        parts = iw.split_for_speech(spoken)
        self.assertEqual(" ".join(parts), spoken)
        words = set(spoken.replace(",", " ").split())
        for p in parts:
            self.assertIn(p.split()[0].strip(","), words)
            self.assertIn(p.split()[-1].strip(","), words)

    def test_chunking_off_keeps_one_piece(self):
        with unittest.mock.patch.object(iw, "REPLY_CHUNKS", False):
            self.assertEqual(len(iw.split_for_speech("Holocene PM. " + self.LONG)), 1)

    # ---- the pipeline ----

    def test_each_chunk_goes_up_and_is_announced_before_the_full_reply(self):
        key, m = self.replied_memo("chunk-basic")
        n0 = len(mc_cps())
        self.tick_until(lambda: m["status"] == "done")
        voiced = self.of_type("voiced", key)
        replied = self.of_type("replied", key)[-1]
        n = replied["reply_chunks"]
        self.assertGreater(n, 1)
        self.assertEqual([v["chunk"] for v in voiced], list(range(1, n + 1)))
        self.assertTrue(all(v["chunks"] == n and v["reply_s3_key"] == replied["reply_s3_key"] for v in voiced))
        stem = replied["reply_s3_key"][:-len(".ogg")]
        self.assertEqual([v["chunk_s3_key"] for v in voiced], [f"{stem}-c{i:02d}of{n:02d}.opus" for i in range(1, n + 1)])
        # every chunk is a real object, uploaded as Ogg audio, before the full file; the full file is the chunks joined
        calls = [c for c in mc_cps()[n0:] if "/holocene-auto/replies/" in c["dst"]]
        self.assertEqual([c["dst"].split("/holocene-auto/")[1] for c in calls], [v["chunk_s3_key"] for v in voiced] + [replied["reply_s3_key"]])
        self.assertTrue(all(c["attr"] == "Content-Type=audio/ogg" for c in calls[:-1]))
        full = (BUCKET_DIR / replied["reply_s3_key"]).read_bytes()
        self.assertEqual(full, b"".join((BUCKET_DIR / v["chunk_s3_key"]).read_bytes() for v in voiced))
        # the fact order: every voiced before replied; timing on both
        order = [t.split(".")[-1] for t, r in facts() if r["data"].get("s3_key") == key and t.endswith(("voiced", "replied"))]
        self.assertEqual(order, ["voiced"] * n + ["replied"])
        self.assertIsNotNone(replied["first_chunk_seconds"])
        self.assertLessEqual(replied["first_chunk_seconds"], replied["last_chunk_seconds"])
        self.assertTrue(all(v["since_reply_seconds"] is not None and v["since_agent_done_seconds"] is not None for v in voiced))
        # vox heard the chunks, in order, and nothing else (the full file was joined, not rendered again)
        self.assertEqual(VOX_TEXTS, [v["spoken_text"] for v in voiced])
        self.assertTrue(VOX_TEXTS[0].startswith("Holocene PM. "))
        # the phone still gets one full file
        self.assertTrue(replied["earshot_key"].endswith(".ogg"))
        self.assertNotIn("voiced_keys", m)  # compacted once done
        doc = iw.status_doc(m)
        self.assertEqual(doc["reply_chunks"], {"n": n, "voiced": n})

    def test_a_join_that_fails_renders_the_full_reply_whole(self):
        key, m = self.replied_memo("chunk-nojoin")
        real = iw.synthesize

        def first_chunk_unjoinable(text, tmp, voice=None, steps=None):
            p, e = real(text, tmp, voice, steps)
            if tmp.name == "c01":
                p.write_bytes(p.read_bytes() + b"NOJOIN")
            return p, e
        with unittest.mock.patch.object(iw, "synthesize", side_effect=first_chunk_unjoinable):
            self.tick_until(lambda: m["status"] == "done")
        n = self.of_type("replied", key)[-1]["reply_chunks"]
        self.assertEqual(len(VOX_TEXTS), n + 1)
        self.assertEqual(VOX_TEXTS[-1], " ".join(VOX_TEXTS[:-1]))  # the whole reply, in one render

    def test_a_retry_after_a_failed_chunk_upload_does_not_announce_a_chunk_twice(self):
        key, m = self.replied_memo("chunk-retry")
        real = mc_.mc
        failed = []

        def flaky(*a, **k):
            if a[0] == "cp" and a[-1].endswith("of03.opus") and "-c02" in a[-1] and not failed:
                failed.append(1)
                return iw.subprocess.CompletedProcess(a, 1, "", "mc: <ERROR> network down")
            return real(*a, **k)
        with unittest.mock.patch.object(mc_, "mc", side_effect=flaky):
            self.tick_until(lambda: m["status"] == "done")
        voiced = self.of_type("voiced", key)
        n = self.of_type("replied", key)[-1]["reply_chunks"]
        self.assertTrue(failed, "the test reply must have three chunks")
        self.assertEqual(sorted(v["chunk"] for v in voiced), list(range(1, n + 1)))  # once each

    def test_a_failed_chunk_upload_stops_the_renders_instead_of_finishing_them(self):
        key, m = self.to_await("chunk-stop")
        m["stage"], m["reply_text"] = "speak", ("One sentence here for the test. " * 30).strip()
        parts = [f"Chunk number {i} of the reply." for i in range(1, 6)]
        real_mc, real_syn = mc_.mc, iw.synthesize
        renders = []

        def slow(text, tmp, voice=None, steps=None):
            renders.append(text)
            time.sleep(0.15)
            return real_syn(text, tmp, voice, steps)

        def no_c01(*a, **k):
            if a[0] == "cp" and "-c01of" in a[-1]:
                return iw.subprocess.CompletedProcess(a, 1, "", "mc: <ERROR> network down")
            return real_mc(*a, **k)
        stamp = mc_.parse_iso(iw.iso(iw.now_utc()))
        with unittest.mock.patch.object(mc_, "mc", side_effect=no_c01), unittest.mock.patch.object(iw, "synthesize", side_effect=slow):
            with self.assertRaises(iw.StageError) as e:
                self.w._voice_chunks(m, parts, stamp, Path(tempfile.mkdtemp()), time.time())
        self.assertEqual(e.exception.stage, "reply_upload")
        self.assertLess(len(renders), len(parts))

    def test_a_cancel_between_chunks_takes_every_uploaded_chunk_back(self):
        key, m = self.replied_memo("chunk-cancel")
        real = mc_.mc
        fired = []

        def spy(*a, **k):
            r = real(*a, **k)
            if a[0] == "cp" and "-c01of" in a[-1] and not fired:  # the car may already be speaking chunk 1
                fired.append(1)
                with self.w.mu:
                    self.w.cancel_memo(m)
            return r
        n_rm = len(mc_rms())
        with unittest.mock.patch.object(mc_, "mc", side_effect=spy):
            self.tick_until(lambda: m["status"] == "cancelled" and key not in self.w.running and len(mc_rms()) > n_rm)
            self.ticks(4)
        self.assertTrue(fired)
        self.assertEqual(self.of_type("replied", key), [])
        gone = mc_rms()[n_rm:]
        self.assertTrue(gone and all(g.endswith(".opus") for g in gone), gone)
        self.assertEqual([p for p in BUCKET_DIR.rglob("*") if m["memo_id"] in p.name], [])
        self.assertNotIn("earshot_key", m)  # the phone never got anything


if __name__ == "__main__":
    unittest.main()

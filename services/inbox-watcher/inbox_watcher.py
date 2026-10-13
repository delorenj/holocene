#!/usr/bin/env python3
"""Inbox watcher: polls S3 inbox, transcribes, dispatches bloodbank commands.

Watches s3://holocene-auto/inbox/<agent-id>/YYYY/MM/DD/*.ogg for new files.
When one lands: download → transcribe via local faster-whisper → pack a
bloodbank.cmd.agent.invocation.start with target_agent_id from the path →
publish via bb-emit. Idempotent: a state file tracks processed keys.

Operator rule (Jarad, 2026-10-12): routing is explicit from the button press,
never inferred. The agent id comes from the S3 key, not from the audio content.

Run: python3 inbox_watcher.py [--once] [--poll 15]
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

S3_BUCKET = "delo/holocene-auto"
S3_BASE_URL = "https://s3.delo.sh/holocene-auto"
INBOX_PREFIX = "inbox"
STATE_FILE = Path(__file__).parent / "inbox-watcher-state.json"
BB_EMIT = "/home/delorenj/code/33GOD/bloodbank/bin/bb-emit"
TRANSCRIBE = "/home/delorenj/.local/bin/transcribe"
TRANSCRIBE_DIR = "/home/delorenj/HeyMa"
GATEWAY_DB = "/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3"
VOX_URL = "https://vox.delo.sh/mcp/"
VOX_VOICE = "rick"
REPLIES_PREFIX = "replies"


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%SZ')}] {msg}", flush=True)


def s3_ls(prefix: str) -> list[str]:
    """List object keys under an S3 prefix using mc (plain text output)."""
    result = subprocess.run(
        ["/usr/local/bin/mc", "ls", "--recursive",
         f"{S3_BUCKET}/{prefix}"],
        capture_output=True, text=True, timeout=30,
    )
    keys = []
    for line in result.stdout.strip().splitlines():
        # Parse lines like: [2026-10-13 08:21:57 EDT] 244KiB STANDARD 33god-pm/2026/10/13/122200Z-test.ogg
        match = re.search(r"\s(\S+\.(?:ogg|webm|m4a|mp3|wav|txt))$", line.strip())
        if match:
            keys.append(f"{prefix}/{match.group(1)}")
    return keys


def s3_download(key: str, dest: Path) -> None:
    subprocess.run(
        ["/usr/local/bin/mc", "cp", f"{S3_BUCKET}/{key}", str(dest)],
        check=True, capture_output=True, timeout=60,
    )


def transcribe(audio_path: Path) -> str:
    """Transcribe an OGG to text. Returns the transcript text."""
    result = subprocess.run(
        [TRANSCRIBE, str(audio_path), "--no-diarization", "--ephemeral"],
        capture_output=True, text=True, timeout=300,
        env={**os.environ, "TRANSCRIBE_DIR": TRANSCRIBE_DIR},
    )
    if result.returncode != 0:
        raise RuntimeError(f"transcribe failed: {result.stderr[:200]}")
    # The transcribe wrapper prints the .md path on stdout as the last line
    md_path = result.stdout.strip().splitlines()[-1].strip()
    if not md_path.endswith(".md"):
        raise RuntimeError(f"unexpected transcribe output: {md_path[:100]}")
    text = Path(md_path).read_text()
    # Strip frontmatter and headers, keep only the spoken content
    lines = []
    in_fm = False
    for line in text.splitlines():
        if line.strip() == "---":
            in_fm = not in_fm
            continue
        if in_fm:
            continue
        if line.startswith("# ") or line.startswith("## "):
            continue
        stripped = line.strip()
        if stripped and not stripped.startswith("**Speaker"):
            lines.append(stripped)
    return " ".join(lines)


def agent_id_from_key(key: str) -> str | None:
    """Extract agent id from inbox/<agent-id>/YYYY/MM/DD/<ts>.ogg."""
    parts = key.split("/")
    if len(parts) >= 5 and parts[0] == INBOX_PREFIX:
        return parts[1]
    return None


def dispatch(agent_id: str, prompt: str, thread_id: str) -> str | None:
    """Publish bloodbank.cmd.agent.invocation.start. Returns correlation id."""
    data = {
        "target_agent_id": agent_id,
        "prompt": prompt,
        "thread_id": thread_id,
        "turn_id": None,
        "context": {
            "source": "holocene-auto:inbox-watcher",
            "repo": "holocene",
            "reason": "voice-inbox",
        },
    }
    result = subprocess.run(
        [BB_EMIT, "--kind", "command",
         "--type", "bloodbank.cmd.agent.invocation.start",
         "--source", "urn:33god:agent:inbox-watcher",
         "--producer", "inbox-watcher",
         "--service", "inbox-watcher",
         "--actor-type", "service",
         "--actor-id", "inbox-watcher",
         "--ordering-key", f"turn:{thread_id}"],
        input=json.dumps(data),
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"bb-emit failed: {result.stderr[:200]}")
    # Extract correlation id from stdout (format varies)
    corr_match = re.search(r'correlation[:\s]+"?([a-f0-9-]+)"?', result.stdout)
    corr = corr_match.group(1) if corr_match else None
    log(f"dispatched → {agent_id} corr={corr}")
    return corr


def wait_for_turn(agent_id: str, timeout_s: int = 120) -> str | None:
    """Poll gateway DB for the most recent completed turn for this profile."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True)
            row = db.execute(
                "SELECT state FROM executions WHERE profile=? ORDER BY created_at DESC LIMIT 1",
                (agent_id,)
            ).fetchone()
            db.close()
            if row and row[0] == "completed":
                return "completed"
            if row and row[0] in ("failed", "rejected"):
                return row[0]
        except Exception as e:
            log(f"wait error: {e}")
        time.sleep(5)
    return None


def read_latest_reply(agent_id: str) -> str | None:
    """Read the most recent assistant message from the profile's session files."""
    sessions_dir = Path(f"/home/delorenj/.hermes/profiles/{agent_id}/sessions")
    if not sessions_dir.exists():
        return None
    # Get most recently modified session files
    files = sorted(sessions_dir.glob("*.json*"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in files[:10]:
        try:
            content = path.read_text()
            # Try JSONL
            for line in reversed(content.strip().splitlines()):
                try:
                    msg = json.loads(line)
                    if msg.get("role") == "assistant":
                        text = msg.get("content", "")
                        if isinstance(text, list):
                            text = " ".join(c.get("text", "") for c in text if c.get("type") == "text")
                        if text and len(text) > 5:
                            return text
                except json.JSONDecodeError:
                    continue
        except Exception:
            continue
    return None


def render_voice(text: str) -> Path | None:
    """Call vox TTS, return path to OGG."""
    clean = re.sub(r'```[\s\S]*?```', '', text)
    clean = re.sub(r'`[^`]+`', '', clean)
    clean = re.sub(r'\*\*([^*]+)\*\*', r'\1', clean)
    clean = re.sub(r'\*([^*]+)\*', r'\1', clean)
    clean = re.sub(r'\n+', ' ', clean)
    clean = clean.strip()
    if len(clean) > 400:
        clean = clean[:400].rsplit(' ', 1)[0] + '…'

    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": "text_to_speech", "arguments": {"text": clean, "voice": VOX_VOICE}}
    })
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        out = Path(f.name)
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", VOX_URL,
         "-H", "Content-Type: application/json",
         "-d", payload, "-o", str(out)],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0 or out.stat().st_size < 100:
        log("vox TTS failed or empty")
        out.unlink()
        return None
    return out


def upload_reply(audio: Path) -> str | None:
    today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    ts = datetime.now(timezone.utc).strftime("%H%M%SZ")
    key = f"{REPLIES_PREFIX}/{today}/{ts}.ogg"
    r = subprocess.run(
        ["/usr/local/bin/mc", "cp", str(audio), f"{S3_BUCKET}/{key}"],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        log(f"upload failed: {r.stderr[:200]}")
        return None
    return key


def load_state() -> set[str]:
    if STATE_FILE.exists():
        return set(json.loads(STATE_FILE.read_text()))
    return set()


def save_state(processed: set[str]) -> None:
    STATE_FILE.write_text(json.dumps(sorted(processed), indent=2))


def process_once() -> int:
    today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    processed = load_state()
    total_new = 0
    # Scan all agent dirs under inbox/
    prefix = f"{INBOX_PREFIX}"
    all_keys = s3_ls(prefix)
    today_keys = [k for k in all_keys if f"/{today}/" in k]
    new_keys = [k for k in today_keys if k not in processed]
    if not new_keys:
        log(f"no new files under {prefix}/{today}/ ({len(today_keys)} total today)")
        return 0

    for key in sorted(new_keys):
        agent_id = agent_id_from_key(key)
        if not agent_id:
            log(f"skipping (no agent in key): {key}")
            processed.add(key)
            continue
        log(f"new file: {key} → agent={agent_id}")
        tmp_audio = Path(tempfile.mktemp(suffix=".ogg"))
        try:
            s3_download(key, tmp_audio)
            transcript = transcribe(tmp_audio)
            if not transcript.strip():
                log(f"empty transcript, skipping: {key}")
                processed.add(key)
                continue
            thread_id = Path(key).stem  # timestamp from filename
            corr = dispatch(agent_id, transcript, thread_id)

            # Wait for agent turn to complete, then render voice reply
            log(f"waiting for {agent_id} turn...")
            state_result = wait_for_turn(agent_id, timeout_s=120)
            if state_result == "completed":
                reply = read_latest_reply(agent_id)
                if reply:
                    log(f"reply ({len(reply)} chars): {reply[:80]}...")
                    audio = render_voice(reply)
                    if audio:
                        reply_key = upload_reply(audio)
                        audio.unlink()
                        if reply_key:
                            log(f"reply rendered → {reply_key}")
                else:
                    log("no reply text found in sessions")
            else:
                log(f"turn ended with state: {state_result}")

            processed.add(key)
            log(f"done: {key} ({len(transcript)} chars)")
        except Exception as e:
            log(f"ERROR processing {key}: {e}")
            # don't mark processed — retry next poll
        finally:
            if tmp_audio.exists():
                tmp_audio.unlink()

    save_state(processed)
    return len(new_keys)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="run once and exit")
    parser.add_argument("--poll", type=int, default=15, help="poll interval seconds")
    args = parser.parse_args()

    log(f"inbox-watcher starting (poll={args.poll}s)")
    while True:
        try:
            process_once()
        except Exception as e:
            log(f"poll error: {e}")
        if args.once:
            break
        time.sleep(args.poll)


if __name__ == "__main__":
    main()

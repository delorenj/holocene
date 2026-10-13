#!/usr/bin/env python3
"""Reply renderer: renders voice replies for completed inbox-watcher turns.

Watches the bloodbank gateway DB for completed executions. For each one
that came from the inbox-watcher (matched by ordering key prefix), fetches
the agent's final reply from the gateway session DB, renders it via vox TTS,
and uploads the OGG to s3://holocene-auto/replies/YYYY/MM/DD/.

The Agent Pad polls the replies box and auto-plays new files.

Run: python3 reply_renderer.py [--once] [--poll 10]
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
from datetime import datetime, timezone
from pathlib import Path

GATEWAY_DB = "/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3"
S3_BUCKET = "delo/holocene-auto"
REPLIES_PREFIX = "replies"
STATE_FILE = Path(__file__).parent / "reply-renderer-state.json"
VOX_URL = "https://vox.delo.sh/mcp/"


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%SZ')}] {msg}", flush=True)


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"rendered": [], "last_check": "2026-01-01T00:00:00"}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def get_completed_voice_turns(since: str) -> list[dict]:
    """Find recently completed executions that might be from voice-inbox.
    
    We can't easily match ordering keys in the DB, so we check all completed
    turns and use the session lookup to see if a reply exists.
    """
    db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True)

    rows = db.execute(
        """SELECT command_id, profile, created_at, updated_at
           FROM executions
           WHERE state = 'completed'
           AND created_at > ?
           ORDER BY created_at ASC""",
        (since,)
    ).fetchall()

    results = []
    for r in rows:
        cid, profile, created, updated = r
        results.append({
            "command_id": cid,
            "profile": profile,
            "created_at": created,
            "updated_at": updated,
        })

    db.close()
    return results


def get_reply_text(profile: str, thread_id: str) -> str | None:
    """Fetch the agent's last assistant message from the session DB."""
    # The session DB path uses the profile name
    session_paths = [
        f"/home/delorenj/.hermes/profiles/{profile}/sessions/{thread_id}.jsonl",
        f"/home/delorenj/.hermes/profiles/{profile}/sessions/{thread_id}.json",
    ]
    for path in session_paths:
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                lines = f.readlines()
            # Find last assistant message
            for line in reversed(lines):
                try:
                    msg = json.loads(line)
                    if msg.get("role") == "assistant":
                        content = msg.get("content", "")
                        if isinstance(content, list):
                            # Extract text from content blocks
                            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                            content = " ".join(texts)
                        if content and len(content) > 5:
                            return content
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            log(f"error reading session {path}: {e}")
    return None


def render_voice(text: str) -> Path | None:
    """Call vox TTS and save OGG. Returns path to audio file."""
    # Clean text for TTS
    clean = re.sub(r'```[\s\S]*?```', '', text)
    clean = re.sub(r'`[^`]+`', '', clean)
    clean = re.sub(r'\*\*([^*]+)\*\*', r'\1', clean)
    clean = re.sub(r'\*([^*]+)\*', r'\1', clean)
    clean = re.sub(r'\n+', ' ', clean)
    clean = clean.strip()
    if len(clean) > 400:
        clean = clean[:400].rsplit(' ', 1)[0] + '…'

    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "text_to_speech",
            "arguments": {"text": clean, "voice": "rick"}
        }
    })

    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        out_path = Path(f.name)

    result = subprocess.run(
        ["curl", "-s", "-X", "POST", VOX_URL,
         "-H", "Content-Type: application/json",
         "-d", payload,
         "-o", str(out_path)],
        capture_output=True, text=True, timeout=60,
    )

    if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 100:
        log("vox TTS failed or returned empty")
        if out_path.exists():
            out_path.unlink()
        return None

    return out_path


def upload_reply(audio_path: Path) -> str | None:
    today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    ts = datetime.now(timezone.utc).strftime("%H%M%SZ")
    key = f"{REPLIES_PREFIX}/{today}/{ts}.ogg"

    result = subprocess.run(
        ["/usr/local/bin/mc", "cp", str(audio_path), f"{S3_BUCKET}/{key}"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        log(f"upload failed: {result.stderr[:200]}")
        return None
    return key


def process_once(state: dict) -> dict:
    since = state.get("last_check", "2026-01-01T00:00:00")
    turns = get_completed_voice_turns(since)
    if not turns:
        log("no new completed voice turns")
        return state

    log(f"found {len(turns)} completed turns")
    for turn in turns:
        cid = turn["command_id"]
        if cid in state.get("rendered", []):
            continue

        profile = turn["profile"]

        log(f"processing turn: {cid} profile={profile}")

        reply_text = get_reply_text(profile, cid)
        if not reply_text:
            log(f"no reply text for {cid}")
            state.setdefault("rendered", []).append(cid)
            continue

        log(f"reply: {reply_text[:80]}...")

        audio = render_voice(reply_text)
        if not audio:
            state.setdefault("rendered", []).append(cid)
            continue

        key = upload_reply(audio)
        audio.unlink()

        if key:
            log(f"reply rendered and uploaded: {key}")
        state.setdefault("rendered", []).append(cid)

    if turns:
        state["last_check"] = turns[-1]["created_at"]
    save_state(state)
    return state


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll", type=int, default=10)
    args = parser.parse_args()

    log(f"reply-renderer starting (poll={args.poll}s)")
    state = load_state()
    while True:
        try:
            state = process_once(state)
        except Exception as e:
            log(f"error: {e}")
        if args.once:
            break
        time.sleep(args.poll)


if __name__ == "__main__":
    main()

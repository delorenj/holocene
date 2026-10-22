#!/usr/bin/env bash
# Install + enable + start the voice memo inbox watcher (and its warm GPU whisper server) as systemd user units.
# Idempotent. Usage: services/inbox-watcher/install.sh [--restart]   (--restart restarts the watcher only)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit=holocene-inbox-watcher.service
whisper=holocene-whisper.service   # the transcribe fast path; the watcher falls back to the CLI without it
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/state/holocene-auto/inbox-watcher"
for u in "$unit" "$whisper"; do
  ln -sfn "$here/$u" "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
systemctl --user enable "$unit" "$whisper" >/dev/null
systemctl --user is-active --quiet "$whisper" || systemctl --user start "$whisper"
if [[ "${1:-}" == "--restart" ]] || ! systemctl --user is-active --quiet "$unit"; then
  systemctl --user restart "$unit"
fi
sleep 2
systemctl --user --no-pager status "$unit" | head -12
curl -fsS -m 3 http://127.0.0.1:8766/health && echo || echo "warn: $whisper not answering on :8766 yet (model loading?)"
echo "logs:  journalctl --user -u $unit -f -o cat"
echo "trace: mise run memo:trace latest"

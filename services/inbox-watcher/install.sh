#!/usr/bin/env bash
# Install + enable + start the voice memo inbox watcher as a systemd user unit.
# Idempotent. Usage: services/inbox-watcher/install.sh [--restart]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit=holocene-inbox-watcher.service
dest="$HOME/.config/systemd/user/$unit"
mkdir -p "$(dirname "$dest")" "$HOME/.local/state/holocene-auto/inbox-watcher"
ln -sfn "$here/$unit" "$dest"
systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null
if [[ "${1:-}" == "--restart" ]] || ! systemctl --user is-active --quiet "$unit"; then
  systemctl --user restart "$unit"
fi
sleep 2
systemctl --user --no-pager status "$unit" | head -12
echo "logs:  journalctl --user -u $unit -f -o cat"
echo "trace: mise run memo:trace latest"
